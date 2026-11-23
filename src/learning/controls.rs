use super::*;
const START_FLOOR: i64 = 20;
const MIN_CHANGED: i64 = 5;
const CHANGE_PERCENT: i64 = 10;

pub(super) async fn counts(tx: &mut Tx<'_>, p: &str, b: Uuid) -> Result<(i64, i64), sqlx::Error> {
    sqlx::query_as("SELECT (SELECT count(*) FROM learning_round_tasks WHERE (project_id,bundle_id)=($1,$2)),(SELECT count(*) FROM learning_round_held_out_tasks WHERE (project_id,bundle_id)=($1,$2))").bind(p).bind(b).fetch_one(&mut **tx).await
}
pub(super) async fn ready(tx: &mut Tx<'_>, row: &LoopRow) -> Result<bool, sqlx::Error> {
    let (e, h) = counts(tx, &row.project_id, row.bundle_id).await?;
    Ok(e.min(h) >= START_FLOOR)
}

pub(super) async fn pending_edits_cover_floor(
    tx: &mut Tx<'_>,
    row: &LoopRow,
) -> Result<bool, sqlx::Error> {
    for table in ["learning_tasks", "learning_held_out_tasks"] {
        let possible:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM {table} t WHERE (project_id,bundle_id)=($1,$2) AND retired_revision IS NULL AND (admission='admitted' OR (admission='pending' AND EXISTS(SELECT FROM {table} old WHERE (old.project_id,old.bundle_id,old.task_id)=(t.project_id,t.bundle_id,t.task_id) AND old.admission='admitted' AND old.retired_revision IS NOT NULL)))")).bind(&row.project_id).bind(row.bundle_id).fetch_one(&mut **tx).await?;
        if possible < START_FLOOR {
            return Ok(false);
        }
    }
    Ok(true)
}

fn enough_changes(changes: i64, live: i64) -> bool {
    changes >= MIN_CHANGED && changes * 100 >= live * CHANGE_PERCENT
}

pub(super) async fn schedule(
    tx: &mut Tx<'_>,
    row: &LoopRow,
) -> Result<Option<&'static str>, sqlx::Error> {
    #[derive(FromRow)]
    struct PreviousRound {
        state: String,
        decision: Option<String>,
        trigger: String,
        task_revision: i64,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let previous:Option<PreviousRound>=sqlx::query_as("SELECT state,decision,trigger,task_revision,created_at FROM learning_rounds WHERE (project_id,bundle_id)=($1,$2) ORDER BY number DESC LIMIT 1")
        .bind(&row.project_id).bind(row.bundle_id).fetch_optional(&mut **tx).await?;
    let trigger = if let Some(previous) = previous {
        if row.started_at.is_some_and(|t| {
            t > previous.created_at && row.resumed_at.is_none_or(|resumed| resumed <= t)
        }) {
            Some("start")
        } else if row.resumed_at.is_some_and(|t| t > previous.created_at) {
            Some("resume")
        } else if previous.decision.as_deref() == Some("adopted") {
            Some("adoption")
        } else {
            let (changes, live): (i64, i64) = {
                sqlx::query_as("SELECT count(DISTINCT task_id) FILTER(WHERE admission_revision>$3 OR (admission='admitted' AND (added_revision>$3 OR retired_revision>$3))),
                    count(*) FILTER(WHERE retired_revision IS NULL AND admission='admitted')
                    FROM learning_tasks WHERE (project_id,bundle_id)=($1,$2)").bind(&row.project_id).bind(row.bundle_id).bind(previous.task_revision).fetch_one(&mut **tx).await?
            };
            if enough_changes(changes, live) {
                Some("task-change")
            } else if previous.state == "failed" || previous.trigger != "retry" {
                Some("retry")
            } else {
                None
            }
        }
    } else {
        Some("start")
    };
    let capped:bool=sqlx::query_scalar("SELECT count(*) >= $3::integer FROM learning_rounds WHERE (project_id,bundle_id)=($1,$2) AND created_at>now()-interval '24 hours'").bind(&row.project_id).bind(row.bundle_id).bind(row.max_rounds_per_day).fetch_one(&mut **tx).await?;
    let waiting = if trigger.is_none() {
        Some("no-new-evidence")
    } else if capped {
        Some("daily-cap")
    } else {
        None
    };
    if row.waiting.as_deref() != waiting {
        sqlx::query("UPDATE learning_loops SET waiting=$3 WHERE (project_id,bundle_id)=($1,$2)")
            .bind(&row.project_id)
            .bind(row.bundle_id)
            .bind(waiting)
            .execute(&mut **tx)
            .await?;
    }
    Ok(trigger.filter(|_| waiting.is_none()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    base_url: String,
    allowed_models: Vec<String>,
    api_key: Option<String>,
}
pub(super) async fn provider(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
) -> Reply {
    let mut tx = auth::read_transaction(&s, &h, &p).await?;
    let row: Option<(String, Vec<String>, Value)> = sqlx::query_as(
        "SELECT base_url,allowed_models,verification FROM workspace_model_providers WHERE project_id=$1",
    )
    .bind(&p)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    Ok(Json(match row {
        Some((url, models, verification)) => {
            json!({"baseUrl":url,"allowedModels":models,"hasKey":true,"verification":verification})
        }
        None => {
            json!({"baseUrl":null,"allowedModels":[],"hasKey":false,"verification":{"status":"pending","checkedAt":null,"models":[]}})
        }
    }))
}
pub(super) async fn set_provider(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let (mut tx, a) = actor_tx(&s, &h, &p, "promote").await?;
    if a.user_id.is_none() {
        return Err(denied());
    }
    let input: Provider = parse(&body(raw)?)?;
    let key = std::env::var("ACCLIMATE_PROVIDER_ENCRYPTION_KEY")
        .ok()
        .and_then(|k| crate::executor::ProviderKey::from_hex(&k).ok())
        .ok_or_else(|| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "provider-unavailable",
                "Provider encryption unavailable",
            )
        })?;
    key.store_in(
        &mut tx,
        &p,
        &input.base_url,
        &input.allowed_models,
        input.api_key.as_deref(),
    )
    .await
    .map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidInput {
            invalid(e.to_string())
        } else {
            db(e)
        }
    })?;
    commands::audit_mutation(
        &mut tx,
        &a,
        &p,
        &format!("/v1/workspaces/{p}/model-provider"),
        &Uuid::new_v4().to_string(),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    let verification = json!({"status":"pending","checkedAt":null,"models":[]});
    Ok(Json(
        json!({"baseUrl":input.base_url,"allowedModels":input.allowed_models,"hasKey":true,"verification":verification}),
    ))
}
pub(super) async fn usage(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
) -> Reply {
    let b = path(&b)?;
    let mut tx = auth::read_transaction(&s, &h, &p).await?;
    require_loop(&mut tx, &p, b, false).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('day',day,'rounds',rounds,'rollouts',rollouts,'optimizerTokens',optimizer_tokens,'taskTokens',task_tokens,'judgeTokens',judge_tokens) FROM learning_usage WHERE (project_id,bundle_id)=($1,$2) ORDER BY day DESC").bind(p).bind(b).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(json!({"items":items})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rollback {
    round_id: Uuid,
    note: Option<String>,
}
pub(super) async fn rollback(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let b = path(&b)?;
    let (mut tx, a) = actor_tx(&s, &h, &p, "promote").await?;
    let row = require_loop(&mut tx, &p, b, true).await?;
    let request = body(raw)?;
    let input: Rollback = parse(&request)?;
    let command = DurableCommand::optional(&h, &p, b, "rollback", &a.principal, request)?;
    if let Some(cmd) = &command
        && let Some(receipt) = cmd
            .replay(&mut tx, || conflict("Idempotency key already used"))
            .await?
    {
        return Ok(Json(receipt));
    }
    restore(
        &mut tx,
        &row,
        input.round_id,
        &a.principal,
        input.note.as_deref(),
        false,
    )
    .await?;
    sqlx::query("UPDATE learning_loops SET alert=NULL WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&p)
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let row = require_loop(&mut tx, &p, b, false).await?;
    let result = loop_document(&mut tx, row, s.optimizer.is_some()).await?;
    audit(
        &mut tx,
        &a,
        &p,
        b,
        "/rollback",
        h.get("idempotency-key").and_then(|v| v.to_str().ok()),
    )
    .await?;
    DurableCommand::finish_optional(command, tx, result).await
}

pub(super) async fn restore(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: Uuid,
    actor: &str,
    note: Option<&str>,
    confirm: bool,
) -> ApiResult<bool> {
    let (channel,parent,adopted,revision):(String,Uuid,Option<Uuid>,i64)=sqlx::query_as("SELECT channel,parent_version_id,adopted_version_id,channel_revision FROM learning_rounds WHERE (project_id,bundle_id,id)=($1,$2,$3)").bind(&row.project_id).bind(row.bundle_id).bind(round).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(||missing("Learning round not found"))?;
    let stale = || {
        err(
            StatusCode::CONFLICT,
            "round-not-at-head",
            "The round has no adoption at the channel head",
        )
    };
    let adopted = adopted.ok_or_else(stale)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "promotion:{}:{}:{}",
            row.project_id, row.bundle_id, channel
        ))
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    let (head,current,digest):(Uuid,i64,String)=sqlx::query_as("SELECT c.version_id,c.revision,v.digest FROM channels c JOIN versions v ON v.id=c.version_id WHERE (c.project_id,c.bundle_id,c.name)=($1,$2,$3) FOR UPDATE OF c").bind(&row.project_id).bind(row.bundle_id).bind(&channel).fetch_one(&mut **tx).await.map_err(db)?;
    if confirm && (head != adopted || current != revision + 1) {
        return Ok(false);
    }
    if head != adopted {
        return Err(stale());
    }
    crate::channels::promote_in_tx(
        tx,
        &row.project_id,
        row.bundle_id,
        &channel,
        actor,
        crate::PromoteRequest {
            version_id: parent.to_string(),
            expected_revision: current.to_string(),
            unevaluated_reason: format!("Restore parent of learning round {round}"),
        },
    )
    .await?;
    sqlx::query("INSERT INTO learning_blocked_versions(project_id,bundle_id,digest,removed_by,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,bundle_id,digest) DO UPDATE SET removed_by=excluded.removed_by,note=excluded.note,created_at=now()").bind(&row.project_id).bind(row.bundle_id).bind(digest).bind(actor).bind(note).execute(&mut **tx).await.map_err(db)?;
    Ok(true)
}

#[derive(sqlx::FromRow)]
struct Measurement {
    score: f64,
    report: sqlx::types::Json<evaluations::Report>,
}
pub(super) const MAX_MEASUREMENT_RETRIES: i32 = 2;
const CLEAR_DROP: f64 = 0.10;
const MIN_FLIPS: usize = 2;
fn regression(parent: &Measurement, child: &Measurement) -> (bool, usize) {
    let passed: std::collections::HashSet<_> = parent
        .report
        .cases
        .iter()
        .filter(|c| evaluations::case_passes(c))
        .map(|c| &c.case_id)
        .collect();
    let flips = child
        .report
        .cases
        .iter()
        .filter(|c| passed.contains(&c.case_id) && !evaluations::case_passes(c))
        .count();
    (
        pass_rate(child) <= pass_rate(parent) - CLEAR_DROP + f64::EPSILON && flips >= MIN_FLIPS,
        flips,
    )
}
/// The share of rollouts that passed. A judged rollout's score gives partial credit, so a task
/// that starts missing one criterion moves the score a little and the pass rate a lot. The
/// regression control judges on the pass rate, as it did when a score was only pass or fail.
fn pass_rate(measurement: &Measurement) -> f64 {
    let cases = &measurement.report.cases;
    let rate = |case: &evaluations::CaseReport| {
        let passed = case.rollouts.iter().filter(|r| r["passed"] == true).count();
        passed as f64 / case.rollouts.len().max(1) as f64
    };
    cases.iter().map(rate).sum::<f64>() / cases.len().max(1) as f64
}
async fn measurement(
    tx: &mut Tx<'_>,
    round: Uuid,
    version: Uuid,
    kind: &str,
) -> Result<Option<Measurement>, sqlx::Error> {
    let existing:Option<(Uuid,String)>=sqlx::query_as("SELECT id,status FROM learning_evaluations WHERE round_id=$1 AND measurement=$2 AND role='retained'").bind(round).bind(kind).fetch_optional(&mut **tx).await?;
    match existing {
        Some((id, status)) if status == "scored" => Ok(Some(
            sqlx::query_as("SELECT score,report FROM learning_evaluations WHERE id=$1")
                .bind(id)
                .fetch_one(&mut **tx)
                .await?,
        )),
        Some((id, status)) if status == "failed" => {
            sqlx::query("UPDATE learning_rollouts SET status='queued',attempts=0,error_code=NULL,lease_token_hash=NULL WHERE evaluation_id=$1 AND status IN ('failed','cancelled')").bind(id).execute(&mut **tx).await?;
            sqlx::query("UPDATE learning_evaluations SET measurement_retries=measurement_retries+1,status='running',error=NULL,started_at=now() WHERE id=$1").bind(id).execute(&mut **tx).await?;
            Ok(None)
        }
        Some(_) => Ok(None),
        None => {
            let id=sqlx::query_scalar("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,measurement) SELECT gen_random_uuid(),$1,'retained','held_out',id,digest,$2 FROM versions WHERE id=$3 RETURNING id").bind(round).bind(kind).bind(version).fetch_one(&mut **tx).await?;
            crate::executor::queue_evaluation(tx, id).await?;
            Ok(None)
        }
    }
}
async fn clear_alert(tx: &mut Tx<'_>, row: &LoopRow) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE learning_loops SET alert=NULL WHERE (project_id,bundle_id)=($1,$2) AND alert IS NOT NULL").bind(&row.project_id).bind(row.bundle_id).execute(&mut **tx).await?;
    Ok(())
}
pub(super) async fn monitor(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: &RoundSummary,
) -> Result<bool, sqlx::Error> {
    let Some(adopted) = round.adopted_version_id else {
        clear_alert(tx, row).await?;
        return Ok(false);
    };
    let live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT FROM learning_rounds r JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(r.project_id,r.bundle_id,r.channel) WHERE r.id=$1 AND c.version_id=r.adopted_version_id AND c.revision=r.channel_revision+1)").bind(round.id).fetch_one(&mut **tx).await?;
    if !live {
        sqlx::query("WITH cancelled AS (UPDATE learning_evaluations SET status='cancelled',error='channel-moved' WHERE round_id=$1 AND measurement<>'initial' AND status IN ('queued','running') RETURNING id)
            UPDATE learning_rollouts SET status='cancelled',lease_token_hash=NULL WHERE evaluation_id IN (SELECT id FROM cancelled) AND status IN ('queued','running','grading')").bind(round.id).execute(&mut **tx).await?;
        clear_alert(tx, row).await?;
        return Ok(false);
    }
    let baseline:Option<Measurement>=sqlx::query_as("SELECT e.score,e.report FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id JOIN learning_rounds current ON current.id=$1
        WHERE (r.project_id,r.bundle_id,r.task_revision,r.runtime)=(current.project_id,current.bundle_id,current.task_revision,current.runtime)
        AND r.number<current.number AND e.version_id=current.parent_version_id AND e.role='retained' AND e.status='scored'
        ORDER BY r.number DESC,e.created_at DESC,e.id LIMIT 1").bind(round.id).fetch_optional(&mut **tx).await?;
    let parent = match baseline {
        Some(parent) => parent,
        None => {
            match measurement(tx, round.id, round.parent_version_id, "baseline-parent").await? {
                Some(parent) => parent,
                None => return Ok(true),
            }
        }
    };
    let child:Measurement=sqlx::query_as("SELECT score,report FROM learning_evaluations WHERE round_id=$1 AND role='retained' AND measurement='initial'").bind(round.id).fetch_one(&mut **tx).await?;
    let (previous_rate, rate) = (pass_rate(&parent), pass_rate(&child));
    if child.score >= parent.score && rate >= previous_rate {
        clear_alert(tx, row).await?;
        return Ok(false);
    }
    let (clear, flips) = regression(&parent, &child);
    let mut alert = json!({"roundId":round.id,"previousScore":parent.score,"score":child.score,"previousPassRate":previous_rate,"passRate":rate,"flippedTasks":flips,"reverted":false});
    let mut pending = false;
    if clear {
        let parent_check =
            measurement(tx, round.id, round.parent_version_id, "confirm-parent").await?;
        let adopted_check = measurement(tx, round.id, adopted, "confirm-adoption").await?;
        pending = parent_check.is_none() || adopted_check.is_none();
        if let (Some(p), Some(a)) = (parent_check, adopted_check) {
            sqlx::query("UPDATE learning_rounds SET confirmed_parent_score=$2,confirmed_adoption_score=$3 WHERE id=$1").bind(round.id).bind(p.score).bind(a.score).execute(&mut **tx).await?;
            if regression(&p, &a).0 {
                let restored = restore(tx, row, round.id, "service:learning-loop", None, true)
                    .await
                    .map_err(|e| optimizer::invariant(e.2))?;
                alert["reverted"] = json!(restored);
                sqlx::query("UPDATE learning_rounds SET reverted=$2 WHERE id=$1")
                    .bind(round.id)
                    .bind(restored)
                    .execute(&mut **tx)
                    .await?;
            }
            sqlx::query("INSERT INTO learning_alert_deliveries(round_id,user_id,previous_score,score,flipped_tasks)
                SELECT $1,u.id,$2,$3,$4 FROM project_memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=$5 AND m.role='admin' AND u.email_verified ON CONFLICT DO NOTHING")
                .bind(round.id).bind(previous_rate).bind(rate).bind(flips as i32).bind(&row.project_id).execute(&mut **tx).await?;
        }
    }
    sqlx::query("UPDATE learning_loops SET alert=$3 WHERE (project_id,bundle_id)=($1,$2) AND alert IS DISTINCT FROM $3").bind(&row.project_id).bind(row.bundle_id).bind(alert).execute(&mut **tx).await?;
    Ok(pending)
}

pub(super) async fn blocked(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
) -> Reply {
    let b = path(&b)?;
    let mut tx = auth::read_transaction(&s, &h, &p).await?;
    require_loop(&mut tx, &p, b, false).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('digest',digest,'removedBy',removed_by,'note',note,'createdAt',created_at) FROM learning_blocked_versions WHERE (project_id,bundle_id)=($1,$2) ORDER BY created_at DESC,digest").bind(p).bind(b).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(json!(rows)))
}
pub(super) async fn unblock(
    State(s): State<AppState>,
    Path((p, b, digest)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<StatusCode> {
    let b = path(&b)?;
    let (mut tx, a) = actor_tx(&s, &h, &p, "promote").await?;
    require_loop(&mut tx, &p, b, true).await?;
    let removed = sqlx::query(
        "DELETE FROM learning_blocked_versions WHERE (project_id,bundle_id,digest)=($1,$2,$3)",
    )
    .bind(&p)
    .bind(b)
    .bind(&digest)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if removed.rows_affected() == 0 {
        return Err(missing("Blocked version not found"));
    }
    audit(
        &mut tx,
        &a,
        &p,
        b,
        &format!("/blocked-versions/{digest}"),
        None,
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_change_requires_both_thresholds() {
        assert!(!enough_changes(4, 20));
        assert!(!enough_changes(5, 51));
        assert!(enough_changes(5, 50));
    }

    /// Twenty judged tasks with four criteria. `partial` of them miss one criterion on every
    /// rollout, so they fail and still score 0.75.
    fn held_out(partial: usize) -> Measurement {
        let cases: Vec<_> = (0..20)
            .map(|i| {
                let (passed, score) = if i < partial {
                    (false, 0.75)
                } else {
                    (true, 1.0)
                };
                evaluations::CaseReport {
                    case_id: format!("task-{i}"),
                    rollouts: vec![json!({"score":score,"passed":passed}); 5],
                }
            })
            .collect();
        Measurement {
            score: 1.0 - 0.25 * partial as f64 / 20.0,
            report: sqlx::types::Json(evaluations::Report { cases }),
        }
    }

    #[test]
    fn revert_judges_on_passing_tasks_not_on_partial_credit() {
        let (parent, child) = (held_out(0), held_out(6));
        // Six tasks stopped passing. Partial credit moves the score by less than the threshold.
        assert!(parent.score - child.score < CLEAR_DROP);
        assert!((pass_rate(&parent) - pass_rate(&child) - 0.3).abs() < 1e-9);
        assert_eq!(regression(&parent, &child), (true, 6));
        // One task is below both limits, and no change is no regression.
        assert_eq!(regression(&parent, &held_out(1)), (false, 1));
        assert_eq!(regression(&parent, &held_out(0)), (false, 0));
    }
}
