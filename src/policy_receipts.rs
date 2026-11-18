use crate::{ApiResult, AppState, db, err, path};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    request_id: String,
    attempt_id: String,
    policy: Policy,
    verdict: String,
    checks: Vec<Check>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    id: String,
    revision: String,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Check {
    code: String,
    result: String,
}

fn valid(report: &Report) -> bool {
    let token = |s: &str, bytes: usize| !s.trim().is_empty() && s.len() <= bytes;
    let digest = report.policy.sha256.strip_prefix("sha256:");
    if !token(&report.policy.id, 128)
        || !token(&report.policy.revision, 1024)
        || !token(&report.attempt_id, 128)
        || !digest.is_some_and(|s| {
            s.len() == 64 && s.bytes().all(|b| matches!(b,b'0'..=b'9'|b'a'..=b'f'))
        })
        || report.checks.is_empty()
        || report.checks.len() > 16
    {
        return false;
    }
    if !report.checks.iter().all(|c| match c.code.as_str() {
        "evidence.incomplete" | "analysis.nonfinite" | "cost.unknown" => c.result == "unknown",
        "policy.minimum_mean_improvement"
        | "policy.maximum_case_regression"
        | "policy.candidate_threshold"
        | "policy.maximum_candidate_task_failures"
        | "policy.maximum_candidate_cost"
        | "policy.maximum_cost_increase" => matches!(c.result.as_str(), "pass" | "fail"),
        _ => false,
    }) {
        return false;
    }
    let unknown = report.checks.iter().any(|c| c.result == "unknown");
    let failed = report.checks.iter().any(|c| c.result == "fail");
    match report.verdict.as_str() {
        "pass" => !unknown && !failed,
        "fail" => failed,
        "indeterminate" => unknown,
        _ => false,
    }
}

fn receipt(row: PgRow) -> Value {
    let mut body: Value = row.get("body");
    body["comparisonId"] = json!(row.get::<Uuid, _>("comparison_id"));
    body["reportedBy"] = json!(row.get::<String, _>("reported_by"));
    body["receivedAt"] = json!(row.get::<DateTime<Utc>, _>("received_at").to_rfc3339());
    body
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/{p}/bundles/{b}/comparisons/{id}/policy-receipts",
            get(list).post(record),
        )
        .route(
            "/v1/projects/{p}/bundles/{b}/versions/{id}/policy-receipts",
            get(blockers),
        )
}

type Scope = Path<(String, String, String)>;
async fn list(
    State(s): State<AppState>,
    Path((p, b, id)): Scope,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible =
        crate::connected_learning::audit_visible(crate::improvement::AUDIT_COMPARISON_MATCH, 4, 5);
    let found = sqlx::query_scalar::<_,bool>(&format!("SELECT EXISTS(SELECT 1 FROM comparisons c WHERE c.project_id=$1 AND c.bundle_id=$2 AND c.id=$3 AND {visible})"))
        .bind(&p).bind(path(&b)?).bind(path(&id)?).bind(principal).bind(reviewer).fetch_one(&mut *tx).await.map_err(db)?;
    if !found {
        return Err(err(
            StatusCode::NOT_FOUND,
            "not_found",
            "Comparison not found",
        ));
    }
    let rows = sqlx::query("SELECT * FROM evaluation_policy_receipts WHERE project_id=$1 AND bundle_id=$2 AND comparison_id=$3 ORDER BY received_at,policy_digest")
        .bind(p).bind(path(&b)?).bind(path(&id)?).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"items":rows.into_iter().map(receipt).collect::<Vec<_>>()}),
    ))
}

async fn blockers(
    State(s): State<AppState>,
    Path((p, b, id)): Scope,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible =
        crate::connected_learning::audit_visible(crate::improvement::AUDIT_COMPARISON_MATCH, 4, 5);
    let rows=sqlx::query(&format!("SELECT pr.* FROM evaluation_policy_receipts pr JOIN comparisons c ON c.id=pr.comparison_id
        WHERE c.project_id=$1 AND c.bundle_id=$2 AND pr.candidate_version_id=$3 AND pr.body->>'verdict'<>'pass' AND {visible} ORDER BY pr.received_at,pr.comparison_id,pr.policy_digest"))
        .bind(&p).bind(path(&b)?).bind(path(&id)?).bind(principal).bind(reviewer).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"items":rows.into_iter().map(receipt).collect::<Vec<_>>()}),
    ))
}

async fn record(
    State(s): State<AppState>,
    Path((p, b, id)): Scope,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&h, &s, &p, "write")?;
    if actor.user_id.is_some() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "machine_principal_required",
            "Report policy receipts with the evaluator machine principal",
        ));
    }
    let q: Report = serde_json::from_slice(&body).map_err(|_| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Malformed policy receipt",
        )
    })?;
    let (bundle, comparison, request) = (path(&b)?, path(&id)?, path(&q.request_id)?);
    if !valid(&q) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Invalid policy receipt",
        ));
    }
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &p, "write").await?;
    let candidate=sqlx::query_scalar::<_,Uuid>("SELECT (c.body->>'candidateVersionId')::uuid FROM comparisons c JOIN evaluation_requests e
          ON (e.project_id,e.bundle_id,e.comparison_id)=(c.project_id,c.bundle_id,c.id)
          WHERE c.project_id=$1 AND c.bundle_id=$2 AND c.id=$3 AND e.id=$4 AND e.attempt_id=$5 AND e.status IN ('completed','failed')
          AND c.submitter=$6 AND e.evaluator_principal=$6 AND c.body#>>'{evaluation,requestId}'=e.id::text AND c.body#>>'{evaluation,attemptId}'=e.attempt_id")
        .bind(&p).bind(bundle).bind(comparison).bind(request).bind(&q.attempt_id).bind(&actor.principal).fetch_optional(&mut *tx).await.map_err(db)?
        .ok_or_else(||err(StatusCode::CONFLICT,"policy_binding_mismatch","The comparison, settled attempt and evaluator principal must match"))?;
    // Serialize reporting with releases of this exact immutable candidate.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("policy-receipt:{p}:{bundle}:{candidate}"))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let body = serde_json::to_value(&q).map_err(db)?;
    sqlx::query("INSERT INTO evaluation_policy_receipts(project_id,bundle_id,candidate_version_id,comparison_id,policy_digest,body,reported_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (comparison_id,policy_digest) DO NOTHING")
        .bind(&p).bind(bundle).bind(candidate).bind(comparison).bind(&q.policy.sha256).bind(&body).bind(&actor.principal).execute(&mut *tx).await.map_err(db)?;
    let row = sqlx::query(
        "SELECT * FROM evaluation_policy_receipts WHERE comparison_id=$1 AND policy_digest=$2",
    )
    .bind(comparison)
    .bind(&q.policy.sha256)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if row.get::<Value, _>("body") != body {
        return Err(err(
            StatusCode::CONFLICT,
            "policy_receipt_conflict",
            "A different receipt is already recorded for this comparison and policy digest",
        ));
    }
    let out = receipt(row);
    tx.commit().await.map_err(db)?;
    Ok(Json(out))
}
