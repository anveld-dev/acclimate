//! Optional activity reports. No lease, takeover, cancellation, or replay semantics.
use crate::WorkspaceRoutes;
use crate::{ApiResult, AppState, CaseKey, db, err, path};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    attempt_id: String,
    sequence: i64,
    phase: Phase,
    completed: i32,
    total: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    case: Option<ProgressCase>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgressCase {
    case_id: String,
    repetition: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Preparing,
    Executing,
    Grading,
    Submitting,
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .workspace_route(
            "/v1/projects/{p}/bundles/{b}/evaluation-requests/{id}/progress",
            get(read).post(report),
        )
        .layer(DefaultBodyLimit::max(2048))
}
fn conflict() -> crate::ApiErr {
    err(
        StatusCode::CONFLICT,
        "evaluation_progress_conflict",
        "Progress owner, attempt, sequence or counts do not match",
    )
}
fn missing() -> crate::ApiErr {
    err(
        StatusCode::NOT_FOUND,
        "not_found",
        "Evaluation request not found",
    )
}

async fn view(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    row: &sqlx::postgres::PgRow,
) -> ApiResult<serde_json::Value> {
    let checked_at: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
    let observation = sqlx::query(
        "SELECT body,received_at FROM evaluation_progress WHERE request_id=$1 AND expires_at>$2",
    )
    .bind(row.get::<Uuid, _>("id"))
    .bind(checked_at)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let status: String = row.get("status");
    let mut activity = "absent";
    let observation = observation.map(|r| {
        let received_at: DateTime<Utc> = r.get("received_at");
        activity =
            if status == "running" && checked_at <= received_at + chrono::Duration::seconds(60) {
                "fresh"
            } else {
                "stale"
            };
        let mut body: serde_json::Value = r.get("body");
        body["receivedAt"] = serde_json::json!(received_at.to_rfc3339());
        body["evaluatorPrincipal"] =
            serde_json::json!(row.get::<Option<String>, _>("evaluator_principal"));
        body
    });
    Ok(
        serde_json::json!({"schemaVersion":1,"requestId":row.get::<Uuid,_>("id"),"status":status,"attemptId":row.get::<Option<String>,_>("attempt_id"),"observation":observation,"activity":activity,"checkedAt":checked_at.to_rfc3339(),"staleAfterSeconds":60}),
    )
}
async fn read(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible = crate::connected_learning::audit_visible("r.audit_request_id=e.id", 4, 5);
    // Same lock order as reporting/lifecycle transitions gives a coherent snapshot.
    let row = sqlx::query(&format!(
        "SELECT e.* FROM evaluation_requests e WHERE e.project_id=$1 AND e.bundle_id=$2 AND e.id=$3 AND {visible} FOR SHARE OF e",
    ))
    .bind(&p).bind(path(&b)?).bind(path(&id)?).bind(principal).bind(reviewer)
    .fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(missing)?;
    Ok(Json(view(&mut tx, &row).await?))
}
async fn report(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    let actor = crate::auth::actor(&h, &s, &p, "evaluate")?;
    let q: Progress = serde_json::from_slice(&body).map_err(|_| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Malformed progress report",
        )
    })?;
    if !(1..=9_007_199_254_740_991).contains(&q.sequence)
        || q.attempt_id.trim().is_empty()
        || q.attempt_id.len() > 128
        || q.completed < 0
        || q.completed > q.total
        || !(1..=2000).contains(&q.total)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Progress exceeds bounded sequence or count limits",
        ));
    }
    let canonical = serde_json::to_value(&q).map_err(db)?;
    let fingerprint = crate::digest(&serde_json::to_vec(&canonical).map_err(db)?);
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &p, "evaluate").await?;
    let row = sqlx::query("SELECT * FROM evaluation_requests WHERE project_id=$1 AND bundle_id=$2 AND id=$3 FOR UPDATE")
        .bind(&p).bind(path(&b)?).bind(path(&id)?).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(missing)?;
    if row.get::<String, _>("status") != "running"
        || row
            .get::<Option<String>, _>("evaluator_principal")
            .as_deref()
            != Some(actor.principal.as_str())
        || row.get::<Option<String>, _>("attempt_id").as_deref() != Some(q.attempt_id.as_str())
    {
        return Err(conflict());
    }
    let request: crate::evaluations::CreateEvaluationRequest =
        serde_json::from_value(row.get("body")).map_err(db)?;
    if q.total != (request.expected_cases.len() * 2) as i32
        || q.completed < row.get::<i32, _>("progress_completed")
        || q.case.as_ref().is_some_and(|c| {
            !request.expected_cases.contains(&CaseKey {
                case_id: c.case_id.clone(),
                repetition: c.repetition,
            })
        })
    {
        return Err(conflict());
    }
    let previous: i64 = row.get("progress_sequence");
    if q.sequence < previous
        || (q.sequence == previous
            && row
                .get::<Option<String>, _>("progress_fingerprint")
                .as_deref()
                != Some(fingerprint.as_str()))
    {
        return Err(conflict());
    }
    if q.sequence > previous {
        sqlx::query("UPDATE evaluation_requests SET progress_sequence=$2,progress_completed=$3,progress_fingerprint=$4,last_activity_at=now() WHERE id=$1")
            .bind(row.get::<Uuid,_>("id")).bind(q.sequence).bind(q.completed).bind(fingerprint).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO evaluation_progress(request_id,body,received_at,expires_at) VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '24 hours') ON CONFLICT(request_id) DO UPDATE SET body=EXCLUDED.body,received_at=clock_timestamp(),expires_at=clock_timestamp()+interval '24 hours'")
            .bind(row.get::<Uuid,_>("id")).bind(canonical).execute(&mut *tx).await.map_err(db)?;
    }
    // Bounded opportunistic retention. SKIP LOCKED avoids cross-request deadlocks.
    sqlx::query("DELETE FROM evaluation_progress WHERE request_id IN (SELECT request_id FROM evaluation_progress WHERE expires_at<=clock_timestamp() ORDER BY expires_at,request_id LIMIT 100 FOR UPDATE SKIP LOCKED)")
        .execute(&mut *tx).await.map_err(db)?;
    let response = view(&mut tx, &row).await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(response))
}
