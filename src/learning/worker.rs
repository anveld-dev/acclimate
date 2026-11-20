use super::{ACTIVE_ROUND_STATES, LoopRow, Tx, active_round, evolve, find_loop, positive_setting};
use crate::AppState;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub async fn learning_worker(s: AppState) {
    let _lifetime = s.runtime.worker_started();
    let mut retry_after = HashMap::new();
    let mut next_sweep = Instant::now();
    while !s.runtime.is_draining() {
        if Instant::now() >= next_sweep {
            next_sweep = Instant::now() + Duration::from_secs(5);
            if let Err(error) = sweep(&s).await {
                eprintln!("learning sweep failed: {error}");
            }
        }
        if let Err(error) = tick(&s, &mut retry_after).await {
            eprintln!("learning tick failed: {error}");
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            _ = s.runtime.wait_for_drain() => return,
        }
    }
}

async fn tick(
    s: &AppState,
    retry_after: &mut HashMap<(String, Uuid), Instant>,
) -> Result<(), sqlx::Error> {
    let now = Instant::now();
    retry_after.retain(|_, deadline| *deadline > now);
    let loops: Vec<(String,Uuid)> = sqlx::query_as(
        "SELECT l.project_id,l.bundle_id FROM learning_loops l WHERE status='running'
         OR EXISTS (SELECT 1 FROM learning_rounds r WHERE (r.project_id,r.bundle_id)=(l.project_id,l.bundle_id)
                    AND r.state=ANY($1)) ORDER BY l.updated_at,l.project_id,l.bundle_id")
        .bind(ACTIVE_ROUND_STATES).fetch_all(&s.db).await?;
    for (project, bundle) in loops {
        if retry_after.contains_key(&(project.clone(), bundle)) {
            continue;
        }
        if let Err(error) = advance_round(s, &project, bundle).await {
            eprintln!("learning round step failed for {project}/{bundle}: {error}");
            retry_after.insert((project, bundle), Instant::now() + Duration::from_secs(10));
        }
    }
    Ok(())
}

async fn sweep(s: &AppState) -> Result<(), sqlx::Error> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(());
    };
    sqlx::query("UPDATE learning_evaluations SET status='failed',
        error=CASE WHEN status='queued' THEN 'Evaluation queue deadline passed' ELSE 'Evaluation run deadline passed' END
        WHERE status IN ('queued','running') AND deadline_at<=now()").execute(&s.db).await?;
    Ok(())
}

async fn advance_round(s: &AppState, project: &str, bundle: Uuid) -> Result<(), sqlx::Error> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(());
    };
    let mut tx = s.db.begin().await?;
    if let Some(row) = find_loop(&mut tx, project, bundle, true).await? {
        advance_locked(&mut tx, &row).await?;
    }
    tx.commit().await
}

async fn advance_locked(tx: &mut Tx<'_>, row: &LoopRow) -> Result<(), sqlx::Error> {
    let Some(round) = active_round(tx, &row.project_id, row.bundle_id).await? else {
        if row.status == "running"
            && evolve::live_count(tx, &row.project_id, row.bundle_id, row.evolve_revision).await?
                > 0
        {
            start_round(tx, row).await?;
        }
        return Ok(());
    };
    let role = match round.state.as_str() {
        "scoring_incumbent" => "incumbent",
        "scoring_held_out" => "retained",
        _ => return Ok(()),
    };
    let (status, score, error): (String, Option<f64>, Option<String>) = sqlx::query_as(
        "SELECT status,score,error FROM learning_evaluations WHERE round_id=$1 AND role=$2",
    )
    .bind(round.id)
    .bind(role)
    .fetch_one(&mut **tx)
    .await?;
    match (role, status.as_str()) {
        ("incumbent", "failed") => fail_round(tx, row, round.id).await?,
        ("incumbent", "scored") => keep(tx, row, round.id, score).await?,
        ("retained", "scored" | "failed") => {
            sqlx::query("UPDATE learning_rounds SET state='completed',ended_at=now(),held_out_score=$2,held_out_error=$3
                         WHERE id=$1 AND state='scoring_held_out'")
                .bind(round.id).bind(score).bind(error).execute(&mut **tx).await?;
            sqlx::query("UPDATE learning_loops SET failed_rounds=0,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
                .bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn channel_head(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    channel: &str,
) -> Result<(Uuid, i64, String), sqlx::Error> {
    sqlx::query_as(
        "SELECT c.version_id,c.revision,v.digest FROM channels c JOIN versions v
                    ON (v.project_id,v.bundle_id,v.id)=(c.project_id,c.bundle_id,c.version_id)
                    WHERE (c.project_id,c.bundle_id,c.name)=($1,$2,$3) FOR SHARE OF c",
    )
    .bind(&row.project_id)
    .bind(row.bundle_id)
    .bind(channel)
    .fetch_one(&mut **tx)
    .await
}

async fn start_round(tx: &mut Tx<'_>, row: &LoopRow) -> Result<(), sqlx::Error> {
    let (version, revision, digest) = channel_head(tx, row, &row.channel).await?;
    let round = Uuid::new_v4();
    let model = std::env::var("ACCLIMATE_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,
                   channel_revision,evolve_revision,memory_revision,setting,held_out,optimizer_model)
                 VALUES($1,$2,$3,$4,'scoring_incumbent',$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(round).bind(&row.project_id).bind(row.bundle_id).bind(row.next_round).bind(version).bind(&row.channel)
        .bind(revision).bind(row.evolve_revision).bind(row.memory_revision).bind(&row.setting).bind(&row.held_out).bind(model)
        .execute(&mut **tx).await?;
    queue(tx, round, version, &digest, Some(row.evolve_revision)).await?;
    sqlx::query("UPDATE learning_loops SET next_round=next_round+1,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
    Ok(())
}

async fn queue(
    tx: &mut Tx<'_>,
    round: Uuid,
    version: Uuid,
    digest: &str,
    revision: Option<i64>,
) -> Result<(), sqlx::Error> {
    let (role, split) = if revision.is_some() {
        ("incumbent", "evolve")
    } else {
        ("retained", "held_out")
    };
    let seconds = positive_setting("ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS", 604800);
    sqlx::query("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,evolve_revision,deadline_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(secs=>$8))")
        .bind(Uuid::new_v4()).bind(round).bind(role).bind(split).bind(version).bind(digest).bind(revision)
        .bind(f64::from(seconds)).execute(&mut **tx).await?;
    Ok(())
}

async fn keep(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: Uuid,
    score: Option<f64>,
) -> Result<(), sqlx::Error> {
    let channel: String = sqlx::query_scalar("SELECT channel FROM learning_rounds WHERE id=$1")
        .bind(round)
        .fetch_one(&mut **tx)
        .await?;
    let (version, _, digest) = channel_head(tx, row, &channel).await?;
    sqlx::query("UPDATE learning_rounds SET state='scoring_held_out',decision='kept',reason='no-candidates',incumbent_score=$2
                 WHERE id=$1 AND state='scoring_incumbent'")
        .bind(round).bind(score).execute(&mut **tx).await?;
    queue(tx, round, version, &digest, None).await
}

async fn fail_round(tx: &mut Tx<'_>, row: &LoopRow, round: Uuid) -> Result<(), sqlx::Error> {
    cancel_children(tx, round, "round failed").await?;
    sqlx::query("UPDATE learning_rounds SET state='failed',reason='incumbent-evaluation-failed',ended_at=now()
                 WHERE id=$1 AND state=ANY($2)")
        .bind(round).bind(ACTIVE_ROUND_STATES).execute(&mut **tx).await?;
    let max = positive_setting("ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS", 3);
    let pause = row.status == "running" && row.failed_rounds as u32 + 1 >= max;
    sqlx::query("UPDATE learning_loops SET failed_rounds=failed_rounds+1,updated_at=now(),
                    status=CASE WHEN $3 THEN 'paused' ELSE status END,
                    pause_reason=CASE WHEN $3 THEN 'failed-rounds' ELSE pause_reason END WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&row.project_id).bind(row.bundle_id).bind(pause).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn stop_round(tx: &mut Tx<'_>, round: Uuid) -> Result<(), sqlx::Error> {
    cancel_children(tx, round, "stopped").await?;
    sqlx::query("UPDATE learning_rounds SET state='stopped',ended_at=now(),reason=CASE WHEN decision IS NULL THEN 'stopped' ELSE reason END
                 WHERE id=$1 AND state=ANY($2)")
        .bind(round).bind(ACTIVE_ROUND_STATES).execute(&mut **tx).await?;
    Ok(())
}

async fn cancel_children(tx: &mut Tx<'_>, round: Uuid, why: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE learning_evaluations SET status='cancelled',error=$2 WHERE round_id=$1 AND status IN ('queued','running')")
        .bind(round).bind(why).execute(&mut **tx).await?;
    Ok(())
}
