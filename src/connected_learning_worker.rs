use crate::{
    ApiResult, AppState, ComparisonRequest, PromoteRequest, ProposalRequest,
    connected_learning::{Descriptor, epochs::audit_is_fresh},
    db, err,
    evaluations::{CreateEvaluationRequest, decode, enqueue_evaluation, validate_report},
    improvement::{enqueue_managed_proposal, validate_comparison},
    path,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::time::Duration;
use uuid::Uuid;

#[path = "connected_learning/field_audits.rs"]
mod field_audits;
#[path = "connected_learning/field_requalification.rs"]
mod field_requalification;

type Tx<'a> = Transaction<'a, Postgres>;
const WORKER: &str = "service:connected-learning";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/projects/{project}/integrations/{integration}/learning/field-requalifications/{version}",
            axum::routing::get(field_requalification::inspect))
        .route("/v1/projects/{project}/integrations/{integration}/learning/field-requalifications",
            post(field_requalification::submit))
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/field-audits",
            post(field_audits::submit),
        )
        .route(
            "/v1/projects/{project}/integrations/{integration}/learning/rounds/{round}/review",
            post(review),
        )
}

fn conflict(reason: &str) -> crate::ApiErr {
    err(StatusCode::CONFLICT, "learning_conflict", reason)
}

struct Connection {
    project: String,
    integration: Uuid,
    bundle: Uuid,
    channel: String,
    authorizer: String,
    evaluator: String,
    submitter: String,
    permitted_paths: Vec<String>,
    development: Descriptor,
    audits: Vec<Descriptor>,
    automatic: bool,
    automatic_rollback: bool,
    has_budget: bool,
    policy_epoch: i64,
    higher_is_better: bool,
    active: bool,
}

impl Connection {
    async fn lock(
        tx: &mut Tx<'_>,
        s: &AppState,
        project: String,
        integration: Uuid,
    ) -> ApiResult<Option<Self>> {
        // Resolve current authority before acquiring connection locks. Browser
        // mutations take membership then connection locks in the same order.
        let authority: Option<(String, String, String)> = sqlx::query_as(
            "SELECT authorized_by,evaluator_principal,outcome_principal FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2",
        )
        .bind(&project)
        .bind(integration)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
        let Some((authorizer, evaluator, submitter)) = authority else {
            return Ok(None);
        };
        let authorizer_id = authorizer
            .strip_prefix("user:")
            .and_then(|id| Uuid::parse_str(id).ok());
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM project_memberships WHERE project_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(&project)
        .bind(authorizer_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
        let has_grant = |principal: &str, rights: &[&str]| {
            s.grants.iter().any(|g| {
                g.project_id == project
                    && g.principal_id == principal
                    && rights
                        .iter()
                        .all(|right| g.rights.iter().any(|r| r == right))
            })
        };

        let enabled: bool = sqlx::query_scalar(
            "SELECT enabled FROM integrations WHERE project_id=$1 AND id=$2 FOR SHARE",
        )
        .bind(&project)
        .bind(integration)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let row = sqlx::query(
            "SELECT *,stopped_at IS NULL AS running,proposal_admissions<max_proposal_admissions AS has_budget FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2 FOR UPDATE",
        )
        .bind(&project)
        .bind(integration)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        if row.get::<String, _>("authorized_by") != authorizer {
            return Err(conflict("Enrollment authorizer changed during processing"));
        }
        let active = enabled
            && row.get::<bool, _>("running")
            && (role.as_deref() == Some("admin") || has_grant(&authorizer, &["write", "promote"]))
            && has_grant(&submitter, &["write"])
            && has_grant(&evaluator, &["read", "write"]);
        let policies: Option<crate::connected_learning::selection::Policies> = row
            .get::<Option<Value>, _>("selection_policies")
            .map(serde_json::from_value)
            .transpose()
            .map_err(db)?;
        Ok(Some(Self {
            policy_epoch: row.get("policy_epoch"),
            higher_is_better: policies
                .as_ref()
                .is_none_or(|p| p.development.higher_is_better()),
            project,
            integration,
            bundle: row.get("bundle_id"),
            channel: row.get("delivery_channel"),
            authorizer,
            evaluator,
            submitter,
            permitted_paths: row.get("permitted_paths"),
            development: serde_json::from_value(row.get("development")).map_err(db)?,
            audits: serde_json::from_value(row.get("audits")).map_err(db)?,
            automatic: row.get("automatic_rollout"),
            automatic_rollback: row.get("automatic_rollback"),
            has_budget: row.get("has_budget"),
            active,
        }))
    }

    async fn baseline(&self, tx: &mut Tx<'_>) -> ApiResult<(Uuid, i64)> {
        sqlx::query_as::<_, (Uuid, i64)>(
            "SELECT version_id,revision FROM channels WHERE (project_id,bundle_id,name)=($1,$2,$3) FOR UPDATE",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind(&self.channel)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)
    }

    async fn admit(&self, tx: &mut Tx<'_>, baseline: (Uuid, i64)) -> ApiResult<()> {
        if !self.active || !self.has_budget || self.next_audit(tx).await?.is_none() {
            return Ok(());
        }
        let outcome = sqlx::query(
            "SELECT * FROM connected_learning_correction_work
             WHERE (project_id,bundle_id,integration_id)=($1,$2,$3) AND action='ready'
             AND (version_id,revision)=($4,$5)
             ORDER BY queued_at,correction_id LIMIT 1",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind(self.integration)
        .bind(baseline.0)
        .bind(baseline.1)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
        let Some(outcome) = outcome else {
            return Ok(());
        };
        let version: Uuid = outcome.get("observed_version");
        let revision: Option<i64> = outcome.get("observed_revision");
        let status: String = outcome.get("status");
        let digest: String = outcome.get("observed_digest");
        let lesson: Option<Value> = outcome.get("lesson");
        let feedback: Option<Value> = outcome.get("feedback");
        let correction: Uuid = outcome.get("correction_id");
        let structural = lesson.is_none();
        let (allowed_paths, hypothesis) = match lesson {
            Some(lesson) => (
                vec![
                    lesson["path"]
                        .as_str()
                        .ok_or_else(|| db("Missing lesson path"))?
                        .to_owned(),
                ],
                lesson["instruction"]
                    .as_str()
                    .ok_or_else(|| db("Missing lesson instruction"))?
                    .to_owned(),
            ),
            None => (
                self.permitted_paths.clone(),
                "Improve the bundle so future tasks satisfy the trusted expected outcome.".into(),
            ),
        };
        let mut evidence = vec![format!(
            "Connection task ended {status} using version {version} ({digest})."
        )];
        if version != baseline.0 || revision != Some(baseline.1) {
            evidence.push(format!(
                "The evaluator reproduced this correction on version {} at delivery revision {}.",
                baseline.0, baseline.1
            ));
        }
        if let Some(feedback) = feedback {
            let expected = feedback["expected"]
                .as_str()
                .ok_or_else(|| db("Missing expected outcome"))?;
            let observed = feedback["observed"]
                .as_str()
                .ok_or_else(|| db("Missing observed outcome"))?;
            evidence.push(format!("Expected outcome: {expected}"));
            evidence.push(format!("Observed outcome: {observed}"));
        }
        self.add_development_history(tx, baseline, correction, &mut evidence)
            .await?;
        let request = ProposalRequest {
            parent_version_id: baseline.0.to_string(),
            allowed_paths,
            hypothesis,
            evidence,
        };
        let proposal = enqueue_managed_proposal(
            tx,
            &self.project,
            self.bundle,
            self.integration,
            &request,
            structural,
        )
        .await?
        .map(|(id, _)| id);
        if proposal.is_some() {
            sqlx::query(
                "UPDATE connected_learning_enrollments SET proposal_admissions=proposal_admissions+1 WHERE (project_id,integration_id)=($1,$2)",
            )
            .bind(&self.project)
            .bind(self.integration)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        }
        let attempt: i32 = sqlx::query_scalar(
            "UPDATE connected_learning_corrections SET pending=false, attempts=attempts+1
            WHERE (project_id,integration_id,correction_id)=($1,$2,$3) RETURNING attempts",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(correction)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let reason = proposal
            .is_none()
            .then_some("Correction has no applicable permitted paths");
        sqlx::query(
            "INSERT INTO connected_learning_rounds (id,project_id,bundle_id,integration_id,outcome_id,parent_version_id,parent_revision,proposal_id,state,reason,correction_id,attempt)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        )
        .bind(Uuid::new_v4())
        .bind(&self.project)
        .bind(self.bundle)
        .bind(self.integration)
        .bind(outcome.get::<Uuid, _>("outcome_id"))
        .bind(baseline.0)
        .bind(baseline.1)
        .bind(proposal)
        .bind(if proposal.is_some() { "proposing" } else { "rejected" })
        .bind(reason)
        .bind(correction).bind(attempt)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn add_development_history(
        &self,
        tx: &mut Tx<'_>,
        baseline: (Uuid, i64),
        correction: Uuid,
        evidence: &mut Vec<String>,
    ) -> ApiResult<()> {
        let history = sqlx::query(
            "SELECT c.body,r.candidate_version_id FROM connected_learning_rounds r
             JOIN comparisons c ON (c.project_id,c.bundle_id,c.id)=(r.project_id,r.bundle_id,r.development_comparison_id)
             WHERE (r.project_id,r.integration_id,r.parent_version_id,r.parent_revision)=($1,$2,$3,$4)
             AND r.policy_epoch=$6 AND r.state='rejected' AND r.audit_request_id IS NULL AND c.complete
             ORDER BY (r.correction_id=$5) DESC,r.updated_at DESC,r.id DESC LIMIT 3",
        )
        .bind(&self.project).bind(self.integration).bind(baseline.0).bind(baseline.1).bind(correction).bind(self.policy_epoch)
        .fetch_all(&mut **tx).await.map_err(db)?;
        for row in history {
            let comparison: ComparisonRequest =
                serde_json::from_value(row.get("body")).map_err(db)?;
            let regressions = comparison
                .results
                .iter()
                .filter(|pair| {
                    (if self.higher_is_better {
                        pair.candidate.reward < pair.parent.reward
                    } else {
                        pair.candidate.reward > pair.parent.reward
                    }) || (pair.parent.execution_status == "completed"
                        && pair.candidate.execution_status != "completed")
                })
                .count();
            let gains = comparison
                .results
                .iter()
                .filter(|pair| {
                    if self.higher_is_better {
                        pair.candidate.reward > pair.parent.reward
                    } else {
                        pair.candidate.reward < pair.parent.reward
                    }
                })
                .count();
            let previous: Uuid = row.get("candidate_version_id");
            evidence.push(format!("Prior candidate {previous} failed development: {gains} improved pairs and {regressions} regressed pairs across {} scored pairs.", comparison.results.len()));
        }
        Ok(())
    }

    async fn next_audit(&self, tx: &mut Tx<'_>) -> ApiResult<Option<usize>> {
        let index: Option<i32> = sqlx::query_scalar(
            "SELECT audit_index FROM connected_learning_available_audits
             WHERE (project_id,integration_id)=($1,$2) ORDER BY audit_index LIMIT 1",
        )
        .bind(&self.project)
        .bind(self.integration)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?;
        Ok(index.map(|value| value as usize))
    }

    async fn audit_is_registered(&self, tx: &mut Tx<'_>, index: i32) -> ApiResult<bool> {
        audit_is_fresh(tx, &self.project, self.bundle, self.integration, index).await
    }

    async fn evaluation_request(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        candidate: Uuid,
        descriptor: &Descriptor,
    ) -> ApiResult<CreateEvaluationRequest> {
        let parent: Uuid = round.get("parent_version_id");
        let versions: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id,digest FROM versions WHERE (project_id,bundle_id)=($1,$2) AND id=ANY($3)",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind([parent, candidate].as_slice())
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?;
        let digest = |id| {
            versions
                .iter()
                .find(|(version, _)| *version == id)
                .map(|(_, digest)| digest.clone())
                .ok_or_else(|| db("Missing evaluation version"))
        };
        Ok(CreateEvaluationRequest {
            parent_version_id: parent.to_string(),
            parent_digest: digest(parent)?,
            candidate_version_id: candidate.to_string(),
            candidate_digest: digest(candidate)?,
            dataset_revision: descriptor.dataset_revision.clone(),
            runtime: descriptor.evaluation_runtime(),
            grader_revision: descriptor.grader_revision.clone(),
            expected_cases: descriptor.expected_cases.clone(),
            proposal_id: round
                .get::<Option<Uuid>, _>("proposal_id")
                .map(|id| id.to_string()),
            require_bound_evidence: true,
        })
    }

    async fn queue_evaluation(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        candidate: Uuid,
        descriptor: &Descriptor,
    ) -> ApiResult<Uuid> {
        let request = self
            .evaluation_request(tx, round, candidate, descriptor)
            .await?;
        let evaluation =
            enqueue_evaluation(tx, &self.project, self.bundle, WORKER, &request).await?;
        path(&evaluation.id)
    }

    async fn evidence(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        request_id: Uuid,
        descriptor: &Descriptor,
    ) -> ApiResult<Evidence> {
        let row = sqlx::query(
            "SELECT *, created_at < now()-interval '24 hours' AS expired FROM evaluation_requests WHERE (project_id,bundle_id,id)=($1,$2,$3)",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind(request_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let expired: bool = row.get("expired");
        let evaluation = decode(row)?;
        let comparison_id = evaluation.comparison_id.as_deref().map(path).transpose()?;
        match evaluation.status.as_str() {
            "requested" | "running" if !expired => return Ok(Evidence::Pending),
            "requested" | "running" => {
                return Ok(Evidence::invalid(None, "Evaluation deadline expired"));
            }
            "completed" => {}
            _ => {
                return Ok(Evidence::invalid(
                    comparison_id,
                    "Evaluation did not complete",
                ));
            }
        }
        let Some(comparison_id) = comparison_id else {
            return Ok(Evidence::invalid(
                None,
                "Completed evaluation lacks evidence",
            ));
        };
        let row = sqlx::query(
            "SELECT body,complete,submitter FROM comparisons WHERE (project_id,bundle_id,id)=($1,$2,$3)",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind(comparison_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let comparison: ComparisonRequest = serde_json::from_value(row.get("body")).map_err(db)?;
        let expected = self
            .evaluation_request(tx, round, round.get("candidate_version_id"), descriptor)
            .await?;
        if serde_json::to_value(&evaluation.request).map_err(db)?
            != serde_json::to_value(&expected).map_err(db)?
            || comparison.evaluation.is_none()
            || validate_report(
                &evaluation,
                &comparison,
                &self.evaluator,
                &row.get::<String, _>("submitter"),
            )
            .is_err()
            || !row.get::<bool, _>("complete")
            || validate_comparison(&comparison) != Ok(true)
        {
            return Ok(Evidence::invalid(
                Some(comparison_id),
                "Evidence bindings or completeness checks failed",
            ));
        }
        let policy: Option<Value> = sqlx::query_scalar(
            "SELECT selection_policies FROM connected_learning_policy_epochs
             WHERE project_id=$1 AND integration_id=$2 AND epoch=$3",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(round.get::<i64, _>("policy_epoch"))
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let selection = match policy {
            Some(policy) => {
                let policies: crate::connected_learning::selection::Policies =
                    serde_json::from_value(policy).map_err(db)?;
                let development =
                    round.get::<Option<Uuid>, _>("development_request_id") == Some(request_id);
                if development {
                    policies.development.check(&comparison)
                } else {
                    policies.audit.check(&comparison)
                }
            }
            None if improved(&comparison) => Ok(()),
            None => Err("No strict improvement without a case regression"),
        };
        if let Err(reason) = selection {
            return Ok(Evidence::Rejected {
                comparison: Some(comparison_id),
                reason,
                failed_quality_policy: true,
            });
        }
        Ok(Evidence::Passed(comparison_id))
    }

    async fn promote(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        comparison: Uuid,
        reviewer: &str,
    ) -> ApiResult<Uuid> {
        if !field_requalification::eligible(
            tx,
            self,
            round.get("candidate_version_id"),
            round.get("parent_revision"),
        )
        .await?
        {
            return Err(conflict(
                "Withdrawn content requires requalification on its field regressions",
            ));
        }
        let promotion = crate::channels::promote_in_tx(
            tx,
            &self.project,
            self.bundle,
            &self.channel,
            reviewer,
            PromoteRequest {
                version_id: round.get::<Uuid, _>("candidate_version_id").to_string(),
                expected_revision: round.get::<i64, _>("parent_revision").to_string(),
                comparison_id: Some(comparison.to_string()),
                unevaluated_reason: None,
            },
        )
        .await?;
        path(&promotion.id)
    }
}

/// Use the worker's authority and lock order before assigning private evaluator work.
pub(crate) async fn evaluator_active(
    tx: &mut Tx<'_>,
    s: &AppState,
    project: &str,
    integration: Uuid,
    principal: &str,
) -> ApiResult<bool> {
    let connection = Connection::lock(tx, s, project.to_owned(), integration)
        .await?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "not_found",
                "Learning enrollment not found",
            )
        })?;
    if connection.evaluator != principal {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Enrolled evaluator required",
        ));
    }
    Ok(connection.active)
}

enum Evidence {
    Pending,
    Rejected {
        comparison: Option<Uuid>,
        reason: &'static str,
        failed_quality_policy: bool,
    },
    Passed(Uuid),
}

impl Evidence {
    fn invalid(comparison: Option<Uuid>, reason: &'static str) -> Self {
        Self::Rejected {
            comparison,
            reason,
            failed_quality_policy: false,
        }
    }
}

fn improved(comparison: &ComparisonRequest) -> bool {
    let mut strictly_better = false;
    for pair in &comparison.results {
        let (Some(parent), Some(candidate)) = (pair.parent.reward, pair.candidate.reward) else {
            return false;
        };
        if candidate < parent
            || (pair.parent.execution_status == "completed"
                && pair.candidate.execution_status != "completed")
        {
            return false;
        }
        strictly_better |= candidate > parent;
    }
    strictly_better
}

fn baseline_matches(round: &PgRow, baseline: (Uuid, i64)) -> bool {
    round.get::<Uuid, _>("parent_version_id") == baseline.0
        && round.get::<i64, _>("parent_revision") == baseline.1
}

async fn requeue_correction(tx: &mut Tx<'_>, round: &PgRow) -> ApiResult<()> {
    sqlx::query(
        "UPDATE connected_learning_corrections SET pending=true,queued_at=clock_timestamp()
        WHERE (project_id,integration_id,correction_id)=($1,$2,$3) AND attempts<2",
    )
    .bind(round.get::<String, _>("project_id"))
    .bind(round.get::<Uuid, _>("integration_id"))
    .bind(round.get::<Uuid, _>("correction_id"))
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) async fn close(tx: &mut Tx<'_>, round: &PgRow, reason: &str) -> ApiResult<()> {
    let id: Uuid = round.get("id");
    sqlx::query("UPDATE proposals SET status='failed',error=$2 WHERE id=$1 AND status IN ('queued','running')")
        .bind(round.get::<Option<Uuid>, _>("proposal_id")).bind(reason)
        .execute(&mut **tx).await.map_err(db)?;
    sqlx::query("UPDATE evaluation_requests e SET status='interrupted',error=$2,updated_at=now()
        FROM connected_learning_rounds r WHERE r.id=$1 AND (e.project_id,e.bundle_id)=(r.project_id,r.bundle_id)
        AND e.id IN (r.development_request_id,r.audit_request_id) AND e.status IN ('requested','running')")
        .bind(id).bind(reason).execute(&mut **tx).await.map_err(db)?;
    sqlx::query("UPDATE connected_learning_rounds SET state='rejected',reason=$2,updated_at=now() WHERE id=$1")
        .bind(id).bind(reason).execute(&mut **tx).await.map_err(db)?;
    // A release action may invalidate the trial while the underlying correction still applies.
    let superseded: bool = sqlx::query_scalar("SELECT (c.version_id,c.revision) IS DISTINCT FROM ($3,$4)
        FROM connected_learning_enrollments e JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
        WHERE (e.project_id,e.integration_id)=($1,$2)")
        .bind(round.get::<String,_>("project_id")).bind(round.get::<Uuid,_>("integration_id"))
        .bind(round.get::<Uuid,_>("parent_version_id")).bind(round.get::<i64,_>("parent_revision")).fetch_one(&mut **tx).await.map_err(db)?;
    if superseded {
        requeue_correction(tx, round).await?;
    }
    Ok(())
}

async fn advance(
    tx: &mut Tx<'_>,
    connection: &Connection,
    round: &PgRow,
    baseline: (Uuid, i64),
) -> ApiResult<()> {
    if !connection.active {
        return close(tx, round, "Connection authority is inactive").await;
    }
    if !baseline_matches(round, baseline) {
        return close(tx, round, "Delivery baseline changed").await;
    }
    let id: Uuid = round.get("id");
    let state: String = round.get("state");
    match state.as_str() {
        "proposing" => {
            let proposal = sqlx::query("SELECT status,candidate_version_id FROM proposals WHERE (project_id,bundle_id,id)=($1,$2,$3)")
                .bind(&connection.project).bind(connection.bundle).bind(round.get::<Uuid, _>("proposal_id"))
                .fetch_one(&mut **tx).await.map_err(db)?;
            match proposal.get::<String, _>("status").as_str() {
                "queued" | "running" => return Ok(()),
                "succeeded" => {}
                _ => return close(tx, round, "Proposal did not generate a candidate").await,
            }
            let Some(candidate) = proposal.get::<Option<Uuid>, _>("candidate_version_id") else {
                return close(tx, round, "Successful proposal lacks a candidate").await;
            };
            let request_id = connection
                .queue_evaluation(tx, round, candidate, &connection.development)
                .await?;
            sqlx::query("UPDATE connected_learning_rounds SET state='development',candidate_version_id=$2,development_request_id=$3,updated_at=now() WHERE id=$1")
                .bind(id).bind(candidate).bind(request_id).execute(&mut **tx).await.map_err(db)?;
        }
        "development" => {
            let request = round.get("development_request_id");
            match connection
                .evidence(tx, round, request, &connection.development)
                .await?
            {
                Evidence::Pending => {}
                Evidence::Rejected {
                    comparison,
                    reason,
                    failed_quality_policy,
                } => {
                    sqlx::query("UPDATE connected_learning_rounds SET development_comparison_id=$2 WHERE id=$1")
                        .bind(id).bind(comparison).execute(&mut **tx).await.map_err(db)?;
                    close(tx, round, reason).await?;
                    if failed_quality_policy {
                        requeue_correction(tx, round).await?;
                    }
                }
                Evidence::Passed(comparison) => {
                    if !field_requalification::check_required_replays(tx, connection, round).await?
                    {
                        return Ok(());
                    }
                    let Some(index) = connection.next_audit(tx).await? else {
                        return close(tx, round, "Independent audit cohorts exhausted").await;
                    };
                    let candidate = round.get("candidate_version_id");
                    let request = connection
                        .queue_evaluation(tx, round, candidate, &connection.audits[index])
                        .await?;
                    sqlx::query("UPDATE connected_learning_rounds SET state='audit',development_comparison_id=$2,audit_index=$3,audit_request_id=$4,updated_at=now() WHERE id=$1")
                        .bind(id).bind(comparison).bind(index as i32).bind(request)
                        .execute(&mut **tx).await.map_err(db)?;
                }
            }
        }
        "audit" | "awaiting_review" => {
            let index: i32 = round.get("audit_index");
            if !connection.audit_is_registered(tx, index).await? {
                return close(tx, round, "Audit cohort is not independently registered").await;
            }
            let descriptor = connection
                .audits
                .get(index as usize)
                .ok_or_else(|| db("Unknown audit index"))?;
            let can_automate = connection.automatic
                && connection.development.committed()
                && descriptor.committed();
            if state == "awaiting_review" && !can_automate {
                return Ok(());
            }
            let request = round.get("audit_request_id");
            match connection.evidence(tx, round, request, descriptor).await? {
                Evidence::Pending => {}
                Evidence::Rejected {
                    comparison, reason, ..
                } => {
                    sqlx::query(
                        "UPDATE connected_learning_rounds SET audit_comparison_id=$2 WHERE id=$1",
                    )
                    .bind(id)
                    .bind(comparison)
                    .execute(&mut **tx)
                    .await
                    .map_err(db)?;
                    close(tx, round, reason).await?;
                }
                Evidence::Passed(comparison) => {
                    if !field_requalification::check_required_replays(tx, connection, round).await?
                    {
                        return Ok(());
                    }
                    if can_automate {
                        match connection
                            .promote(tx, round, comparison, &connection.authorizer)
                            .await
                        {
                            Ok(promotion) => {
                                record_promotion(tx, id, comparison, promotion).await?
                            }
                            Err(error) if error.0.is_client_error() => {
                                sqlx::query("UPDATE connected_learning_rounds SET audit_comparison_id=$2 WHERE id=$1")
                                    .bind(id).bind(comparison).execute(&mut **tx).await.map_err(db)?;
                                close(tx, round, "Candidate could not be promoted").await?
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        sqlx::query("UPDATE connected_learning_rounds SET state='awaiting_review',audit_comparison_id=$2,updated_at=now() WHERE id=$1")
                            .bind(id).bind(comparison).execute(&mut **tx).await.map_err(db)?;
                    }
                }
            }
        }
        _ => unreachable!("only active round states are selected"),
    }
    Ok(())
}

async fn record_promotion(
    tx: &mut Tx<'_>,
    round: Uuid,
    comparison: Uuid,
    promotion: Uuid,
) -> ApiResult<()> {
    sqlx::query("UPDATE connected_learning_rounds SET state='promoted',audit_comparison_id=$2,promotion_id=$3,updated_at=now() WHERE id=$1")
        .bind(round).bind(comparison).bind(promotion).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

async fn tick(s: &AppState, project: String, integration: Uuid) -> ApiResult<()> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(());
    };
    let mut tx = s.db.begin().await.map_err(db)?;
    let Some(connection) = Connection::lock(&mut tx, s, project, integration).await? else {
        return Ok(());
    };
    let round = sqlx::query(
        "SELECT * FROM connected_learning_rounds WHERE (project_id,integration_id)=($1,$2)
         AND state IN ('proposing','development','audit','awaiting_review') ORDER BY created_at,id LIMIT 1",
    )
    .bind(&connection.project).bind(connection.integration).fetch_optional(&mut *tx).await.map_err(db)?;
    let baseline = connection.baseline(&mut tx).await?;
    if let Some(round) = round {
        advance(&mut tx, &connection, &round, baseline).await?;
    } else {
        connection.admit(&mut tx, baseline).await?;
    }
    tx.commit().await.map_err(db)
}

/// Protect provider work before a queue claim and again before accepting its
/// result. The caller holds these authority locks through the proposal update.
pub(crate) async fn authorize_proposal(
    tx: &mut Tx<'_>,
    s: &AppState,
    project: &str,
    bundle: Uuid,
    proposal: Uuid,
) -> ApiResult<bool> {
    let integration: Option<Uuid> = sqlx::query_scalar(
        "SELECT integration_id FROM connected_learning_rounds WHERE (project_id,bundle_id,proposal_id)=($1,$2,$3)",
    )
    .bind(project).bind(bundle).bind(proposal).fetch_optional(&mut **tx).await.map_err(db)?;
    let Some(integration) = integration else {
        return Ok(true);
    };
    let Some(connection) = Connection::lock(tx, s, project.to_owned(), integration).await? else {
        return Ok(false);
    };
    let round = sqlx::query(
        "SELECT * FROM connected_learning_rounds WHERE (project_id,bundle_id,proposal_id)=($1,$2,$3)",
    )
    .bind(project).bind(bundle).bind(proposal).fetch_one(&mut **tx).await.map_err(db)?;
    if round.get::<String, _>("state") != "proposing" {
        return Ok(false);
    }
    if !connection.active {
        close(tx, &round, "Connection authority is inactive").await?;
        return Ok(false);
    }
    let baseline = connection.baseline(tx).await?;
    if !baseline_matches(&round, baseline) {
        close(tx, &round, "Delivery baseline changed").await?;
        return Ok(false);
    }
    Ok(true)
}

pub async fn connected_learning_worker(s: AppState) {
    while !s.runtime.is_draining() {
        let entries = sqlx::query_as::<_, (String, Uuid)>(
            "SELECT e.project_id,e.integration_id FROM connected_learning_enrollments e
             WHERE EXISTS (
                 SELECT 1 FROM connected_learning_rounds r
                 WHERE (r.project_id,r.integration_id)=(e.project_id,e.integration_id)
                 AND r.state IN ('proposing','development','audit','awaiting_review')
             )
             OR (
                 e.stopped_at IS NULL AND e.proposal_admissions < e.max_proposal_admissions
                 AND EXISTS (
                     SELECT 1 FROM integrations i WHERE (i.project_id,i.id)=(e.project_id,e.integration_id) AND i.enabled
                 )
                 AND EXISTS (
                     SELECT 1 FROM connected_learning_correction_work f
                     WHERE (f.project_id,f.integration_id)=(e.project_id,e.integration_id) AND f.action='ready'
                 )
                 AND EXISTS (
                     SELECT 1 FROM connected_learning_available_audits a
                     WHERE (a.project_id,a.integration_id)=(e.project_id,e.integration_id)
                 )
             )
             ORDER BY e.project_id,e.integration_id",
        ).fetch_all(&s.db).await;
        match entries {
            Ok(entries) => {
                for (project, integration) in entries {
                    if s.runtime.is_draining() {
                        return;
                    }
                    if let Err(error) = tick(&s, project.clone(), integration).await {
                        eprintln!(
                            "Connected learning round processing failed for {project}/{integration}: {}",
                            error.1
                        );
                    }
                }
            }
            Err(error) => eprintln!("Connected learning scan failed: {error}"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            _ = s.runtime.wait_for_drain() => return,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    approve: bool,
}

async fn review(
    State(s): State<AppState>,
    Path((project, integration, round_id)): Path<(String, Uuid, Uuid)>,
    headers: HeaderMap,
    Json(review): Json<Review>,
) -> ApiResult<Json<Value>> {
    let actor = crate::auth::actor(&headers, &s, &project, "promote")?;
    let mut tx = s.db.begin().await.map_err(db)?;
    crate::auth::authorize_transaction(&mut tx, &actor, &project, "promote").await?;
    let connection = Connection::lock(&mut tx, &s, project, integration)
        .await?
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "not_found",
                "Learning enrollment not found",
            )
        })?;
    if actor.principal == connection.evaluator || actor.principal == connection.submitter {
        return Err(err(
            StatusCode::FORBIDDEN,
            "denied",
            "Independent reviewer required",
        ));
    }
    let round = sqlx::query(
        "SELECT * FROM connected_learning_rounds WHERE (project_id,integration_id,id)=($1,$2,$3)",
    )
    .bind(&connection.project)
    .bind(integration)
    .bind(round_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            "not_found",
            "Learning round not found",
        )
    })?;
    let state: String = round.get("state");
    let reason: Option<String> = round.get("reason");
    if review.approve && state == "promoted" {
        return Ok(Json(
            json!({"roundId":round_id,"state":state,"promotionId":round.get::<Uuid,_>("promotion_id")}),
        ));
    }
    if !review.approve && reason.as_deref() == Some("Reviewer declined promotion") {
        return Ok(Json(json!({"roundId":round_id,"state":state})));
    }
    if state != "awaiting_review" {
        return Err(conflict("Round is not awaiting review"));
    }
    if !review.approve {
        close(&mut tx, &round, "Reviewer declined promotion").await?;
        tx.commit().await.map_err(db)?;
        return Ok(Json(json!({"roundId":round_id,"state":"rejected"})));
    }
    let baseline = connection.baseline(&mut tx).await?;
    if !connection.active || !baseline_matches(&round, baseline) {
        return Err(conflict(
            "Connection authority or delivery baseline changed",
        ));
    }
    let index: i32 = round.get("audit_index");
    if !connection.audit_is_registered(&mut tx, index).await? {
        return Err(conflict("Audit cohort is not independently registered"));
    }
    let descriptor = connection
        .audits
        .get(index as usize)
        .ok_or_else(|| db("Unknown audit index"))?;
    let evidence = connection
        .evidence(&mut tx, &round, round.get("audit_request_id"), descriptor)
        .await?;
    let Evidence::Passed(comparison) = evidence else {
        return Err(conflict("Audit evidence is not eligible for promotion"));
    };
    let promotion = connection
        .promote(&mut tx, &round, comparison, &actor.principal)
        .await?;
    record_promotion(&mut tx, round_id, comparison, promotion).await?;
    tx.commit().await.map_err(db)?;
    Ok(Json(
        json!({"roundId":round_id,"state":"promoted","promotionId":promotion}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CaseKey, CasePair, Outcome};

    fn scored(reward: f64, execution_status: &str) -> Outcome {
        Outcome {
            execution_status: execution_status.into(),
            grading_status: "scored".into(),
            reward: Some(reward),
            output_ref: None,
            error: None,
            usage: None,
        }
    }

    #[test]
    fn rollout_requires_a_strict_gain_without_regressions() {
        let keys = ["policy", "guard"].map(|case_id| CaseKey {
            case_id: case_id.into(),
            repetition: 0,
        });
        let mut comparison = ComparisonRequest {
            evaluation: None,
            parent_version_id: "parent".into(),
            candidate_version_id: "candidate".into(),
            parent_digest: "parent-digest".into(),
            candidate_digest: "candidate-digest".into(),
            dataset_revision: "dataset".into(),
            runtime: Default::default(),
            grader_revision: "grader".into(),
            expected_cases: keys.to_vec(),
            results: keys
                .into_iter()
                .map(|key| CasePair {
                    key,
                    parent: scored(1.0, "completed"),
                    candidate: scored(1.0, "completed"),
                })
                .collect(),
        };
        assert!(!improved(&comparison));
        comparison.results[0].candidate.reward = Some(10.0);
        assert!(improved(&comparison));
        comparison.results[1].candidate.reward = Some(0.0);
        assert!(!improved(&comparison));
        comparison.results[1].candidate = scored(1.0, "task_failed");
        assert!(!improved(&comparison));
        comparison.results[1].candidate = scored(1.0, "completed");
        comparison.results[1].candidate.reward = None;
        assert!(!improved(&comparison));
    }
}
