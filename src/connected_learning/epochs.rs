use super::{
    Descriptor, absent, app_principal, config, conflict, denied, enrollment_view, invalid,
    learning_admin,
    repetitions::Plan,
    selection::{Policies, Stage},
    statistics::{AUDIT_Z, Calibration},
    validate_descriptors,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    development: Option<Descriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selection_policies: Option<Policies>,
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

pub(super) async fn save_policy_epoch(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO connected_learning_policy_epochs(project_id,integration_id,epoch,development,selection_policies)
        SELECT project_id,integration_id,policy_epoch,development,selection_policies
        FROM connected_learning_enrollments WHERE (project_id,integration_id)=($1,$2)")
        .bind(project).bind(integration).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

pub(super) async fn register_cohorts(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    bundle: Uuid,
    integration: Uuid,
    development: Option<&Descriptor>,
    previous_count: usize,
    audits: &[Descriptor],
) -> ApiResult<()> {
    if development.is_none() && audits.is_empty() {
        return Ok(());
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('connected-learning-cohorts:' || $1 || ':' || $2::uuid::text, 0))")
        .bind(project).bind(bundle).execute(&mut **tx).await.map_err(db)?;
    let registrations = development
        .into_iter()
        .map(|descriptor| (None, descriptor))
        .chain(
            audits
                .iter()
                .enumerate()
                .map(|(index, descriptor)| (Some((previous_count + index) as i32), descriptor)),
        );
    for (slot, descriptor) in registrations {
        sqlx::query("SELECT connected_learning_register($1,$2,$3,$4,$5)")
            .bind(project)
            .bind(bundle)
            .bind(integration)
            .bind(slot)
            .bind(serde_json::to_value(descriptor).map_err(db)?)
            .execute(&mut **tx)
            .await
            .map_err(registry_error)?;
    }
    Ok(())
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
    let rotate = request.development.is_some() || request.selection_policies.is_some();
    if request.renewal_id.is_nil()
        || request.expected_revision < 0
        || !(0..=100).contains(&request.proposal_admissions)
        || request.audits.len() > 32
        || (request.proposal_admissions == 0 && request.audits.is_empty() && !rotate)
    {
        return Err(invalid(
            "Renew up to 100 proposals, 32 audits, or rotate the evaluation policy",
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
    let command = crate::commands::DurableCommand::new(
        &project,
        integration,
        "renew",
        &actor.principal,
        request.renewal_id,
        body.clone(),
    );
    if let Some(response) = command
        .replay(&mut tx, || {
            conflict("Renewal ID already binds different settings")
        })
        .await?
    {
        return Ok(Json(response));
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
    let settings = config(&row)?;
    let development = request
        .development
        .as_ref()
        .unwrap_or(&settings.development);
    let policies = request
        .selection_policies
        .as_ref()
        .or(settings.selection_policies.as_ref());
    let previous_epoch = row.get::<i64, _>("policy_epoch");
    let epoch = if rotate {
        if settings.automatic_rollout {
            crate::auth::authorize_transaction(&mut tx, &actor, &project, "promote").await?;
        }
        let reviews = sqlx::query(
            "SELECT * FROM connected_learning_rounds
            WHERE (project_id,integration_id)=($1,$2) AND state='awaiting_review'",
        )
        .bind(&project)
        .bind(integration)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        for round in reviews {
            crate::connected_learning_worker::expire_review(&mut tx, &round).await?;
        }
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2
             AND state IN ('proposing','development','audit','awaiting_review'))"
        ).bind(&project).bind(integration).fetch_one(&mut *tx).await.map_err(db)?;
        if active {
            return Err(conflict(
                "Selection and development may rotate only between rounds",
            ));
        }
        crate::connected_learning_worker::discard_developed(
            &mut tx,
            &project,
            integration,
            previous_epoch,
        )
        .await?;
        sqlx::query(
            "INSERT INTO connected_learning_incumbent_events
            (project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,
             source_revision,version_id,chain_length,reason)
            SELECT project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,
                   source_revision,baseline_version_id,0,'policy epoch rotated'
            FROM (SELECT * FROM connected_learning_incumbent_events
                WHERE (project_id,integration_id,policy_epoch)=($1,$2,$3)
                ORDER BY sequence DESC LIMIT 1) head WHERE chain_length>0",
        )
        .bind(&project)
        .bind(integration)
        .bind(previous_epoch)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        previous_epoch
            .checked_add(1)
            .ok_or_else(|| conflict("Policy epoch limit reached"))?
    } else {
        previous_epoch
    };
    if rotate || !request.audits.is_empty() {
        validate_descriptors(development, &request.audits, settings.automatic_rollout)?;
        if let Some(policies) = policies {
            policies.development.validate(&[development], None)?;
            let spent = sqlx::query_scalar::<_, i32>(
                "SELECT audit_index FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2 AND audit_index IS NOT NULL AND NOT audit_released"
            ).bind(&project).bind(integration).fetch_all(&mut *tx).await.map_err(db)?
            .into_iter().collect::<std::collections::HashSet<_>>();
            let future_audits = settings
                .audits
                .iter()
                .enumerate()
                .filter(|(i, d)| {
                    !spent.contains(&(*i as i32)) && (!settings.automatic_rollout || d.committed())
                })
                .map(|(_, d)| d)
                .chain(&request.audits)
                .collect::<Vec<_>>();
            policies.audit.validate(
                &future_audits,
                settings.selection_policies.as_ref().map(|p| &p.audit),
            )?;
        }
    }
    let updated = sqlx::query(
        "UPDATE connected_learning_enrollments
         SET max_proposal_admissions=$3,audits=audits || $4,renewal_revision=$5,
             development=$6,selection_policies=$7,policy_epoch=$8
         WHERE project_id=$1 AND integration_id=$2 RETURNING *",
    )
    .bind(&project)
    .bind(integration)
    .bind(limit)
    .bind(audits)
    .bind(revision)
    .bind(serde_json::to_value(development).map_err(db)?)
    .bind(policies.map(serde_json::to_value).transpose().map_err(db)?)
    .bind(epoch)
    .fetch_one(&mut *tx)
    .await
    .map_err(registry_error)?;
    if rotate {
        save_policy_epoch(&mut tx, &project, integration).await?;
    }
    if !rotate && !request.audits.is_empty() {
        extend_repetition_plan(
            &mut tx,
            &project,
            integration,
            epoch,
            settings.audits.len(),
            &request.audits,
            policies,
        )
        .await?;
    }
    register_cohorts(
        &mut tx,
        &project,
        row.get("bundle_id"),
        integration,
        request.development.as_ref(),
        settings.audits.len(),
        &request.audits,
    )
    .await?;
    let mut view = enrollment_view(&updated, true, true)?;
    view["appliedRenewalRevision"] = json!(revision);
    command.finish(tx, view).await
}

async fn extend_repetition_plan(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
    epoch: i64,
    previous_count: usize,
    audits: &[Descriptor],
    policies: Option<&Policies>,
) -> ApiResult<()> {
    let stored: Option<(Value, Value)> = sqlx::query_as(
        "SELECT noise_calibration,repetition_plan
         FROM connected_learning_policy_epochs
         WHERE (project_id,integration_id,epoch)=($1,$2,$3) AND repetition_plan IS NOT NULL",
    )
    .bind(project)
    .bind(integration)
    .bind(epoch)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let Some((calibration, mut view)) = stored else {
        return Ok(());
    };
    let calibration: Calibration = serde_json::from_value(calibration).map_err(db)?;
    let mut plan: Plan = serde_json::from_value(view["plan"].take()).map_err(db)?;
    let defaults = Policies::default();
    let policies = policies.unwrap_or(&defaults);
    let target = policies
        .audit
        .target_effect
        .or(policies.development.target_effect);
    plan.extend_audits(audits);
    let projections = view["auditProjections"]
        .as_array_mut()
        .ok_or_else(|| db("Missing audit power projections"))?;
    let mut stopped = None;
    for (offset, audit) in audits.iter().enumerate() {
        let projection = plan.project(
            audit,
            Some(previous_count + offset),
            &calibration,
            policies.audit.threshold(Stage::Audit),
            AUDIT_Z,
            target,
        );
        stopped = stopped.or_else(|| projection.stop_reason(target, "Audit"));
        projections.push(json!(projection));
    }
    view["plan"] = json!(plan);
    sqlx::query(
        "UPDATE connected_learning_policy_epochs
         SET repetition_plan=$4,calibration_stopped_reason=COALESCE(calibration_stopped_reason,$5)
         WHERE (project_id,integration_id,epoch)=($1,$2,$3)",
    )
    .bind(project)
    .bind(integration)
    .bind(epoch)
    .bind(view)
    .bind(stopped)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

pub(super) async fn remaining_audits(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<i64> {
    sqlx::query_scalar(
        "SELECT count(*) FROM connected_learning_available_audits
         WHERE (project_id,integration_id)=($1,$2)",
    )
    .bind(project)
    .bind(integration)
    .fetch_one(&mut **tx)
    .await
    .map_err(db)
}
