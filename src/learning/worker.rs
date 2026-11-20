use super::{
    ACTIVE_ROUND_STATES, LoopRow, Tx, active_round, evolve, find_loop,
    optimizer::{self, CallKey, Kind, Pins},
    positive_setting,
};
mod advance;
use crate::AppState;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::task::{Id, JoinSet};
use uuid::Uuid;

pub async fn learning_worker(s: AppState) {
    let _lifetime = s.runtime.worker_started();
    let mut retry_after = HashMap::new();
    let mut next_sweep = Instant::now();
    let mut tasks = JoinSet::new();
    let mut held = HashMap::new();
    while !s.runtime.is_draining() {
        while let Some(result) = tasks.try_join_next_with_id() {
            match result {
                Ok((id, result)) => {
                    held.remove(&id);
                    if let Err(error) = result {
                        eprintln!("learning optimizer task failed: {error}");
                    }
                }
                Err(error) => {
                    held.remove(&error.id());
                    eprintln!("learning optimizer task ended: {error}");
                }
            }
        }
        if Instant::now() >= next_sweep {
            next_sweep = Instant::now() + Duration::from_secs(5);
            if let Err(error) = sweep(&s, held.values().copied().collect()).await {
                eprintln!("learning sweep failed: {error}");
            }
        }
        if let Err(error) = tick(&s, &mut retry_after).await {
            eprintln!("learning tick failed: {error}");
        }
        if let Err(error) = spawn_calls(&s, &mut tasks, &mut held).await {
            eprintln!("learning optimizer dispatch failed: {error}");
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

async fn sweep(s: &AppState, held: Vec<Uuid>) -> Result<(), sqlx::Error> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(());
    };
    sqlx::query("UPDATE learning_evaluations SET status='failed',
        error=CASE WHEN status='queued' THEN 'Evaluation queue deadline passed' ELSE 'Evaluation run deadline passed' END
        WHERE status IN ('queued','running') AND deadline_at<=now()").execute(&s.db).await?;
    sqlx::query(
        "UPDATE learning_optimizer_calls
        SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
            error_code=CASE WHEN attempts<3 THEN NULL ELSE 'provider-failed' END,
            error=CASE WHEN attempts<3 THEN NULL ELSE 'attempt limit reached' END
        WHERE status='running' AND NOT (round_id=ANY($1))",
    )
    .bind(held)
    .execute(&s.db)
    .await?;
    Ok(())
}

async fn spawn_calls(
    s: &AppState,
    tasks: &mut JoinSet<Result<(), sqlx::Error>>,
    held: &mut HashMap<Id, Uuid>,
) -> Result<(), sqlx::Error> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(());
    };
    let queued: Vec<(Uuid, String, i16)> = sqlx::query_as(
        "SELECT round_id,kind,sample FROM learning_optimizer_calls WHERE status='queued'",
    )
    .fetch_all(&s.db)
    .await?;
    for (round, kind, sample) in queued {
        if held.values().any(|id| *id == round) {
            continue;
        }
        let kind = match kind.as_str() {
            "propose" => Kind::Propose,
            "screen" => Kind::Screen,
            "select" => Kind::Select,
            _ => return Err(optimizer::invariant("Invalid optimizer call kind")),
        };
        let state = s.clone();
        let task = tasks.spawn(async move {
            optimizer::run_call(
                &state,
                CallKey {
                    round,
                    kind,
                    sample,
                },
            )
            .await
        });
        held.insert(task.id(), round);
    }
    Ok(())
}

async fn advance_round(s: &AppState, project: &str, bundle: Uuid) -> Result<(), sqlx::Error> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(());
    };
    let mut tx = s.db.begin().await?;
    if let Some(row) = find_loop(&mut tx, project, bundle, true).await? {
        advance_locked(
            &mut tx,
            &row,
            s.optimizer.as_ref().map(|model| model.model()),
        )
        .await?;
    }
    tx.commit().await
}

async fn advance_locked(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    model: Option<&str>,
) -> Result<(), sqlx::Error> {
    let Some(round) = active_round(tx, &row.project_id, row.bundle_id).await? else {
        if row.status == "running"
            && evolve::live_count(tx, &row.project_id, row.bundle_id, row.evolve_revision).await?
                > 0
        {
            start_round(tx, row, model).await?;
        }
        return Ok(());
    };
    let role = match round.state.as_str() {
        "scoring_incumbent" => "incumbent",
        "scoring_held_out" => "retained",
        state => {
            let pins = Pins::load(tx, round.id).await?;
            return advance::step(tx, row, &pins, state).await;
        }
    };
    let (status, score, error): (String, Option<f64>, Option<String>) = sqlx::query_as(
        "SELECT status,score,error FROM learning_evaluations WHERE round_id=$1 AND role=$2",
    )
    .bind(round.id)
    .bind(role)
    .fetch_one(&mut **tx)
    .await?;
    match (role, status.as_str()) {
        ("incumbent", "failed") => {
            fail_round(tx, row, round.id, "incumbent-evaluation-failed").await?
        }
        ("incumbent", "scored") => {
            let pins = Pins::load(tx, round.id).await?;
            optimizer::enqueue(tx, &pins, Kind::Propose, 1).await?;
            sqlx::query(
                "UPDATE learning_rounds SET state='proposing',incumbent_score=$2 WHERE id=$1",
            )
            .bind(round.id)
            .bind(score)
            .execute(&mut **tx)
            .await?;
        }
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

async fn start_round(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    model: Option<&str>,
) -> Result<(), sqlx::Error> {
    let (version, revision, digest) = channel_head(tx, row, &row.channel).await?;
    let round = Uuid::new_v4();
    sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,
                   channel_revision,evolve_revision,memory_revision,setting,held_out,optimizer_model)
                 VALUES($1,$2,$3,$4,'scoring_incumbent',$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(round).bind(&row.project_id).bind(row.bundle_id).bind(row.next_round).bind(version).bind(&row.channel)
        .bind(revision).bind(row.evolve_revision).bind(row.memory_revision).bind(&row.setting).bind(&row.held_out).bind(model)
        .execute(&mut **tx).await?;
    queue(
        tx,
        round,
        version,
        &digest,
        Some((row.evolve_revision, None)),
    )
    .await?;
    sqlx::query("UPDATE learning_loops SET next_round=next_round+1,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
    Ok(())
}

async fn queue(
    tx: &mut Tx<'_>,
    round: Uuid,
    version: Uuid,
    digest: &str,
    evolve: Option<(i64, Option<i16>)>,
) -> Result<Uuid, sqlx::Error> {
    let (role, split, revision, sample) = match evolve {
        Some((rev, Some(sample))) => ("candidate", "evolve", Some(rev), Some(sample)),
        Some((rev, None)) => ("incumbent", "evolve", Some(rev), None),
        None => ("retained", "held_out", None, None),
    };
    let id = Uuid::new_v4();
    let seconds = positive_setting("ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS", 604800);
    sqlx::query("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,evolve_revision,sample,deadline_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9))")
        .bind(id).bind(round).bind(role).bind(split).bind(version).bind(digest).bind(revision).bind(sample)
        .bind(f64::from(seconds)).execute(&mut **tx).await?;
    Ok(id)
}

async fn fail_round(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error> {
    cancel_children(tx, round, "round failed").await?;
    sqlx::query(
        "UPDATE learning_rounds SET state='failed',reason=$3,ended_at=now()
                 WHERE id=$1 AND state=ANY($2)",
    )
    .bind(round)
    .bind(ACTIVE_ROUND_STATES)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    let max = positive_setting("ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS", 3);
    let pause = if reason == "optimizer-context-too-large" {
        Some(reason)
    } else if row.status == "running" && row.failed_rounds as u32 + 1 >= max {
        Some("failed-rounds")
    } else {
        None
    };
    sqlx::query(
        "UPDATE learning_loops SET failed_rounds=failed_rounds+1,updated_at=now(),
                    status=CASE WHEN $3::text IS NOT NULL THEN 'paused' ELSE status END,
                    pause_reason=COALESCE($3,pause_reason) WHERE (project_id,bundle_id)=($1,$2)",
    )
    .bind(&row.project_id)
    .bind(row.bundle_id)
    .bind(pause)
    .execute(&mut **tx)
    .await?;
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
    sqlx::query(
        "UPDATE learning_optimizer_calls SET status='failed',error_code='cancelled',error=$2
        WHERE round_id=$1 AND status IN ('queued','running')",
    )
    .bind(round)
    .bind(why)
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE learning_candidates SET status='evaluation_failed' WHERE round_id=$1 AND status='evaluating'")
        .bind(round).execute(&mut **tx).await?;
    Ok(())
}
