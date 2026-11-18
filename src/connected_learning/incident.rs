use super::*;

pub(super) async fn inspect(
    State(s): State<AppState>,
    Path((project, integration, outcome)): Path<(String, Uuid, Uuid)>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::auth::read_transaction(&s, &headers, &project).await?;
    let available = epochs::remaining_audits(&mut tx, &project, integration).await?;
    // Read the historical release, field verdict and current target in one database snapshot.
    let result: Value = sqlx::query_scalar(include_str!("outcome_status.sql"))
        .bind(&project)
        .bind(integration)
        .bind(outcome)
        .bind(available)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "not_found",
                "Outcome not found on this connection",
            )
        })?;
    Ok(Json(result))
}

pub(super) async fn work(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<Vec<Value>> {
    sqlx::query_scalar(
        "SELECT jsonb_build_object('roundId',r.id,'outcomeId',r.outcome_id,'versionId',v.id,
                  'digest',v.digest,'baselineRevision',r.parent_revision::text)
         FROM connected_learning_rounds r JOIN versions v ON v.id=r.candidate_version_id
         JOIN connected_learning_enrollments e ON (e.project_id,e.integration_id)=(r.project_id,r.integration_id)
         JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
         WHERE (r.project_id,r.integration_id)=($1,$2) AND r.state='development' AND r.incident_replay='pending'
           AND (c.version_id,c.revision)=(r.parent_version_id,r.parent_revision)",
    ).bind(project).bind(integration).fetch_all(&mut **tx).await.map_err(db)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Verdict {
    round_id: Uuid,
    outcome_id: Uuid,
    version_id: Uuid,
    digest: String,
    baseline_revision: String,
    verdict: String,
}

pub(super) async fn submit(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<Verdict>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&headers, &s, &project, "write")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "write").await?;
    let active = crate::connected_learning_worker::evaluator_active(
        &mut tx,
        &s,
        &project,
        integration,
        &actor.principal,
    )
    .await?;
    let revision = corrections::revision(&input.baseline_revision)?;
    if !matches!(
        input.verdict.as_str(),
        "pass" | "regression" | "unavailable"
    ) {
        return Err(invalid("Unknown incident replay verdict"));
    }
    // The enrollment/connection lock serializes verdicts with state transitions.
    let row = sqlx::query(
        "SELECT r.state,r.incident_replay,(c.version_id,c.revision)=(r.parent_version_id,r.parent_revision) AS current
         FROM connected_learning_rounds r JOIN versions v ON v.id=r.candidate_version_id
         JOIN connected_learning_enrollments e ON (e.project_id,e.integration_id)=(r.project_id,r.integration_id)
         JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
         WHERE (r.project_id,r.integration_id,r.id,r.outcome_id,v.id,v.digest,r.parent_revision)=($1,$2,$3,$4,$5,$6,$7)",
    ).bind(&project).bind(integration).bind(input.round_id).bind(input.outcome_id).bind(input.version_id)
     .bind(&input.digest).bind(revision).fetch_optional(&mut *tx).await.map_err(db)?
     .ok_or_else(|| conflict("Incident replay identity does not match this round"))?;
    let saved: Option<String> = row.get("incident_replay");
    if saved.as_deref() != Some(&input.verdict) {
        if !active
            || !row.get::<bool, _>("current")
            || row.get::<String, _>("state") != "development"
            || saved.as_deref() != Some("pending")
        {
            return Err(conflict(
                "Incident replay is not pending for this candidate",
            ));
        }
        sqlx::query("UPDATE connected_learning_rounds SET incident_replay=$2 WHERE id=$1")
            .bind(input.round_id)
            .bind(&input.verdict)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"accepted":true})))
}
