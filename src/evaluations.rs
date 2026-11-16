use crate::pagination::{ListQuery, Page};
use crate::{ApiResult, AppState, CaseKey, ComparisonRequest, db, err, path};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
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
    #[serde(default)]
    pub require_bound_evidence: bool,
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
fn decode(r: PgRow) -> ApiResult<Evaluation> {
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
    })
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests",
            get(list).post(create),
        )
        .route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}",
            get(detail),
        )
        .route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/start",
            post(start),
        )
        .route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/finish",
            post(finish),
        )
        .route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/interrupt",
            post(interrupt),
        )
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
}
async fn create(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    let q: CreateEvaluationRequest =
        serde_json::from_slice(&body).map_err(|_| invalid("Malformed request"))?;
    let route = format!("/v1/projects/{p}/bundles/{b}/evaluation-requests");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    if !bounded(&q) {
        return Err(invalid(
            "Evaluation request exceeds limits or has duplicate cases",
        ));
    }
    let bid = path(&b)?;
    let parent = path(&q.parent_version_id)?;
    let candidate = path(&q.candidate_version_id)?;
    let rows=sqlx::query("SELECT id,digest,parent_version_id FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=ANY($3)").bind(&p).bind(bid).bind(vec![parent,candidate]).fetch_all(&mut *cmd.tx).await.map_err(db)?;
    if !rows.iter().any(|r| {
        r.get::<Uuid, _>("id") == parent && r.get::<String, _>("digest") == q.parent_digest
    }) || !rows.iter().any(|r| {
        r.get::<Uuid, _>("id") == candidate
            && r.get::<String, _>("digest") == q.candidate_digest
            && r.get::<Option<Uuid>, _>("parent_version_id") == Some(parent)
    }) {
        return Err(invalid(
            "Version identities or candidate parent do not match",
        ));
    }
    if let Some(proposal) = &q.proposal_id {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM proposals WHERE project_id=$1 AND bundle_id=$2 AND id=$3 AND parent_version_id=$4 AND candidate_version_id=$5 AND status='succeeded')").bind(&p).bind(bid).bind(path(proposal)?).bind(parent).bind(candidate).fetch_one(&mut *cmd.tx).await.map_err(db)?;
        if !valid {
            return Err(invalid("Proposal does not match candidate"));
        }
    }
    let row=sqlx::query("INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status) VALUES($1,$2,$3,$4,$5,'requested') RETURNING *").bind(Uuid::new_v4()).bind(p).bind(bid).bind(serde_json::to_value(q).map_err(db)?).bind(a.principal).fetch_one(&mut *cmd.tx).await.map_err(db)?;
    crate::commands::finish_mutation(cmd, StatusCode::CREATED, decode(row)?).await
}
async fn detail(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<Evaluation>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let row = sqlx::query(
        "SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3",
    )
    .bind(p)
    .bind(path(&b)?)
    .bind(path(&id)?)
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
    let c =
        crate::pagination::resolve(&mut tx, "evaluation_requests", &p, bid, q.cursor.as_deref())
            .await?;
    let rows=sqlx::query("SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5").bind(&p).bind(bid).bind(c.map(|x|x.0)).bind(c.map(|x|x.1)).bind(n+1).fetch_all(&mut *tx).await.map_err(db)?;
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
async fn transition(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
    body: Bytes,
    action: &str,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    let route = format!("/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/{action}");
    let mut cmd = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let bid = path(&b)?;
    let eid = path(&id)?;
    let row=sqlx::query("SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3 FOR UPDATE").bind(&p).bind(bid).bind(eid).fetch_optional(&mut *cmd.tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Evaluation request not found"))?;
    let mut e = decode(row)?;
    match action {
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
    let r=sqlx::query("UPDATE evaluation_requests SET status=$4,evaluator_principal=$5,attempt_id=$6,comparison_id=$7,error=$8,updated_at=CASE WHEN status=$4 AND evaluator_principal IS NOT DISTINCT FROM $5 AND attempt_id IS NOT DISTINCT FROM $6 AND comparison_id IS NOT DISTINCT FROM $7 AND error IS NOT DISTINCT FROM $8 THEN updated_at ELSE now() END WHERE project_id=$1 AND bundle_id=$2 AND id=$3 RETURNING *").bind(p).bind(bid).bind(eid).bind(e.status).bind(e.evaluator_principal).bind(e.attempt_id).bind(e.comparison_id.as_deref().map(path).transpose()?).bind(e.error).fetch_one(&mut *cmd.tx).await.map_err(db)?;
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
    if let Some(binding) = &c.evaluation {
        if binding.request_id != e.id
            || Some(binding.attempt_id.as_str()) != e.attempt_id.as_deref()
        {
            return Err(conflict());
        }
    } else if x.require_bound_evidence {
        return Err(invalid(
            "This evaluation requires request and attempt bound evidence",
        ));
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
) -> ApiResult<()> {
    let Some(binding) = &report.evaluation else {
        return Ok(());
    };
    let row = sqlx::query("SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3 FOR UPDATE")
        .bind(project).bind(bundle).bind(path(&binding.request_id)?).fetch_optional(&mut **tx).await.map_err(db)?
        .ok_or_else(|| invalid("Evaluation request not found"))?;
    let evaluation = decode(row)?;
    if evaluation.status != "running" {
        return Err(conflict());
    }
    validate_report(&evaluation, report, principal, principal)
}
