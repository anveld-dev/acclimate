use super::{
    ACTIVE_ROUND_STATES, LoopRow, Tx, active_round, find_loop,
    optimizer::{self, CallKey, Kind, OptimizerModel, Pins},
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
    crate::executor::expire_leases(&s.db).await?;
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
        advance_locked(&mut tx, &row, s.optimizer.as_deref()).await?;
    }
    tx.commit().await
}

async fn advance_locked(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    optimizer: Option<&dyn OptimizerModel>,
) -> Result<(), sqlx::Error> {
    let below_floor = row.status == "running"
        && row.started_at.is_some()
        && !super::controls::ready(tx, row).await?;
    if below_floor && !super::controls::pending_edits_cover_floor(tx, row).await? {
        sqlx::query("UPDATE learning_loops SET status='paused',pause_reason='tasks-required',waiting=NULL,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)").bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
    }
    let Some(round) = active_round(tx, &row.project_id, row.bundle_id).await? else {
        if row.status == "running"
            && !below_floor
            && row.started_at.is_some()
            && let Some(trigger) = super::controls::schedule(tx, row).await?
        {
            start_round(tx, row, optimizer, trigger).await?;
        }
        return Ok(());
    };
    const UNMATCHED_TIMEOUT_SECONDS: i32 = 300;
    let expired:Option<bool>=sqlx::query_scalar("WITH availability AS (
        SELECT EXISTS(SELECT FROM learning_evaluations e JOIN learning_rollouts l ON l.evaluation_id=e.id WHERE e.round_id=r.id AND l.status='queued') AND NOT EXISTS(
          SELECT FROM present_executors c JOIN workspace_model_providers p ON p.project_id=r.project_id
          WHERE c.runtime=r.runtime->'executor'
          AND p.verification->>'status'='verified' AND p.base_url=r.runtime->>'baseUrl' AND r.task_model=ANY(p.allowed_models) AND r.judge_model=ANY(p.allowed_models)) AS missing
        FROM learning_rounds r WHERE r.id=$1)
        UPDATE learning_rounds SET unmatched_since=CASE WHEN missing THEN coalesce(unmatched_since,now()) END FROM availability
        WHERE id=$1 AND (unmatched_since IS NOT NULL OR missing) RETURNING coalesce(unmatched_since<=now()-make_interval(secs=>$2::int),false)")
        .bind(round.id).bind(UNMATCHED_TIMEOUT_SECONDS).fetch_optional(&mut **tx).await?;
    if expired == Some(true) {
        // The release already happened, so an unfinished check must still reach the administrators.
        if round.state == "scoring_held_out"
            && let Some(version) = round.adopted_version_id
        {
            alert_incomplete_check(tx, row, round.id, version).await?;
        }
        return fail_round(tx, row, round.id, "no-matching-executor").await;
    }
    crate::executor::settle_round(tx, round.id).await?;
    let role = match round.state.as_str() {
        "scoring_incumbent" => "incumbent",
        "scoring_held_out" => "retained",
        state => {
            let pins = Pins::load(tx, round.id).await?;
            return advance::step(tx, row, &pins, state).await;
        }
    };
    let (status, score, error): (String, Option<f64>, Option<String>) = sqlx::query_as(
        "SELECT status,score,error FROM learning_evaluations WHERE round_id=$1 AND role=$2 AND measurement='initial'",
    )
    .bind(round.id)
    .bind(role)
    .fetch_one(&mut **tx)
    .await?;
    match (role, status.as_str()) {
        ("incumbent", "failed") => {
            // A provider outage is not a problem with the loop, so it waits rather than pausing.
            let reason = match record_failure_cause(tx, round.id, "incumbent").await? {
                Some(true) => "provider-unavailable",
                _ => "incumbent-evaluation-failed",
            };
            return fail_round(tx, row, round.id, reason).await;
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
            let exhausted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT FROM learning_evaluations WHERE round_id=$1 AND measurement<>'initial' AND status='failed' AND measurement_retries >= $2)")
                .bind(round.id).bind(super::controls::MAX_MEASUREMENT_RETRIES).fetch_one(&mut **tx).await?;
            if exhausted {
                sqlx::query("WITH cancelled AS (UPDATE learning_evaluations SET status='cancelled' WHERE round_id=$1 AND measurement<>'initial' AND status IN ('queued','running') RETURNING id)
                    UPDATE learning_rollouts SET status='cancelled',lease_token_hash=NULL WHERE evaluation_id IN (SELECT id FROM cancelled) AND status IN ('queued','running','grading')").bind(round.id).execute(&mut **tx).await?;
            }
            let error = if exhausted {
                Some("regression-check-incomplete".to_owned())
            } else {
                error
            };
            if exhausted || status == "failed" {
                record_failure_cause(tx, round.id, "retained").await?;
                if let Some(version) = round.adopted_version_id {
                    alert_incomplete_check(tx, row, round.id, version).await?;
                }
            }
            if !exhausted && score.is_some() && super::controls::monitor(tx, row, &round).await? {
                return Ok(());
            }
            sqlx::query("UPDATE learning_rounds SET state='completed',ended_at=now(),held_out_score=$2,held_out_error=$3
                         WHERE id=$1 AND state='scoring_held_out'")
                .bind(round.id).bind(score.filter(|_| error.is_none())).bind(error).execute(&mut **tx).await?;
            sqlx::query("UPDATE learning_loops SET failed_rounds=0,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
                .bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
        }
        _ => {}
    }
    Ok(())
}

pub(super) async fn channel_head(
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

pub(super) async fn available_runtime(
    tx: &mut Tx<'_>,
    row: &LoopRow,
) -> Result<Option<serde_json::Value>, sqlx::Error> {
    sqlx::query_scalar(
        // Pin the identity an executor last declared. A lease it took before a restart can still
        // be unexpired, and the view would also offer that lease's older identity.
        "SELECT jsonb_build_object('executor',c.runtime,'taskModel',$2::text,'judgeModel',$3::text,'baseUrl',p.base_url)
         FROM executor_credentials c CROSS JOIN workspace_model_providers p
         WHERE p.project_id=$1 AND p.verification->>'status'='verified' AND c.runtime IS NOT NULL
           AND c.revoked_at IS NULL AND c.id IN (SELECT id FROM present_executors)
           AND $2=ANY(p.allowed_models) AND $3=ANY(p.allowed_models)
         ORDER BY c.last_seen_at DESC,c.id LIMIT 1")
        .bind(&row.project_id).bind(&row.task_model).bind(&row.judge_model).fetch_optional(&mut **tx).await
}

async fn start_round(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    optimizer: Option<&dyn OptimizerModel>,
    trigger: &str,
) -> Result<(), sqlx::Error> {
    let (version, revision, digest) = channel_head(tx, row, &row.channel).await?;
    let runtime = available_runtime(tx, row).await?;
    let Some(runtime) = runtime else {
        sqlx::query("UPDATE learning_loops SET waiting=CASE WHEN EXISTS(SELECT FROM workspace_model_providers WHERE project_id=$1 AND NOT ($3=ANY(allowed_models) AND $4=ANY(allowed_models))) THEN 'models-not-allowed' ELSE 'no-executor' END WHERE (project_id,bundle_id)=($1,$2)").bind(&row.project_id).bind(row.bundle_id).bind(&row.task_model).bind(&row.judge_model).execute(&mut **tx).await?;
        return Ok(());
    };
    let round = Uuid::new_v4();
    sqlx::query("INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,parent_version_id,channel,
                   channel_revision,task_revision,memory_revision,setting,runtime,optimizer_model,optimizer_reasoning_effort,trigger,task_model,judge_model)
                 VALUES($1,$2,$3,$4,'scoring_incumbent',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)")
        .bind(round).bind(&row.project_id).bind(row.bundle_id).bind(row.next_round).bind(version).bind(&row.channel)
        .bind(revision).bind(row.task_revision).bind(row.memory_revision).bind(&row.setting).bind(&runtime).bind(optimizer.map(OptimizerModel::model))
        .bind(optimizer.and_then(OptimizerModel::reasoning_effort)).bind(trigger).bind(&row.task_model).bind(&row.judge_model)
        .execute(&mut **tx).await?;
    let incumbent = queue(tx, round, version, &digest, Some((row.task_revision, None))).await?;
    if reuse_score(tx, incumbent).await? {
        sqlx::query("UPDATE learning_rounds SET incumbent_reused=true WHERE id=$1")
            .bind(round)
            .execute(&mut **tx)
            .await?;
    } else {
        crate::executor::queue_evaluation(tx, incumbent).await?;
    }
    sqlx::query("INSERT INTO learning_usage(project_id,bundle_id,day,rounds) VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(project_id,bundle_id,day) DO UPDATE SET rounds=learning_usage.rounds+1").bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
    sqlx::query("UPDATE learning_loops SET next_round=next_round+1,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
    Ok(())
}

/// Only original rollout measurements supply a score. A previous copy resolves to the
/// same original measurement because the digest, task revision and runtime must match.
async fn reuse_score(tx: &mut Tx<'_>, evaluation: Uuid) -> Result<bool, sqlx::Error> {
    let result=sqlx::query("WITH measurement AS (
        SELECT e.report,e.score,e.mean_task_tokens FROM learning_evaluations dest
        JOIN learning_rounds current ON current.id=dest.round_id
        JOIN learning_rounds previous ON (previous.project_id,previous.bundle_id)=(current.project_id,current.bundle_id)
            AND previous.number<current.number AND previous.task_revision=current.task_revision
            AND previous.runtime=current.runtime
        JOIN learning_evaluations e ON e.round_id=previous.id AND e.digest=dest.digest AND e.split=dest.split
        WHERE dest.id=$1 AND e.status='scored' AND e.measurement='initial'
          AND EXISTS(SELECT FROM learning_rollouts l WHERE l.evaluation_id=e.id AND l.status='scored')
        ORDER BY previous.number DESC,e.created_at DESC,e.id LIMIT 1
    ) UPDATE learning_evaluations dest SET status='scored',report=m.report,score=m.score,mean_task_tokens=m.mean_task_tokens,started_at=now()
      FROM measurement m WHERE dest.id=$1")
        .bind(evaluation).execute(&mut **tx).await?;
    Ok(result.rows_affected() == 1)
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

    sqlx::query("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,evolve_revision,sample)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(round).bind(role).bind(split).bind(version).bind(digest).bind(revision).bind(sample)
        .execute(&mut **tx).await?;
    if role == "candidate" {
        crate::executor::queue_evaluation(tx, id).await?;
    }
    Ok(id)
}

/// Records the first failed rollout of the round's evaluations in `role` as the round's failure
/// cause, and returns whether every failed rollout was a model provider failure. A held-out
/// rollout's message is never recorded, because held-out content stays with the service.
async fn record_failure_cause(
    tx: &mut Tx<'_>,
    round: Uuid,
    role: &str,
) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar("WITH failed AS (
        SELECT l.error_code,l.error_message,e.split,l.task_id,l.rollout,e.created_at FROM learning_rollouts l
        JOIN learning_evaluations e ON e.id=l.evaluation_id WHERE e.round_id=$1 AND e.role=$2 AND l.status='failed'
    ), first AS (SELECT * FROM failed ORDER BY created_at,task_id COLLATE \"C\",rollout LIMIT 1)
    UPDATE learning_rounds r SET failure_code=f.error_code,failure_split=f.split,
        failure_message=CASE WHEN f.split='evolve' THEN f.error_message END
    FROM first f WHERE r.id=$1
    RETURNING (SELECT coalesce(bool_and(error_code='gateway-upstream'),false) FROM failed)")
        .bind(round).bind(role).fetch_optional(&mut **tx).await
}

async fn alert_incomplete_check(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: Uuid,
    version: Uuid,
) -> Result<(), sqlx::Error> {
    let alert = serde_json::json!({"kind":"regression-check-incomplete","roundId":round,"versionId":version});
    sqlx::query("UPDATE learning_loops SET alert=$3 WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&row.project_id)
        .bind(row.bundle_id)
        .bind(alert)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO learning_alert_deliveries(round_id,user_id) SELECT $1,u.id FROM project_memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=$2 AND m.role='admin' AND u.email_verified ON CONFLICT DO NOTHING").bind(round).bind(&row.project_id).execute(&mut **tx).await?;
    Ok(())
}

async fn fail_round(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error> {
    cancel_children(tx, round, "round failed").await?;
    sqlx::query(
        "UPDATE learning_rounds SET state='failed',reason=CASE WHEN decision IS NULL THEN $3 ELSE reason END,held_out_error=CASE WHEN decision IS NOT NULL THEN $3 END,ended_at=now()
                 WHERE id=$1 AND state=ANY($2)",
    )
    .bind(round)
    .bind(ACTIVE_ROUND_STATES)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    // Neither reason is a fault of the bundle or the loop, so neither counts toward a pause.
    if matches!(reason, "no-matching-executor" | "provider-unavailable") {
        return Ok(());
    }
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
    sqlx::query("UPDATE learning_rollouts SET status='cancelled',lease_token_hash=NULL WHERE evaluation_id IN (SELECT id FROM learning_evaluations WHERE round_id=$1) AND status IN ('queued','running','grading')").bind(round).execute(&mut **tx).await?;
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
