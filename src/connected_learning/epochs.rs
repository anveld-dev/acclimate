use super::{
    Descriptor, absent, app_principal, config, conflict, denied, enrollment_view, invalid,
    learning_admin, validate,
};
use crate::{ApiErr, ApiResult, AppState, db};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Renewal {
    renewal_id: Uuid,
    expected_revision: i64,
    proposal_admissions: i32,
    audits: Vec<Descriptor>,
}

pub(super) fn valid_fingerprints(descriptor: &Descriptor) -> bool {
    let cases = &descriptor.case_fingerprints;
    let families = &descriptor.family_fingerprints;
    let case_count = descriptor.expected_cases.len();
    cases.len() <= case_count
        && families.len() <= case_count
        && descriptor
            .dataset_digest
            .iter()
            .chain(cases)
            .chain(families)
            .all(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
}

pub(super) fn registry_error(error: sqlx::Error) -> ApiErr {
    if error
        .as_database_error()
        .and_then(|database| database.constraint())
        == Some("connected_learning_cohort_exclusive")
    {
        return conflict(
            "A dataset or case identity overlaps another learning cohort for this bundle",
        );
    }
    db(error)
}

pub(super) async fn renew(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(request): Json<Renewal>,
) -> ApiResult<Json<Value>> {
    let actor = learning_admin(&s, &h, &project)?;
    if request.renewal_id.is_nil()
        || request.expected_revision < 0
        || !(0..=100).contains(&request.proposal_admissions)
        || request.audits.len() > 32
        || (request.proposal_admissions == 0 && request.audits.is_empty())
    {
        return Err(invalid(
            "A renewal must add up to 100 proposals or 32 audits",
        ));
    }

    let body = serde_json::to_value(&request).map_err(db)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "admin").await?;
    let enabled: bool = sqlx::query_scalar(
        "SELECT enabled FROM integrations WHERE project_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(&project)
    .bind(integration)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(absent)?;
    let row = sqlx::query(
        "SELECT * FROM connected_learning_enrollments
         WHERE project_id=$1 AND integration_id=$2 FOR UPDATE",
    )
    .bind(&project)
    .bind(integration)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(absent)?;
    if app_principal(&row, &actor.principal) {
        return Err(denied());
    }
    if let Some((prior, revision)) = sqlx::query_as::<_, (Value, i64)>(
        "SELECT request,revision FROM connected_learning_renewals
         WHERE project_id=$1 AND integration_id=$2 AND renewal_id=$3",
    )
    .bind(&project)
    .bind(integration)
    .bind(request.renewal_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    {
        if prior != body {
            return Err(conflict("Renewal ID already binds different settings"));
        }
        let mut view = enrollment_view(&row, enabled, true)?;
        view["appliedRenewalRevision"] = json!(revision);
        return Ok(Json(view));
    }

    if !enabled
        || row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("stopped_at")
            .is_some()
    {
        return Err(conflict("Connection learning is inactive"));
    }
    let revision: i64 = row.get("renewal_revision");
    if revision != request.expected_revision {
        return Err(conflict("Renewal revision has changed"));
    }
    let revision = revision
        .checked_add(1)
        .ok_or_else(|| conflict("Renewal revision limit reached"))?;
    let limit = row
        .get::<i32, _>("max_proposal_admissions")
        .checked_add(request.proposal_admissions)
        .ok_or_else(|| conflict("Proposal admission limit reached"))?;

    let audits = serde_json::to_value(&request.audits).map_err(db)?;
    if !request.audits.is_empty() {
        let mut window = config(&row)?;
        window.max_proposal_admissions = request.proposal_admissions.max(1);
        window.audits = request.audits;
        validate(&window)?;
    }
    let updated = sqlx::query(
        "UPDATE connected_learning_enrollments
         SET max_proposal_admissions=$3,audits=audits || $4,renewal_revision=$5
         WHERE project_id=$1 AND integration_id=$2 RETURNING *",
    )
    .bind(&project)
    .bind(integration)
    .bind(limit)
    .bind(audits)
    .bind(revision)
    .fetch_one(&mut *tx)
    .await
    .map_err(registry_error)?;
    sqlx::query(
        "INSERT INTO connected_learning_renewals(project_id,integration_id,renewal_id,request,revision,authorized_by)
         VALUES($1,$2,$3,$4,$5,$6)",
    )
    .bind(&project)
    .bind(integration)
    .bind(request.renewal_id)
    .bind(body)
    .bind(revision)
    .bind(actor.principal)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    let mut view = enrollment_view(&updated, true, true)?;
    view["appliedRenewalRevision"] = json!(revision);
    Ok(Json(view))
}

pub(crate) async fn audit_is_fresh(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    bundle: Uuid,
    integration: Uuid,
    index: i32,
) -> ApiResult<bool> {
    sqlx::query_scalar(
        "SELECT connected_learning_audit_registered(project_id,bundle_id,integration_id,$4,audits->$4)
         FROM connected_learning_enrollments WHERE (project_id,bundle_id,integration_id)=($1,$2,$3)",
    )
    .bind(project)
    .bind(bundle)
    .bind(integration)
    .bind(index)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)
}

pub(super) async fn remaining_audits(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<i64> {
    sqlx::query_scalar(
        "SELECT count(*) FROM connected_learning_enrollments e
         CROSS JOIN LATERAL jsonb_array_elements(e.audits) WITH ORDINALITY AS a(descriptor,n)
         WHERE (e.project_id,e.integration_id)=($1,$2)
           AND NOT EXISTS (
              SELECT 1 FROM connected_learning_rounds r
              WHERE (r.project_id,r.integration_id,r.audit_index)=(e.project_id,e.integration_id,(n-1)::integer)
           )
           AND connected_learning_audit_registered(e.project_id,e.bundle_id,e.integration_id,(n-1)::integer,descriptor)",
    )
    .bind(project)
    .bind(integration)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)
}
