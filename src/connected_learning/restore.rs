use super::{absent, app_principal, bounded, conflict, denied, invalid};
use crate::{ApiResult, AppState, PromoteRequest, db};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum TargetKind {
    Delivery,
    Source,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: TargetKind,
    revision: String,
    version_id: Uuid,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Restore {
    restore_id: Uuid,
    expected_revision: String,
    target: Target,
    reason: String,
}

fn revision(text: &str) -> ApiResult<i64> {
    text.parse::<i64>()
        .ok()
        .filter(|v| *v > 0 && v.to_string() == text)
        .ok_or_else(|| invalid("Expected a canonical positive channel revision"))
}

/// Only previously served managed versions or the currently published source
/// may be selected. The POST rechecks eligibility under the enrollment lock.
pub(super) async fn targets(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<Vec<Value>> {
    sqlx::query_scalar(
        "WITH enrollment AS (
             SELECT e.bundle_id,e.source_channel,e.delivery_channel,d.revision,d.version_id
             FROM connected_learning_enrollments e
             JOIN channels d ON (d.project_id,d.bundle_id,d.name)=(e.project_id,e.bundle_id,e.delivery_channel)
             WHERE e.project_id=$1 AND e.integration_id=$2 AND d.revision>0
         ), targets AS (
             SELECT 'source' AS kind,c.revision,c.version_id,e.revision AS current_revision,0 AS ordering
             FROM enrollment e JOIN channels c ON (c.project_id,c.bundle_id,c.name)=($1,e.bundle_id,e.source_channel)
             WHERE c.version_id<>e.version_id
             UNION ALL
             SELECT 'delivery',p.revision,p.version_id,e.revision,1
             FROM enrollment e JOIN promotions p ON (p.project_id,p.bundle_id,p.channel)=($1,e.bundle_id,e.delivery_channel)
             WHERE p.revision<e.revision AND p.version_id<>e.version_id
         )
         SELECT jsonb_build_object('kind',kind,'revision',revision::text,'versionId',version_id)
         FROM targets WHERE connected_field_eligible($1,$2,version_id,current_revision)
         ORDER BY ordering,revision DESC LIMIT 101",
    )
    .bind(project)
    .bind(integration)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)
}

pub(super) async fn restore(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(request): Json<Restore>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&h, &s, &project, "promote")?;
    if request.restore_id.is_nil() || !bounded(&request.reason, 1024) {
        return Err(invalid(
            "A restore ID and a reviewed reason of at most 1024 bytes are required",
        ));
    }
    let expected = revision(&request.expected_revision)?;
    let target_revision = revision(&request.target.revision)?;
    let body = serde_json::to_value(&request).map_err(db)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "promote").await?;
    // Take the same integration-then-enrollment locks used by the scheduler.
    let enabled: bool = sqlx::query_scalar(
        "SELECT enabled FROM integrations WHERE project_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(&project)
    .bind(integration)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(absent)?;
    let enrollment = sqlx::query("SELECT * FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2 FOR UPDATE")
        .bind(&project).bind(integration).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(absent)?;
    if app_principal(&enrollment, &actor.principal) {
        return Err(denied());
    }
    let command = crate::commands::DurableCommand::new(
        &project,
        integration,
        "restore",
        &actor.principal,
        request.restore_id,
        body,
    );
    if let Some(response) = command
        .replay(&mut tx, || {
            conflict("Restore ID already binds a different review")
        })
        .await?
    {
        return Ok(Json(response));
    }
    if !enabled {
        return Err(conflict("Connection is disabled"));
    }
    let bundle: Uuid = enrollment.get("bundle_id");
    let delivery: String = enrollment.get("delivery_channel");
    let target_id = request.target.version_id;
    let (current_version, current_revision): (Uuid, i64) = sqlx::query_as(
        "SELECT version_id,revision FROM channels WHERE (project_id,bundle_id,name)=($1,$2,$3) FOR UPDATE",
    )
    .bind(&project)
    .bind(bundle)
    .bind(&delivery)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if current_revision != expected || current_version == target_id {
        return Err(conflict(
            "Restore requires the current delivery revision and a different target",
        ));
    }
    let eligible_release = match request.target.kind {
        TargetKind::Delivery => sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM promotions
                 WHERE (project_id,bundle_id,channel,revision,version_id)=($1,$2,$3,$4,$5)
                 AND revision<$6)",
        )
        .bind(&project)
        .bind(bundle)
        .bind(&delivery)
        .bind(target_revision)
        .bind(target_id)
        .bind(expected)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?,
        TargetKind::Source => {
            // Hold the source row through commit so a concurrent publication
            // cannot silently change which source release the operator reviewed.
            let current_source: Option<(i64, Uuid)> = sqlx::query_as(
                "SELECT revision,version_id FROM channels WHERE (project_id,bundle_id,name)=($1,$2,$3) FOR SHARE",
            )
            .bind(&project)
            .bind(bundle)
            .bind(enrollment.get::<String, _>("source_channel"))
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
            current_source == Some((target_revision, target_id))
        }
    };
    if !eligible_release {
        return Err(conflict(
            "Target must match a prior delivery or the current published source revision",
        ));
    }
    let eligible: bool = sqlx::query_scalar("SELECT connected_field_eligible($1,$2,$3,$4)")
        .bind(&project)
        .bind(integration)
        .bind(target_id)
        .bind(expected)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if !eligible {
        return Err(conflict(
            "Withdrawn content requires field requalification before restoration",
        ));
    }
    let promotion = crate::channels::promote_in_tx(
        &mut tx,
        &project,
        bundle,
        &delivery,
        &actor.principal,
        PromoteRequest {
            version_id: target_id.to_string(),
            expected_revision: request.expected_revision,
            comparison_id: None,
            unevaluated_reason: Some(request.reason),
            policy_override: None,
        },
        crate::channels::Publication::Restore(match request.target.kind {
            TargetKind::Delivery => &delivery,
            TargetKind::Source => enrollment.get::<&str, _>("source_channel"),
        }),
    )
    .await?;
    let rounds = sqlx::query(
        "SELECT * FROM connected_learning_rounds WHERE (project_id,integration_id)=($1,$2)
         AND state IN ('proposing','development','audit','awaiting_review')",
    )
    .bind(&project)
    .bind(integration)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    for round in rounds {
        crate::connected_learning_worker::close(
            &mut tx,
            &round,
            "Delivery changed by reviewed restore",
        )
        .await?;
    }
    let response = serde_json::to_value(&promotion).map_err(db)?;
    command.finish(tx, response).await
}
