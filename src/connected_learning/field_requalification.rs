use super::{Connection, Tx, conflict};
use crate::{ApiResult, AppState, db, err};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Replay {
    version_id: Uuid,
    digest: String,
    baseline_revision: String,
    outcome_id: Uuid,
    verdict: super::field_audits::Verdict,
}

async fn evaluator(
    tx: &mut Tx<'_>,
    state: &AppState,
    headers: &HeaderMap,
    project: String,
    integration: Uuid,
) -> ApiResult<Connection> {
    let actor = crate::auth::actor(headers, state, &project, "write")?;
    crate::auth::authorize_transaction(tx, &actor, &project, "write").await?;
    let c = Connection::lock(tx, state, project, integration)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Enrollment not found"))?;
    if c.evaluator != actor.principal {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Independent field evaluator required",
        ));
    }
    if !c.active {
        return Err(conflict("Field auditing authority is inactive"));
    }
    Ok(c)
}

async fn digest(tx: &mut Tx<'_>, c: &Connection, candidate: Uuid) -> ApiResult<String> {
    sqlx::query_scalar("SELECT digest FROM versions WHERE (project_id,bundle_id,id)=($1,$2,$3)")
        .bind(&c.project)
        .bind(c.bundle)
        .bind(candidate)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Version not found"))
}

pub(super) async fn eligible(
    tx: &mut Tx<'_>,
    c: &Connection,
    candidate: Uuid,
    revision: i64,
) -> ApiResult<bool> {
    sqlx::query_scalar("SELECT connected_field_eligible($1,$2,$3,$4)")
        .bind(&c.project)
        .bind(c.integration)
        .bind(candidate)
        .bind(revision)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)
}

pub(super) async fn inspect(
    State(s): State<AppState>,
    Path((project, integration, candidate)): Path<(String, Uuid, Uuid)>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = s.db.begin().await.map_err(db)?;
    let c = evaluator(&mut tx, &s, &headers, project, integration).await?;
    let revision = c.baseline(&mut tx).await?.1;
    let digest = digest(&mut tx, &c, candidate).await?;
    let (pending,failed): (Vec<Uuid>,Vec<Uuid>) = sqlx::query_as(
        "SELECT COALESCE(array_agg(outcome_id ORDER BY sequence) FILTER (WHERE replay IS NULL),'{}'::uuid[]),
                COALESCE(array_agg(outcome_id ORDER BY sequence) FILTER (WHERE replay='regression'),'{}'::uuid[])
         FROM connected_field_requirements($1,$2,$3,$4)")
        .bind(&c.project).bind(integration).bind(candidate).bind(revision).fetch_one(&mut *tx).await.map_err(db)?;
    Ok(Json(
        json!({"versionId":candidate,"digest":digest,"baselineRevision":revision.to_string(),
                    "pendingOutcomeIds":pending,"failedOutcomeIds":failed}),
    ))
}

pub(super) async fn submit(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    headers: HeaderMap,
    Json(replay): Json<Replay>,
) -> ApiResult<Json<Value>> {
    let mut tx = s.db.begin().await.map_err(db)?;
    let c = evaluator(&mut tx, &s, &headers, project, integration).await?;
    let revision = replay
        .baseline_revision
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0 && v.to_string() == replay.baseline_revision)
        .ok_or_else(|| conflict("Invalid baseline revision"))?;
    if digest(&mut tx, &c, replay.version_id).await? != replay.digest {
        return Err(conflict("Field replay candidate digest does not match"));
    }
    let (sequence, previous): (i64, Option<String>) = sqlx::query_as(
        "SELECT sequence,replay FROM connected_field_requirements($1,$2,$3,$4) WHERE outcome_id=$5",
    )
    .bind(&c.project)
    .bind(integration)
    .bind(replay.version_id)
    .bind(revision)
    .bind(replay.outcome_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| conflict("Outcome is not a required field replay for these bytes"))?;
    if let Some(previous) = previous {
        if previous != replay.verdict.as_str() {
            return Err(conflict("A different field replay result already exists"));
        }
    } else {
        if c.baseline(&mut tx).await?.1 != revision {
            return Err(conflict("Field replay baseline has changed"));
        }
        sqlx::query("INSERT INTO connected_learning_field_requalifications
            (regression_sequence,candidate_version_id,baseline_revision,verdict,evaluator_principal) VALUES ($1,$2,$3,$4,$5)")
            .bind(sequence).bind(replay.version_id).bind(revision).bind(replay.verdict.as_str()).bind(&c.evaluator)
            .execute(&mut *tx).await.map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(Json(json!({"accepted":true})))
}

pub(super) async fn check_required_replays(
    tx: &mut Tx<'_>,
    c: &Connection,
    round: &sqlx::postgres::PgRow,
) -> ApiResult<bool> {
    use sqlx::Row;
    let candidate = round.get("candidate_version_id");
    let revision = round.get("parent_revision");
    if eligible(tx, c, candidate, revision).await? {
        return Ok(true);
    }
    let id: Uuid = round.get("id");
    let terminal: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT FROM connected_field_requirements($1,$2,$3,$4) WHERE replay='regression')
           OR EXISTS(SELECT FROM connected_learning_rounds WHERE id=$5 AND updated_at < now()-interval '24 hours')")
        .bind(&c.project).bind(c.integration).bind(candidate).bind(revision).bind(id).fetch_one(&mut **tx).await.map_err(db)?;
    if terminal {
        super::close(
            tx,
            round,
            "Withdrawn content failed or timed out awaiting field requalification",
        )
        .await?;
    }
    Ok(false)
}
