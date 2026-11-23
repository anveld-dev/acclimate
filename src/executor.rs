mod probe;
mod provider;
pub use provider::{KeyMismatch, ProviderKey, reset_provider_keys};
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

const TASK_MAX_TOKENS: usize = 200_000;
const JUDGE_MAX_TOKENS: usize = 64_000;

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
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(axum::middleware::from_fn(crate::request_limits::<true>))
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
type CredentialRow = (
    Uuid,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<Value>,
    Option<DateTime<Utc>>,
);
/// Every executor credential, oldest first, without its token or token hash.
pub async fn list_credentials(pool: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<CredentialRow> = sqlx::query_as(
        "SELECT id,created_at,last_seen_at,runtime,revoked_at FROM executor_credentials ORDER BY created_at,id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, created, seen, runtime, revoked)| {
            credential_summary(id, created, seen, runtime, revoked)
        })
        .collect())
}
fn credential_summary(
    id: Uuid,
    created: DateTime<Utc>,
    seen: Option<DateTime<Utc>>,
    runtime: Option<Value>,
    revoked: Option<DateTime<Utc>>,
) -> Value {
    json!({
        "id": id,
        "createdAt": created,
        "lastSeenAt": seen,
        "runtime": runtime,
        "revoked": revoked.is_some(),
        "revokedAt": revoked,
    })
}
pub async fn revoke_credential(pool: &PgPool, id: Uuid) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query_scalar::<_,Uuid>("UPDATE executor_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id")
        .bind(id)
        .fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE learning_rollouts SET status=CASE WHEN attempts=2 THEN 'failed' ELSE 'queued' END,error_code=CASE WHEN attempts=2 THEN 'executor' END,lease_token_hash=NULL WHERE lease_owner=$1 AND status IN ('running','grading')").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE workspace_model_providers SET probe_expires=now(),probe_token=NULL WHERE probe_owner=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await
}
/// Say on the service why a workspace's provider now shows "Provider key unavailable".
fn unusable_key(project: &str, configured: bool) {
    if configured {
        eprintln!(
            "The stored provider key for workspace {project} could not be decrypted with ACCLIMATE_PROVIDER_ENCRYPTION_KEY. Its provider now shows \"Provider key unavailable\" and its rounds cannot run. Restore the encryption key it was stored with, or have a workspace administrator enter the provider key again."
        );
    } else {
        eprintln!(
            "ACCLIMATE_PROVIDER_ENCRYPTION_KEY is not set, so the stored provider key for workspace {project} cannot be used. Its provider now shows \"Provider key unavailable\". Set the key the provider keys were stored with and restart the service."
        );
    }
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
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
    if let Some(doc) = probe::claim(&mut tx, owner, s.key.as_deref()).await? {
        tx.commit().await.map_err(db)?;
        return Ok(Some(doc));
    }
    crate::learning::trial_work::dispatch(&mut tx, executor).await?;
    let row = sqlx::query("SELECT l.id,l.input,l.grader,t.kind,v.project_id,convert_from(v.payload,'UTF8')::jsonb AS bundle,p.base_url,p.encrypted_key,coalesce(r.runtime,t.runtime) AS runtime
        FROM learning_rollouts l LEFT JOIN learning_evaluations e ON e.id=l.evaluation_id LEFT JOIN learning_rounds r ON r.id=e.round_id
        LEFT JOIN learning_trials t ON t.id=l.trial_id JOIN versions v ON v.id=coalesce(e.version_id,t.version_id)
        JOIN workspace_model_providers p ON p.project_id=v.project_id
        WHERE p.verification->>'status'='verified' AND l.status='queued' AND coalesce(r.runtime,t.runtime)->'executor'=$1 AND coalesce(r.runtime,t.runtime)->>'baseUrl'=p.base_url
        AND coalesce(r.runtime,t.runtime)->>'taskModel'=ANY(p.allowed_models)
        AND (coalesce(r.runtime,t.runtime)->>'judgeModel' IS NULL OR coalesce(r.runtime,t.runtime)->>'judgeModel'=ANY(p.allowed_models))
        ORDER BY CASE WHEN t.kind='try' THEN 0 WHEN l.evaluation_id IS NOT NULL THEN 1 ELSE 2 END,l.created_at,l.id FOR UPDATE OF l SKIP LOCKED LIMIT 1")
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
    let key = s.key.as_ref().and_then(|key| {
        key.open(
            &project,
            &endpoint,
            &mut row.get::<Vec<u8>, _>("encrypted_key"),
        )
    });
    let Some(key) = key else {
        unusable_key(&project, s.key.is_some());
        sqlx::query("UPDATE workspace_model_providers SET verification=jsonb_build_object('status','failed','checkedAt',now(),'models',(SELECT jsonb_agg(jsonb_build_object('model',m,'ok',false,'usage',false,'message','Provider key unavailable')) FROM unnest(allowed_models) m)) WHERE project_id=$1 AND encrypted_key=$2").bind(&project).bind(row.get::<Vec<u8>,_>("encrypted_key")).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        return Ok(None);
    };
    let lease = Uuid::new_v4();
    let bearer = secret();
    let expires: DateTime<Utc> = sqlx::query_scalar("UPDATE learning_rollouts SET status='running',lease_id=$2,lease_token_hash=$3,lease_owner=$4,attempts=attempts+1,lease_expires_at=clock_timestamp()+interval '45 seconds',output=NULL,stop=NULL,gateway_log=NULL,tokens=NULL WHERE id=$1 RETURNING lease_expires_at")
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
        "rolloutId":id,"provider":{"baseUrl":endpoint,"apiKey":key},"limits":{"maxTokens":TASK_MAX_TOKENS,"judgeMaxTokens":JUDGE_MAX_TOKENS,"timeoutSeconds":600}
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
    // Revoke and claim lock the credential and then its leases. Renewal and presence are separate
    // statements here, so a heartbeat never holds a lease lock while it waits for the credential.
    let probe: Option<(DateTime<Utc>, Uuid)> = sqlx::query_as("UPDATE workspace_model_providers SET probe_expires=now()+interval '45 seconds' WHERE probe_id=$1 AND probe_token=$2 AND probe_expires>now() AND EXISTS(SELECT FROM executor_credentials WHERE id=probe_owner AND revoked_at IS NULL) RETURNING probe_expires,probe_owner")
        .bind(id)
        .bind(token(&headers)?)
        .fetch_optional(&s.pool)
        .await
        .map_err(db)?;
    let (expires, owner) = match probe {
        Some(renewed) => renewed,
        None => sqlx::query_as("UPDATE learning_rollouts SET lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE lease_id=$1 AND lease_token_hash=$2 AND lease_expires_at>clock_timestamp() AND status IN ('running','grading') RETURNING lease_expires_at,lease_owner")
            .bind(id)
            .bind(token(&headers)?)
            .fetch_optional(&s.pool)
            .await
            .map_err(db)?
            .ok_or_else(conflict)?,
    };
    sqlx::query("UPDATE executor_credentials SET last_seen_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL")
        .bind(owner)
        .execute(&s.pool)
        .await
        .map_err(db)?;
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
        "completed" | "token-limit" | "time-limit" | "invalid-output"
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
/// A judged score is the share of criteria met, averaged over the judgments. A judgment that
/// passed met every criterion, and one that failed missed at least one, which bounds the score.
fn judged_score_fits(score: f64, votes: &[bool], criteria: usize) -> bool {
    let passing = votes.iter().filter(|v| **v).count() as f64;
    let failing = votes.len() as f64 - passing;
    let runs = votes.len() as f64;
    let most = (passing + failing * (criteria as f64 - 1.0) / criteria as f64) / runs;
    // The score counts whole criteria across the judgments.
    let met = score * runs * criteria as f64;
    criteria > 0
        && (met - met.round()).abs() < 1e-6
        && score >= passing / runs - 1e-9
        && score <= most + 1e-9
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
    Probe {
        models: Vec<probe::ModelResult>,
    },
    Error {
        error: InfraError,
        tokens: Option<Tokens>,
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
    message: String,
}
async fn result(
    State(s): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<StatusCode> {
    let mut tx = s.pool.begin().await.map_err(db)?;
    let req = serde_json::from_value::<ResultBody>(body);
    if let Ok(ResultBody::Probe { models }) = req {
        probe::finish(&mut tx, id, &token(&headers)?, models).await?;
        tx.commit().await.map_err(db)?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let row = lock_active_lease(&mut tx, id, &headers).await?;
    if let Some(trial) = row.get::<Option<Uuid>, _>("trial_id") {
        sqlx::query("SELECT id FROM learning_trials WHERE id=$1 FOR UPDATE")
            .bind(trial)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let req = match req {
        Ok(ResultBody::Scored { .. })
            if row.get::<Option<String>, _>("kind").as_deref() == Some("conversion") =>
        {
            reject_conversion(&mut tx, id, row.get("trial_id"), None).await?;
            tx.commit().await.map_err(db)?;
            return Err(invalid());
        }
        Ok(body) => body,
        Err(_) if row.get::<Option<String>, _>("kind").as_deref() == Some("conversion") => {
            reject_conversion(&mut tx, id, row.get("trial_id"), None).await?;
            tx.commit().await.map_err(db)?;
            return Err(invalid());
        }
        Err(_) => return Err(invalid()),
    };
    match req {
        ResultBody::Probe { .. } => unreachable!(),
        ResultBody::Error { error, tokens } => {
            if !matches!(
                error.code.as_str(),
                "gateway-upstream"
                    | "judge-budget"
                    | "judge-invalid-reply"
                    | "sandbox-start"
                    | "executor"
            ) {
                return Err(invalid());
            }
            sqlx::query("UPDATE learning_rollouts SET status=CASE attempts WHEN 2 THEN 'failed' ELSE 'queued' END,error_code=CASE attempts WHEN 2 THEN $2 END,error_message=CASE attempts WHEN 2 THEN left($3,500) END,tokens=$4,lease_token_hash=NULL WHERE lease_id=$1")
        .bind(id)
        .bind(error.code)
        .bind(error.message)
        .bind(tokens.map(|counts|json!(counts)))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
            if row.get::<Option<String>, _>("kind").as_deref() == Some("conversion") {
                sqlx::query("UPDATE learning_task_imports SET failure='Conversion failed after two attempts' WHERE conversion_trial=$1 AND EXISTS(SELECT FROM learning_rollouts WHERE lease_id=$2 AND status='failed')").bind(row.get::<Uuid,_>("trial_id")).bind(id).execute(&mut *tx).await.map_err(db)?;
            }
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
            let applied =
                if trials::valid_conversion(&row.get::<Value, _>("input"), &cards, &set_aside) {
                    crate::learning::trial_work::convert(
                        &mut tx,
                        row.get("trial_id"),
                        &cards,
                        &set_aside,
                    )
                    .await
                } else {
                    Err(invalid())
                };
            if let Err(error) = applied {
                if error.0.is_client_error() {
                    reject_conversion(&mut tx, id, row.get("trial_id"), Some(json!(tokens)))
                        .await?;
                    tx.commit().await.map_err(db)?;
                }
                return Err(error);
            }
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
                let criteria = grader["criteria"].as_array().map(Vec::len);
                if votes.len() != 3
                    || (votes.iter().filter(|v| **v).count() >= 2) != verdict.passed
                    || criteria != Some(verdict.reasons.len())
                    || verdict.reasons.iter().any(|r| r.trim().is_empty())
                    // An executor from before partial credit reports 1 or 0. Accept that while
                    // it is replaced, so an upgrade does not fail the rollouts in flight.
                    || !(judged_score_fits(verdict.score, votes, verdict.reasons.len())
                        || verdict.score == f64::from(verdict.passed))
                {
                    return Err(invalid());
                }
            } else if verdict.votes.is_some() || verdict.score != f64::from(verdict.passed) {
                return Err(invalid());
            }
            if !completed && verdict.passed {
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

async fn reject_conversion(
    tx: &mut Tx<'_>,
    lease: Uuid,
    trial: Uuid,
    tokens: Option<Value>,
) -> ApiResult<()> {
    sqlx::query("UPDATE learning_rollouts SET status='failed',error_code='invalid-conversion',tokens=$2,lease_token_hash=NULL WHERE lease_id=$1").bind(lease).bind(tokens).execute(&mut **tx).await.map_err(db)?;
    sqlx::query("UPDATE learning_task_imports SET failure='Executor returned invalid conversion material' WHERE conversion_trial=$1").bind(trial).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{credential_summary, judged_score_fits};
    use serde_json::json;

    #[test]
    fn credential_summary_names_the_credential_without_its_secret() {
        let id = uuid::Uuid::nil();
        let created = "2026-01-02T03:04:05Z".parse().unwrap();
        let fresh = credential_summary(id, created, None, None, None);
        assert_eq!(
            fresh,
            json!({"id":id,"createdAt":"2026-01-02T03:04:05Z","lastSeenAt":null,"runtime":null,"revoked":false,"revokedAt":null})
        );
        let runtime = json!({"build":"b","harnesses":{"chat":"1"},"sandboxRuntime":"runsc","runnerImage":"sha256:1"});
        let seen = "2026-01-03T00:00:00Z".parse().unwrap();
        let used = credential_summary(id, created, Some(seen), Some(runtime.clone()), Some(seen));
        assert_eq!(used["runtime"], runtime);
        assert_eq!(used["lastSeenAt"], "2026-01-03T00:00:00Z");
        assert_eq!(used["revoked"], true);
        assert_eq!(used["revokedAt"], "2026-01-03T00:00:00Z");
        let mut fields: Vec<_> = used.as_object().unwrap().keys().cloned().collect();
        fields.sort();
        assert_eq!(
            fields,
            [
                "createdAt",
                "id",
                "lastSeenAt",
                "revoked",
                "revokedAt",
                "runtime"
            ]
        );
    }

    #[test]
    fn judged_score_must_agree_with_the_votes() {
        // Four criteria, three judgments.
        assert!(judged_score_fits(1.0, &[true, true, true], 4));
        assert!(!judged_score_fits(0.99, &[true, true, true], 4));
        // Two passing judgments give at least two thirds. The third missed a criterion.
        assert!(judged_score_fits(11.0 / 12.0, &[true, true, false], 4));
        assert!(judged_score_fits(2.0 / 3.0, &[true, true, false], 4));
        assert!(!judged_score_fits(1.0, &[true, true, false], 4));
        assert!(!judged_score_fits(0.5, &[true, true, false], 4));
        // Three failing judgments can still meet most criteria, never all.
        assert!(judged_score_fits(0.75, &[false, false, false], 4));
        assert!(!judged_score_fits(0.7, &[false, false, false], 4));
        assert!(judged_score_fits(0.0, &[false, false, false], 4));
        assert!(!judged_score_fits(1.0, &[false, false, false], 4));
        assert!(!judged_score_fits(f64::NAN, &[false, false, false], 4));
        // A single criterion leaves no room: the score is the share of passing judgments.
        assert!(judged_score_fits(1.0 / 3.0, &[true, false, false], 1));
        assert!(!judged_score_fits(0.5, &[true, false, false], 1));
    }
}
