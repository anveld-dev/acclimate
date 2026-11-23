use crate::{
    ApiResult, AppState, auth,
    commands::{self, DurableCommand},
    db, err, path,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

mod controls;
mod evaluations;
mod history;
pub(crate) mod imports;
mod memory;
pub(super) mod optimizer;
mod outcomes;
pub(crate) mod tasks;
pub(crate) mod trial_work;
pub(crate) mod worker;

type Tx<'a> = Transaction<'a, Postgres>;
type Body = Result<Json<Value>, JsonRejection>;
type Reply = ApiResult<Json<Value>>;
const PREFIX: &str = "/v1/workspaces/{project}/bundles/{bundle}/learning";
pub(super) const IMPORT_ROUTE: &str =
    "/v1/workspaces/{project}/bundles/{bundle}/learning/tasks/import";
const ACTIVE_ROUND_STATES: &[&str] = &[
    "scoring_incumbent",
    "proposing",
    "screening",
    "evaluating",
    "selecting",
    "scoring_held_out",
];

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            &format!("{PREFIX}/tasks"),
            get(tasks::list).post(tasks::create),
        )
        .route(
            &format!("{PREFIX}/tasks/{{id}}"),
            axum::routing::patch(tasks::edit).delete(tasks::retire),
        )
        .route(&format!("{PREFIX}/tasks/confirm"), post(tasks::confirm))
        .route(&format!("{PREFIX}/tasks/recheck"), post(tasks::recheck_all))
        .route(
            &format!("{PREFIX}/tasks/{{id}}/recheck"),
            post(tasks::recheck),
        )
        .route(
            &format!("{PREFIX}/tasks/{{id}}/try"),
            post(trial_work::try_task),
        )
        .route(&format!("{PREFIX}/trials/{{id}}"), get(trial_work::read))
        .route(
            &format!("{PREFIX}/tasks/imports/{{id}}"),
            get(trial_work::import_status),
        )
        .route(IMPORT_ROUTE, post(imports::upload))
        .route(
            &format!("{PREFIX}/held-out-tasks/export"),
            get(tasks::export),
        )
        .route(
            "/v1/workspaces/{project}/model-provider",
            get(controls::provider).put(controls::set_provider),
        )
        .route(&format!("{PREFIX}/usage"), get(controls::usage))
        .route(
            &format!("{PREFIX}/blocked-versions"),
            get(controls::blocked),
        )
        .route(
            &format!("{PREFIX}/blocked-versions/{{digest}}"),
            axum::routing::delete(controls::unblock),
        )
        .route(&format!("{PREFIX}/rollback"), post(controls::rollback))
        .route(&format!("{PREFIX}/start"), post(start))
        .route(PREFIX, get(inspect).put(enroll))
        .route(&format!("{PREFIX}/pause"), post(pause))
        .route(&format!("{PREFIX}/resume"), post(resume))
        .route(&format!("{PREFIX}/stop"), post(stop))
        .route(&format!("{PREFIX}/rounds"), get(list_rounds))
        .route(&format!("{PREFIX}/rounds/{{round}}"), get(get_round))
        .route(
            &format!("{PREFIX}/outcomes"),
            post(outcomes::submit_outcome),
        )
        .route(&format!("{PREFIX}/memory"), get(memory::get))
}

fn invalid(message: impl Into<String>) -> crate::ApiErr {
    err(StatusCode::BAD_REQUEST, "invalid_content", message)
}
fn missing(message: &str) -> crate::ApiErr {
    err(StatusCode::NOT_FOUND, "not_found", message)
}
fn conflict(message: &str) -> crate::ApiErr {
    err(StatusCode::CONFLICT, "learning_conflict", message)
}
fn denied() -> crate::ApiErr {
    err(
        StatusCode::FORBIDDEN,
        "denied",
        "This operation requires a signed-in workspace member",
    )
}
fn body(raw: Body) -> ApiResult<Value> {
    let Json(value) = raw.map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "Request exceeds 2MiB",
            )
        } else {
            invalid("Expected a valid JSON request body")
        }
    })?;
    Ok(value)
}
fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> ApiResult<T> {
    if !value.is_object() {
        return Err(invalid("Expected a JSON object"));
    }
    serde_json::from_value(value.clone()).map_err(|_| invalid("Invalid learning request fields"))
}
fn positive_setting(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

#[derive(FromRow)]
struct LoopRow {
    project_id: String,
    bundle_id: Uuid,
    status: String,
    pause_reason: Option<String>,
    channel: String,
    setting: Value,
    memory_revision: i64,
    task_revision: i64,
    task_model: Option<String>,
    judge_model: Option<String>,
    max_rounds_per_day: i32,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    resumed_at: Option<chrono::DateTime<chrono::Utc>>,
    waiting: Option<String>,
    alert: Option<Value>,
    next_round: i32,
    failed_rounds: i32,
    enrolled_by: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

async fn find_loop(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    lock: bool,
) -> Result<Option<LoopRow>, sqlx::Error> {
    let query = if lock {
        "SELECT * FROM learning_loops WHERE (project_id,bundle_id)=($1,$2) FOR UPDATE"
    } else {
        "SELECT * FROM learning_loops WHERE (project_id,bundle_id)=($1,$2)"
    };
    sqlx::query_as(query)
        .bind(project)
        .bind(bundle)
        .fetch_optional(&mut **tx)
        .await
}
async fn require_loop(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    lock: bool,
) -> ApiResult<LoopRow> {
    find_loop(tx, project, bundle, lock)
        .await
        .map_err(db)?
        .ok_or_else(|| missing("Learning loop not enrolled"))
}
async fn actor_tx<'a>(
    s: &'a AppState,
    h: &HeaderMap,
    project: &str,
    right: &str,
) -> ApiResult<(Tx<'a>, auth::Actor)> {
    let actor = auth::actor(h, s, project, right)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    let right = if right == "promote" && actor.user_id.is_some() {
        "admin"
    } else {
        right
    };
    auth::authorize_transaction(&mut tx, &actor, project, right).await?;
    Ok((tx, actor))
}
async fn audit(
    tx: &mut Tx<'_>,
    actor: &auth::Actor,
    project: &str,
    bundle: Uuid,
    suffix: &str,
    key: Option<&str>,
) -> ApiResult<()> {
    let route = format!("/v1/workspaces/{project}/bundles/{bundle}/learning{suffix}");
    let key = key
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    commands::audit_mutation(tx, actor, project, &route, &key).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    channel: String,
    task_model: String,
    judge_model: String,
    max_rounds_per_day: Option<i32>,
    setting: Setting,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Setting {
    domain: String,
    benchmark: String,
    #[serde(default)]
    policy_model: String,
}
async fn enroll(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
    raw: Body,
) -> Reply {
    let bundle = path(&bundle)?;
    let (mut tx, actor) = actor_tx(&s, &h, &project, "promote").await?;
    let mut request = body(raw)?;
    let mut input: Enrollment = parse(&request)?;

    if input.max_rounds_per_day.is_some_and(|v| v < 1) {
        return Err(invalid("Daily round cap must be positive"));
    }
    let allowed: Option<Vec<String>> = sqlx::query_scalar(
        "SELECT allowed_models FROM workspace_model_providers WHERE project_id=$1 FOR SHARE",
    )
    .bind(&project)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    if input.task_model == input.judge_model
        || !allowed.is_some_and(|m| m.contains(&input.task_model) && m.contains(&input.judge_model))
    {
        return Err(invalid("Choose two different allowed provider models"));
    }
    input.setting.policy_model.clone_from(&input.task_model);
    request["setting"]["policyModel"] = json!(input.task_model);
    if !request["setting"].is_object()
        || !crate::channels::valid_channel(&input.channel)
        || [
            &input.setting.domain,
            &input.setting.benchmark,
            &input.setting.policy_model,
        ]
        .iter()
        .any(|s| s.trim().is_empty() || s.len() > 256 || s.chars().any(char::is_control))
    {
        return Err(invalid("Invalid learning enrollment"));
    }
    let command = DurableCommand::optional(
        &h,
        &project,
        bundle,
        "enroll",
        &actor.principal,
        request.clone(),
    )?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM bundles WHERE (project_id,id)=($1,$2))")
            .bind(&project)
            .bind(bundle)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    if !exists {
        return Err(missing("Bundle not found"));
    }

    let existing = find_loop(&mut tx, &project, bundle, true)
        .await
        .map_err(db)?;
    let head: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM channels WHERE (project_id,bundle_id,name)=($1,$2,$3))",
    )
    .bind(&project)
    .bind(bundle)
    .bind(&input.channel)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if !head {
        return Err(invalid("Release a version on the learning channel first"));
    }
    if existing.is_none() {
        sqlx::query("INSERT INTO learning_loops(project_id,bundle_id,channel,setting,enrolled_by,status,pause_reason)
                     VALUES($1,$2,$3,$4,$5,'paused','operator') ON CONFLICT DO NOTHING")
            .bind(&project).bind(bundle).bind(&input.channel).bind(&request["setting"]).bind(&actor.principal)
            .execute(&mut *tx).await.map_err(db)?;
    }
    let row = match existing {
        Some(row) => row,
        None => require_loop(&mut tx, &project, bundle, true).await?,
    };
    if let Some(command) = &command
        && let Some(receipt) = command
            .replay(&mut tx, || conflict("Idempotency key already used"))
            .await?
    {
        return Ok(Json(receipt));
    }
    let moves_work = row.channel != input.channel;
    if moves_work
        && active_round(&mut tx, &project, bundle)
            .await
            .map_err(db)?
            .is_some()
    {
        return Err(conflict("Pause the loop and let the round end first"));
    }
    if moves_work || row.setting != request["setting"] || row.status == "stopped" {
        sqlx::query("UPDATE learning_loops SET channel=$3,setting=$4,enrolled_by=$5,updated_at=now() WHERE (project_id,bundle_id)=($1,$2)")
            .bind(&project).bind(bundle).bind(&input.channel).bind(&request["setting"]).bind(&actor.principal)
            .execute(&mut *tx).await.map_err(db)?;
    }
    sqlx::query("UPDATE learning_loops SET task_model=$3,judge_model=$4,max_rounds_per_day=coalesce($5,max_rounds_per_day) WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&project).bind(bundle).bind(input.task_model).bind(input.judge_model).bind(input.max_rounds_per_day).execute(&mut *tx).await.map_err(db)?;
    let row = require_loop(&mut tx, &project, bundle, false).await?;
    let result = loop_document(&mut tx, row, s.optimizer.is_some()).await?;
    audit(
        &mut tx,
        &actor,
        &project,
        bundle,
        "",
        h.get("idempotency-key").and_then(|v| v.to_str().ok()),
    )
    .await?;
    DurableCommand::finish_optional(command, tx, result).await
}

macro_rules! status_route {
    ($name:ident) => {
        async fn $name(
            State(s): State<AppState>,
            Path((project, bundle)): Path<(String, String)>,
            h: HeaderMap,
        ) -> Reply {
            change_status(&s, &project, path(&bundle)?, &h, stringify!($name)).await
        }
    };
}
status_route!(start);
status_route!(pause);
status_route!(resume);
status_route!(stop);

async fn change_status(
    s: &AppState,
    project: &str,
    bundle: Uuid,
    h: &HeaderMap,
    operation: &str,
) -> Reply {
    let (mut tx, actor) = actor_tx(s, h, project, "promote").await?;
    let row = require_loop(&mut tx, project, bundle, true).await?;
    let command =
        DurableCommand::optional(h, project, bundle, operation, &actor.principal, Value::Null)?;
    if let Some(command) = &command
        && let Some(receipt) = command
            .replay(&mut tx, || conflict("Idempotency key already used"))
            .await?
    {
        return Ok(Json(receipt));
    }
    if operation == "resume"
        && (row.started_at.is_none() || row.pause_reason.as_deref() == Some("tasks-required"))
    {
        return Err(conflict("Use Start after adding admitted tasks"));
    }
    if operation == "start" || operation == "resume" {
        if !controls::ready(&mut tx, &row).await.map_err(db)? {
            return Err(err(
                StatusCode::CONFLICT,
                "tasks-required",
                "At least 20 admitted tasks in each split are required",
            ));
        }
        let verification: Option<String> = sqlx::query_scalar(
            "SELECT verification->>'status' FROM workspace_model_providers WHERE project_id=$1 FOR SHARE"
        ).bind(project).fetch_optional(&mut *tx).await.map_err(db)?;
        if verification.as_deref() != Some("verified") {
            return Err(conflict(
                "Verify the workspace model provider before starting",
            ));
        }
        if row.task_model.is_none() || row.judge_model.is_none() {
            return Err(conflict(
                "Configure the task and judge models before starting",
            ));
        }
        if s.optimizer.is_none() {
            return Err(err(
                StatusCode::CONFLICT,
                "optimizer-required",
                "The service has no optimizer model. Set ACCLIMATE_MODEL_ENDPOINT, ACCLIMATE_MODEL_TOKEN and ACCLIMATE_MODEL and restart it",
            ));
        }
        sqlx::query("UPDATE learning_loops SET started_at=coalesce(started_at,now()) WHERE (project_id,bundle_id)=($1,$2)").bind(project).bind(bundle).execute(&mut *tx).await.map_err(db)?;
    }
    let (status, reason) = match (operation, row.status.as_str()) {
        ("pause" | "resume", "stopped") => {
            return Err(conflict("Use Start to restart a stopped loop"));
        }
        ("pause", "running") => ("paused", Some("operator")),
        ("start", _) | ("resume", "paused") => ("running", None),
        ("stop", "running" | "paused") => {
            if let Some(round) = active_round(&mut tx, project, bundle).await.map_err(db)? {
                worker::stop_round(&mut tx, round.id).await.map_err(db)?;
            }
            ("stopped", None)
        }
        _ => (row.status.as_str(), row.pause_reason.as_deref()),
    };
    if status != row.status {
        sqlx::query("UPDATE learning_loops SET status=$3,pause_reason=$4,updated_at=now(),waiting=NULL,resumed_at=CASE WHEN $3='running' THEN now() ELSE resumed_at END,
                      failed_rounds=CASE WHEN $3='running' THEN 0 ELSE failed_rounds END WHERE (project_id,bundle_id)=($1,$2)")
            .bind(project).bind(bundle).bind(status).bind(reason).execute(&mut *tx).await.map_err(db)?;
    }
    let row = require_loop(&mut tx, project, bundle, false).await?;
    let result = loop_document(&mut tx, row, s.optimizer.is_some()).await?;
    audit(
        &mut tx,
        &actor,
        project,
        bundle,
        &format!("/{operation}"),
        h.get("idempotency-key").and_then(|v| v.to_str().ok()),
    )
    .await?;
    DurableCommand::finish_optional(command, tx, result).await
}

#[derive(FromRow, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundSummary {
    id: Uuid,
    number: i32,
    state: String,
    decision: Option<String>,
    #[sqlx(rename = "public_reason")]
    reason: Option<String>,
    parent_version_id: Uuid,
    diff: Option<Value>,
    diagnosis: Option<Value>,
    evolve_score: Option<f64>,
    adopted_sample: Option<i16>,
    adopted_version_id: Option<Uuid>,
    incumbent_score: Option<f64>,
    held_out_score: Option<f64>,
    confirmed_parent_score: Option<f64>,
    confirmed_adoption_score: Option<f64>,
    reverted: bool,
    progress: Value,
    #[serde(serialize_with = "serialize_held_out_error")]
    held_out_error: Option<String>,
    trigger: String,
    incumbent_reused: bool,
    task_model: Option<String>,
    judge_model: Option<String>,
    task_revision: i64,
    created_at: chrono::DateTime<chrono::Utc>,
    ended_at: Option<chrono::DateTime<chrono::Utc>>,
}

fn serialize_held_out_error<S: serde::Serializer>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(
        &value.as_deref().map(evaluations::safe_held_out_error),
        serializer,
    )
}

const ROUND_SELECT:&str="SELECT r.*,CASE WHEN r.held_out_error='no-matching-executor' THEN r.held_out_error ELSE r.reason END AS public_reason,(SELECT jsonb_build_object('scored',count(*) FILTER(WHERE l.status='scored'),'total',count(*)) FROM learning_evaluations e JOIN learning_rollouts l ON l.evaluation_id=e.id WHERE e.round_id=r.id) AS progress,c.changes AS diff,c.diagnosis,coalesce(c.evolve_score,r.incumbent_score) AS evolve_score
    FROM learning_rounds r LEFT JOIN learning_candidates c ON (c.round_id,c.sample)=(r.id,r.adopted_sample)";
async fn active_round(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
) -> Result<Option<RoundSummary>, sqlx::Error> {
    sqlx::query_as(&format!(
        "{ROUND_SELECT} WHERE (r.project_id,r.bundle_id)=($1,$2) AND r.state=ANY($3)"
    ))
    .bind(project)
    .bind(bundle)
    .bind(ACTIVE_ROUND_STATES)
    .fetch_optional(&mut **tx)
    .await
}

async fn summaries(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    before: Option<i32>,
    limit: i64,
) -> ApiResult<Vec<RoundSummary>> {
    sqlx::query_as(&format!("{ROUND_SELECT} WHERE (r.project_id,r.bundle_id)=($1,$2) AND ($3::int IS NULL OR number<$3) ORDER BY number DESC LIMIT $4"))
    .bind(project)
    .bind(bundle)
    .bind(before)
    .bind(limit)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)
}

async fn loop_document(
    tx: &mut Tx<'_>,
    row: LoopRow,
    optimizer_configured: bool,
) -> ApiResult<Value> {
    let project = &row.project_id;
    let bundle = row.bundle_id;
    let active = active_round(tx, project, bundle).await.map_err(db)?;
    let recent = summaries(tx, project, bundle, None, 10).await?;
    let (e, h) = controls::counts(tx, project, bundle).await.map_err(db)?;
    Ok(json!({
        "taskModel":row.task_model,"judgeModel":row.judge_model,"taskRevision":row.task_revision,
        "maxRoundsPerDay":row.max_rounds_per_day,"waiting":row.waiting,"alert":row.alert,
        "admittedEvolve":e,"admittedHeldOut":h,"optimizerConfigured":optimizer_configured,
        "workspaceId": project, "bundleId": bundle, "status": row.status, "pauseReason": row.pause_reason,
        "channel": row.channel, "setting": row.setting,
        "memoryRevision": row.memory_revision,
        "nextRound": row.next_round, "failedRounds": row.failed_rounds, "enrolledBy": row.enrolled_by,
        "createdAt": row.created_at, "updatedAt": row.updated_at, "activeRound": active, "rounds": recent
    }))
}

async fn inspect(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
) -> Reply {
    let bundle = path(&bundle)?;
    let mut tx = auth::read_transaction(&s, &h, &project).await?;
    let row = require_loop(&mut tx, &project, bundle, false).await?;
    Ok(Json(
        loop_document(&mut tx, row, s.optimizer.is_some()).await?,
    ))
}

#[derive(Deserialize)]
struct RoundPage {
    before: Option<i32>,
    limit: Option<i64>,
}
async fn list_rounds(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
    query: Result<Query<RoundPage>, axum::extract::rejection::QueryRejection>,
) -> Reply {
    let Query(query) = query.map_err(|_| invalid("Invalid round page"))?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) || query.before.is_some_and(|n| n < 1) {
        return Err(invalid("Invalid round page"));
    }
    let bundle = path(&bundle)?;
    let mut tx = auth::read_transaction(&s, &h, &project).await?;
    require_loop(&mut tx, &project, bundle, false).await?;
    let mut items = summaries(&mut tx, &project, bundle, query.before, limit + 1).await?;
    let has_more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = items.last().filter(|_| has_more).map(|row| row.number);
    Ok(Json(json!({"items":items, "next":next})))
}

#[derive(Deserialize)]
struct RoundDetail {
    evaluation: Option<String>,
}

async fn get_round(
    State(s): State<AppState>,
    Path((project, bundle, round)): Path<(String, String, String)>,
    h: HeaderMap,
    Query(query): Query<RoundDetail>,
) -> Reply {
    use sqlx::Row;
    let (bundle, round) = (path(&bundle)?, path(&round)?);
    let requested = query.evaluation.as_deref().map(path).transpose()?;
    let mut tx = auth::read_transaction(&s, &h, &project).await?;
    let row = sqlx::query(&format!(
        "{ROUND_SELECT} WHERE (r.project_id,r.bundle_id,r.id)=($1,$2,$3)"
    ))
    .bind(&project)
    .bind(bundle)
    .bind(round)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| missing("Learning round not found"))?;
    let evals = evaluations::round_documents(&mut tx, &project, bundle, round, requested).await?;
    let mut result = serde_json::to_value(RoundSummary::from_row(&row).map_err(db)?).map_err(db)?;
    let pins = json!({
        "channel": row.get::<String,_>("channel"), "channelRevision": row.get::<i64,_>("channel_revision").to_string(),
        "evolveRevision": row.get::<i64,_>("task_revision"), "memoryRevision": row.get::<i64,_>("memory_revision"),
        "memoryDigest": row.get::<Option<String>,_>("memory_digest"), "historyDigest": row.get::<Option<String>,_>("history_digest"),
        "setting": row.get::<Value,_>("setting"),
        "optimizerModel": row.get::<Option<String>,_>("optimizer_model"),
        "optimizerReasoningEffort": row.get::<Option<String>,_>("optimizer_reasoning_effort"), "selection": row.get::<Option<Value>,_>("selection"),
        "candidates": optimizer::candidates(&mut tx, round).await.map_err(db)?, "evaluations": evals
    });
    result
        .as_object_mut()
        .unwrap()
        .extend(pins.as_object().unwrap().clone());
    Ok(Json(result))
}
