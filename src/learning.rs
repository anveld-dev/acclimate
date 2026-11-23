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
mod evolve;
mod history;
pub(crate) mod imports;
mod memory;
pub(super) mod optimizer;
pub(crate) mod tasks;
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
        .route(&format!("{PREFIX}/rollback"), post(controls::rollback))
        .route(&format!("{PREFIX}/start"), post(start))
        .route(PREFIX, get(inspect).put(enroll))
        .route(&format!("{PREFIX}/pause"), post(pause))
        .route(&format!("{PREFIX}/resume"), post(resume))
        .route(&format!("{PREFIX}/stop"), post(stop))
        .route(&format!("{PREFIX}/rounds"), get(list_rounds))
        .route(&format!("{PREFIX}/rounds/{{round}}"), get(get_round))
        .route(
            &format!("{PREFIX}/evolve-cases"),
            get(evolve::list_cases).post(evolve::submit_cases),
        )
        .route(&format!("{PREFIX}/outcomes"), post(evolve::submit_outcome))
        .route(&format!("{PREFIX}/memory"), get(memory::get))
        .route(&format!("{PREFIX}/work"), get(evaluations::work))
        .route(
            &format!("{PREFIX}/evaluations/{{evaluation}}/start"),
            post(evaluations::start),
        )
        .route(
            &format!("{PREFIX}/evaluations/{{evaluation}}/report"),
            post(evaluations::report),
        )
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
        "This operation requires a different learning principal",
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
fn valid_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
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
    app_principal: String,
    setting: Value,
    held_out: Value,
    evolve_revision: i64,
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
fn require_app(actor: &auth::Actor, principal: &str) -> ApiResult<()> {
    if actor.user_id.is_some() || actor.principal != principal {
        return Err(denied());
    }
    Ok(())
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
    #[serde(default)]
    app_principal_id: String,
    task_model: Option<String>,
    judge_model: Option<String>,
    max_rounds_per_day: Option<i32>,
    setting: Setting,
    held_out: Option<HeldOut>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Setting {
    domain: String,
    benchmark: String,
    #[serde(default)]
    policy_model: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HeldOut {
    digest: String,
    cases: i32,
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
    let central = input.task_model.is_some();
    if input.task_model.is_some() != input.judge_model.is_some()
        || input.max_rounds_per_day.is_some_and(|v| v < 1)
    {
        return Err(invalid("Supply both models and a positive daily cap"));
    }
    if let (Some(task), Some(judge)) = (&input.task_model, &input.judge_model) {
        let allowed: Option<Vec<String>> = sqlx::query_scalar(
            "SELECT allowed_models FROM workspace_model_providers WHERE project_id=$1 FOR SHARE",
        )
        .bind(&project)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if task == judge || !allowed.is_some_and(|m| m.contains(task) && m.contains(judge)) {
            return Err(invalid("Choose two different allowed provider models"));
        }
        input.setting.policy_model = task.clone();
        request["setting"]["policyModel"] = json!(task);
    }
    if input.held_out.is_none() && central {
        request["heldOut"] = json!({});
    }
    if !request["setting"].is_object()
        || !request["heldOut"].is_object()
        || !crate::channels::valid_channel(&input.channel)
        || (!central && input.app_principal_id.is_empty())
        || input.app_principal_id.len() > 1024
        || [
            &input.setting.domain,
            &input.setting.benchmark,
            &input.setting.policy_model,
        ]
        .iter()
        .any(|s| s.trim().is_empty() || s.len() > 256 || s.chars().any(char::is_control))
        || input.held_out.as_ref().map_or(!central, |held| {
            !valid_digest(&held.digest) || !(1..=10_000).contains(&held.cases)
        })
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

    // Check machine authority before acquiring the loop lock, in the same order as app mutations.
    let grant = s.grants.iter().any(|g| {
        g.project_id == project
            && g.principal_id == input.app_principal_id
            && auth::rights_allow(&g.rights, "evaluate")
    });
    if !grant && !input.app_principal_id.is_empty() {
        let machine: Option<Vec<String>> = sqlx::query_scalar("SELECT rights FROM machine_tokens WHERE (project_id,principal_id)=($1,$2) AND revoked_at IS NULL AND expires_at>now() FOR SHARE")
            .bind(&project).bind(&input.app_principal_id).fetch_optional(&mut *tx).await.map_err(db)?;
        if !machine.is_some_and(|rights| auth::rights_allow(&rights, "evaluate")) {
            return Err(invalid(
                "The app principal requires evaluate on this workspace",
            ));
        }
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
        sqlx::query("INSERT INTO learning_loops(project_id,bundle_id,channel,app_principal,setting,held_out,enrolled_by,status,pause_reason)
                     VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN 'paused' ELSE 'running' END,CASE WHEN $8 THEN 'operator' END) ON CONFLICT(project_id,bundle_id) DO NOTHING")
            .bind(&project).bind(bundle).bind(&input.channel).bind(&input.app_principal_id)
            .bind(&request["setting"]).bind(&request["heldOut"]).bind(&actor.principal).bind(central)
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
    if let Some(task) = row.task_model.as_ref().filter(|_| !central) {
        request["setting"]["policyModel"] = json!(task)
    }
    if central && request.get("appPrincipalId").is_none() {
        input.app_principal_id.clone_from(&row.app_principal);
    }
    if central && input.held_out.is_none() {
        request["heldOut"] = row.held_out.clone();
    }
    let moves_work = row.channel != input.channel
        || row.app_principal != input.app_principal_id
        || row.held_out != request["heldOut"];
    if moves_work
        && active_round(&mut tx, &project, bundle)
            .await
            .map_err(db)?
            .is_some()
    {
        return Err(conflict("Pause the loop and let the round end first"));
    }
    if moves_work || row.setting != request["setting"] || row.status == "stopped" {
        sqlx::query("UPDATE learning_loops SET channel=$3, app_principal=$4, setting=$5, held_out=$6,
                      enrolled_by=$7, status=CASE WHEN status='stopped' AND $8=false AND started_at IS NULL THEN 'running' ELSE status END, updated_at=now()
                     WHERE (project_id,bundle_id)=($1,$2)")
            .bind(&project).bind(bundle).bind(&input.channel).bind(&input.app_principal_id)
            .bind(&request["setting"]).bind(&request["heldOut"]).bind(&actor.principal).bind(central)
            .execute(&mut *tx).await.map_err(db)?;
    }
    sqlx::query("UPDATE learning_loops SET task_model=coalesce($3,task_model),judge_model=coalesce($4,judge_model),max_rounds_per_day=coalesce($5,max_rounds_per_day) WHERE (project_id,bundle_id)=($1,$2)")
        .bind(&project).bind(bundle).bind(input.task_model).bind(input.judge_model).bind(input.max_rounds_per_day).execute(&mut *tx).await.map_err(db)?;
    let row = require_loop(&mut tx, &project, bundle, false).await?;
    let result = loop_document(&mut tx, row).await?;
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
    if operation == "start"
        || (operation == "resume" && (row.started_at.is_some() || row.task_model.is_some()))
    {
        if !controls::ready(&mut tx, &row).await.map_err(db)? {
            return Err(err(
                StatusCode::CONFLICT,
                "tasks-required",
                "At least 20 admitted tasks in each split are required",
            ));
        }
        sqlx::query("UPDATE learning_loops SET started_at=coalesce(started_at,now()) WHERE (project_id,bundle_id)=($1,$2)").bind(project).bind(bundle).execute(&mut *tx).await.map_err(db)?;
    }
    let (status, reason) = match (operation, row.status.as_str()) {
        ("pause" | "resume", "stopped") => {
            return Err(conflict("Use PUT to restart a stopped loop"));
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
    let result = loop_document(&mut tx, row).await?;
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
    reason: Option<String>,
    parent_version_id: Uuid,
    diff: Option<Value>,
    diagnosis: Option<Value>,
    evolve_score: Option<f64>,
    adopted_sample: Option<i16>,
    adopted_version_id: Option<Uuid>,
    incumbent_score: Option<f64>,
    held_out_score: Option<f64>,
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

const ROUND_SELECT:&str="SELECT r.*,c.changes AS diff,c.diagnosis,coalesce(c.evolve_score,r.incumbent_score) AS evolve_score
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

async fn loop_document(tx: &mut Tx<'_>, row: LoopRow) -> ApiResult<Value> {
    let project = &row.project_id;
    let bundle = row.bundle_id;
    let live = evolve::live_count(tx, project, bundle, row.evolve_revision)
        .await
        .map_err(db)?;
    let active = active_round(tx, project, bundle).await.map_err(db)?;
    let recent = summaries(tx, project, bundle, None, 10).await?;
    let (e, h) = controls::counts(tx, project, bundle).await.map_err(db)?;
    Ok(json!({
        "taskModel":row.task_model,"judgeModel":row.judge_model,"taskRevision":row.task_revision,
        "maxRoundsPerDay":row.max_rounds_per_day,"waiting":row.waiting,"alert":row.alert,
        "admittedEvolve":e,"admittedHeldOut":h,
        "workspaceId": project, "bundleId": bundle, "status": row.status, "pauseReason": row.pause_reason,
        "channel": row.channel, "appPrincipalId": row.app_principal, "setting": row.setting, "heldOut": row.held_out,
        "evolveRevision": row.evolve_revision, "liveCases": live, "memoryRevision": row.memory_revision,
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
    Ok(Json(loop_document(&mut tx, row).await?))
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
        "evolveRevision": row.get::<i64,_>("evolve_revision"), "memoryRevision": row.get::<i64,_>("memory_revision"),
        "memoryDigest": row.get::<Option<String>,_>("memory_digest"), "historyDigest": row.get::<Option<String>,_>("history_digest"),
        "setting": row.get::<Value,_>("setting"), "heldOut": row.get::<Value,_>("held_out"),
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
