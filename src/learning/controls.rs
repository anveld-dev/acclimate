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
            if changes >= MIN_CHANGED && changes * 100 >= live * CHANGE_PERCENT {
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
    api_key: String,
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
        &input.api_key,
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
    let input: Rollback = parse(&body(raw)?)?;
    restore(
        &mut tx,
        &row,
        input.round_id,
        &a.principal,
        input.note.as_deref(),
        false,
    )
    .await?;
    let result = loop_document(&mut tx, row).await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(result))
}

pub(super) async fn restore(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: Uuid,
    actor: &str,
    note: Option<&str>,
    confirm: bool,
) -> ApiResult<()> {
    let (channel,parent,adopted,revision):(String,Uuid,Uuid,i64)=sqlx::query_as("SELECT channel,parent_version_id,adopted_version_id,channel_revision FROM learning_rounds WHERE (project_id,bundle_id,id)=($1,$2,$3) AND decision='adopted'").bind(&row.project_id).bind(row.bundle_id).bind(round).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(||missing("Adopted round not found"))?;
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
        return Ok(());
    }
    if head == parent {
        return Ok(());
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
    sqlx::query("INSERT INTO learning_blocked_versions(project_id,bundle_id,digest,removed_by,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(&row.project_id).bind(row.bundle_id).bind(digest).bind(actor).bind(note).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Measurement {
    score: f64,
    report: sqlx::types::Json<evaluations::Report>,
}
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
        child.score <= parent.score - CLEAR_DROP + f64::EPSILON && flips >= MIN_FLIPS,
        flips,
    )
}
/// Returns true while an independent confirmation is outstanding.
pub(super) async fn monitor(
    tx: &mut Tx<'_>,
    row: &LoopRow,
    round: &RoundSummary,
) -> Result<bool, sqlx::Error> {
    #[derive(FromRow)]
    struct Baseline {
        version_id: Uuid,
        #[sqlx(flatten)]
        measurement: Measurement,
    }
    let baseline: Option<Baseline> = sqlx::query_as(
        "SELECT e.version_id,e.score,e.report FROM learning_evaluations e
         JOIN learning_rounds r ON r.id=e.round_id JOIN learning_rounds current ON current.id=$1
         WHERE (r.project_id,r.bundle_id)=(current.project_id,current.bundle_id)
           AND r.number<current.number AND r.task_revision=current.task_revision AND r.runtime=current.runtime
           AND e.role='retained' AND e.measurement='initial' AND e.status='scored'
         ORDER BY r.number DESC LIMIT 1",
    )
    .bind(round.id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(baseline) = baseline else {
        return Ok(false);
    };
    let parent = baseline.measurement;
    let child:Measurement=sqlx::query_as("SELECT score,report FROM learning_evaluations WHERE round_id=$1 AND role='retained' AND measurement='initial'").bind(round.id).fetch_one(&mut **tx).await?;
    if child.score >= parent.score {
        return Ok(false);
    }
    let (clear, flips) = regression(&parent, &child);
    let alert = json!({"roundId":round.id,"previousScore":parent.score,"score":child.score,"flippedTasks":flips});
    let changed=sqlx::query("UPDATE learning_loops SET alert=$3 WHERE (project_id,bundle_id)=($1,$2) AND alert IS DISTINCT FROM $3").bind(&row.project_id).bind(row.bundle_id).bind(alert).execute(&mut **tx).await?;
    if changed.rows_affected() > 0 {
        sqlx::query("INSERT INTO learning_alert_deliveries(round_id,user_id,previous_score,score,flipped_tasks)
            SELECT $1,u.id,$2,$3,$4 FROM project_memberships m JOIN users u ON u.id=m.user_id
            WHERE m.project_id=$5 AND m.role='admin' AND u.email_verified ON CONFLICT DO NOTHING")
            .bind(round.id).bind(parent.score).bind(child.score).bind(flips as i32).bind(&row.project_id)
            .execute(&mut **tx).await?;
    }
    let Some(adopted) = round
        .adopted_version_id
        .filter(|_| clear && round.parent_version_id == baseline.version_id)
    else {
        return Ok(false);
    };
    let mut measurements = Vec::new();
    for (kind, version) in [
        ("confirm-parent", round.parent_version_id),
        ("confirm-adoption", adopted),
    ] {
        let result:Option<(String,Option<f64>,sqlx::types::Json<evaluations::Report>)>=sqlx::query_as("SELECT status,score,report FROM learning_evaluations WHERE round_id=$1 AND measurement=$2").bind(round.id).bind(kind).fetch_optional(&mut **tx).await?;
        match result {
            Some((_, Some(score), report)) => measurements.push(Measurement { score, report }),
            Some((status, ..)) => return Ok(matches!(status.as_str(), "queued" | "running")),
            None => {
                let id = sqlx::query_scalar("INSERT INTO learning_evaluations(id,round_id,role,split,version_id,digest,measurement) SELECT gen_random_uuid(),$1,'retained','held_out',id,digest,$2 FROM versions WHERE id=$3 RETURNING id").bind(round.id).bind(kind).bind(version).fetch_one(&mut **tx).await?;
                crate::executor::queue_evaluation(tx, id).await?;
                return Ok(true);
            }
        }
    }
    sqlx::query("UPDATE learning_rounds SET confirmed_parent_score=$2,confirmed_adoption_score=$3 WHERE id=$1")
        .bind(round.id).bind(measurements[0].score).bind(measurements[1].score).execute(&mut **tx).await?;
    if regression(&measurements[0], &measurements[1]).0 {
        restore(tx, row, round.id, "service:learning-loop", None, true)
            .await
            .map_err(|e| optimizer::invariant(e.2))?;
    }
    Ok(false)
}
