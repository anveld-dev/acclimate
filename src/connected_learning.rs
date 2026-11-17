use crate::{ApiErr, ApiResult, AppState, BundlePayload, CaseKey, PromoteRequest, db, err};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) mod epochs;

pub(crate) const CONNECTION_HEADER: &str = "x-acclimate-integration-id";

pub(crate) fn internal_channel(channel: &str) -> bool {
    channel
        .strip_prefix("learn-")
        .is_some_and(crate::commands::guided_uuid)
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning",
            get(inspect).put(enroll),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/stop",
            post(stop),
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
    pub dataset_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub case_fingerprints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub family_fingerprints: Vec<String>,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    installation_id: String,
    permitted_paths: Vec<String>,
    max_proposal_admissions: i32,
    development: Descriptor,
    audits: Vec<Descriptor>,
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
    let descriptors = std::iter::once(&config.development).chain(&config.audits);
    let mut revisions = HashSet::new();
    let mut case_ids = HashSet::new();
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
    for descriptor in descriptors {
        let unique_cases: HashSet<_> = descriptor.expected_cases.iter().collect();
        let ids: HashSet<_> = descriptor
            .expected_cases
            .iter()
            .map(|case| &case.case_id)
            .collect();
        if !bounded(&descriptor.dataset_revision, 1024)
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
        max_proposal_admissions: row.get("max_proposal_admissions"),
        development: serde_json::from_value(row.get("development")).map_err(db)?,
        audits: serde_json::from_value(row.get("audits")).map_err(db)?,
        automatic_rollout: row.get("automatic_rollout"),
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
    value["enabled"] = json!(enabled);
    if !include_audits {
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
        if previous_rollout == request.automatic_rollout
            && previous_rollback == request.automatic_rollback
        {
            return Ok(Json(enrollment_view(&row, true, true)?));
        }
        if (!previous_rollout && request.automatic_rollout)
            || (previous_rollback != request.automatic_rollback
                && request.automatic_rollback == Some(true))
        {
            validate_grants()?;
        }
        let row = sqlx::query("UPDATE connected_learning_enrollments SET automatic_rollout=$3,authorized_by=$4,automatic_rollback=$5 WHERE project_id=$1 AND integration_id=$2 RETURNING *")
            .bind(&project).bind(integration).bind(request.automatic_rollout).bind(&actor.principal).bind(request.automatic_rollback)
            .fetch_one(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        return Ok(Json(enrollment_view(&row, true, true)?));
    }
    if expected_rollout.is_some() {
        return Err(conflict(
            "Learning enrollment must exist for a rollout precondition",
        ));
    }
    validate(&request)?;
    validate_grants()?;
    let bundle: Uuid = connection.get("bundle_id");
    let source: String = connection.get("channel");
    let current = sqlx::query("SELECT c.revision,v.id,v.payload FROM channels c JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(c.project_id,c.bundle_id,c.version_id) WHERE (c.project_id,c.bundle_id,c.name)=($1,$2,$3) FOR SHARE OF c")
        .bind(&project).bind(bundle).bind(&source).fetch_one(&mut *tx).await.map_err(db)?;
    let payload: BundlePayload =
        serde_json::from_slice(&current.get::<Vec<u8>, _>("payload")).map_err(db)?;
    if request
        .permitted_paths
        .iter()
        .any(|path| !payload.files.iter().any(|file| file.path == *path))
    {
        return Err(invalid(
            "Permitted paths must exist in the enrolled bundle version",
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
        },
    )
    .await?;
    let row = sqlx::query("INSERT INTO connected_learning_enrollments(project_id,integration_id,bundle_id,source_channel,source_revision,delivery_channel,installation_id,permitted_paths,max_proposal_admissions,development,audits,automatic_rollout,outcome_principal,evaluator_principal,authorized_by,automatic_rollback) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *")
        .bind(&project).bind(integration).bind(bundle).bind(&source).bind(current.get::<i64, _>("revision")).bind(delivery).bind(&request.installation_id)
        .bind(&request.permitted_paths).bind(request.max_proposal_admissions)
        .bind(serde_json::to_value(&request.development).map_err(db)?).bind(serde_json::to_value(&request.audits).map_err(db)?)
        .bind(request.automatic_rollout).bind(&request.outcome_principal).bind(&request.evaluator_principal).bind(&actor.principal).bind(request.automatic_rollback.unwrap_or(true))
        .fetch_one(&mut *tx).await.map_err(epochs::registry_error)?;
    tx.commit().await.map_err(db)?;
    Ok(Json(enrollment_view(&row, true, true)?))
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
    let rounds: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'outcomeId',outcome_id,'state',state,'reason',reason,'parentVersionId',parent_version_id,'candidateVersionId',candidate_version_id,'proposalId',proposal_id,'developmentRequestId',development_request_id,'developmentComparisonId',development_comparison_id,'auditRequestId',audit_request_id,'auditComparisonId',audit_comparison_id,'promotionId',promotion_id,'fieldAudits',jsonb_build_object('windowSize',field_audit_window_size,'regressions',field_audit_regressions,'rollbackPromotionId',rollback_promotion_id)) FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(project).bind(integration).fetch_all(&mut *tx).await.map_err(db)?;
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
    enrollment(&mut tx, &project, integration).await?;
    let row = sqlx::query("SELECT e.*,i.enabled FROM connected_learning_enrollments e JOIN integrations i ON (i.project_id,i.id)=(e.project_id,e.integration_id) WHERE e.project_id=$1 AND e.integration_id=$2 FOR UPDATE OF e")
        .bind(&project).bind(integration).fetch_one(&mut *tx).await.map_err(db)?;
    if row.get::<String, _>("outcome_principal") != actor.principal {
        return Err(denied());
    }
    let permitted_paths: Vec<String> = row.get("permitted_paths");
    if let Some(lesson) = &outcome.lesson
        && (!bounded(&lesson.instruction, 4096) || !permitted_paths.contains(&lesson.path))
    {
        return Err(invalid(
            "Lesson must supply a bounded instruction for a permitted path",
        ));
    }
    if let Some(feedback) = &outcome.feedback
        && (!bounded(&feedback.expected, 2048)
            || !bounded(&feedback.observed, 2048)
            || feedback.expected.trim() == feedback.observed.trim())
    {
        return Err(invalid(
            "Feedback must describe a bounded expected and observed discrepancy",
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
    let (delivery_revision, field_parent) = match (
        outcome.started_receipt_id,
        &outcome.delivery_revision,
    ) {
        (None, None) => (None, None),
        (Some(receipt), Some(revision)) if !receipt.is_nil() => {
            let delivery_revision = revision
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0 && value.to_string() == *revision)
                .ok_or_else(|| invalid("A canonical delivery revision is required"))?;
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
            .bind(revision)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if !correlated {
                return Err(invalid(
                    "A matching fresh channel-started delivery receipt is required",
                ));
            }
            let parent = sqlx::query_scalar(
                "SELECT r.parent_version_id FROM connected_learning_rounds r
                 JOIN promotions p ON (p.project_id,p.bundle_id,p.id)=(r.project_id,r.bundle_id,r.promotion_id)
                 JOIN channels c ON (c.project_id,c.bundle_id,c.name,c.revision,c.version_id)
                                  =(p.project_id,p.bundle_id,p.channel,p.revision,p.version_id)
                 WHERE (r.project_id,r.bundle_id,r.integration_id)=($1,$2,$3)
                   AND (p.channel,p.revision,p.version_id)=($4,$5,$6)
                   AND r.state='promoted'",
            )
            .bind(&project).bind(bundle).bind(integration).bind(row.get::<String,_>("delivery_channel"))
            .bind(delivery_revision).bind(outcome.version_id)
            .fetch_optional(&mut *tx).await.map_err(db)?;
            (Some(delivery_revision), parent)
        }
        _ => {
            return Err(invalid(
                "Started receipt and delivery revision are required together",
            ));
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO connected_learning_outcomes(project_id,integration_id,bundle_id,outcome_id,
             version_id,digest,status,lesson,feedback,submitted_by,fingerprint,
             started_receipt_id,delivery_revision,field_parent_version_id)
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
    .bind(actor.principal)
    .bind(&fingerprint)
    .bind(outcome.started_receipt_id)
    .bind(delivery_revision)
    .bind(field_parent)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if inserted.rows_affected() != 1 {
        return Err(conflict(
            "Delivery receipt already binds a different outcome",
        ));
    }
    let response = outcome_response(&mut tx, &project, bundle, &outcome, field_parent).await?;
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
    let row = enrollment(&mut tx, &project, integration).await?;
    if row.get::<String, _>("evaluator_principal") != actor.principal {
        return Err(denied());
    }
    let active = row.get::<bool, _>("enabled")
        && row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("stopped_at")
            .is_none();
    let items: Vec<Value> = if active {
        sqlx::query_scalar("SELECT jsonb_build_object('roundId',r.id,'evaluationRequestId',e.id,'phase', CASE WHEN e.id=r.audit_request_id THEN 'audit' ELSE 'development' END,'status',e.status) FROM connected_learning_rounds r JOIN connected_learning_enrollments enrollment ON (enrollment.project_id,enrollment.integration_id)=(r.project_id,r.integration_id) JOIN evaluation_requests e ON e.project_id=r.project_id AND e.bundle_id=r.bundle_id AND e.id=CASE r.state WHEN 'audit' THEN r.audit_request_id WHEN 'development' THEN r.development_request_id END WHERE r.project_id=$1 AND r.integration_id=$2 AND e.status IN ('requested','running') AND (r.state <> 'audit' OR connected_learning_audit_registered(r.project_id,r.bundle_id,r.integration_id,r.audit_index,enrollment.audits->r.audit_index)) ORDER BY r.created_at,r.id LIMIT 100")
            .bind(project).bind(integration).fetch_all(&mut *tx).await.map_err(db)?
    } else {
        vec![]
    };
    Ok(Json(
        json!({"installationId":row.get::<String,_>("installation_id"),"bundleId":row.get::<Uuid,_>("bundle_id"),"active":active,"items":items}),
    ))
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
        "SELECT integration_id,CASE WHEN audit_request_id=$3 THEN audit_index END AS audit_index,CASE WHEN audit_request_id=$3 THEN 'audit' ELSE 'development' END AS phase FROM connected_learning_rounds WHERE project_id=$1 AND bundle_id=$2 AND (development_request_id=$3 OR audit_request_id=$3)",
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
    if let Some(index) = round.get::<Option<i32>, _>("audit_index")
        && !epochs::audit_is_fresh(tx, project, bundle, integration, index).await?
    {
        return Err(conflict("Audit cohort is not independently registered"));
    }
    if starting {
        let active: bool = sqlx::query_scalar("SELECT stopped_at IS NULL FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2 FOR SHARE")
            .bind(project).bind(integration).fetch_one(&mut **tx).await.map_err(db)?;
        let current: bool = sqlx::query_scalar(
            "SELECT state=$3 FROM connected_learning_rounds WHERE project_id=$1 AND integration_id=$2 AND (development_request_id=$4 OR audit_request_id=$4)",
        )
        .bind(project).bind(integration).bind(round.get::<String, _>("phase")).bind(evaluation)
        .fetch_one(&mut **tx).await.map_err(db)?;
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
