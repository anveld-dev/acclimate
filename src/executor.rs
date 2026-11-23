mod provider;
pub use provider::ProviderKey;
mod queue;
pub mod trials;
pub use queue::queue_evaluation;
pub(crate) use queue::settle_round;

use crate::{ApiResult, commands, db, digest, err};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::sync::Arc;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;
#[derive(Clone)]
struct Service {
    pool: PgPool,
    key: Option<Arc<ProviderKey>>,
    runtime: Arc<crate::RuntimeStatus>,
}
pub fn router(
    pool: PgPool,
    key: Option<ProviderKey>,
    runtime: Arc<crate::RuntimeStatus>,
) -> Router {
    Router::new()
        .route("/internal/executor/leases", post(lease))
        .route("/internal/executor/leases/{id}/heartbeat", post(heartbeat))
        .route("/internal/executor/leases/{id}/output", post(output))
        .route("/internal/executor/leases/{id}/result", post(result))
        .layer(axum::middleware::from_fn(crate::request_limits))
        .with_state(Service {
            pool,
            key: key.map(Arc::new),
            runtime,
        })
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
pub async fn create_credential(pool: &PgPool) -> Result<(Uuid, String), sqlx::Error> {
    let token = secret();
    let id =
        sqlx::query_scalar("INSERT INTO executor_credentials(token_hash) VALUES($1) RETURNING id")
            .bind(digest(token.as_bytes()))
            .fetch_one(pool)
            .await?;
    Ok((id, token))
}
pub async fn revoke_credential(pool: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query_scalar::<_,Uuid>("UPDATE executor_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id")
        .bind(id)
        .fetch_one(pool).await?;
    Ok(())
}
fn unauthorized() -> crate::ApiErr {
    err(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "Invalid executor credential",
    )
}
fn conflict() -> crate::ApiErr {
    err(
        StatusCode::CONFLICT,
        "lease_conflict",
        "Lease expired or no longer accepts this transition",
    )
}
fn token(headers: &HeaderMap) -> ApiResult<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty())
        .map(|s| digest(s.as_bytes()))
        .ok_or_else(unauthorized)
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutorIdentity {
    build: String,
    harnesses: Value,
    sandbox_runtime: String,
    runner_image: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseRequest {
    executor: ExecutorIdentity,
    #[serde(default)]
    wait_seconds: u64,
}
async fn lease(
    State(s): State<Service>,
    headers: HeaderMap,
    Json(req): Json<LeaseRequest>,
) -> ApiResult<Response> {
    let hash = token(&headers)?;
    let identity = json!(req.executor);
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(req.wait_seconds.min(25));
    loop {
        if let Some(doc) = claim(&s, &hash, &identity).await? {
            return Ok(Json(doc).into_response());
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
pub(crate) async fn expire_leases<'a>(
    executor: impl sqlx::PgExecutor<'a>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE learning_rollouts SET status=CASE attempts WHEN 2 THEN 'failed' ELSE 'queued' END,
        error_code=CASE attempts WHEN 2 THEN 'executor' END,lease_token_hash=NULL
        WHERE status IN ('running','grading') AND lease_expires_at<=clock_timestamp()",
    )
    .execute(executor)
    .await?;
    Ok(())
}
async fn claim(s: &Service, hash: &str, executor: &Value) -> ApiResult<Option<Value>> {
    let _permit = s
        .runtime
        .claim_permit()
        .await
        .ok_or_else(|| db("ownership unavailable"))?;
    let mut tx = s.pool.begin().await.map_err(db)?;
    let owner: Uuid = sqlx::query_scalar(
        "SELECT id FROM executor_credentials WHERE token_hash=$1 AND revoked_at IS NULL FOR UPDATE",
    )
    .bind(hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(unauthorized)?;
    expire_leases(&mut *tx).await.map_err(db)?;
    sqlx::query(
        "UPDATE executor_credentials SET runtime=$2,last_seen_at=clock_timestamp() WHERE id=$1",
    )
    .bind(owner)
    .bind(executor)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    crate::learning::trial_work::dispatch(&mut tx, executor).await?;
    let row = sqlx::query("SELECT l.id,l.input,l.grader,t.kind,v.project_id,convert_from(v.payload,'UTF8')::jsonb AS bundle,p.base_url,p.encrypted_key,coalesce(r.runtime,t.runtime) AS runtime
        FROM learning_rollouts l LEFT JOIN learning_evaluations e ON e.id=l.evaluation_id LEFT JOIN learning_rounds r ON r.id=e.round_id
        LEFT JOIN learning_trials t ON t.id=l.trial_id JOIN versions v ON v.id=coalesce(e.version_id,t.version_id)
        JOIN workspace_model_providers p ON p.project_id=v.project_id
        WHERE l.status='queued' AND coalesce(r.runtime,t.runtime)->'executor'=$1 AND coalesce(r.runtime,t.runtime)->>'baseUrl'=p.base_url
        AND coalesce(r.runtime,t.runtime)->>'taskModel'=ANY(p.allowed_models)
        AND (coalesce(r.runtime,t.runtime)->>'judgeModel' IS NULL OR coalesce(r.runtime,t.runtime)->>'judgeModel'=ANY(p.allowed_models))
        ORDER BY (l.trial_id IS NULL),l.created_at,l.id FOR UPDATE OF l SKIP LOCKED LIMIT 1")
        .bind(executor)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
    let Some(row) = row else {
        tx.commit().await.map_err(db)?;
        return Ok(None);
    };
    let id: Uuid = row.get("id");
    let project: String = row.get("project_id");
    let endpoint: String = row.get("base_url");
    let runtime: Value = row.get("runtime");
    let key = s
        .key
        .as_ref()
        .and_then(|key| {
            key.open(
                &project,
                &endpoint,
                &mut row.get::<Vec<u8>, _>("encrypted_key"),
            )
        })
        .ok_or_else(|| db("provider key unavailable"))?;
    let lease = Uuid::new_v4();
    let bearer = secret();
    let expires: DateTime<Utc> = sqlx::query_scalar("UPDATE learning_rollouts SET status='running',lease_id=$2,lease_token_hash=$3,lease_owner=$4,attempts=attempts+1,lease_expires_at=clock_timestamp()+interval '45 seconds',output=NULL,stop=NULL,gateway_log=NULL WHERE id=$1 RETURNING lease_expires_at")
        .bind(id)
        .bind(lease)
        .bind(digest(bearer.as_bytes()))
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    audit(&mut tx, &project, owner, lease, "/internal/executor/leases").await?;
    tx.commit().await.map_err(db)?;
    let mut doc = json!({
        "leaseId":lease,"leaseToken":bearer,"expiresAt":expires,"heartbeatSeconds":15,
        "rolloutId":id,"provider":{"baseUrl":endpoint,"apiKey":key},"limits":{"maxTokens":200000,"timeoutSeconds":600}
    });
    let input = row.get::<Value, _>("input");
    let fields = match row.get::<Option<String>, _>("kind").as_deref() {
        Some("admission") => {
            let grader = row.get::<Value, _>("grader");
            json!({"kind":"grade","output":input,"judgeRuns":judge_runs(&grader),"grader":grader,"judgeModel":runtime["judgeModel"]})
        }
        Some("conversion") => {
            json!({"kind":"conversion","material":input,"judgeModel":runtime["judgeModel"]})
        }
        _ => {
            json!({"kind":"rollout","harness":"chat","bundle":row.get::<Value,_>("bundle"),"input":input,"taskModel":runtime["taskModel"]})
        }
    };
    doc.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    Ok(Some(doc))
}
async fn audit(
    tx: &mut Tx<'_>,
    project: &str,
    owner: Uuid,
    lease: Uuid,
    path: &str,
) -> ApiResult<()> {
    let principal = format!("executor:{owner}");
    commands::write_audit(
        tx,
        project,
        None,
        &principal,
        &principal,
        path,
        &lease.to_string(),
    )
    .await
}
async fn lock_active_lease(tx: &mut Tx<'_>, id: Uuid, headers: &HeaderMap) -> ApiResult<PgRow> {
    sqlx::query("SELECT t.kind,l.trial_id,l.input,l.status,l.grader,l.stop,l.lease_owner,coalesce(r.project_id,t.project_id) AS project,coalesce(r.runtime,t.runtime) AS runtime FROM learning_rollouts l LEFT JOIN learning_evaluations e ON e.id=l.evaluation_id LEFT JOIN learning_rounds r ON r.id=e.round_id LEFT JOIN learning_trials t ON t.id=l.trial_id WHERE lease_id=$1 AND lease_token_hash=$2 AND lease_expires_at>clock_timestamp() AND l.status IN ('running','grading') FOR UPDATE OF l")
        .bind(id)
        .bind(token(headers)?)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?.ok_or_else(conflict)
}
async fn heartbeat(
    State(s): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let expires: DateTime<Utc> = sqlx::query_scalar("UPDATE learning_rollouts SET lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE lease_id=$1 AND lease_token_hash=$2 AND lease_expires_at>clock_timestamp() AND status IN ('running','grading') RETURNING lease_expires_at")
        .bind(id)
        .bind(token(&headers)?)
        .fetch_optional(&s.pool)
        .await
        .map_err(db)?.ok_or_else(conflict)?;
    Ok(Json(json!({"expiresAt":expires})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    output: Option<String>,
    stop: String,
    gateway_log: Vec<GatewayEntry>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct GatewayEntry {
    at: Value,
    route: String,
    model: String,
    status: u16,
    request: Value,
    response: Value,
    usage: Value,
}

fn invalid() -> crate::ApiErr {
    err(
        StatusCode::BAD_REQUEST,
        "invalid_content",
        "Invalid rollout report",
    )
}
async fn output(
    State(s): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<Output>,
) -> ApiResult<Json<Value>> {
    if !matches!(
        req.stop.as_str(),
        "completed" | "token-limit" | "time-limit"
    ) {
        return Err(invalid());
    }
    let mut tx = s.pool.begin().await.map_err(db)?;
    let row = lock_active_lease(&mut tx, id, &headers).await?;
    if row.get::<String, _>("status") != "running"
        || matches!(
            row.get::<Option<String>, _>("kind").as_deref(),
            Some("admission" | "conversion")
        )
    {
        return Err(conflict());
    }
    sqlx::query("UPDATE learning_rollouts SET status='grading',output=$2,stop=$3,gateway_log=$4 WHERE lease_id=$1")
        .bind(id)
        .bind(req.output)
        .bind(req.stop)
        .bind(json!(req.gateway_log))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"grader":row.get::<Value,_>("grader"),"judgeModel":row.get::<Value,_>("runtime")["judgeModel"],"judgeRuns":judge_runs(&row.get::<Value,_>("grader"))}),
    ))
}
fn judge_runs(grader: &Value) -> usize {
    if grader["type"] == "criteria" { 3 } else { 0 }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Verdict {
    passed: bool,
    score: f64,
    reasons: Vec<String>,
    votes: Option<Vec<bool>>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Counts {
    input: u64,
    output: u64,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Tokens {
    task: Counts,
    judge: Counts,
}
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum ResultBody {
    Error {
        error: InfraError,
    },
    Converted {
        cards: Vec<Value>,
        #[serde(rename = "setAside")]
        set_aside: Vec<Value>,
        #[serde(rename = "judgeLog")]
        judge_log: Vec<GatewayEntry>,
        tokens: JudgeTokens,
    },
    Scored {
        verdict: Verdict,
        #[serde(rename = "judgeLog")]
        judge_log: Vec<GatewayEntry>,
        tokens: Tokens,
    },
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct JudgeTokens {
    judge: Counts,
}
#[derive(Deserialize)]
struct InfraError {
    code: String,
    #[serde(rename = "message")]
    _message: String,
}
async fn result(
    State(s): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<ResultBody>,
) -> ApiResult<StatusCode> {
    let mut tx = s.pool.begin().await.map_err(db)?;
    let row = lock_active_lease(&mut tx, id, &headers).await?;
    if let Some(trial) = row.get::<Option<Uuid>, _>("trial_id") {
        sqlx::query("SELECT id FROM learning_trials WHERE id=$1 FOR UPDATE")
            .bind(trial)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    match req {
        ResultBody::Error { error } => {
            if !matches!(
                error.code.as_str(),
                "gateway-upstream" | "sandbox-start" | "executor"
            ) {
                return Err(invalid());
            }
            sqlx::query("UPDATE learning_rollouts SET status=CASE attempts WHEN 2 THEN 'failed' ELSE 'queued' END,error_code=CASE attempts WHEN 2 THEN $2 END,lease_token_hash=NULL WHERE lease_id=$1")
        .bind(id)
        .bind(error.code)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        }
        ResultBody::Converted {
            cards,
            set_aside,
            judge_log,
            tokens,
        } => {
            if row.get::<Option<String>, _>("kind").as_deref() != Some("conversion")
                || row.get::<String, _>("status") != "running"
            {
                return Err(conflict());
            }
            if !trials::valid_conversion(&row.get::<Value, _>("input"), &cards, &set_aside) {
                return Err(invalid());
            }
            crate::learning::trial_work::convert(&mut tx, row.get("trial_id"), &cards, &set_aside)
                .await?;
            sqlx::query("UPDATE learning_rollouts SET status='converted',conversion_result=$2,judge_log=$3,tokens=$4,lease_token_hash=NULL WHERE lease_id=$1")
                .bind(id).bind(json!({"cards":cards,"setAside":set_aside})).bind(json!(judge_log)).bind(json!(tokens)).execute(&mut *tx).await.map_err(db)?;
        }
        ResultBody::Scored {
            verdict,
            judge_log,
            tokens,
        } => {
            let grade = row.get::<Option<String>, _>("kind").as_deref() == Some("admission");
            if row.get::<String, _>("status") != if grade { "running" } else { "grading" } {
                return Err(conflict());
            }
            let completed =
                grade || row.get::<Option<String>, _>("stop").as_deref() == Some("completed");
            let grader = row.get::<Value, _>("grader");
            if completed && grader["type"] == "criteria" {
                let votes = verdict.votes.as_ref().ok_or_else(invalid)?;
                if votes.len() != 3
                    || (votes.iter().filter(|v| **v).count() >= 2) != verdict.passed
                    || grader["criteria"].as_array().map(Vec::len) != Some(verdict.reasons.len())
                    || verdict.reasons.iter().any(|r| r.trim().is_empty())
                {
                    return Err(invalid());
                }
            } else if verdict.votes.is_some() {
                return Err(invalid());
            }
            if verdict.score != f64::from(verdict.passed) || (!completed && verdict.passed) {
                return Err(invalid());
            }
            sqlx::query("UPDATE learning_rollouts SET status='scored',score=$2,passed=$3,reasons=$4,judge_log=$5,tokens=$6,votes=$7,lease_token_hash=NULL WHERE lease_id=$1")
        .bind(id)
        .bind(verdict.score)
        .bind(verdict.passed)
        .bind(json!(verdict.reasons))
        .bind(json!(judge_log))
        .bind(json!(tokens))
        .bind(verdict.votes.map(|v|json!(v)))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        }
    }
    if row.get::<Option<String>, _>("kind").as_deref() == Some("admission") {
        crate::learning::trial_work::apply(&mut tx, row.get("trial_id")).await?;
    }
    audit(
        &mut tx,
        row.get("project"),
        row.get("lease_owner"),
        id,
        &format!("/internal/executor/leases/{id}/result"),
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT)
}
