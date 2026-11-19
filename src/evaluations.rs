use crate::WorkspaceRoutes;
use crate::pagination::{ListQuery, Page};
use crate::{ApiResult, AppState, CaseKey, ComparisonRequest, db, err, path};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, postgres::PgRow};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEvaluationRequest {
    pub parent_version_id: String,
    pub parent_digest: String,
    pub candidate_version_id: String,
    pub candidate_digest: String,
    pub dataset_revision: String,
    pub runtime: HashMap<String, String>,
    pub grader_revision: String,
    pub expected_cases: Vec<CaseKey>,
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default = "bound_evidence")]
    pub require_bound_evidence: bool,
    /// The evaluator's own label for this run, such as a CLI `--name`. Display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_name: Option<String>,
    /// An earlier request on the same parent and candidate content that this run supersedes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
    /// Digest of the quality policy chosen before the run. Receipts for other policies are flagged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_digest: Option<String>,
}
fn bound_evidence() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub id: String,
    #[serde(flatten)]
    pub request: CreateEvaluationRequest,
    pub status: String,
    pub evaluator_principal: Option<String>,
    pub attempt_id: Option<String>,
    pub comparison_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Last start, progress report or bound report from the current attempt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abandoned_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abandoned_by: Option<String>,
}
fn invalid(m: &str) -> crate::ApiErr {
    err(StatusCode::BAD_REQUEST, "invalid_content", m)
}
fn conflict() -> crate::ApiErr {
    err(
        StatusCode::CONFLICT,
        "evaluation_conflict",
        "Evaluation state, evaluator or attempt does not match",
    )
}
pub(crate) fn decode(r: PgRow) -> ApiResult<Evaluation> {
    Ok(Evaluation {
        id: r.get::<Uuid, _>("id").to_string(),
        request: serde_json::from_value(r.get("body")).map_err(db)?,
        status: r.get("status"),
        evaluator_principal: r.get("evaluator_principal"),
        attempt_id: r.get("attempt_id"),
        comparison_id: r
            .get::<Option<Uuid>, _>("comparison_id")
            .map(|v| v.to_string()),
        error: r.get("error"),
        created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
        updated_at: r.get::<DateTime<Utc>, _>("updated_at").to_rfc3339(),
        last_activity_at: optional_time(&r, "last_activity_at"),
        abandoned_at: optional_time(&r, "abandoned_at"),
        abandoned_by: r.try_get("abandoned_by").ok().flatten(),
    })
}
fn optional_time(r: &PgRow, column: &str) -> Option<String> {
    r.try_get::<Option<DateTime<Utc>>, _>(column)
        .ok()
        .flatten()
        .map(|t| t.to_rfc3339())
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .workspace_route(
            "/v1/projects/{p}/evaluation-capabilities",
            get(capabilities),
        )
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests",
            get(list).post(create),
        )
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}",
            get(detail),
        )
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/start",
            post(start),
        )
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/finish",
            post(finish),
        )
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/interrupt",
            post(interrupt),
        )
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/abandon",
            post(abandon),
        )
}

pub(crate) const EXPIRY_PRINCIPAL: &str = "service:evaluation-expiry";
const DEFAULT_ABANDON_SECONDS: u32 = 7_200;

/// Inactivity after which a running, unmanaged attempt is abandoned by the service.
pub fn abandon_after_seconds() -> u32 {
    std::env::var("ACCLIMATE_EVALUATION_ABANDON_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|&seconds| seconds >= 60)
        .unwrap_or(DEFAULT_ABANDON_SECONDS)
}

/// Abandon running attempts with no start, progress or bound report within
/// `seconds`. This does not claim the original worker stopped. It only refuses
/// that attempt's later reports and keeps its evidence out of releases.
/// Connected-learning requests keep their own deadlines and are never touched.
pub async fn abandon_inactive_evaluations(db: &sqlx::PgPool, seconds: u32) -> sqlx::Result<u64> {
    let reason = format!("No evaluator activity for {seconds} seconds");
    let result = sqlx::query(
        "UPDATE evaluation_requests e SET status='abandoned',error=$2,abandoned_at=now(),abandoned_by=$3,updated_at=now()
         WHERE e.id IN (
           SELECT id FROM evaluation_requests
           WHERE status='running' AND requested_by<>'service:connected-learning'
             AND COALESCE(last_activity_at,started_at,updated_at) < now()-make_interval(secs=>$1)
           ORDER BY COALESCE(last_activity_at,started_at,updated_at),id LIMIT 100
           FOR UPDATE SKIP LOCKED)
           AND e.status='running'",
    )
    .bind(f64::from(seconds))
    .bind(reason)
    .bind(EXPIRY_PRINCIPAL)
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

/// Point-in-time authority, not evaluator/provider readiness or a lease.
async fn capabilities(
    State(s): State<AppState>,
    Path(p): Path<String>,
    h: HeaderMap,
) -> ApiResult<impl axum::response::IntoResponse> {
    let actor = crate::auth::actor(&h, &s, &p, "read")?;
    if actor.user_id.is_some() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "machine_principal_required",
            "Evaluator capabilities require a machine principal",
        ));
    }
    if !crate::commands::guided_project(&p) || actor.principal.len() > 1024 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "guided_target_unsupported",
            "Target does not support retained evaluator operations",
        ));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)")
        .bind(&p)
        .fetch_one(&s.db)
        .await
        .map_err(db)?;
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "not_found", "Project not found"));
    }
    let has = |right| {
        crate::auth::actor(&h, &s, &p, right).is_ok_and(|other| other.principal == actor.principal)
    };
    let evaluate = has("evaluate");
    let credential = match actor.machine_token {
        Some(token) => {
            let expires: Option<DateTime<Utc>> = sqlx::query_scalar(
                "SELECT expires_at FROM machine_tokens WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()",
            )
            .bind(token)
            .fetch_optional(&s.db)
            .await
            .map_err(db)?;
            let expires = expires.ok_or_else(|| {
                err(
                    StatusCode::UNAUTHORIZED,
                    "unauthenticated",
                    "Unknown, expired or revoked bearer token",
                )
            })?;
            serde_json::json!({"kind": "machineToken", "id": token, "expiresAt": expires})
        }
        None => serde_json::json!({"kind": "static"}),
    };
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(serde_json::json!({
            "schemaVersion": 1,
            "projectId": p,
            "principalId": actor.principal,
            "checkedAt": Utc::now(),
            "readUnpublished": true,
            "writeEvaluation": evaluate,
            "retainedEvaluationOperations": true,
            "rights": {
                "read": true,
                "evaluate": evaluate,
                "write": has("write"),
                "propose": has("propose"),
                "promote": has("promote"),
            },
            "credential": credential,
            "abandonment": {
                "explicit": evaluate,
                "inactivitySeconds": abandon_after_seconds(),
            },
            "runLabels": true,
        })),
    ))
}
fn bounded(q: &CreateEvaluationRequest) -> bool {
    let strings = [
        &q.parent_digest,
        &q.candidate_digest,
        &q.dataset_revision,
        &q.grader_revision,
    ];
    strings
        .iter()
        .all(|s| !s.trim().is_empty() && s.len() <= 1024)
        && !q.runtime.is_empty()
        && q.runtime.len() <= 64
        && q.runtime.iter().all(|(k, v)| {
            !k.trim().is_empty() && k.len() <= 128 && !v.trim().is_empty() && v.len() <= 4096
        })
        && !q.expected_cases.is_empty()
        && q.expected_cases.len() <= 1000
        && q.expected_cases
            .iter()
            .all(|k| !k.case_id.trim().is_empty() && k.case_id.len() <= 1024)
        && q.expected_cases.iter().collect::<HashSet<_>>().len() == q.expected_cases.len()
        && q.run_name.as_deref().is_none_or(|name| {
            !name.is_empty()
                && name.len() <= 80
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}
async fn create(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "evaluate")?;
    let q: CreateEvaluationRequest =
        serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
    let route = format!("/v1/projects/{p}/bundles/{b}/evaluation-requests");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let bid = path(&b)?;
    let evaluation = enqueue_evaluation(&mut cmd.tx, &p, bid, &a.principal, &q).await?;
    crate::commands::finish_mutation(cmd, StatusCode::CREATED, evaluation).await
}

pub(crate) async fn enqueue_evaluation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    bid: Uuid,
    principal: &str,
    q: &CreateEvaluationRequest,
) -> ApiResult<Evaluation> {
    if !q.require_bound_evidence {
        return Err(invalid("Evaluation requests require bound evidence"));
    }
    if q.policy_digest.as_deref().is_some_and(|digest| {
        !digest.strip_prefix("sha256:").is_some_and(|hex| {
            hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
    }) {
        return Err(invalid("policyDigest must be a sha256: digest"));
    }
    if !bounded(q) {
        return Err(invalid(
            "Evaluation request exceeds limits or has duplicate cases",
        ));
    }
    let parent = path(&q.parent_version_id)?;
    let candidate = path(&q.candidate_version_id)?;
    let managed = principal == "service:connected-learning" && q.proposal_id.is_none();
    let rows=sqlx::query("SELECT id,digest,parent_version_id FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=ANY($3)").bind(project).bind(bid).bind(vec![parent,candidate]).fetch_all(&mut **tx).await.map_err(db)?;
    let matches_version = |id, digest: &str| {
        rows.iter()
            .find(|row| row.get::<Uuid, _>("id") == id && row.get::<String, _>("digest") == digest)
    };
    let invalid_identity = || invalid("Version identities or candidate parent do not match");
    let candidate_row =
        matches_version(candidate, &q.candidate_digest).ok_or_else(invalid_identity)?;
    let direct_parent = candidate_row.get::<Option<Uuid>, _>("parent_version_id") == Some(parent);
    if matches_version(parent, &q.parent_digest).is_none()
        || !(direct_parent
            || managed
                && (parent == candidate
                    || crate::connected_learning::descends_from(
                        tx, project, bid, candidate, parent,
                    )
                    .await?))
    {
        return Err(invalid_identity());
    }
    if let Some(proposal) = &q.proposal_id {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM proposals WHERE project_id=$1 AND bundle_id=$2 AND id=$3 AND parent_version_id=$4 AND candidate_version_id=$5 AND status='succeeded')").bind(project).bind(bid).bind(path(proposal)?).bind(parent).bind(candidate).fetch_one(&mut **tx).await.map_err(db)?;
        if !valid {
            return Err(invalid("Proposal does not match candidate"));
        }
    }
    if let Some(prior) = &q.retry_of {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3 AND body->>'parentVersionId'=$4 AND body->>'candidateDigest'=$5)").bind(project).bind(bid).bind(path(prior)?).bind(&q.parent_version_id).bind(&q.candidate_digest).fetch_one(&mut **tx).await.map_err(db)?;
        if !valid {
            return Err(invalid(
                "Retried request must share the parent and candidate content",
            ));
        }
    }
    let row=sqlx::query("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status) VALUES($1,$2,$3,$4,$5,'requested') RETURNING *").bind(Uuid::new_v4()).bind(project).bind(bid).bind(serde_json::to_value(q).map_err(db)?).bind(principal).fetch_one(&mut **tx).await.map_err(db)?;
    decode(row)
}
async fn detail(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<Evaluation>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible = crate::connected_learning::audit_visible("r.audit_request_id=e.id", 4, 5);
    let row = sqlx::query(&format!(
        "SELECT e.* FROM evaluation_requests e WHERE e.project_id=$1 AND e.bundle_id=$2 AND e.id=$3 AND {visible}",
    ))
    .bind(p)
    .bind(path(&b)?)
    .bind(path(&id)?)
    .bind(principal)
    .bind(reviewer)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            "not_found",
            "Evaluation request not found",
        )
    })?;
    Ok(Json(decode(row)?))
}
async fn list(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Page<Evaluation>>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let n = q.bounds()?;
    let bid = path(&b)?;
    let c = crate::pagination::decode("evaluation_requests", &p, bid, q.cursor.as_deref())?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible = crate::connected_learning::audit_visible("r.audit_request_id=e.id", 6, 7);
    let rows = sqlx::query(&format!(
        "SELECT e.* FROM evaluation_requests e WHERE e.project_id=$1 AND e.bundle_id=$2
         AND ($3::timestamptz IS NULL OR (e.created_at,e.id)<($3,$4)) AND {visible}
         ORDER BY e.created_at DESC,e.id DESC LIMIT $5",
    ))
    .bind(&p)
    .bind(bid)
    .bind(c.map(|x| x.0))
    .bind(c.map(|x| x.1))
    .bind(n + 1)
    .bind(principal)
    .bind(reviewer)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let items = rows
        .into_iter()
        .map(decode)
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(crate::pagination::page(items, n, |x| {
        crate::pagination::encode("evaluation_requests", &p, bid, &x.created_at, &x.id)
    })))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    attempt_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Finish {
    attempt_id: String,
    comparison_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Interrupt {
    reason: String,
}
async fn start(
    s: State<AppState>,
    p: Path<(String, String, String)>,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    transition(s, p, h, b, "start").await
}
async fn finish(
    s: State<AppState>,
    p: Path<(String, String, String)>,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    transition(s, p, h, b, "finish").await
}
async fn interrupt(
    s: State<AppState>,
    p: Path<(String, String, String)>,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    transition(s, p, h, b, "interrupt").await
}
async fn abandon(
    s: State<AppState>,
    p: Path<(String, String, String)>,
    h: HeaderMap,
    b: Bytes,
) -> ApiResult<Response> {
    transition(s, p, h, b, "abandon").await
}
async fn transition(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
    body: Bytes,
    action: &str,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "evaluate")?;
    let route = format!("/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/{action}");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let bid = path(&b)?;
    let eid = path(&id)?;
    crate::connected_learning::authorize_evaluator(
        &mut cmd.tx,
        &p,
        bid,
        eid,
        &a.principal,
        action == "start",
    )
    .await?;
    let row=sqlx::query("SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3 FOR UPDATE").bind(&p).bind(bid).bind(eid).fetch_optional(&mut *cmd.tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Evaluation request not found"))?;
    let managed = row.get::<String, _>("requested_by") == "service:connected-learning";
    let mut e = decode(row)?;
    let mut abandoned = false;
    match action {
        "abandon" => {
            let q: Interrupt =
                serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
            if q.reason.trim().is_empty() || q.reason.len() > 4096 {
                return Err(invalid("Abandonment reason required (max 4096 bytes)"));
            }
            if managed {
                return Err(err(
                    StatusCode::CONFLICT,
                    "managed_evaluation",
                    "Connected-learning evaluations settle on their own deadlines",
                ));
            }
            if e.status == "requested" || e.status == "running" {
                e.status = "abandoned".into();
                e.error = Some(q.reason);
                abandoned = true;
            } else if e.status != "abandoned" || e.error.as_deref() != Some(&q.reason) {
                return Err(conflict());
            }
        }
        "start" => {
            let q: Start =
                serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
            if q.attempt_id.trim().is_empty() || q.attempt_id.len() > 128 {
                return Err(invalid("Invalid attempt ID"));
            }
            if e.status == "requested" {
                e.status = "running".into();
                e.evaluator_principal = Some(a.principal.clone());
                e.attempt_id = Some(q.attempt_id)
            } else if !matches!(e.status.as_str(), "running" | "completed" | "failed")
                || e.evaluator_principal.as_deref() != Some(&a.principal)
                || e.attempt_id.as_deref() != Some(&q.attempt_id)
            {
                return Err(conflict());
            }
        }
        "interrupt" => {
            let q: Interrupt =
                serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
            if q.reason.trim().is_empty() || q.reason.len() > 4096 {
                return Err(invalid("Interruption reason required (max 4096 bytes)"));
            }
            if e.status == "requested" || e.status == "running" {
                e.status = "interrupted".into();
                e.error = Some(q.reason)
            } else if e.status != "interrupted" || e.error.as_deref() != Some(&q.reason) {
                return Err(conflict());
            }
        }
        "finish" => {
            let q: Finish =
                serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
            if e.evaluator_principal.as_deref() != Some(&a.principal)
                || e.attempt_id.as_deref() != Some(&q.attempt_id)
            {
                return Err(conflict());
            }
            if matches!(e.status.as_str(), "completed" | "failed") {
                if e.comparison_id.as_deref() != Some(&q.comparison_id) {
                    return Err(conflict());
                }
            } else {
                if e.status != "running" {
                    return Err(conflict());
                }
                let r=sqlx::query("SELECT body,complete,submitter FROM comparisons WHERE project_id=$1 AND bundle_id=$2 AND id=$3").bind(&p).bind(bid).bind(path(&q.comparison_id)?).fetch_optional(&mut *cmd.tx).await.map_err(db)?.ok_or_else(||invalid("Comparison not found"))?;
                let c: ComparisonRequest = serde_json::from_value(r.get("body")).map_err(db)?;
                validate_report(&e, &c, &a.principal, &r.get::<String, _>("submitter"))?;
                let complete: bool = r.get("complete");
                e.status = if complete { "completed" } else { "failed" }.into();
                e.error = if complete {
                    None
                } else {
                    Some("Comparison is incomplete".into())
                };
                e.comparison_id = Some(q.comparison_id);
            }
        }
        _ => unreachable!(),
    }
    let r=sqlx::query("UPDATE evaluation_requests SET started_at=CASE WHEN $4='running' AND status<>'running' THEN now() ELSE started_at END,last_activity_at=CASE WHEN $4='running' AND status<>'running' THEN now() ELSE last_activity_at END,abandoned_at=CASE WHEN $9 THEN now() ELSE abandoned_at END,abandoned_by=CASE WHEN $9 THEN $10 ELSE abandoned_by END,status=$4,evaluator_principal=$5,attempt_id=$6,comparison_id=$7,error=$8,updated_at=CASE WHEN status=$4 AND evaluator_principal IS NOT DISTINCT FROM $5 AND attempt_id IS NOT DISTINCT FROM $6 AND comparison_id IS NOT DISTINCT FROM $7 AND error IS NOT DISTINCT FROM $8 THEN updated_at ELSE now() END WHERE project_id=$1 AND bundle_id=$2 AND id=$3 RETURNING *").bind(p).bind(bid).bind(eid).bind(e.status).bind(e.evaluator_principal).bind(e.attempt_id).bind(e.comparison_id.as_deref().map(path).transpose()?).bind(e.error).bind(abandoned).bind(&a.principal).fetch_one(&mut *cmd.tx).await.map_err(db)?;
    crate::commands::finish_mutation(cmd, StatusCode::OK, decode(r)?).await
}

/// Both submission and finish call this while holding the evaluation row lock.
pub(crate) fn validate_report(
    e: &Evaluation,
    c: &ComparisonRequest,
    principal: &str,
    submitter: &str,
) -> ApiResult<()> {
    let x = &e.request;
    if e.evaluator_principal.as_deref() != Some(principal) {
        return Err(conflict());
    }
    if submitter != principal {
        return Err(invalid(
            "Comparison submitter or declared evaluation settings do not match",
        ));
    }
    let binding = c
        .evaluation
        .as_ref()
        .ok_or_else(|| invalid("This evaluation requires request and attempt bound evidence"))?;
    if binding.request_id != e.id || Some(binding.attempt_id.as_str()) != e.attempt_id.as_deref() {
        return Err(conflict());
    }
    if c.parent_version_id != x.parent_version_id
        || c.parent_digest != x.parent_digest
        || c.candidate_version_id != x.candidate_version_id
        || c.candidate_digest != x.candidate_digest
        || c.dataset_revision != x.dataset_revision
        || c.runtime != x.runtime
        || c.grader_revision != x.grader_revision
        || c.expected_cases.iter().collect::<HashSet<_>>()
            != x.expected_cases.iter().collect::<HashSet<_>>()
    {
        return Err(invalid(
            "Comparison submitter or declared evaluation settings do not match",
        ));
    }
    Ok(())
}
pub(crate) async fn validate_submission(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    bundle: Uuid,
    report: &ComparisonRequest,
    principal: &str,
) -> ApiResult<bool> {
    let Some(binding) = &report.evaluation else {
        return Ok(false);
    };
    let row = sqlx::query("SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3 FOR UPDATE")
        .bind(project).bind(bundle).bind(path(&binding.request_id)?).fetch_optional(&mut **tx).await.map_err(db)?
        .ok_or_else(|| invalid("Evaluation request not found"))?;
    let managed = row.get::<String, _>("requested_by") == "service:connected-learning";
    let evaluation = decode(row)?;
    if evaluation.status != "running" {
        return Err(conflict());
    }
    validate_report(&evaluation, report, principal, principal)?;
    sqlx::query("UPDATE evaluation_requests SET last_activity_at=now() WHERE id=$1")
        .bind(path(&evaluation.id)?)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    Ok(managed)
}
