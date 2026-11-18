use crate::{ApiErr, ApiResult, AppState, BundlePayload, CaseKey, PromoteRequest, db, err};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

mod corrections;
pub(crate) mod epochs;
mod incident;
mod restore;
pub(crate) mod selection;
pub(crate) mod statistics;

pub(crate) const CONNECTION_HEADER: &str = "x-acclimate-integration-id";

pub(crate) fn internal_channel(channel: &str) -> bool {
    channel
        .strip_prefix("learn-")
        .is_some_and(crate::commands::guided_uuid)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/corrections",
            post(corrections::submit),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/rechecks",
            post(corrections::recheck),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning",
            get(inspect).put(enroll),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/stop",
            post(stop),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/restore",
            post(restore::restore),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/renew",
            post(epochs::renew),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/outcomes",
            post(submit_outcome),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/outcomes/{outcome}",
            get(incident::inspect),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/incident-replays",
            post(incident::submit),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/work",
            get(work),
        )
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Descriptor {
    pub dataset_revision: String,
    pub runtime: HashMap<String, String>,
    pub grader_revision: String,
    pub expected_cases: Vec<CaseKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixture_protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub case_fingerprints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub family_fingerprints: Vec<String>,
}

const FIXTURE_DATASET_KEY: &str = "acclimate.fixtures.v1.dataset";
const FIXTURE_INPUTS_KEY: &str = "acclimate.fixtures.v1.inputs";

impl Descriptor {
    pub(crate) fn committed(&self) -> bool {
        self.fixture_protocol.as_deref() == Some("installed-v1")
    }

    // Both entries survive normal request/report identity checks. The inputs entry binds the
    // exact fingerprints the cohort registry used for detecting overlap across assignments.
    pub(crate) fn evaluation_runtime(&self) -> HashMap<String, String> {
        let mut runtime = self.runtime.clone();
        if self.committed()
            && let Some(digest) = &self.dataset_digest
        {
            let mut inputs = self.case_fingerprints.clone();
            inputs.sort_unstable();
            runtime.insert(FIXTURE_DATASET_KEY.into(), digest.clone());
            runtime.insert(
                FIXTURE_INPUTS_KEY.into(),
                hex::encode(Sha256::digest(inputs.join("\n"))),
            );
        }
        runtime
    }
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    installation_id: String,
    permitted_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skill_packages: Option<crate::proposal_edits::SkillPackages>,
    max_proposal_admissions: i32,
    development: Descriptor,
    audits: Vec<Descriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selection_policies: Option<selection::Policies>,
    automatic_rollout: bool,
    #[serde(default, skip_serializing)]
    expected_automatic_rollout: Option<bool>,
    automatic_rollback: Option<bool>,
    outcome_principal: String,
    evaluator_principal: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lesson {
    path: String,
    instruction: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum TerminalStatus {
    Completed,
    Failed,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Feedback {
    expected: String,
    observed: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskOutcome {
    outcome_id: Uuid,
    version_id: Uuid,
    digest: String,
    status: TerminalStatus,
    lesson: Option<Lesson>,
    feedback: Option<Feedback>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_receipt_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_revision: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    require_incident_replay: bool,
}

fn invalid(message: &str) -> ApiErr {
    err(StatusCode::BAD_REQUEST, "invalid_content", message)
}

fn absent() -> ApiErr {
    err(
        StatusCode::NOT_FOUND,
        "not_found",
        "Learning enrollment not found",
    )
}

fn conflict(message: &str) -> ApiErr {
    err(StatusCode::CONFLICT, "learning_conflict", message)
}

fn denied() -> ApiErr {
    err(
        StatusCode::FORBIDDEN,
        "denied",
        "Learning authority required",
    )
}

fn learning_admin(s: &AppState, h: &HeaderMap, project: &str) -> ApiResult<crate::auth::Actor> {
    let actor = crate::auth::actor(h, s, project, "write")?;
    if actor.user_id.is_some() {
        crate::auth::actor(h, s, project, "admin")?;
    } else {
        crate::auth::actor(h, s, project, "promote")?;
    }
    Ok(actor)
}

fn bounded(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit
}

fn validate(config: &Enrollment) -> ApiResult<()> {
    if !bounded(&config.installation_id, 128)
        || !bounded(&config.outcome_principal, 1024)
        || !bounded(&config.evaluator_principal, 1024)
        || config.outcome_principal == config.evaluator_principal
        || !(1..=100).contains(&config.max_proposal_admissions)
        || !(1..=32).contains(&config.permitted_paths.len())
        || config.permitted_paths.iter().collect::<HashSet<_>>().len()
            != config.permitted_paths.len()
        || !(1..=32).contains(&config.audits.len())
    {
        return Err(invalid("Invalid enrollment controls"));
    }
    validate_descriptors(
        &config.development,
        &config.audits,
        config.automatic_rollout,
    )?;
    if let Some(policies) = &config.selection_policies {
        policies
            .development
            .validate(&[&config.development], None)?;
        policies
            .audit
            .validate(&config.audits.iter().collect::<Vec<_>>(), None)?;
    }
    Ok(())
}

fn validate_descriptors(
    development: &Descriptor,
    audits: &[Descriptor],
    automatic: bool,
) -> ApiResult<()> {
    let mut revisions = HashSet::new();
    let mut case_ids = HashSet::new();
    for descriptor in std::iter::once(development).chain(audits) {
        let unique_cases: HashSet<_> = descriptor.expected_cases.iter().collect();
        let ids: HashSet<_> = descriptor
            .expected_cases
            .iter()
            .map(|case| &case.case_id)
            .collect();
        if automatic && !descriptor.committed() {
            return Err(invalid(
                "Automatic rollout requires installed-v1 development and audit fixtures",
            ));
        }
        if descriptor.fixture_protocol.is_some() && !descriptor.committed()
            || descriptor.runtime.contains_key(FIXTURE_DATASET_KEY)
            || descriptor.runtime.contains_key(FIXTURE_INPUTS_KEY)
            || (descriptor.committed()
                && (descriptor.dataset_digest.is_none()
                    || descriptor.case_fingerprints.len() != ids.len()
                    || descriptor.runtime.len() > 62))
            || !bounded(&descriptor.dataset_revision, 1024)
            || !revisions.insert(&descriptor.dataset_revision)
            || !bounded(&descriptor.grader_revision, 1024)
            || descriptor.runtime.is_empty()
            || descriptor.runtime.len() > 64
            || descriptor
                .runtime
                .iter()
                .any(|(key, value)| !bounded(key, 128) || !bounded(value, 4096))
            || !(1..=1000).contains(&descriptor.expected_cases.len())
            || unique_cases.len() != descriptor.expected_cases.len()
            || !epochs::valid_fingerprints(descriptor)
            || ids
                .iter()
                .any(|id| !bounded(id, 1024) || case_ids.contains(id))
        {
            return Err(invalid(
                "Evaluation descriptors must be valid and declare disjoint cohorts",
            ));
        }
        case_ids.extend(ids);
    }
    Ok(())
}

fn app_principal(row: &PgRow, principal: &str) -> bool {
    principal == row.get::<String, _>("outcome_principal")
        || principal == row.get::<String, _>("evaluator_principal")
}

fn config(row: &PgRow) -> ApiResult<Enrollment> {
    Ok(Enrollment {
        installation_id: row.get("installation_id"),
        permitted_paths: row.get("permitted_paths"),
        skill_packages: row
            .get::<Option<Value>, _>("skill_packages")
            .map(serde_json::from_value)
            .transpose()
            .map_err(db)?,
        max_proposal_admissions: row.get("max_proposal_admissions"),
        development: serde_json::from_value(row.get("development")).map_err(db)?,
        audits: serde_json::from_value(row.get("audits")).map_err(db)?,
        automatic_rollout: row.get("automatic_rollout"),
        selection_policies: row
            .get::<Option<Value>, _>("selection_policies")
            .map(serde_json::from_value)
            .transpose()
            .map_err(db)?,
        expected_automatic_rollout: None,
        automatic_rollback: Some(row.get("automatic_rollback")),
        outcome_principal: row.get("outcome_principal"),
        evaluator_principal: row.get("evaluator_principal"),
    })
}

fn enrollment_view(row: &PgRow, enabled: bool, include_audits: bool) -> ApiResult<Value> {
    let settings = config(row)?;
    let audit_count = settings.audits.len();
    let mut value = serde_json::to_value(settings).map_err(db)?;
    value["auditCount"] = json!(audit_count);
    value["policyEpoch"] = json!(row.get::<i64, _>("policy_epoch"));
    value["enabled"] = json!(enabled);
    if !include_audits {
        value.as_object_mut().unwrap().remove("selectionPolicies");
        value
            .as_object_mut()
            .expect("Enrollment serializes as an object")
            .remove("audits");
    }
    value["projectId"] = json!(row.get::<String, _>("project_id"));
    value["integrationId"] = json!(row.get::<Uuid, _>("integration_id"));
    value["bundleId"] = json!(row.get::<Uuid, _>("bundle_id"));
    value["channel"] = json!(row.get::<String, _>("source_channel"));
    value["authorizedBy"] = json!(row.get::<String, _>("authorized_by"));
    value["proposalAdmissions"] = json!(row.get::<i32, _>("proposal_admissions"));
    value["renewalRevision"] = json!(row.get::<i64, _>("renewal_revision"));
    value["stoppedAt"] = json!(row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("stopped_at"));
    Ok(value)
}

async fn enrollment(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
) -> ApiResult<PgRow> {
    sqlx::query("SELECT e.*, i.enabled FROM connected_learning_enrollments e JOIN integrations i ON (i.project_id,i.id)=(e.project_id,e.integration_id) WHERE e.project_id=$1 AND e.integration_id=$2 FOR SHARE OF i")
        .bind(project).bind(integration).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(absent)
}

async fn enroll(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(mut request): Json<Enrollment>,
) -> ApiResult<Json<Value>> {
    let actor = learning_admin(&s, &h, &project)?;
    if actor.principal == request.outcome_principal
        || actor.principal == request.evaluator_principal
    {
        return Err(denied());
    }
    if request.automatic_rollout {
        crate::auth::actor(&h, &s, &project, "promote")?;
    }
    let enrolled_grant = |principal: &str, rights: &[&str]| {
        s.grants.iter().any(|grant| {
            grant.project_id == project
                && grant.principal_id == principal
                && rights
                    .iter()
                    .all(|right| grant.rights.iter().any(|granted| granted == right))
        })
    };
    let validate_grants = || {
        if !enrolled_grant(&request.outcome_principal, &["write"])
            || !enrolled_grant(&request.evaluator_principal, &["read", "write"])
        {
            return Err(invalid(
                "Outcome and evaluator principals require current project grants",
            ));
        }
        Ok(())
    };
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "admin").await?;
    if request.automatic_rollout {
        crate::auth::authorize_transaction(&mut tx, &actor, &project, "promote").await?;
    }
    if request
        .skill_packages
        .as_ref()
        .is_some_and(|policy| !policy.valid())
    {
        return Err(invalid(
            "Skill package permissions require bounded unique skill names",
        ));
    }
    let expected_rollout = request.expected_automatic_rollout.take();
    let connection = sqlx::query("SELECT bundle_id,channel FROM integrations WHERE project_id=$1 AND id=$2 AND enabled FOR UPDATE")
        .bind(&project).bind(integration).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(absent)?;
    if let Some(row) = sqlx::query(
        "SELECT * FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2",
    )
    .bind(&project)
    .bind(integration)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    {
        if app_principal(&row, &actor.principal) {
            return Err(denied());
        }
        let mut frozen = config(&row)?;
        let previous_packages = frozen.skill_packages.clone();
        request.skill_packages = request
            .skill_packages
            .or_else(|| previous_packages.clone())
            .filter(|policy| policy.enabled());
        let paths_changed = frozen.permitted_paths != request.permitted_paths;
        if paths_changed {
            let mut added = request
                .permitted_paths
                .iter()
                .filter(|path| !frozen.permitted_paths.contains(path));
            let mut removed = frozen
                .permitted_paths
                .iter()
                .filter(|path| !request.permitted_paths.contains(path));
            if !(1..=32).contains(&request.permitted_paths.len())
                || request.permitted_paths.iter().collect::<HashSet<_>>().len()
                    != request.permitted_paths.len()
                || !added.all(|path| {
                    request
                        .skill_packages
                        .as_ref()
                        .is_some_and(|p| p.permits_future_path(path))
                })
                || !removed.all(|path| {
                    previous_packages
                        .as_ref()
                        .is_some_and(|p| p.permits_future_path(path))
                        || request
                            .skill_packages
                            .as_ref()
                            .is_some_and(|p| p.permits_future_path(path))
                })
            {
                return Err(conflict(
                    "Only editable paths inside authorized skill packages can change",
                ));
            }
        }
        let packages_changed = previous_packages != request.skill_packages || paths_changed;
        if packages_changed {
            let active = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2 AND state NOT IN ('rejected','promoted'))")
                .bind(&project).bind(integration).fetch_one(&mut *tx).await.map_err(db)?;
            if active {
                return Err(conflict("Change skill permissions between learning rounds"));
            }
            frozen.skill_packages = request.skill_packages.clone();
            frozen.permitted_paths = request.permitted_paths.clone();
        }
        if request.selection_policies.is_none() {
            request.selection_policies = frozen.selection_policies.clone();
        }
        let previous_rollout = frozen.automatic_rollout;
        if expected_rollout.is_some_and(|expected| expected != previous_rollout) {
            return Err(conflict("Automatic rollout changed before this update"));
        }
        let previous_rollback = frozen.automatic_rollback;
        request.automatic_rollback = request.automatic_rollback.or(previous_rollback);
        frozen.automatic_rollout = request.automatic_rollout;
        frozen.automatic_rollback = request.automatic_rollback;
        if frozen != request {
            return Err(conflict("Enrollment settings are frozen"));
        }
        if !previous_rollout && request.automatic_rollout {
            let registered: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM connected_learning_enrollments e
                 CROSS JOIN LATERAL jsonb_array_elements(e.audits) WITH ORDINALITY AS a(descriptor,n)
                 WHERE (e.project_id,e.integration_id)=($1,$2)
                 AND descriptor->>'fixtureProtocol'='installed-v1'
                )",
            )
            .bind(&project).bind(integration).fetch_one(&mut *tx).await.map_err(db)?;
            if !request.development.committed() || !registered {
                return Err(invalid(
                    "Install committed development and registered audit fixtures before enabling automatic rollout",
                ));
            }
        }
        if !packages_changed
            && previous_rollout == request.automatic_rollout
            && previous_rollback == request.automatic_rollback
        {
            return Ok(Json(enrollment_view(&row, true, true)?));
        }
        let reauthorize = (!previous_rollout && request.automatic_rollout)
            || (previous_rollback != request.automatic_rollback
                && request.automatic_rollback == Some(true));
        if reauthorize {
            validate_grants()?;
            record_authorization(&mut tx, &project, integration, &actor.principal).await?;
        }
        let row = sqlx::query("UPDATE connected_learning_enrollments SET automatic_rollout=$3,authorized_by=COALESCE($4,authorized_by),automatic_rollback=$5,skill_packages=$6,permitted_paths=$7 WHERE project_id=$1 AND integration_id=$2 RETURNING *")
            .bind(&project).bind(integration).bind(request.automatic_rollout).bind(reauthorize.then_some(&actor.principal)).bind(request.automatic_rollback)
            .bind(request.skill_packages.as_ref().map(serde_json::to_value).transpose().map_err(db)?)
            .bind(&request.permitted_paths)
            .fetch_one(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        return Ok(Json(enrollment_view(&row, true, true)?));
    }
    if expected_rollout.is_some() {
        return Err(conflict(
            "Learning enrollment must exist for a rollout precondition",
        ));
    }
    request
        .selection_policies
        .get_or_insert_with(selection::Policies::default);
    request.skill_packages = request.skill_packages.filter(|policy| policy.enabled());
    validate(&request)?;
    validate_grants()?;
    let bundle: Uuid = connection.get("bundle_id");
    let source: String = connection.get("channel");
    let current = sqlx::query("SELECT c.revision,v.id,v.payload FROM channels c JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(c.project_id,c.bundle_id,c.version_id) WHERE (c.project_id,c.bundle_id,c.name)=($1,$2,$3) FOR SHARE OF c")
        .bind(&project).bind(bundle).bind(&source).fetch_one(&mut *tx).await.map_err(db)?;
    let payload: BundlePayload =
        serde_json::from_slice(&current.get::<Vec<u8>, _>("payload")).map_err(db)?;
    if request.permitted_paths.iter().any(|path| {
        !payload.files.iter().any(|file| file.path == *path)
            && !crate::proposal_edits::memory_path(path)
            && !request
                .skill_packages
                .as_ref()
                .is_some_and(|policy| policy.permits_future_path(path))
    }) {
        return Err(invalid(
            "Permitted paths must exist in the enrolled bundle or belong to a permitted new skill",
        ));
    }
    let delivery = format!("learn-{integration}");
    crate::channels::promote_in_tx(
        &mut tx,
        &project,
        bundle,
        &delivery,
        &actor.principal,
        PromoteRequest {
            version_id: current.get::<Uuid, _>("id").to_string(),
            expected_revision: "0".into(),
            comparison_id: None,
            unevaluated_reason: Some(
                "Connection delivery seeded from enrolled source channel".into(),
            ),
            policy_override: None,
        },
        Some(&source),
    )
    .await?;
    let row = sqlx::query("INSERT INTO connected_learning_enrollments(project_id,integration_id,bundle_id,source_channel,source_revision,delivery_channel,installation_id,permitted_paths,max_proposal_admissions,development,audits,automatic_rollout,outcome_principal,evaluator_principal,authorized_by,automatic_rollback,selection_policies,skill_packages) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *")
        .bind(&project).bind(integration).bind(bundle).bind(&source).bind(current.get::<i64, _>("revision")).bind(delivery).bind(&request.installation_id)
        .bind(&request.permitted_paths).bind(request.max_proposal_admissions)
        .bind(serde_json::to_value(&request.development).map_err(db)?).bind(serde_json::to_value(&request.audits).map_err(db)?)
        .bind(request.automatic_rollout).bind(&request.outcome_principal).bind(&request.evaluator_principal).bind(&actor.principal).bind(request.automatic_rollback.unwrap_or(true))
        .bind(request.selection_policies.as_ref().map(serde_json::to_value).transpose().map_err(db)?)
        .bind(request.skill_packages.as_ref().map(serde_json::to_value).transpose().map_err(db)?)
        .fetch_one(&mut *tx).await.map_err(epochs::registry_error)?;
    epochs::register_cohorts(
        &mut tx,
        &project,
        bundle,
        integration,
        Some(&request.development),
        0,
        &request.audits,
    )
    .await?;
    epochs::save_policy_epoch(&mut tx, &project, integration).await?;
    record_authorization(&mut tx, &project, integration, &actor.principal).await?;
    sqlx::query(
        "INSERT INTO connected_learning_field_releases(promotion_id,validated)
        SELECT id,true FROM promotions WHERE (project_id,bundle_id,channel,revision)=($1,$2,$3,1)",
    )
    .bind(&project)
    .bind(bundle)
    .bind(row.get::<String, _>("delivery_channel"))
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(enrollment_view(&row, true, true)?))
}

async fn record_authorization(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    integration: Uuid,
    principal: &str,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO connected_learning_authorizations(project_id,integration_id,principal) VALUES($1,$2,$3)")
        .bind(project).bind(integration).bind(principal).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

async fn inspect(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &project).await?;
    let row = enrollment(&mut tx, &project, integration).await?;
    let include_audits = match learning_admin(&s, &h, &project) {
        Ok(admin) if !app_principal(&row, &admin.principal) => {
            crate::auth::authorize_transaction(&mut tx, &admin, &project, "admin")
                .await
                .is_ok()
        }
        _ => false,
    };
    let mut view = enrollment_view(&row, row.get("enabled"), include_audits)?;
    view["noiseCalibration"] = sqlx::query_scalar::<_, Value>(
        "SELECT jsonb_build_object('requestId',p.calibration_request_id,'status',COALESCE(e.status,'queued'))
             || COALESCE(p.noise_calibration,'{}'::jsonb)
         FROM connected_learning_policy_epochs p
         LEFT JOIN evaluation_requests e ON e.id=p.calibration_request_id
         WHERE (p.project_id,p.integration_id,p.epoch)=($1,$2,$3)",
    ).bind(&project).bind(integration).bind(row.get::<i64,_>("policy_epoch"))
     .fetch_one(&mut *tx).await.map_err(db)?;
    view["remainingAudits"] =
        json!(epochs::remaining_audits(&mut tx, &project, integration).await?);
    let delivery = sqlx::query(
        "SELECT version_id,revision FROM channels WHERE project_id=$1 AND bundle_id=$2 AND name=$3",
    )
    .bind(&project)
    .bind(row.get::<Uuid, _>("bundle_id"))
    .bind(row.get::<String, _>("delivery_channel"))
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    view["deliveredVersionId"] = json!(delivery.get::<Uuid, _>("version_id"));
    view["deliveredRevision"] = json!(delivery.get::<i64, _>("revision").to_string());
    let can_restore = match crate::auth::actor(&h, &s, &project, "promote") {
        Ok(actor) if row.get::<bool, _>("enabled") && !app_principal(&row, &actor.principal) => {
            crate::auth::authorize_transaction(&mut tx, &actor, &project, "promote")
                .await
                .is_ok()
        }
        _ => false,
    };
    view["restoreTargets"] = if can_restore {
        json!(restore::targets(&mut tx, &project, integration).await?)
    } else {
        json!([])
    };
    let rounds: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'policyEpoch',policy_epoch,'outcomeId',outcome_id,'correctionId',correction_id,'attempt',attempt,'incidentReplay',(SELECT replay.incident_replay FROM connected_learning_round_replays replay WHERE replay.round_id=connected_learning_rounds.id),'state',state,'reason',reason,'parentVersionId',parent_version_id,'candidateVersionId',candidate_version_id,'proposalId',proposal_id,'developmentRequestId',development_request_id,'developmentComparisonId',development_comparison_id,'auditRequestId',audit_request_id,'auditComparisonId',audit_comparison_id,'promotionId',promotion_id,'fieldAudits',jsonb_build_object('windowSize',field_audit_window_size,'regressions',field_audit_regressions,'rollbackPromotionId',(SELECT f.rollback_promotion_id FROM connected_learning_field_releases f WHERE f.promotion_id=connected_learning_rounds.promotion_id))) FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(&project).bind(integration).fetch_all(&mut *tx).await.map_err(db)?;
    if include_audits {
        let mut epochs: Vec<i64> = rounds
            .iter()
            .filter_map(|r| r["policyEpoch"].as_i64())
            .collect();
        epochs.push(row.get("policy_epoch"));
        let history: Vec<Value> = sqlx::query_scalar(
            "SELECT jsonb_build_object('policyEpoch',epoch,'development',development,'selectionPolicies',selection_policies)
             FROM connected_learning_policy_epochs WHERE project_id=$1 AND integration_id=$2
             AND epoch=ANY($3) ORDER BY epoch DESC"
        ).bind(&project).bind(integration).bind(epochs)
         .fetch_all(&mut *tx).await.map_err(db)?;
        view["policyHistory"] = json!(history);
    }
    view["rounds"] = json!(rounds);
    Ok(Json(view))
}

async fn stop(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let actor = learning_admin(&s, &h, &project)?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "admin").await?;
    let current = enrollment(&mut tx, &project, integration).await?;
    if app_principal(&current, &actor.principal) {
        return Err(denied());
    }
    let enabled = current.get("enabled");
    let row = sqlx::query("UPDATE connected_learning_enrollments SET stopped_at=COALESCE(stopped_at,now()) WHERE project_id=$1 AND integration_id=$2 RETURNING *")
        .bind(project).bind(integration).fetch_one(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(enrollment_view(&row, enabled, true)?))
}

// Keep the original parent binding in the idempotent outcome response even
// after the connection advances or the original delivery receipt expires.
async fn outcome_response(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    bundle: Uuid,
    outcome: &TaskOutcome,
    parent: Option<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut response = json!({
        "outcomeId": outcome.outcome_id,
        "accepted": true,
        "eligible": outcome.lesson.is_some() || outcome.feedback.is_some(),
    });
    if let Some(parent) = parent {
        let digest: String = sqlx::query_scalar(
            "SELECT digest FROM versions WHERE (project_id,bundle_id,id)=($1,$2,$3)",
        )
        .bind(project)
        .bind(bundle)
        .bind(parent)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        response["fieldAudit"] = json!({"parentVersionId":parent,"parentDigest":digest});
    }
    Ok(Json(response))
}

async fn submit_outcome(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
    Json(outcome): Json<TaskOutcome>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&h, &s, &project, "write")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "write").await?;
    let row = corrections::locked(&mut tx, &project, integration).await?;
    if row.get::<String, _>("outcome_principal") != actor.principal {
        return Err(denied());
    }
    corrections::validate_teaching(&row, outcome.lesson.as_ref(), outcome.feedback.as_ref())?;
    if outcome.require_incident_replay && outcome.lesson.is_none() && outcome.feedback.is_none() {
        return Err(invalid(
            "An incident replay requires a lesson or graded discrepancy",
        ));
    }
    let bundle: Uuid = row.get("bundle_id");
    let body = serde_json::to_value(&outcome).map_err(db)?;
    let fingerprint = crate::digest(&serde_json::to_vec(&body).map_err(db)?);
    let prior = sqlx::query_as::<_, (String, Option<Uuid>)>("SELECT fingerprint,field_parent_version_id FROM connected_learning_outcomes WHERE project_id=$1 AND integration_id=$2 AND bundle_id=$3 AND outcome_id=$4")
        .bind(&project).bind(integration).bind(bundle).bind(outcome.outcome_id).fetch_optional(&mut *tx).await.map_err(db)?;
    if let Some((prior, parent)) = prior {
        if prior != fingerprint {
            return Err(conflict(
                "Outcome ID was already used for different content",
            ));
        }
        return outcome_response(&mut tx, &project, bundle, &outcome, parent).await;
    }
    if !row.get::<bool, _>("enabled")
        || row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("stopped_at")
            .is_some()
    {
        return Err(conflict("Learning admission is closed"));
    }
    let known = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM versions v JOIN promotions p ON (p.project_id,p.bundle_id,p.version_id)=(v.project_id,v.bundle_id,v.id) WHERE (v.project_id,v.bundle_id,v.id,v.digest)=($1,$2,$3,$4) AND ((p.channel=$5 AND p.revision <= $7) OR p.channel=$6))")
        .bind(&project).bind(bundle).bind(outcome.version_id).bind(&outcome.digest)
        .bind(row.get::<String,_>("source_channel")).bind(row.get::<String,_>("delivery_channel")).bind(row.get::<i64,_>("source_revision"))
        .fetch_one(&mut *tx).await.map_err(db)?;
    if !known {
        return Err(invalid(
            "Outcome version and digest must come from this connection",
        ));
    }
    let observed_revision = outcome
        .delivery_revision
        .as_deref()
        .map(corrections::revision)
        .transpose()?;
    if let Some(revision) = observed_revision {
        let served = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM promotions WHERE (project_id,bundle_id,channel,version_id,revision)=($1,$2,$3,$4,$5))")
            .bind(&project).bind(bundle).bind(row.get::<String,_>("delivery_channel"))
            .bind(outcome.version_id).bind(revision).fetch_one(&mut *tx).await.map_err(db)?;
        if !served {
            return Err(invalid(
                "Observed revision did not serve this version on the connection",
            ));
        }
    }
    let field_parent = match (outcome.started_receipt_id, observed_revision) {
        (None, _) => None,
        (Some(receipt), Some(delivery_revision)) if !receipt.is_nil() => {
            let correlated: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM integration_receipts
                   WHERE (project_id,bundle_id,integration_id,event_id,version_id)=($1,$2,$3,$4,$5)
                     AND received_at >= now()-interval '30 days'
                     AND body->>'digest'=$6 AND body->>'channel'=$7 AND body->>'revision'=$8
                     AND body->>'stage'='started' AND body->'stale'='false'::jsonb
                     AND body->>'source' IN ('network','cache'))",
            )
            .bind(&project)
            .bind(bundle)
            .bind(integration)
            .bind(receipt)
            .bind(outcome.version_id)
            .bind(&outcome.digest)
            .bind(row.get::<String, _>("source_channel"))
            .bind(delivery_revision.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if !correlated {
                return Err(invalid(
                    "A matching fresh channel-started delivery receipt is required",
                ));
            }
            sqlx::query_scalar(
                "SELECT f.control_version_id FROM promotions p
                 JOIN connected_learning_field_releases f ON f.promotion_id=p.id
                 JOIN connected_learning_enrollments e ON (e.project_id,e.bundle_id,e.delivery_channel)=(p.project_id,p.bundle_id,p.channel)
                 WHERE (e.project_id,e.bundle_id,e.integration_id) = ($1,$2,$3)
                   AND (p.channel,p.revision,p.version_id)=($4,$5,$6)
                   AND f.control_version_id IS NOT NULL",
            )
            .bind(&project).bind(bundle).bind(integration).bind(row.get::<String,_>("delivery_channel"))
            .bind(delivery_revision).bind(outcome.version_id)
            .fetch_optional(&mut *tx).await.map_err(db)?
        }
        _ => {
            return Err(invalid("A started receipt requires its delivery revision"));
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO connected_learning_outcomes(project_id,integration_id,bundle_id,outcome_id,
             version_id,digest,status,lesson,feedback,submitted_by,fingerprint,
             started_receipt_id,field_parent_version_id,observed_revision)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING",
    )
    .bind(&project)
    .bind(integration)
    .bind(bundle)
    .bind(outcome.outcome_id)
    .bind(outcome.version_id)
    .bind(&outcome.digest)
    .bind(body["status"].as_str())
    .bind(
        outcome
            .lesson
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(db)?,
    )
    .bind(
        outcome
            .feedback
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(db)?,
    )
    .bind(&actor.principal)
    .bind(&fingerprint)
    .bind(outcome.started_receipt_id)
    .bind(field_parent)
    .bind(observed_revision)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if inserted.rows_affected() != 1 {
        return Err(conflict(
            "Delivery receipt already binds a different outcome",
        ));
    }
    let response = outcome_response(&mut tx, &project, bundle, &outcome, field_parent).await?;
    if outcome.lesson.is_some() || outcome.feedback.is_some() {
        corrections::append(&mut tx, &row, &outcome.into(), &actor.principal).await?;
    }
    tx.commit().await.map_err(db)?;
    Ok(response)
}

async fn work(
    State(s): State<AppState>,
    Path((project, integration)): Path<(String, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&h, &s, &project, "write")?;
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
    let row = enrollment(&mut tx, &project, integration).await?;
    let mut rechecks = Vec::new();
    let mut incident_replays = Vec::new();
    let mut field_replays = Vec::new();
    if active {
        sqlx::query(
            "INSERT INTO connected_learning_replay_obligations
            (project_id,integration_id,bundle_id,correction_id,version_id,baseline_revision)
            SELECT project_id,integration_id,bundle_id,correction_id,version_id,revision
            FROM connected_learning_correction_work
            WHERE (project_id,integration_id)=($1,$2) AND action='recheck'
            ORDER BY queued_at,correction_id LIMIT 100
            ON CONFLICT DO NOTHING",
        )
        .bind(&project)
        .bind(integration)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("INSERT INTO connected_learning_replay_obligations
            (project_id,integration_id,bundle_id,regression_sequence,version_id,baseline_revision)
            SELECT r.project_id,r.integration_id,r.bundle_id,q.sequence,r.candidate_version_id,r.parent_revision
            FROM connected_learning_rounds r
            CROSS JOIN LATERAL connected_field_requirements(r.project_id,r.integration_id,r.candidate_version_id,r.parent_revision) q
            WHERE (r.project_id,r.integration_id)=($1,$2) AND r.state IN ('development','audit','awaiting_review')
            AND q.replay IS NULL ON CONFLICT DO NOTHING")
            .bind(&project).bind(integration).execute(&mut *tx).await.map_err(db)?;
        let replays: Vec<(String, Value)> =
            sqlx::query_as(include_str!("connected_learning/replay_work.sql"))
                .bind(&project)
                .bind(integration)
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?;
        for (kind, payload) in replays {
            match kind.as_str() {
                "correction" => rechecks.push(payload),
                "incident" => incident_replays.push(payload),
                "field" => field_replays.push(payload),
                _ => return Err(db("Invalid replay work kind")),
            }
        }
    }
    let items: Vec<Value> = if active {
        sqlx::query_scalar("SELECT payload FROM (
            SELECT jsonb_build_object('roundId',NULL,'evaluationRequestId',e.id,'phase','calibration','status',e.status) AS payload
            FROM connected_learning_policy_epochs p
            JOIN connected_learning_enrollments l ON (l.project_id,l.integration_id,l.policy_epoch)=(p.project_id,p.integration_id,p.epoch)
            JOIN evaluation_requests e ON e.id=p.calibration_request_id
            WHERE (p.project_id,p.integration_id)=($1,$2) AND e.status IN ('requested','running')
            UNION ALL
            SELECT jsonb_build_object('roundId',r.id,'evaluationRequestId',e.id,'phase', CASE WHEN e.id=r.audit_request_id THEN 'audit' ELSE 'development' END,'status',e.status) FROM connected_learning_rounds r JOIN evaluation_requests e ON e.project_id=r.project_id AND e.bundle_id=r.bundle_id AND e.id=CASE r.state WHEN 'audit' THEN r.audit_request_id WHEN 'development' THEN r.development_request_id END WHERE r.project_id=$1 AND r.integration_id=$2 AND e.status IN ('requested','running')  ) assigned LIMIT 100")
            .bind(project).bind(integration).fetch_all(&mut *tx).await.map_err(db)?
    } else {
        vec![]
    };
    let response = json!({"installationId":row.get::<String,_>("installation_id"),
        "bundleId":row.get::<Uuid,_>("bundle_id"),"active":active,"items":items,
        "rechecks":rechecks,"fieldReplays":field_replays,"incidentReplays":incident_replays});
    tx.commit().await.map_err(db)?;
    Ok(Json(response))
}

// Take the connection lock before the enrollment lock, matching stop and admission.
pub(crate) async fn authorize_evaluator(
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
    bundle: Uuid,
    evaluation: Uuid,
    principal: &str,
    starting: bool,
) -> ApiResult<()> {
    let round = sqlx::query(
        "SELECT integration_id,CASE WHEN audit_request_id=$3 THEN 'audit' ELSE 'development' END AS phase FROM connected_learning_rounds WHERE project_id=$1 AND bundle_id=$2 AND (development_request_id=$3 OR audit_request_id=$3)
         UNION ALL
         SELECT p.integration_id,'calibration' FROM connected_learning_policy_epochs p
         JOIN connected_learning_enrollments e USING(project_id,integration_id)
         WHERE (p.project_id,e.bundle_id,p.calibration_request_id)=($1,$2,$3)",
    )
    .bind(project).bind(bundle).bind(evaluation).fetch_optional(&mut **tx).await.map_err(db)?;
    let Some(round) = round else {
        return Ok(());
    };
    let integration = round.get("integration_id");
    let row = enrollment(tx, project, integration).await?;
    if row.get::<String, _>("evaluator_principal") != principal {
        return Err(denied());
    }
    if starting {
        let active: bool = sqlx::query_scalar("SELECT stopped_at IS NULL FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2 FOR SHARE")
            .bind(project).bind(integration).fetch_one(&mut **tx).await.map_err(db)?;
        let phase: String = round.get("phase");
        let current: bool = if phase == "calibration" {
            sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM connected_learning_policy_epochs
                WHERE (project_id,integration_id,epoch,calibration_request_id)=($1,$2,$3,$4))",
            )
            .bind(project)
            .bind(integration)
            .bind(row.get::<i64, _>("policy_epoch"))
            .bind(evaluation)
            .fetch_one(&mut **tx)
            .await
            .map_err(db)?
        } else {
            sqlx::query_scalar(
            "SELECT state=$3 FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2 AND (development_request_id=$4 OR audit_request_id=$4)",
        )
        .bind(project).bind(integration).bind(phase).bind(evaluation)
        .fetch_one(&mut **tx).await.map_err(db)?
        };
        if !active || !current || !row.get::<bool, _>("enabled") {
            return Err(conflict("Learning dispatch is closed"));
        }
    }
    Ok(())
}

/// Readers with promotion authority can inspect audit evidence for review.
pub(crate) async fn audit_reader(
    s: &AppState,
    h: &HeaderMap,
    tx: &mut Transaction<'_, Postgres>,
    project: &str,
) -> ApiResult<(String, bool)> {
    let reader = crate::auth::actor(h, s, project, "read")?;
    let reviewer = match crate::auth::actor(h, s, project, "promote") {
        Ok(actor) => crate::auth::authorize_transaction(tx, &actor, project, "promote")
            .await
            .is_ok(),
        Err(_) => false,
    };
    Ok((reader.principal, reviewer))
}

pub(crate) const AUDIT_READ_FILTER: &str = "FROM connected_learning_rounds r
     JOIN connected_learning_enrollments cl
       ON (cl.project_id,cl.bundle_id,cl.integration_id)=(r.project_id,r.bundle_id,r.integration_id)
     WHERE (r.project_id,r.bundle_id)=($1,$2)";

pub(crate) fn audit_visible(evidence_match: &str, principal: usize, reviewer: usize) -> String {
    format!(
        "NOT EXISTS (SELECT 1 {AUDIT_READ_FILTER}
           AND ({evidence_match})
           AND cl.evaluator_principal <> ${principal}
           AND (NOT ${reviewer} OR cl.outcome_principal = ${principal}))"
    )
}
