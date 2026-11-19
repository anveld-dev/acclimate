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
    use crate::connected_learning::statistics::{MAX_MISSING_PERCENT, scored_reward};
    let cap = if q.evaluation.is_some() {
        MAX_MISSING_PERCENT
    } else {
        0
    };
    Ok(seen.len() == expected.len()
        && [true, false].into_iter().all(|parent| {
            q.results
                .iter()
                .filter(|pair| {
                    scored_reward(if parent {
                        &pair.parent
                    } else {
                        &pair.candidate
                    })
                    .is_none()
                })
                .count()
                * 100
                <= expected.len() * cap
        }))
}

// Only fixed local edit-validation errors are public. Never reflect arbitrary provider details.
fn public_edit_error(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "Edit outside allowed paths" => "provider edit is outside allowed paths",
        "Anchor does not match original text" => {
            "provider edit anchor does not match original text"
        }
        "Anchor is ambiguous in original text" => {
            "provider edit anchor is ambiguous in original text"
        }
        "Original edit ranges overlap" => "provider edit ranges overlap in original text",
        "Proposal did not change any file" => "proposal did not change any file",
        _ => return None,
    })
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
    let a = crate::auth::actor(&h, &s, &p, "evaluate")?;
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
    let managed =
        crate::evaluations::validate_submission(&mut command.tx, &p, bid, &q, &a.principal).await?;
    crate::connected_learning::parent_cache::verify(&mut command.tx, &q).await?;
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
    // Only the managed calibration scheduler can create a bound self-comparison.
    let calibration = q.evaluation.is_some() && q.parent_version_id == q.candidate_version_id;
    if !calibration
        && pr
            .get::<Option<Uuid>, _>("parent_version_id")
            .map(|x| x.to_string())
            != Some(q.parent_version_id.clone())
        && !(managed
            && crate::connected_learning::descends_from(
                &mut command.tx,
                &p,
                bid,
                path(&q.candidate_version_id)?,
                path(&q.parent_version_id)?,
            )
            .await?)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_content",
            "Candidate parent mismatch",
        ));
    }
    let id = Uuid::new_v4();
    let r=sqlx::query("INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter,parent_source_comparison_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at").bind(id).bind(&p).bind(bid).bind(serde_json::to_value(&q).map_err(db)?).bind(complete).bind(&a.principal).bind(q.parent_source_comparison_id).fetch_one(&mut *command.tx).await.map_err(db)?;
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
pub(crate) const AUDIT_COMPARISON_MATCH: &str =
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
        screening: Vec::new(),
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
        q.allowed_paths.retain(|path| {
            crate::proposal_edits::memory_path(path)
                || parent_payload.files.iter().any(|f| f.path == *path)
        });
    }
    if q.allowed_paths.is_empty() && skill_packages.is_none() {
        return Ok(None);
    }
    let allowed: HashSet<_> = q.allowed_paths.iter().collect();
    if allowed.len() != q.allowed_paths.len()
        || q.allowed_paths.iter().any(|path| {
            !crate::proposal_edits::memory_path(path)
                && !parent_payload.files.iter().any(|f| f.path == *path)
        })
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
    let (_, review) = crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let r=sqlx::query("SELECT p.id,p.parent_version_id AS proposal_parent_version_id,p.status,p.attempts,p.candidate_version_id,CASE WHEN $4 THEN p.rationale END AS rationale,p.error,CASE WHEN $4 THEN p.screening ELSE '[]'::jsonb END AS screening,p.created_at,v.id,v.bundle_id,v.parent_version_id,v.digest,v.created_at AS v_created FROM proposals p LEFT JOIN versions v ON v.id=p.candidate_version_id WHERE p.project_id=$1 AND p.bundle_id=$2 AND p.id=$3").bind(&p).bind(path(&b)?).bind(path(&id)?).bind(review).fetch_optional(&mut *tx).await.map_err(db)?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_found","Proposal not found"))?;
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
        screening: r
            .get::<sqlx::types::Json<Vec<serde_json::Value>>, _>("screening")
            .0,
        error: r.get("error"),
        created_at: r.get::<DateTime<Utc>, _>("created_at").to_rfc3339(),
    }))
}
static PROPOSAL_SLOT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
pub async fn proposal_worker(s: AppState) {
    let _lifetime = s.runtime.worker_started();
    while !s.runtime.is_draining() {
        let next = if let Some(permit) = s.runtime.claim_permit().await {
            let recovered = sqlx::query("UPDATE proposals SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
                error=CASE WHEN attempts<3 THEN 'worker interrupted; retrying' ELSE 'attempt limit reached' END,
                next_claim_at=now()+make_interval(secs=>power(2,attempts)) WHERE status='running'")
                .execute(&s.db).await;
            let next = match recovered {
                Ok(_) => sqlx::query(
                    "SELECT id,project_id,bundle_id FROM proposals
                    WHERE status='queued' AND next_claim_at<=now() ORDER BY created_at LIMIT 1",
                )
                .fetch_optional(&s.db)
                .await
                .ok()
                .flatten(),
                Err(_) => None,
            };
            drop(permit);
            next
        } else {
            None
        };
        if let Some(r) = next {
            let id = r.get("id");
            run_proposal(s.clone(), r.get("project_id"), r.get("bundle_id"), id).await;
            if let Some(_permit) = s.runtime.claim_permit().await
                && sqlx::query(
                    "UPDATE proposals SET next_claim_at=now()+interval '5 seconds'
                    WHERE id=$1 AND status='queued'",
                )
                .bind(id)
                .execute(&s.db)
                .await
                .is_err()
            {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        } else {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {},
                _ = s.runtime.wait_for_drain() => {},
            }
        }
    }
}
async fn fail_proposal(s: &AppState, id: Uuid, attempt: i32, error: &str) {
    let _ = sqlx::query("UPDATE proposals SET status='failed',error=$3 WHERE id=$1 AND status='running' AND attempts=$2")
        .bind(id).bind(attempt).bind(error).execute(&s.db).await;
}

/// Appends a rejected screening's objections to the repair request as critic-sourced evidence.
fn add_critic_objections(request: &mut ProposalRequest, record: &serde_json::Value) {
    let objections: Vec<&str> = record["result"]["objections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect();
    if objections.is_empty() {
        return;
    }
    request.evidence.push(
        serde_json::json!({
            "source": "critic",
            "field": "criticObjections",
            "text": serde_json::json!(objections).to_string(),
        })
        .to_string(),
    );
}

/// Records a failure whose kind drives managed-learning control flow.
async fn fail_proposal_kind(s: &AppState, id: Uuid, attempt: i32, kind: &str) {
    let _ = sqlx::query("UPDATE proposals SET status='failed',error=$3,failure_kind=$3 WHERE id=$1 AND status='running' AND attempts=$2")
        .bind(id).bind(attempt).bind(kind).execute(&s.db).await;
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
    let Ok(claimed) = sqlx::query("UPDATE proposals SET status='running',attempts=attempts+1 WHERE id=$1 AND status='queued' AND attempts<3 RETURNING request,parent_version_id,requested_by,attempts,skill_packages,screening").bind(id).fetch_optional(&mut *tx).await else { return };
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
    let managed = requested_by == "service:connected-learning";
    // Pending proposals created before structured evidence must be readmitted.
    if managed
        && q.evidence
            .iter()
            .any(|entry| serde_json::from_str::<crate::LearningEvidence>(entry).is_err())
    {
        fail_proposal_kind(&s, id, attempt, "proposal-format-rejected").await;
        return;
    }
    let mut candidate_output = None;
    let screening: serde_json::Value = r.get("screening");
    let first_rejection = screening
        .get(0)
        .filter(|record| record["result"]["verdict"] == "reject");
    // The repair attempt sees the critic's objections as fenced, structured evidence.
    let mut model_request = q.clone();
    if let Some(record) = first_rejection {
        add_critic_objections(&mut model_request, record);
    }
    for stage in usize::from(first_rejection.is_some())..2 {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(125),
            provider.propose_classified(
                parent_payload.clone(),
                model_request.clone(),
                policy.clone(),
            ),
        )
        .await;
        let (candidate, rationale) = match result {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                match error {
                    crate::ProposalFailure::Format(_) if managed => {
                        let _ = sqlx::query(
                            "UPDATE proposals SET status='failed',
                            error='proposal-format-rejected',failure_kind='proposal-format-rejected'
                            WHERE id=$1 AND status='running' AND attempts=$2",
                        )
                        .bind(id)
                        .bind(attempt)
                        .execute(&s.db)
                        .await;
                    }
                    crate::ProposalFailure::Format(detail)
                    | crate::ProposalFailure::Provider(detail) => {
                        fail_proposal(
                            &s,
                            id,
                            attempt,
                            public_edit_error(&detail).unwrap_or("provider request failed"),
                        )
                        .await;
                    }
                }
                return;
            }
            Err(_) => {
                fail_proposal(&s, id, attempt, "provider timeout").await;
                return;
            }
        };
        let validation = crate::bundles::validate_payload(&candidate).and_then(|()| {
            crate::proposal_edits::validate_changes(
                &parent_payload,
                &candidate,
                &q,
                policy.as_ref(),
            )?;
            crate::proposal_edits::validate_growth(&parent_payload, &candidate)
        });
        if let Err(reason) = validation {
            fail_proposal(
                &s,
                id,
                attempt,
                public_edit_error(&reason).unwrap_or("provider returned invalid edits"),
            )
            .await;
            return;
        }
        let files = crate::proposal_edits::changed_files(&parent_payload, &candidate);
        let scan_text = std::iter::once(rationale.as_str()).chain(
            files
                .iter()
                .flat_map(|(path, old, new)| std::iter::once(*path).chain(*old).chain(*new)),
        );
        if !matches!(crate::proposal_scanner::scan(scan_text), Ok(false)) {
            fail_proposal_kind(&s, id, attempt, "scanner-rejected").await;
            return;
        }
        if !managed {
            candidate_output = Some((candidate, rationale, None));
            break;
        }
        let structural = files
            .iter()
            .any(|(_, old, new)| old.is_none() || new.is_none());
        let retained: Vec<_> = parent_payload
            .files
            .iter()
            .filter(|file| !files.iter().any(|(path, _, _)| *path == file.path))
            .collect();
        let changes: Vec<_> = files.iter().map(|(path, before, after)| {
            serde_json::json!({"path": path, "before": before, "after": after})
        }).collect();
        let data = serde_json::json!({
            "changes": changes, "retained": retained
        });
        let verdict =
            tokio::time::timeout(std::time::Duration::from_secs(60), provider.critique(data))
                .await
                .ok()
                .and_then(Result::ok);
        let record = serde_json::json!({
            "stage": if stage == 0 { "initial" } else { "repair" },
            "result": verdict,
            "scannerClean": true,
            "structural": structural,
            "changes": changes,
        });
        match verdict {
            Some(crate::CriticVerdict::Accept { .. }) => {
                candidate_output = Some((candidate, rationale, Some(record)));
                break;
            }
            Some(crate::CriticVerdict::Reject { .. }) if stage == 0 => {
                let recorded = sqlx::query("UPDATE proposals SET screening=jsonb_build_array($3::jsonb) WHERE id=$1 AND status='running' AND attempts=$2")
                    .bind(id).bind(attempt).bind(&record).execute(&s.db).await;
                if !matches!(recorded, Ok(result) if result.rows_affected() == 1) {
                    return;
                }
                add_critic_objections(&mut model_request, &record);
            }
            verdict => {
                let error = if verdict.is_some() {
                    "critic-rejected"
                } else {
                    "critic-unavailable"
                };
                let _ = sqlx::query("UPDATE proposals SET status='failed',error=$3,failure_kind=$3,screening=screening || jsonb_build_array($4::jsonb) WHERE id=$1 AND status='running' AND attempts=$2")
                    .bind(id).bind(attempt).bind(error).bind(record).execute(&s.db).await;
                return;
            }
        }
    }
    let Some((candidate, rationale, screen)) = candidate_output else {
        return;
    };
    let bytes = match crate::encode_payload(&candidate) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _=sqlx::query("UPDATE proposals SET status='failed',error='candidate payload exceeds limit' WHERE id=$1 AND status='running' AND attempts=$2").bind(id).bind(attempt).execute(&s.db).await;
            return;
        }
    };
    let Some(_permit) = s.runtime.claim_permit().await else {
        return;
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
        let _ = sqlx::query("UPDATE proposals SET status='failed',error='provider candidate is incompatible with bundle target',screening=screening || $3::jsonb WHERE id=$1 AND status='running' AND attempts=$2").bind(id).bind(attempt).bind(serde_json::json!(screen.into_iter().collect::<Vec<_>>())).execute(&mut *tx).await;
        let _ = tx.commit().await;
        return;
    }
    let vid = Uuid::new_v4();
    if sqlx::query("INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by,proposal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(vid).bind(p).bind(b).bind(parent).bind(crate::digest(&bytes)).bind(bytes).bind(&requested_by).bind(id).execute(&mut *tx).await.is_err(){return}
    let updated=sqlx::query("UPDATE proposals SET status='succeeded',candidate_version_id=$2,rationale=$3,error=NULL,screening=screening || $4::jsonb WHERE id=$1 AND status='running'").bind(id).bind(vid).bind(rationale).bind(serde_json::json!(screen.into_iter().collect::<Vec<_>>())).execute(&mut *tx).await;
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
    let c = crate::pagination::decode("comparisons", &p, bid, q.cursor.as_deref())?;
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
    let c = crate::pagination::decode("proposals", &p, bid, q.cursor.as_deref())?;
    let (_, review) = crate::connected_learning::audit_reader(&s, &h, &mut tx, &p).await?;
    let rows=sqlx::query("SELECT p.id,p.parent_version_id AS proposal_parent_version_id,p.status,p.attempts,p.candidate_version_id,CASE WHEN $6 THEN p.rationale END AS rationale,p.error,CASE WHEN $6 THEN p.screening ELSE '[]'::jsonb END AS screening,p.created_at,v.bundle_id,v.parent_version_id,v.digest,v.created_at AS v_created FROM proposals p LEFT JOIN versions v ON v.id=p.candidate_version_id WHERE p.project_id=$1 AND p.bundle_id=$2 AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3,$4)) ORDER BY p.created_at DESC,p.id DESC LIMIT $5").bind(&p).bind(bid).bind(c.map(|x|x.0)).bind(c.map(|x|x.1)).bind(n+1).bind(review).fetch_all(&mut *tx).await.map_err(db)?;
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
            screening: r
                .get::<sqlx::types::Json<Vec<serde_json::Value>>, _>("screening")
                .0,
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
    use super::public_edit_error;
    #[test]
    fn edit_rejections_are_actionable_without_reflecting_provider_details() {
        assert_eq!(
            public_edit_error("Anchor does not match original text"),
            Some("provider edit anchor does not match original text")
        );
        assert_eq!(
            public_edit_error("Anchor is ambiguous in original text"),
            Some("provider edit anchor is ambiguous in original text")
        );
        assert_eq!(
            public_edit_error("Original edit ranges overlap"),
            Some("provider edit ranges overlap in original text")
        );
        assert_eq!(public_edit_error("secret provider details"), None);
        assert_eq!(
            public_edit_error("Anchor does not match original text: private contents"),
            None
        );
    }
}
