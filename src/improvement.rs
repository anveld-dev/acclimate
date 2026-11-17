use crate::ComparisonRequest;
use std::collections::HashSet;

pub fn validate_comparison(q: &ComparisonRequest) -> Result<bool, String> {
    if q.expected_cases.is_empty()
        || q.expected_cases.len() > 1000
        || q.expected_cases
            .iter()
            .any(|key| key.case_id.trim().is_empty())
        || q.runtime.keys().any(|key| key.trim().is_empty())
        || q.dataset_revision.trim().is_empty()
        || q.grader_revision.trim().is_empty()
        || q.runtime.is_empty()
        || q.runtime.values().any(|v| v.trim().is_empty())
    {
        return Err("Missing comparison identity or too many expected pairs".into());
    }
    let expected: HashSet<_> = q.expected_cases.iter().cloned().collect();
    if expected.len() != q.expected_cases.len() {
        return Err("Duplicate expected pair".into());
    }
    let mut seen = HashSet::new();
    for r in &q.results {
        if !expected.contains(&r.key) || !seen.insert(r.key.clone()) {
            return Err("Unexpected or duplicate result pair".into());
        }
        for o in [&r.parent, &r.candidate] {
            if !matches!(
                o.execution_status.as_str(),
                "completed" | "task_failed" | "infrastructure_failed"
            ) || !matches!(o.grading_status.as_str(), "scored" | "missing" | "failed")
            {
                return Err("Invalid outcome status".into());
            }
            if (o.grading_status == "scored") != o.reward.is_some() {
                return Err("Grading status and reward disagree".into());
            }
            if o.reward.map(|v| !v.is_finite()).unwrap_or(false) {
                return Err("Non-finite reward".into());
            }
            if let Some(u) = &o.usage
                && u.cost_usd
                    .map(|v| !v.is_finite() || v < 0.0)
                    .unwrap_or(false)
            {
                return Err("Invalid usage cost".into());
            }
        }
    }
    Ok(seen.len() == expected.len()
        && q.results.iter().all(|r| {
            r.parent.execution_status != "infrastructure_failed"
                && r.candidate.execution_status != "infrastructure_failed"
                && r.parent.grading_status == "scored"
                && r.candidate.grading_status == "scored"
                && r.parent.reward.is_some()
                && r.candidate.reward.is_some()
        }))
}

// Only fixed local edit-validation errors are public. Never reflect arbitrary provider details.
fn public_proposal_failure(reason: &str) -> &'static str {
    match reason {
        "Anchor does not match original text" => {
            "provider edit anchor does not match original text"
        }
        "Anchor is ambiguous in original text" => {
            "provider edit anchor is ambiguous in original text"
        }
        "Original edit ranges overlap" => "provider edit ranges overlap in original text",
        "Proposal did not change any file" => "proposal did not change any file",
        _ => "provider request failed",
    }
}

use crate::{
    ApiResult, AppState, BundlePayload, Comparison, Proposal, ProposalRequest, VersionMetadata, db,
    err, path,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use chrono::{DateTime, Utc};
use sqlx::Row;
use std::sync::{Arc, OnceLock};
use uuid::Uuid;
pub async fn create_comparison(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "write")?;
    let q: ComparisonRequest = serde_json::from_slice(&body).map_err(|_| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Malformed request",
        )
    })?;
    let route = format!("/v1/projects/{p}/bundles/{b}/comparisons");
    let mut command = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let complete =
        validate_comparison(&q).map_err(|e| err(StatusCode::BAD_REQUEST, "invalid_content", e))?;
    let bid = path(&b)?;
    crate::evaluations::validate_submission(&mut command.tx, &p, bid, &q, &a.principal).await?;
    for (id, dig) in [
        (&q.parent_version_id, &q.parent_digest),
        (&q.candidate_version_id, &q.candidate_digest),
    ] {
        let row = sqlx::query(
            "SELECT digest FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=$3",
        )
        .bind(&p)
        .bind(bid)
        .bind(path(id)?)
        .fetch_optional(&mut *command.tx)
        .await
        .map_err(db)?
        .ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Comparison version missing",
            )
        })?;
        if row.get::<String, _>("digest") != *dig {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Comparison digest mismatch",
            ));
        }
    }
    let pr = sqlx::query("SELECT parent_version_id FROM versions WHERE id=$1")
        .bind(path(&q.candidate_version_id)?)
        .fetch_one(&mut *command.tx)
        .await
        .map_err(db)?;
    if pr
        .get::<Option<Uuid>, _>("parent_version_id")
        .map(|x| x.to_string())
        != Some(q.parent_version_id.clone())
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Candidate parent mismatch",
        ));
    }
    let id = Uuid::new_v4();
    let r=sqlx::query("INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at").bind(id).bind(&p).bind(bid).bind(serde_json::to_value(&q).map_err(db)?).bind(complete).bind(&a.principal).fetch_one(&mut *command.tx).await.map_err(db)?;
    crate::commands::finish_mutation(
        command,
        StatusCode::CREATED,
        Comparison {
            request: q,
            id: id.to_string(),
            complete,
            submitter: a.principal,
            created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
        },
    )
    .await
}
// The binding exists as soon as the evaluator submits the report. The round's
// comparison pointer is populated only after evaluation settlement.
const AUDIT_COMPARISON_MATCH: &str =
    "r.audit_comparison_id=c.id OR r.audit_request_id::text=c.body #>> '{evaluation,requestId}'";

pub async fn get_comparison(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<Comparison>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible = crate::connected_learning::audit_visible(AUDIT_COMPARISON_MATCH, 4, 5);
    let r = sqlx::query(&format!(
        "SELECT c.body,c.complete,c.submitter,c.created_at FROM comparisons c
         WHERE c.project_id=$1 AND c.bundle_id=$2 AND c.id=$3 AND {visible}",
    ))
    .bind(p)
    .bind(path(&b)?)
    .bind(path(&id)?)
    .bind(principal)
    .bind(reviewer)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "Comparison not found"))?;
    Ok(Json(Comparison {
        request: serde_json::from_value(r.get("body")).map_err(db)?,
        id,
        complete: r.get("complete"),
        submitter: r.get("submitter"),
        created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
    }))
}
pub async fn create_proposal(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = crate::auth::actor(&h, &s, &p, "propose")?;
    let q: ProposalRequest = serde_json::from_slice(&body).map_err(|_| {
        err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Malformed request",
        )
    })?;
    let route = format!("/v1/projects/{p}/bundles/{b}/proposals");
    let mut command = match crate::commands::begin_mutation(&s, &a, &p, &route, &h, &body).await? {
        crate::commands::MutationStart::Execute(command) => command,
        crate::commands::MutationStart::Replay(response) => return Ok(response),
    };
    let bid = path(&b)?;
    let (id, created_at) = enqueue_proposal(&mut command.tx, &p, bid, &a.principal, &q).await?;
    let out = Proposal {
        id: id.to_string(),
        parent_version_id: q.parent_version_id,
        status: "queued".into(),
        attempts: 0,
        candidate: None,
        rationale: None,
        error: None,
        created_at: created_at.to_rfc3339(),
    };
    crate::commands::finish_mutation(command, StatusCode::ACCEPTED, out).await
}

pub(crate) async fn enqueue_proposal(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    bid: Uuid,
    principal: &str,
    q: &ProposalRequest,
) -> ApiResult<(Uuid, DateTime<Utc>)> {
    enqueue(tx, project, bid, principal, q.clone(), None, false)
        .await?
        .ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                "invalid_content",
                "Allowed paths must include an existing file",
            )
        })
}

pub(crate) async fn enqueue_managed_proposal(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    bid: Uuid,
    integration: Uuid,
    request: &ProposalRequest,
    allow_structure: bool,
) -> ApiResult<Option<(Uuid, DateTime<Utc>)>> {
    let policy: Option<serde_json::Value> = if allow_structure {
        sqlx::query_scalar("SELECT skill_packages FROM connected_learning_enrollments WHERE (project_id,bundle_id,integration_id)=($1,$2,$3)")
            .bind(project).bind(bid).bind(integration).fetch_one(&mut **tx).await.map_err(db)?
    } else {
        None
    };
    enqueue(
        tx,
        project,
        bid,
        "service:connected-learning",
        request.clone(),
        policy,
        true,
    )
    .await
}

async fn enqueue(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: &str,
    bid: Uuid,
    principal: &str,
    mut q: ProposalRequest,
    skill_packages: Option<serde_json::Value>,
    filter_missing: bool,
) -> ApiResult<Option<(Uuid, DateTime<Utc>)>> {
    if (!filter_missing && q.allowed_paths.is_empty())
        || q.allowed_paths.len() > 128
        || q.hypothesis.trim().is_empty()
        || q.hypothesis.len() > 4096
        || q.evidence.len() > 20
        || q.evidence.iter().any(|x| x.len() > 4096)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Proposal request exceeds limits",
        ));
    }
    let parent = path(&q.parent_version_id)?;
    let parent_row =
        sqlx::query("SELECT payload FROM versions WHERE project_id=$1 AND bundle_id=$2 AND id=$3")
            .bind(project)
            .bind(bid)
            .bind(parent)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?
            .ok_or_else(|| {
                err(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Parent version not found",
                )
            })?;
    let parent_payload: BundlePayload =
        serde_json::from_slice(&parent_row.get::<Vec<u8>, _>("payload")).map_err(db)?;
    if filter_missing {
        q.allowed_paths
            .retain(|path| parent_payload.files.iter().any(|f| f.path == *path));
    }
    if q.allowed_paths.is_empty() && skill_packages.is_none() {
        return Ok(None);
    }
    let allowed: HashSet<_> = q.allowed_paths.iter().collect();
    if allowed.len() != q.allowed_paths.len()
        || q.allowed_paths
            .iter()
            .any(|path| !parent_payload.files.iter().any(|f| f.path == *path))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Allowed paths must be unique existing files",
        ));
    }
    let id = Uuid::new_v4();
    let row=sqlx::query("INSERT INTO proposals(id,project_id,bundle_id,parent_version_id,request,status,requested_by,skill_packages) SELECT $1,$2,$3,$4,$5,'queued',$6,$7 WHERE EXISTS(SELECT 1 FROM versions WHERE project_id=$2 AND bundle_id=$3 AND id=$4) RETURNING created_at").bind(id).bind(project).bind(bid).bind(parent).bind(serde_json::to_value(q).map_err(db)?).bind(principal).bind(skill_packages).fetch_optional(&mut **tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Parent version not found"))?;
    Ok(Some((id, row.get("created_at"))))
}
pub async fn get_proposal(
    State(s): State<AppState>,
    Path((p, b, id)): Path<(String, String, String)>,
    h: HeaderMap,
) -> ApiResult<Json<Proposal>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let r=sqlx::query("SELECT p.id,p.parent_version_id AS proposal_parent_version_id,p.status,p.attempts,p.candidate_version_id,p.rationale,p.error,p.created_at,v.id,v.bundle_id,v.parent_version_id,v.digest,v.created_at AS v_created FROM proposals p LEFT JOIN versions v ON v.id=p.candidate_version_id WHERE p.project_id=$1 AND p.bundle_id=$2 AND p.id=$3").bind(&p).bind(path(&b)?).bind(path(&id)?).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Proposal not found"))?;
    let candidate = r
        .get::<Option<Uuid>, _>("candidate_version_id")
        .map(|vid| VersionMetadata {
            id: vid.to_string(),
            bundle_id: r.get::<Uuid, _>("bundle_id").to_string(),
            parent_version_id: r
                .get::<Option<Uuid>, _>("parent_version_id")
                .map(|x| x.to_string()),
            digest: r.get("digest"),
            created_at: r.get::<DateTime<Utc>, _>("v_created").to_rfc3339(),
        });
    Ok(Json(Proposal {
        id,
        status: r.get("status"),
        parent_version_id: r.get::<Uuid, _>("proposal_parent_version_id").to_string(),
        attempts: r.get("attempts"),
        candidate,
        rationale: r.get("rationale"),
        error: r.get("error"),
        created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
    }))
}
static PROPOSAL_SLOT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
pub async fn proposal_worker(s: AppState) {
    let _lifetime = s.runtime.worker_started();
    while !s.runtime.is_draining() {
        let _=sqlx::query("UPDATE proposals SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error=CASE WHEN attempts<3 THEN 'worker interrupted; retrying' ELSE 'attempt limit reached' END WHERE status='running'").execute(&s.db).await;
        if let Ok(Some(r))=sqlx::query("SELECT id,project_id,bundle_id FROM proposals WHERE status='queued' ORDER BY created_at LIMIT 1").fetch_optional(&s.db).await {
            run_proposal(s.clone(),r.get("project_id"),r.get("bundle_id"),r.get("id")).await;
        } else {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {},
                _ = s.runtime.wait_for_drain() => {},
            }
        }
    }
}
async fn run_proposal(s: AppState, p: String, b: Uuid, id: Uuid) {
    let slot = PROPOSAL_SLOT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone();
    let Ok(_permit) = slot.acquire_owned().await else {
        return;
    };
    let Some(claim_permit) = s.runtime.claim_permit().await else {
        return;
    };
    let Ok(mut tx) = s.db.begin().await else {
        return;
    };
    match crate::connected_learning_worker::authorize_proposal(&mut tx, &s, &p, b, id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = tx.commit().await;
            return;
        }
        Err(_) => return,
    }
    let Ok(claimed) = sqlx::query("UPDATE proposals SET status='running',attempts=attempts+1 WHERE id=$1 AND status='queued' AND attempts<3 RETURNING request,parent_version_id,requested_by,attempts,skill_packages").bind(id).fetch_optional(&mut *tx).await else { return };
    if tx.commit().await.is_err() {
        return;
    }
    drop(claim_permit);
    let Some(r) = claimed else { return };
    let attempt: i32 = r.get("attempts");
    let Some(provider) = &s.provider else {
        let _=sqlx::query("UPDATE proposals SET status='failed',error='proposal provider disabled' WHERE id=$1 AND status='running' AND attempts=$2").bind(id).bind(attempt).execute(&s.db).await;
        return;
    };
    let q: ProposalRequest = match serde_json::from_value(r.get("request")) {
        Ok(x) => x,
        Err(_) => return,
    };
    let policy = match r
        .get::<Option<serde_json::Value>, _>("skill_packages")
        .map(serde_json::from_value::<crate::proposal_edits::SkillPackages>)
        .transpose()
    {
        Ok(policy) => policy,
        Err(_) => return,
    };
    let parent = r.get::<Uuid, _>("parent_version_id");
    let requested_by: String = r.get("requested_by");
    let row = sqlx::query("SELECT payload FROM versions WHERE id=$1")
        .bind(parent)
        .fetch_optional(&s.db)
        .await
        .ok()
        .flatten();
    let Some(row) = row else { return };
    let parent_payload: BundlePayload =
        match serde_json::from_slice(&row.get::<Vec<u8>, _>("payload")) {
            Ok(x) => x,
            Err(_) => return,
        };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        provider.propose_scoped(parent_payload.clone(), q.clone(), policy.clone()),
    )
    .await;
    let output = match result {
        Ok(Ok(v)) => v,
        Ok(Err(reason)) => {
            let _ = sqlx::query("UPDATE proposals SET status='failed',error=$2 WHERE id=$1 AND status='running' AND attempts=$3")
                .bind(id)
                .bind(public_proposal_failure(&reason))
                .bind(attempt)
                .execute(&s.db)
                .await;
            return;
        }
        _ => {
            let _ = sqlx::query(
                "UPDATE proposals SET status='failed',error='provider timeout' WHERE id=$1 AND status='running' AND attempts=$2",
            )
            .bind(id)
            .bind(attempt)
            .execute(&s.db)
            .await;
            return;
        }
    };
    let (candidate, rationale) = output;
    if crate::bundles::validate_payload(&candidate).is_err()
        || crate::proposal_edits::validate_changes(&parent_payload, &candidate, &q, policy.as_ref())
            .is_err()
    {
        let _=sqlx::query("UPDATE proposals SET status='failed',error='provider returned invalid edits' WHERE id=$1 AND status='running' AND attempts=$2").bind(id).bind(attempt).execute(&s.db).await;
        return;
    }
    let bytes = match crate::encode_payload(&candidate) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _=sqlx::query("UPDATE proposals SET status='failed',error='candidate payload exceeds limit' WHERE id=$1 AND status='running' AND attempts=$2").bind(id).bind(attempt).execute(&s.db).await;
            return;
        }
    };
    let mut tx = match s.db.begin().await {
        Ok(t) => t,
        Err(_) => return,
    };
    match crate::connected_learning_worker::authorize_proposal(&mut tx, &s, &p, b, id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = tx.commit().await;
            return;
        }
        Err(_) => return,
    }
    let current: Option<(String, i32)> =
        match sqlx::query_as("SELECT status, attempts FROM proposals WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(row) => row,
            Err(_) => return,
        };
    if !matches!(current, Some((ref status, current_attempt)) if status == "running" && current_attempt == attempt)
    {
        return;
    }
    if crate::compatibility::validate_in_tx(&mut tx, &p, b, &candidate)
        .await
        .is_err()
    {
        let _ = sqlx::query("UPDATE proposals SET status='failed',error='provider candidate is incompatible with bundle target' WHERE id=$1 AND status='running' AND attempts=$2").bind(id).bind(attempt).execute(&mut *tx).await;
        let _ = tx.commit().await;
        return;
    }
    let vid = Uuid::new_v4();
    if sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by,proposal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(vid).bind(p).bind(b).bind(parent).bind(crate::digest(&bytes)).bind(bytes).bind(&requested_by).bind(id).execute(&mut *tx).await.is_err(){return}
    let updated=sqlx::query("UPDATE proposals SET status='succeeded',candidate_version_id=$2,rationale=$3,error=NULL WHERE id=$1 AND status='running'").bind(id).bind(vid).bind(rationale).execute(&mut *tx).await;
    if !matches!(updated,Ok(result) if result.rows_affected()==1) {
        return;
    }
    let _ = tx.commit().await;
}

pub async fn list_comparisons(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<crate::pagination::ListQuery>,
) -> ApiResult<Json<crate::pagination::Page<Comparison>>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let n = q.bounds()?;
    let bid = path(&b)?;
    let c =
        crate::pagination::resolve(&mut tx, "comparisons", &p, bid, q.cursor.as_deref()).await?;
    let (principal, reviewer) =
        crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let visible = crate::connected_learning::audit_visible(AUDIT_COMPARISON_MATCH, 6, 7);
    let rows = sqlx::query(&format!(
        "SELECT c.* FROM comparisons c WHERE c.project_id=$1 AND c.bundle_id=$2
         AND ($3::timestamptz IS NULL OR (c.created_at,c.id)<($3,$4)) AND {visible}
         ORDER BY c.created_at DESC,c.id DESC LIMIT $5"
    ))
    .bind(&p)
    .bind(bid)
    .bind(c.map(|x| x.0))
    .bind(c.map(|x| x.1))
    .bind(n + 1)
    .bind(principal)
    .bind(reviewer)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let items = rows
        .into_iter()
        .map(|r| {
            Ok(Comparison {
                request: serde_json::from_value(r.get("body")).map_err(db)?,
                id: r.get::<Uuid, _>("id").to_string(),
                complete: r.get("complete"),
                submitter: r.get("submitter"),
                created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(crate::pagination::page(items, n, |x| {
        crate::pagination::encode("comparisons", &p, bid, &x.created_at, &x.id)
    })))
}
pub async fn list_proposals(
    State(s): State<AppState>,
    Path((p, b)): Path<(String, String)>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<crate::pagination::ListQuery>,
) -> ApiResult<Json<crate::pagination::Page<Proposal>>> {
    let mut tx = crate::auth::read_transaction(&s, &h, &p).await?;
    let n = q.bounds()?;
    let bid = path(&b)?;
    let c = crate::pagination::resolve(&mut tx, "proposals", &p, bid, q.cursor.as_deref()).await?;
    let rows=sqlx::query("SELECT p.id,p.parent_version_id AS proposal_parent_version_id,p.status,p.attempts,p.candidate_version_id,p.rationale,p.error,p.created_at,v.bundle_id,v.parent_version_id,v.digest,v.created_at AS v_created FROM proposals p LEFT JOIN versions v ON v.id=p.candidate_version_id WHERE p.project_id=$1 AND p.bundle_id=$2 AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3,$4)) ORDER BY p.created_at DESC,p.id DESC LIMIT $5").bind(&p).bind(bid).bind(c.map(|x|x.0)).bind(c.map(|x|x.1)).bind(n+1).fetch_all(&mut *tx).await.map_err(db)?;
    let items = rows
        .into_iter()
        .map(|r| Proposal {
            id: r.get::<Uuid, _>("id").to_string(),
            parent_version_id: r.get::<Uuid, _>("proposal_parent_version_id").to_string(),
            status: r.get("status"),
            attempts: r.get("attempts"),
            candidate: r
                .get::<Option<Uuid>, _>("candidate_version_id")
                .map(|id| VersionMetadata {
                    id: id.to_string(),
                    bundle_id: r.get::<Uuid, _>("bundle_id").to_string(),
                    parent_version_id: r
                        .get::<Option<Uuid>, _>("parent_version_id")
                        .map(|x| x.to_string()),
                    digest: r.get("digest"),
                    created_at: r.get::<DateTime<Utc>, _>("v_created").to_rfc3339(),
                }),
            rationale: r.get("rationale"),
            error: r.get("error"),
            created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
        })
        .collect::<Vec<_>>();
    Ok(Json(crate::pagination::page(items, n, |x| {
        crate::pagination::encode("proposals", &p, bid, &x.created_at, &x.id)
    })))
}

#[cfg(test)]
mod proposal_failure_tests {
    use super::public_proposal_failure;
    #[test]
    fn edit_rejections_are_actionable_without_reflecting_provider_details() {
        assert_eq!(
            public_proposal_failure("Anchor does not match original text"),
            "provider edit anchor does not match original text"
        );
        assert_eq!(
            public_proposal_failure("Anchor is ambiguous in original text"),
            "provider edit anchor is ambiguous in original text"
        );
        assert_eq!(
            public_proposal_failure("Original edit ranges overlap"),
            "provider edit ranges overlap in original text"
        );
        assert_eq!(
            public_proposal_failure("secret provider details"),
            "provider request failed"
        );
        assert_eq!(
            public_proposal_failure("Anchor does not match original text: private contents"),
            "provider request failed"
        );
    }
}
