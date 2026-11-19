use crate::WorkspaceRoutes;
use crate::{
    ApiResult, AppState, CaseKey, ComparisonRequest, PromoteRequest, ProposalRequest,
    connected_learning::{
        Descriptor, repetitions,
        selection::Stage,
        statistics::{AUDIT_Z, DEVELOPMENT_Z},
    },
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
use sqlx::{Acquire, Postgres, Row, Transaction, postgres::PgRow};
use std::time::Duration;
use uuid::Uuid;

#[path = "connected_learning/field_audits.rs"]
mod field_audits;
#[path = "connected_learning/field_requalification.rs"]
mod field_requalification;

type Tx<'a> = Transaction<'a, Postgres>;
const WORKER: &str = "service:connected-learning";
const AUTOMATIC_ROLLOUT: &str = "Automatic rollout after a passing audit";
const REVIEW_DECLINED: &str = "Reviewer declined promotion";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .workspace_route("/v1/projects/{project}/integrations/{integration}/learning/field-requalifications/{version}",
            axum::routing::get(field_requalification::inspect))
        .workspace_route("/v1/projects/{project}/integrations/{integration}/learning/field-requalifications",
            post(field_requalification::submit))
        .workspace_route(
            "/v1/projects/{project}/integrations/{integration}/learning/field-audits",
            post(field_audits::submit),
        )
        .workspace_route(
            "/v1/projects/{project}/integrations/{integration}/learning/rounds/{round}/review",
            post(review),
        )
}

fn processing_error(reason: &str) -> crate::ApiErr {
    err(
        StatusCode::SERVICE_UNAVAILABLE,
        "learning_processing_error",
        reason,
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
    evaluator: String,
    submitter: String,
    permitted_paths: Vec<String>,
    development: Descriptor,
    audits: Vec<Descriptor>,
    automatic: bool,
    automatic_rollback: bool,
    has_budget: bool,
    max_corrections_per_round: i32,
    policy_epoch: i64,
    higher_is_better: bool,
    modern_development: bool,
    active: bool,
}

impl Connection {
    async fn lock(
        tx: &mut Tx<'_>,
        s: &AppState,
        project: String,
        integration: Uuid,
    ) -> ApiResult<Option<Self>> {
        Self::load(tx, s, project, integration, true).await
    }

    async fn load(
        tx: &mut Tx<'_>,
        s: &AppState,
        project: String,
        integration: Uuid,
        write: bool,
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
        let lock = if write { " FOR UPDATE" } else { "" };
        let query = format!(
            "SELECT *,stopped_at IS NULL AS running,proposal_admissions<max_proposal_admissions AS has_budget FROM connected_learning_enrollments WHERE project_id=$1 AND integration_id=$2{lock}",
        );
        let row = sqlx::query(&query)
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
        let policies: crate::connected_learning::selection::Policies = row
            .get::<Option<Value>, _>("selection_policies")
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| processing_error("Invalid stored selection policies"))?
            .unwrap_or_default();
        Ok(Some(Self {
            policy_epoch: row.get("policy_epoch"),
            higher_is_better: policies.development.higher_is_better(),
            modern_development: policies.development.modern(),
            project,
            integration,
            bundle: row.get("bundle_id"),
            channel: row.get("delivery_channel"),
            evaluator,
            submitter,
            permitted_paths: row.get("permitted_paths"),
            development: serde_json::from_value(row.get("development"))
                .map_err(|_| processing_error("Invalid stored development descriptor"))?,
            audits: serde_json::from_value(row.get("audits"))
                .map_err(|_| processing_error("Invalid stored audit descriptors"))?,
            automatic: role.as_deref() == Some("admin") && row.get("automatic_rollout"),
            automatic_rollback: row.get("automatic_rollback"),
            has_budget: row.get("has_budget"),
            max_corrections_per_round: row.get("max_corrections_per_round"),
            active,
        }))
    }

    async fn audit_rejected_digest(&self, tx: &mut Tx<'_>, version: Uuid) -> ApiResult<bool> {
        sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM connected_learning_rounds r
                JOIN versions rejected ON rejected.id=r.candidate_version_id
                JOIN versions proposed ON proposed.id=$4 AND proposed.digest=rejected.digest
                WHERE (r.project_id,r.integration_id,r.policy_epoch)=($1,$2,$3)
                  AND r.audit_policy_rejected
            )",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(self.policy_epoch)
        .bind(version)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)
    }

    async fn record_automatic(&self, tx: &mut Tx<'_>, promotion: Uuid) -> ApiResult<()> {
        sqlx::query(
            "INSERT INTO connected_learning_automatic_promotions(promotion_id,authorization_id)
            VALUES ($3,(SELECT id FROM connected_learning_authorizations
              WHERE (project_id,integration_id)=($1,$2) ORDER BY id DESC LIMIT 1))",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(promotion)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        Ok(())
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

    async fn sync_incumbent(&self, tx: &mut Tx<'_>, baseline: (Uuid, i64)) -> ApiResult<bool> {
        let changed: Option<bool> = sqlx::query_scalar(
            "WITH current AS (
                SELECT source.revision, head.sequence, head.baseline_version_id, head.baseline_revision, head.source_revision
                FROM connected_learning_enrollments e
                JOIN channels source ON (source.project_id,source.bundle_id,source.name)=(e.project_id,e.bundle_id,e.source_channel)
                LEFT JOIN LATERAL (
                    SELECT * FROM connected_learning_incumbent_events h
                    WHERE (h.project_id,h.integration_id,h.policy_epoch)=(e.project_id,e.integration_id,e.policy_epoch)
                    ORDER BY sequence DESC LIMIT 1
                ) head ON true
                WHERE (e.project_id,e.integration_id)=($1,$2)
                FOR SHARE OF source
            )
            , inserted AS (INSERT INTO connected_learning_incumbent_events
                (project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,version_id,chain_length,reason)
            SELECT $1,$2,$3,$4,$5,revision,$4,0,
                CASE WHEN sequence IS NULL THEN 'epoch initialized' ELSE 'published channel changed' END
            FROM current WHERE (baseline_version_id,baseline_revision,source_revision) IS DISTINCT FROM ($4,$5,revision)
            RETURNING sequence)
            SELECT current.sequence IS NOT NULL FROM current CROSS JOIN inserted",
        )
        .bind(&self.project).bind(self.integration).bind(self.policy_epoch).bind(baseline.0).bind(baseline.1)
        .fetch_optional(&mut **tx).await.map_err(db)?;
        if changed == Some(true) {
            discard_developed(tx, &self.project, self.integration, self.policy_epoch).await?;
        }
        Ok(changed == Some(true))
    }

    async fn accept_development(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        comparison: Uuid,
        indeterminate_cost: bool,
    ) -> ApiResult<(i32, bool)> {
        sqlx::query_as(
            "INSERT INTO connected_learning_incumbent_events
                (project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,
                 version_id,parent_version_id,round_id,development_comparison_id,chain_length,indeterminate_cost,reason)
             SELECT project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,
                 $4,version_id,$5,$6,chain_length+1,indeterminate_cost OR $7,'development accepted'
             FROM connected_learning_incumbent_events
             WHERE (project_id,integration_id,policy_epoch)=($1,$2,$3)
             ORDER BY sequence DESC LIMIT 1
             RETURNING chain_length,indeterminate_cost",
        )
        .bind(&self.project).bind(self.integration).bind(self.policy_epoch)
        .bind(round.get::<Uuid,_>("candidate_version_id")).bind(round.get::<Uuid,_>("id")).bind(comparison)
        .bind(indeterminate_cost)
        .fetch_one(&mut **tx).await.map_err(db)
    }

    async fn cumulative_growth_allowed(&self, tx: &mut Tx<'_>, round: &PgRow) -> ApiResult<bool> {
        let (baseline, candidate): (Vec<u8>, Vec<u8>) = sqlx::query_as(
            "SELECT p.payload,c.payload FROM versions p CROSS JOIN versions c WHERE p.id=$1 AND c.id=$2",
        )
        .bind(round.get::<Uuid,_>("parent_version_id")).bind(round.get::<Uuid,_>("candidate_version_id"))
        .fetch_one(&mut **tx).await.map_err(db)?;
        let baseline = serde_json::from_slice(&baseline).map_err(db)?;
        let candidate = serde_json::from_slice(&candidate).map_err(db)?;
        Ok(crate::proposal_edits::validate_growth(&baseline, &candidate).is_ok())
    }

    async fn admit(&self, tx: &mut Tx<'_>, baseline: (Uuid, i64)) -> ApiResult<()> {
        if !self.active || !self.has_budget || self.next_audit(tx).await?.is_none() {
            return Ok(());
        }
        let outcomes = sqlx::query(
            "SELECT * FROM connected_learning_correction_work
             WHERE (project_id,bundle_id,integration_id)=($1,$2,$3) AND action='ready'
             AND (version_id,revision)=($4,$5)
             ORDER BY queued_at,correction_id LIMIT $6",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind(self.integration)
        .bind(baseline.0)
        .bind(baseline.1)
        .bind(i64::from(self.max_corrections_per_round))
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?;
        let Some(outcome) = outcomes.first() else {
            return Ok(());
        };
        let incumbent: Uuid = sqlx::query_scalar(
            "SELECT version_id FROM connected_learning_incumbent_events
             WHERE (project_id,integration_id,policy_epoch)=($1,$2,$3) ORDER BY sequence DESC LIMIT 1",
        )
        .bind(&self.project).bind(self.integration).bind(self.policy_epoch)
        .fetch_one(&mut **tx).await.map_err(db)?;
        let mut included = Vec::new();
        let mut structural = false;
        let mut includes_lesson = false;
        let mut rejection = None;
        let mut request = ProposalRequest {
            parent_version_id: incumbent.to_string(),
            allowed_paths: Vec::new(),
            hypothesis: "Improve the bundle to address the admitted corrections.".into(),
            evidence: Vec::new(),
        };
        for row in &outcomes {
            let correction: Uuid = row.get("correction_id");
            let lesson: Option<Value> = row.get("lesson");
            let feedback: Option<Value> = row.get("feedback");
            let mut next = request.clone();
            let build = || -> ApiResult<ProposalRequest> {
                let paths = match &lesson {
                    Some(lesson) => vec![
                        lesson["path"]
                            .as_str()
                            .ok_or_else(|| processing_error("Missing lesson path"))?
                            .to_owned(),
                    ],
                    None => self.permitted_paths.clone(),
                };
                if paths
                    .iter()
                    .any(|path| !self.permitted_paths.contains(path))
                {
                    return Err(processing_error(
                        "Queued lesson path is no longer permitted",
                    ));
                }
                let provenance = json!({
                    "correctionId": correction,
                    "outcomeId": row.get::<Uuid, _>("outcome_id"),
                    "observedVersionId": row.get::<Uuid, _>("observed_version"),
                    "observedDigest": row.get::<String, _>("observed_digest"),
                    "observedRevision": row.get::<Option<i64>, _>("observed_revision").map(|r| r.to_string()),
                    "status": row.get::<String, _>("status"),
                    "baselineVersionId": baseline.0,
                    "baselineRevision": baseline.1.to_string(),
                    "reproducedOnBaseline": row.get::<Uuid, _>("observed_version") != baseline.0
                        || row.get::<Option<i64>, _>("observed_revision") != Some(baseline.1),
                    "lessonPath": lesson.as_ref().map(|l| &l["path"]),
                });
                next.evidence.push(evidence_entry(
                    "service",
                    "correction",
                    &provenance.to_string(),
                ));
                if let Some(lesson) = &lesson {
                    let instruction = lesson["instruction"]
                        .as_str()
                        .ok_or_else(|| processing_error("Missing lesson instruction"))?;
                    next.evidence
                        .push(evidence_entry("app", "lessonInstruction", instruction));
                }
                if let Some(feedback) = feedback {
                    let expected = feedback["expected"]
                        .as_str()
                        .ok_or_else(|| processing_error("Missing expected outcome"))?;
                    let observed = feedback["observed"]
                        .as_str()
                        .ok_or_else(|| processing_error("Missing observed outcome"))?;
                    next.evidence
                        .push(evidence_entry("app", "expected", expected));
                    next.evidence
                        .push(evidence_entry("app", "observed", observed));
                }
                for path in paths {
                    if !next.allowed_paths.contains(&path) {
                        next.allowed_paths.push(path);
                    }
                }
                Ok(next)
            };
            let next = match build() {
                Ok(next) => next,
                Err(error) => {
                    if included.is_empty() {
                        included.push(correction);
                        rejection = Some(error.2);
                    }
                    break;
                }
            };
            if !fits_proposal_prompt(&next) {
                break;
            }
            structural |= lesson.is_none();
            includes_lesson |= lesson.is_some();
            included.push(correction);
            request = next;
        }
        let Some(&correction) = included.first() else {
            return Ok(());
        };
        let proposal = if rejection.is_some() {
            None
        } else {
            let mut history = Vec::new();
            self.add_proposal_history(tx, &included, includes_lesson, &mut history)
                .await?;
            for entry in history {
                request.evidence.push(entry);
                if !fits_proposal_prompt(&request) {
                    request.evidence.pop();
                    break;
                }
            }
            enqueue_managed_proposal(
                tx,
                &self.project,
                self.bundle,
                self.integration,
                &request,
                structural,
            )
            .await?
            .map(|(id, _)| id)
        };
        let reason = rejection.or_else(|| {
            proposal
                .is_none()
                .then(|| "Correction has no applicable permitted paths".to_owned())
        });
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
        let attempts: std::collections::HashMap<Uuid, i32> = sqlx::query_as::<_, (Uuid, i32)>(
            "UPDATE connected_learning_corrections SET pending=false, attempts=attempts+1
            WHERE (project_id,integration_id)=($1,$2) AND correction_id=ANY($3)
            RETURNING correction_id,attempts",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(&included)
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?
        .into_iter()
        .collect();
        let round_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO connected_learning_rounds (id,project_id,bundle_id,integration_id,outcome_id,parent_version_id,parent_revision,proposal_id,state,reason,correction_id,attempt,policy_epoch,development_parent_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(round_id)
        .bind(&self.project)
        .bind(self.bundle)
        .bind(self.integration)
        .bind(outcome.get::<Uuid, _>("outcome_id"))
        .bind(baseline.0)
        .bind(baseline.1)
        .bind(proposal)
        .bind(if proposal.is_some() { "proposing" } else { "rejected" })
        .bind(reason)
        .bind(correction).bind(attempts[&correction]).bind(self.policy_epoch).bind(incumbent)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        for (index, correction) in included.iter().enumerate().skip(1) {
            sqlx::query("INSERT INTO connected_learning_round_corrections
                (round_id,project_id,integration_id,correction_id,attempt,position) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(round_id).bind(&self.project).bind(self.integration).bind(correction)
                .bind(attempts[correction]).bind(index as i32 + 1)
                .execute(&mut **tx).await.map_err(db)?;
        }
        Ok(())
    }

    async fn add_proposal_history(
        &self,
        tx: &mut Tx<'_>,
        corrections: &[Uuid],
        includes_lesson: bool,
        evidence: &mut Vec<String>,
    ) -> ApiResult<()> {
        let history = sqlx::query(
            "SELECT members.provenance,
                    r.candidate_version_id,r.state,r.decision,r.audit_request_id,r.audit_policy_rejected,
                    CASE WHEN (NOT members.has_lesson OR $5)
                           AND p.screening -> -1 -> 'scannerClean' = 'true'::jsonb
                         THEN p.rationale END AS rationale,
                    parent.payload AS before,candidate.payload AS after,c.body
             FROM connected_learning_rounds r
             CROSS JOIN LATERAL (
                 SELECT jsonb_agg(jsonb_build_object('correctionId',m.correction_id,'outcomeId',c.outcome_id,
                            'attempt',m.attempt) ORDER BY m.position) AS provenance,
                        bool_or(m.correction_id=ANY($4::uuid[])) AS same_correction,
                        bool_or(c.lesson IS NOT NULL) AS has_lesson
                 FROM connected_learning_round_corrections m
                 JOIN connected_learning_corrections c USING (project_id,integration_id,correction_id)
                 WHERE m.round_id=r.id
             ) members
             JOIN proposals p ON p.id=r.proposal_id
             JOIN versions parent ON parent.id=p.parent_version_id
             LEFT JOIN versions candidate ON candidate.id=r.candidate_version_id
             LEFT JOIN comparisons c
               ON (c.project_id,c.bundle_id,c.id)=(r.project_id,r.bundle_id,r.development_comparison_id)
               AND c.complete AND c.id IS DISTINCT FROM r.audit_comparison_id
               AND r.development_request_id IS DISTINCT FROM r.audit_request_id
               AND c.body #>> '{evaluation,requestId}'=r.development_request_id::text
             WHERE (r.project_id,r.integration_id,r.bundle_id)=($1,$2,$3)
               AND (r.state IN ('promoted','developed') OR (r.state='rejected'
                 AND (r.candidate_version_id IS NOT NULL OR r.decision IN ('critic_rejected','scanner_rejected'))))
             ORDER BY members.same_correction DESC,r.updated_at DESC,r.id DESC LIMIT 12",
        )
        .bind(&self.project).bind(self.integration).bind(self.bundle).bind(corrections).bind(includes_lesson)
        .fetch_all(&mut **tx).await.map_err(db)?;
        let mut remaining = 8192;
        for row in history {
            let label = match row.get::<Option<&str>, _>("decision") {
                Some("critic_rejected") => Some("critic-rejected"),
                Some("scanner_rejected") => Some("scanner-rejected"),
                _ => None,
            };
            if let Some(label) = label {
                evidence.push(evidence_entry("service", "priorOutcome", label));
                continue;
            }
            let candidate = row.get::<Option<Uuid>, _>("candidate_version_id");
            let outcome = if row.get::<String, _>("state") == "promoted" {
                "accepted"
            } else if row.get::<String, _>("state") == "developed" {
                "development-accepted"
            } else if row.get::<Option<String>, _>("decision").as_deref() == Some("review_declined")
            {
                "review-declined"
            } else if row.get::<bool, _>("audit_policy_rejected") {
                "audit-rejected"
            } else if row.get::<Option<String>, _>("decision").as_deref() == Some("chain_discarded")
            {
                "chain-discarded"
            } else if row.get::<Option<Uuid>, _>("audit_request_id").is_some() {
                "audit-rejected"
            } else {
                "development-rejected"
            };
            let mut improved = std::collections::BTreeSet::new();
            let mut regressed = std::collections::BTreeSet::new();
            let (mut gains, mut losses, mut failures, mut scored) = (0, 0, 0, 0);
            if let Some(body) = row.get::<Option<Value>, _>("body") {
                let comparison: ComparisonRequest = serde_json::from_value(body).map_err(db)?;
                for pair in comparison.results {
                    if pair.candidate.execution_status == "task_failed" {
                        failures += 1;
                    }
                    if let (Some(before), Some(after)) = (pair.parent.reward, pair.candidate.reward)
                    {
                        scored += 1;
                        if before != after {
                            if (after > before) == self.higher_is_better {
                                gains += 1;
                                improved.insert(pair.key.case_id);
                            } else {
                                losses += 1;
                                regressed.insert(pair.key.case_id);
                            }
                        }
                    }
                }
            }
            let excerpts = if let Some(after) = row.get::<Option<Vec<u8>>, _>("after")
                && row.get::<Option<String>, _>("rationale").is_some()
            {
                let before =
                    serde_json::from_slice(&row.get::<Vec<u8>, _>("before")).map_err(db)?;
                let after = serde_json::from_slice(&after).map_err(db)?;
                serde_json::json!(crate::proposal_edits::edit_excerpts(&before, &after))
            } else {
                Value::Null
            };
            let entry = serde_json::json!({
                "candidateVersionId": candidate,
                "includedCorrections": row.get::<Value, _>("provenance"),
                "outcome": outcome,
                "rationale": row.get::<Option<String>, _>("rationale").map(|text| text.chars().take(160).collect::<String>()),
                "edits": excerpts,
                "development": (scored + failures > 0).then(|| serde_json::json!({
                    "scoredPairs": scored, "improvedPairs": gains, "regressedPairs": losses,
                    "improvedCaseIds": improved.into_iter().take(8).collect::<Vec<_>>(),
                    "regressedCaseIds": regressed.into_iter().take(8).collect::<Vec<_>>(),
                    "taskFailures": failures
                })),
            });
            let summary = evidence_entry("service", "priorAttempt", &entry.to_string());
            if summary.len() <= remaining.min(4096) {
                remaining -= summary.len();
                evidence.push(summary);
            }
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

    async fn evaluation_request(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        candidate: Uuid,
        descriptor: &Descriptor,
        step: bool,
    ) -> ApiResult<CreateEvaluationRequest> {
        let parent = if step {
            development_parent(round)
        } else {
            round.get("parent_version_id")
        };
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
            proposal_id: if parent != development_parent(round) {
                None
            } else {
                round
                    .get::<Option<Uuid>, _>("proposal_id")
                    .map(|id| id.to_string())
            },
            require_bound_evidence: true,
        })
    }

    async fn queue_evaluation(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        candidate: Uuid,
        descriptor: &Descriptor,
        step: bool,
    ) -> ApiResult<Uuid> {
        let mut request = self
            .evaluation_request(tx, round, candidate, descriptor, step)
            .await?;
        let plan: Option<Value> = sqlx::query_scalar(
            "SELECT repetition_plan FROM connected_learning_policy_epochs
             WHERE (project_id,integration_id,epoch)=($1,$2,$3)",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(round.get::<i64, _>("policy_epoch"))
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        if let Some(plan) = plan {
            let plan: repetitions::Plan =
                serde_json::from_value(plan["plan"].clone()).map_err(db)?;
            let audit = self.audits.iter().position(|audit| audit == descriptor);
            request.expected_cases = plan.expected_cases(descriptor, audit);
        }
        let evaluation =
            enqueue_evaluation(tx, &self.project, self.bundle, WORKER, &request).await?;
        let id = path(&evaluation.id)?;
        // Legacy policies can use a fresh first step as their cumulative check.
        let private_parent = development_parent(round) != round.get::<Uuid, _>("parent_version_id");
        if step && private_parent {
            crate::connected_learning::parent_cache::assign(
                tx,
                id,
                (
                    &self.project,
                    self.integration,
                    self.bundle,
                    self.policy_epoch,
                ),
                &self.evaluator,
                &request,
            )
            .await?;
        }
        Ok(id)
    }

    async fn calibrate(&self, tx: &mut Tx<'_>, baseline: Uuid) -> ApiResult<bool> {
        use crate::connected_learning::statistics::scored_reward;
        let row = sqlx::query(
            "SELECT p.calibration_request_id,(p.noise_calibration IS NOT NULL AND p.repetition_plan IS NOT NULL) AS published,p.selection_policies,p.calibration_stopped_reason,
                    e.status,c.body,c.complete,c.submitter,
                    CASE WHEN e.started_at IS NULL THEN e.created_at < now()-make_interval(secs => $5)
                         ELSE e.started_at < now()-make_interval(secs => $4) END AS expired
             FROM connected_learning_policy_epochs p
             LEFT JOIN evaluation_requests e ON e.id=p.calibration_request_id
             LEFT JOIN comparisons c ON c.id=e.comparison_id
             WHERE (p.project_id,p.integration_id,p.epoch)=($1,$2,$3)",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(self.policy_epoch)
        .bind(deadline_seconds(
            "ACCLIMATE_LEARNING_EVALUATION_SECONDS",
            86_400,
        ))
        .bind(evaluation_queue_seconds())
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        if row
            .get::<Option<String>, _>("calibration_stopped_reason")
            .is_some()
        {
            return Ok(false);
        }
        if row.get::<bool, _>("published") {
            return Ok(true);
        }
        if row
            .get::<Option<Uuid>, _>("calibration_request_id")
            .is_none()
        {
            let digest: String = sqlx::query_scalar("SELECT digest FROM versions WHERE id=$1")
                .bind(baseline)
                .fetch_one(&mut **tx)
                .await
                .map_err(db)?;
            let d = &self.development;
            let request = CreateEvaluationRequest {
                parent_version_id: baseline.to_string(),
                candidate_version_id: baseline.to_string(),
                parent_digest: digest.clone(),
                candidate_digest: digest,
                dataset_revision: d.dataset_revision.clone(),
                grader_revision: d.grader_revision.clone(),
                runtime: d.evaluation_runtime(),
                expected_cases: repetitions::calibration_keys(d),
                proposal_id: None,
                require_bound_evidence: true,
            };
            let evaluation =
                enqueue_evaluation(tx, &self.project, self.bundle, WORKER, &request).await?;
            sqlx::query(
                "UPDATE connected_learning_policy_epochs SET calibration_request_id=$4
                         WHERE (project_id,integration_id,epoch)=($1,$2,$3)",
            )
            .bind(&self.project)
            .bind(self.integration)
            .bind(self.policy_epoch)
            .bind(path(&evaluation.id)?)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
            return Ok(false);
        }
        let status: Option<String> = row.get("status");
        if matches!(status.as_deref(), Some("requested" | "running"))
            && row.get::<Option<bool>, _>("expired") == Some(true)
        {
            sqlx::query("UPDATE evaluation_requests SET status='interrupted',error='Calibration deadline expired',updated_at=now()
                         WHERE id=$1 AND status IN ('requested','running')")
                .bind(row.get::<Uuid,_>("calibration_request_id"))
                .execute(&mut **tx).await.map_err(db)?;
            return Ok(false);
        }
        if matches!(status.as_deref(), Some("requested" | "running")) {
            return Ok(false);
        }
        let comparison = if status.as_deref() == Some("completed")
            && row.get::<Option<bool>, _>("complete") == Some(true)
            && row.get::<Option<String>, _>("submitter").as_deref() == Some(&self.evaluator)
        {
            serde_json::from_value::<ComparisonRequest>(row.get("body"))
                .ok()
                .filter(|comparison| {
                    validate_comparison(comparison) == Ok(true)
                        && comparison.results.iter().any(|pair| {
                            scored_reward(&pair.parent).is_some()
                                && scored_reward(&pair.candidate).is_some()
                        })
                        && comparison
                            .results
                            .iter()
                            .flat_map(|pair| [&pair.parent, &pair.candidate])
                            .filter_map(scored_reward)
                            .all(|v| (0.0..=1.0).contains(&v))
                })
        } else {
            None
        };
        let Some(comparison) = comparison else {
            sqlx::query(
                "UPDATE connected_learning_policy_epochs SET calibration_request_id=NULL,
                calibration_failures=calibration_failures+1,
                calibration_stopped_reason=CASE WHEN calibration_failures+1 >= $4
                    THEN 'Calibration attempt limit reached without usable evidence' END
                WHERE (project_id,integration_id,epoch)=($1,$2,$3)",
            )
            .bind(&self.project)
            .bind(self.integration)
            .bind(self.policy_epoch)
            .bind(deadline_seconds("ACCLIMATE_LEARNING_CALIBRATION_ATTEMPTS", 3) as i32)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
            return Ok(false);
        };
        let policies: crate::connected_learning::selection::Policies = row
            .get::<Option<Value>, _>("selection_policies")
            .map(serde_json::from_value)
            .transpose()
            .map_err(db)?
            .unwrap_or_default();
        let calibration = crate::connected_learning::statistics::calibrate(
            &comparison,
            policies.development.threshold(Stage::Cumulative),
            scored_reward,
        );
        let repetition_keys = |report: &ComparisonRequest| {
            let sorted = |mut keys: Vec<CaseKey>| {
                keys.sort_unstable_by(|a, b| {
                    (&a.case_id, a.repetition).cmp(&(&b.case_id, b.repetition))
                });
                keys
            };
            let scored = report
                .results
                .iter()
                .filter(|pair| {
                    scored_reward(&pair.parent).is_some()
                        && scored_reward(&pair.candidate).is_some()
                })
                .map(|pair| pair.key.clone())
                .collect();
            (sorted(report.expected_cases.clone()), sorted(scored))
        };
        let keys = repetition_keys(&comparison);
        let previous: Vec<(Value, Value)> = sqlx::query_as(
            "SELECT p.noise_calibration, c.body
             FROM connected_learning_policy_epochs p
             JOIN evaluation_requests e ON e.id=p.calibration_request_id
             JOIN comparisons c ON c.id=e.comparison_id
             WHERE (p.project_id,p.integration_id)=($1,$2) AND p.epoch < $3
               AND p.development=$4 AND c.submitter=$5 AND e.status='completed' AND c.complete
               AND p.noise_calibration IS NOT NULL AND p.repetition_plan IS NOT NULL
               AND c.body->>'parentVersionId'=$6 AND c.body->>'parentDigest'=$7
             ORDER BY p.epoch",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(self.policy_epoch)
        .bind(json!(self.development))
        .bind(&self.evaluator)
        .bind(&comparison.parent_version_id)
        .bind(&comparison.parent_digest)
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?;
        let history = previous
            .into_iter()
            .filter_map(|(calibration, report)| {
                let report = serde_json::from_value::<ComparisonRequest>(report).ok()?;
                (report.candidate_version_id == comparison.candidate_version_id
                    && report.candidate_digest == comparison.candidate_digest
                    && report.dataset_revision == comparison.dataset_revision
                    && report.grader_revision == comparison.grader_revision
                    && report.runtime == comparison.runtime
                    && repetition_keys(&report) == keys)
                    .then(|| serde_json::from_value(calibration))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(db)?;
        let (guard_noise, observations) =
            crate::connected_learning::statistics::pool_calibrations(&calibration, &history);
        let noise = (&guard_noise, observations);
        let target = policies.development.target_effect;
        let audit_target = policies.audit.target_effect.or(target);
        let plan = repetitions::Plan::new(&self.development, &self.audits, &calibration);
        let development = plan.project(
            &self.development,
            None,
            noise,
            policies.development.threshold(Stage::Development {
                replay_passed: false,
            }),
            DEVELOPMENT_Z,
            target,
        );
        let cumulative = plan.project(
            &self.development,
            None,
            noise,
            policies.development.threshold(Stage::Cumulative),
            DEVELOPMENT_Z,
            target,
        );
        let audits: Vec<_> = self
            .audits
            .iter()
            .enumerate()
            .map(|(index, audit)| {
                plan.project(
                    audit,
                    Some(index),
                    noise,
                    policies.audit.threshold(Stage::Audit),
                    AUDIT_Z,
                    audit_target,
                )
            })
            .collect();
        let gates = std::iter::once(("Development".to_owned(), &development))
            .chain(std::iter::once(("Cumulative".to_owned(), &cumulative)))
            .chain(
                audits
                    .iter()
                    .enumerate()
                    .map(|(index, audit)| (format!("Audit {}", index + 1), audit)),
            );
        let stopped = gates
            .clone()
            .find_map(|(stage, gate)| gate.stop_reason(&stage));
        let warnings = gates
            .filter_map(|(stage, gate)| gate.warning(&stage))
            .collect::<Vec<_>>();
        let warning = (!warnings.is_empty()).then(|| warnings.join("\n"));
        sqlx::query(
            "UPDATE connected_learning_policy_epochs
             SET noise_calibration=$4,repetition_plan=$5,calibration_stopped_reason=$6
             WHERE (project_id,integration_id,epoch)=($1,$2,$3)",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(self.policy_epoch)
        .bind(json!(calibration))
        .bind(json!({"plan": plan, "developmentProjection": development, "cumulativeProjection": cumulative, "auditProjections": audits, "powerGuardObservations": observations, "powerGuardNoise": guard_noise, "warning": warning}))
        .bind(&stopped)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        Ok(stopped.is_none())
    }

    async fn evidence(
        &self,
        tx: &mut Tx<'_>,
        round: &PgRow,
        request_id: Uuid,
        descriptor: &Descriptor,
    ) -> ApiResult<Evidence> {
        let row = sqlx::query(
            "SELECT *, CASE WHEN started_at IS NULL THEN created_at < now()-make_interval(secs => $5)
                ELSE started_at < now()-make_interval(secs => $4) END AS expired FROM evaluation_requests WHERE (project_id,bundle_id,id)=($1,$2,$3)",
        )
        .bind(&self.project)
        .bind(self.bundle)
        .bind(request_id)
        .bind(deadline_seconds("ACCLIMATE_LEARNING_EVALUATION_SECONDS", 86_400))
        .bind(evaluation_queue_seconds())
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let expired: bool = row.get("expired");
        let evaluation =
            decode(row).map_err(|_| processing_error("Invalid stored evaluation request"))?;
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
        let step = round.get::<Option<Uuid>, _>("development_request_id") == Some(request_id);
        let development =
            step || round.get::<Option<Uuid>, _>("cumulative_request_id") == Some(request_id);
        let candidate = if step {
            round.get("candidate_version_id")
        } else {
            release_candidate(round)
        };
        let mut expected = self
            .evaluation_request(tx, round, candidate, descriptor, step)
            .await?;
        // The immutable request carries the inventory selected when it was queued.
        expected
            .expected_cases
            .clone_from(&evaluation.request.expected_cases);
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
        let (policy, mut calibration): (Option<Value>, Option<Value>) = sqlx::query_as(
            "SELECT selection_policies,noise_calibration FROM connected_learning_policy_epochs
             WHERE project_id=$1 AND integration_id=$2 AND epoch=$3",
        )
        .bind(&self.project)
        .bind(self.integration)
        .bind(round.get::<i64, _>("policy_epoch"))
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        if calibration.is_none() {
            // An upgrade may invalidate the report of a still-active round.
            if !self.calibrate(tx, round.get("parent_version_id")).await? {
                return Ok(Evidence::invalid(
                    Some(comparison_id),
                    "A valid noise calibration is required",
                ));
            }
            calibration = sqlx::query_scalar(
                "SELECT noise_calibration FROM connected_learning_policy_epochs
                 WHERE (project_id,integration_id,epoch)=($1,$2,$3)",
            )
            .bind(&self.project)
            .bind(self.integration)
            .bind(round.get::<i64, _>("policy_epoch"))
            .fetch_one(&mut **tx)
            .await
            .map_err(db)?;
        }
        let policies: crate::connected_learning::selection::Policies = policy
            .map(serde_json::from_value)
            .transpose()
            .map_err(db)?
            .unwrap_or_default();
        let mut repetitions = std::collections::BTreeMap::new();
        for pair in &comparison.results {
            *repetitions.entry(&pair.key.case_id).or_insert(0usize) += 1;
        }
        let evaluated =
            crate::connected_learning::statistics::harmonic_repetitions(repetitions.into_values());
        let calibrated_sd = calibration
            .and_then(|v| {
                Some(
                    v["pairedStandardDeviation"].as_f64()?
                        * (v["effectiveRepetitions"].as_f64()? / evaluated).sqrt(),
                )
            })
            .unwrap_or(0.0);
        let policy = if development {
            &policies.development
        } else {
            &policies.audit
        };
        let mut summary = None;
        let stage = if step {
            Stage::Development {
                replay_passed: round.get::<Option<String>, _>("incident_replay").as_deref()
                    == Some("pass"),
            }
        } else if development {
            Stage::Cumulative
        } else {
            Stage::Audit
        };
        let result = policy.check_with_summary(&comparison, stage, calibrated_sd, &mut summary);
        if development
            && (!step || development_parent(round) == round.get::<Uuid, _>("parent_version_id"))
            && let Some((estimate, bound)) = summary
        {
            sqlx::query("UPDATE connected_learning_rounds SET cumulative_estimate=$2,cumulative_bound=$3 WHERE id=$1")
                .bind(round.get::<Uuid,_>("id")).bind(estimate).bind(bound)
                .execute(&mut **tx).await.map_err(db)?;
        }
        if let Err(reason) = result {
            if step
                && reason == "Development step lacks evidence of benefit"
                && round.get::<Option<String>, _>("incident_replay").as_deref() == Some("pending")
            {
                return Ok(Evidence::Pending);
            }
            if matches!(
                reason,
                "Candidate cost is unknown" | "Parent cost is unknown"
            ) {
                return Ok(Evidence::Indeterminate(comparison_id));
            }
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
        policy_override: Option<crate::PolicyOverride>,
    ) -> ApiResult<Uuid> {
        if !matches!(
            round.get::<Option<String>, _>("incident_replay").as_deref(),
            None | Some("pass")
        ) {
            return Err(conflict(
                "A passing replay of the triggering incident is required",
            ));
        }
        if !field_requalification::eligible(
            tx,
            self,
            release_candidate(round),
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
                version_id: release_candidate(round).to_string(),
                expected_revision: round.get::<i64, _>("parent_revision").to_string(),
                comparison_id: Some(comparison.to_string()),
                unevaluated_reason: None,
                policy_override,
            },
            crate::channels::Publication::Learning,
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
    let connection = Connection::load(tx, s, project.to_owned(), integration, false)
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
    Indeterminate(Uuid),
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

fn development_parent(round: &PgRow) -> Uuid {
    round
        .get::<Option<Uuid>, _>("development_parent_id")
        .unwrap_or_else(|| round.get("parent_version_id"))
}

fn release_candidate(round: &PgRow) -> Uuid {
    round
        .get::<Option<Uuid>, _>("release_candidate_id")
        .unwrap_or_else(|| round.get("candidate_version_id"))
}

pub(crate) fn development_check_interval() -> i32 {
    let configured = |name, default| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|value| (1..=1000).contains(value))
            .unwrap_or(default)
    };
    configured("ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS", 3)
}

fn baseline_matches(round: &PgRow, baseline: (Uuid, i64)) -> bool {
    round.get::<Uuid, _>("parent_version_id") == baseline.0
        && round.get::<i64, _>("parent_revision") == baseline.1
}

fn evidence_entry(source: &str, field: &str, text: &str) -> String {
    json!({"source": source, "field": field, "text": text}).to_string()
}

fn fits_proposal_prompt(request: &ProposalRequest) -> bool {
    request.evidence.len() <= 20
        && json!(request)
            .to_string()
            .replace(['<', '>'], "\\u003c")
            .len()
            <= 65_536
}

async fn requeue_correction(tx: &mut Tx<'_>, round: &PgRow) -> ApiResult<()> {
    sqlx::query(
        "UPDATE connected_learning_corrections SET pending=true,queued_at=clock_timestamp()
        WHERE (project_id,integration_id)=($1,$2) AND attempts<2 AND correction_id IN
            (SELECT correction_id FROM connected_learning_round_corrections WHERE round_id=$3)",
    )
    .bind(round.get::<String, _>("project_id"))
    .bind(round.get::<Uuid, _>("integration_id"))
    .bind(round.get::<Uuid, _>("id"))
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) async fn discard_developed(
    tx: &mut Tx<'_>,
    project: &str,
    integration: Uuid,
    epoch: i64,
) -> ApiResult<()> {
    sqlx::query("WITH discarded AS (
        UPDATE connected_learning_rounds SET state='rejected',decision='chain_discarded',
            reason='Development chain discarded',updated_at=now()
        WHERE (project_id,integration_id,policy_epoch)=($1,$2,$3) AND state='developed'
        RETURNING id
    )
    UPDATE connected_learning_corrections c SET pending=true,queued_at=clock_timestamp()
    WHERE (c.project_id,c.integration_id)=($1,$2) AND c.attempts<2 AND EXISTS (
        SELECT 1 FROM connected_learning_round_corrections m JOIN discarded d ON d.id=m.round_id
        WHERE (m.project_id,m.integration_id,m.correction_id)=(c.project_id,c.integration_id,c.correction_id)
    )").bind(project).bind(integration).bind(epoch).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

pub(crate) async fn close(tx: &mut Tx<'_>, round: &PgRow, reason: &str) -> ApiResult<()> {
    let id: Uuid = round.get("id");
    sqlx::query("UPDATE proposals SET status='failed',error=$2 WHERE id=$1 AND status IN ('queued','running')")
        .bind(round.get::<Option<Uuid>, _>("proposal_id")).bind(reason)
        .execute(&mut **tx).await.map_err(db)?;
    sqlx::query("UPDATE evaluation_requests e SET status='interrupted',error=$2,updated_at=now()
        FROM connected_learning_rounds r WHERE r.id=$1 AND (e.project_id,e.bundle_id)=(r.project_id,r.bundle_id)
        AND e.id IN (r.development_request_id,r.cumulative_request_id,r.audit_request_id) AND e.status IN ('requested','running')")
        .bind(id).bind(reason).execute(&mut **tx).await.map_err(db)?;
    sqlx::query(
        "UPDATE connected_learning_rounds SET state='rejected',reason=$2,updated_at=now(),
        decision=CASE WHEN (decision IS NULL OR decision='policy_review')
            AND EXISTS (SELECT 1 FROM connected_learning_incumbent_events h
                        WHERE h.round_id=$1 AND h.chain_length>0)
            THEN 'chain_discarded' ELSE decision END,
        audit_released=audit_index IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM evaluation_requests e JOIN comparisons c
            ON (c.project_id,c.bundle_id,c.id)=(e.project_id,e.bundle_id,e.comparison_id)
            WHERE e.id=audit_request_id AND e.project_id=connected_learning_rounds.project_id
            AND e.bundle_id=connected_learning_rounds.bundle_id AND c.complete
        ) AND NOT EXISTS (SELECT 1 FROM comparisons c WHERE c.complete
            AND (c.project_id,c.bundle_id)=(connected_learning_rounds.project_id,connected_learning_rounds.bundle_id)
            AND (c.id=audit_comparison_id OR c.body->'evaluation'->>'requestId'=audit_request_id::text))
        WHERE id=$1",
    )
    .bind(id)
    .bind(reason)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    let discarded_length: Option<i32> = sqlx::query_scalar(
        "WITH head AS (
             SELECT h.* FROM connected_learning_incumbent_events h JOIN connected_learning_rounds r
               ON (h.project_id,h.integration_id,h.policy_epoch)=(r.project_id,r.integration_id,r.policy_epoch)
             WHERE r.id=$1 ORDER BY h.sequence DESC LIMIT 1
         ), reset AS (
             INSERT INTO connected_learning_incumbent_events
                 (project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,
                  version_id,round_id,chain_length,reason)
             SELECT project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,
                 baseline_version_id,$1,0,$2
             FROM head WHERE round_id=$1 AND chain_length>0
             RETURNING sequence
         )
         SELECT head.chain_length FROM head CROSS JOIN reset",
    ).bind(id).bind(reason).fetch_optional(&mut **tx).await.map_err(db)?;
    if let Some(length) = discarded_length {
        discard_developed(
            tx,
            &round.get::<String, _>("project_id"),
            round.get("integration_id"),
            round.get("policy_epoch"),
        )
        .await?;
        // A multi-step chain head can go directly to audit without waiting in
        // the developed state. Retry it along with the earlier discarded steps.
        if length > 1
            || round
                .get::<Option<chrono::DateTime<chrono::Utc>>, _>("developed_at")
                .is_some()
        {
            requeue_correction(tx, round).await?;
        }
    }
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

fn evaluation_queue_seconds() -> f64 {
    deadline_seconds("ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS", 7 * 86_400)
}

fn deadline_seconds(name: &str, default: u32) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|&seconds| seconds > 0)
        .unwrap_or(default)
        .into()
}

pub(crate) async fn expire_review(tx: &mut Tx<'_>, round: &PgRow) -> ApiResult<bool> {
    if round.get::<String, _>("state") != "awaiting_review" {
        return Ok(false);
    }
    let expired = sqlx::query(
        "UPDATE connected_learning_rounds SET decision='expired_review'
        WHERE id=$1 AND review_started_at <= now()-make_interval(secs => $2)",
    )
    .bind(round.get::<Uuid, _>("id"))
    .bind(deadline_seconds(
        "ACCLIMATE_LEARNING_REVIEW_SECONDS",
        14 * 86_400,
    ))
    .execute(&mut **tx)
    .await
    .map_err(db)?
    .rows_affected()
        != 0;
    if expired {
        close(tx, round, "Review deadline expired").await?;
    }
    Ok(expired)
}

async fn incident_replay_ready(tx: &mut Tx<'_>, round: &PgRow) -> ApiResult<bool> {
    let reason = match round.get::<Option<String>, _>("incident_replay").as_deref() {
        None | Some("pass") => return Ok(true),
        Some("regression") => "Candidate still fails the triggering incident",
        Some("unavailable") => "Evaluator could not reproduce the incident from private evidence",
        Some("pending") => return Ok(false),
        Some(_) => return Err(db("Invalid incident replay state")),
    };
    close(tx, round, reason).await?;
    Ok(false)
}

async fn advance_development(
    tx: &mut Tx<'_>,
    connection: &Connection,
    round: &PgRow,
) -> ApiResult<()> {
    let id: Uuid = round.get("id");
    let cumulative: Option<Uuid> = round.get("cumulative_request_id");
    let request = cumulative.unwrap_or_else(|| round.get("development_request_id"));
    let evidence = connection
        .evidence(tx, round, request, &connection.development)
        .await?;
    let (comparison, unknown_cost) = match evidence {
        Evidence::Pending => return Ok(()),
        Evidence::Rejected {
            comparison,
            reason,
            failed_quality_policy,
        } => {
            if cumulative.is_some() {
                sqlx::query(
                    "UPDATE connected_learning_rounds SET cumulative_comparison_id=$2 WHERE id=$1",
                )
                .bind(id)
                .bind(comparison)
                .execute(&mut **tx)
                .await
                .map_err(db)?;
                return close(
                    tx,
                    round,
                    &format!("Cumulative development failed: {reason}"),
                )
                .await;
            }
            save_step_comparison(tx, id, comparison).await?;
            close(tx, round, reason).await?;
            if failed_quality_policy {
                requeue_correction(tx, round).await?;
            }
            return Ok(());
        }
        Evidence::Passed(comparison) => (comparison, false),
        Evidence::Indeterminate(comparison) => (comparison, true),
    };

    let candidate = if cumulative.is_some() {
        sqlx::query("UPDATE connected_learning_rounds SET cumulative_comparison_id=$2 WHERE id=$1")
            .bind(id)
            .bind(comparison)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        release_candidate(round)
    } else {
        save_step_comparison(tx, id, Some(comparison)).await?;
        if !incident_replay_ready(tx, round).await?
            || !field_requalification::check_required_replays(
                tx,
                connection,
                round,
                round.get("candidate_version_id"),
            )
            .await?
        {
            return Ok(());
        }
        if !connection.cumulative_growth_allowed(tx, round).await? {
            return close(tx, round, "Candidate exceeds cumulative byte-growth limit").await;
        }

        let (length, chain_unknown_cost) = connection
            .accept_development(tx, round, comparison, unknown_cost)
            .await?;

        if length < development_check_interval() && connection.has_budget {
            sqlx::query("UPDATE connected_learning_rounds SET state='developed',developed_at=now(),updated_at=now() WHERE id=$1")
                .bind(id).execute(&mut **tx).await.map_err(db)?;
            return Ok(());
        }

        return start_chain_check(tx, connection, round, length, chain_unknown_cost).await;
    };

    if cumulative.is_some()
        && !field_requalification::check_required_replays(tx, connection, round, candidate).await?
    {
        return Ok(());
    }
    start_audit(tx, connection, round, candidate, unknown_cost).await
}

async fn start_chain_check(
    tx: &mut Tx<'_>,
    connection: &Connection,
    round: &PgRow,
    length: i32,
    unknown_cost: bool,
) -> ApiResult<()> {
    if connection.next_audit(tx).await?.is_none() {
        return close(tx, round, "Independent audit cohorts exhausted").await;
    }
    let candidate = round.get("candidate_version_id");
    if length <= 1 && !connection.modern_development {
        return start_audit(tx, connection, round, candidate, unknown_cost).await;
    }
    let request = connection
        .queue_evaluation(tx, round, candidate, &connection.development, false)
        .await?;
    sqlx::query(
        "UPDATE connected_learning_rounds SET state='development',
        cumulative_request_id=$2,indeterminate_development_cost=$3,
        next_tick_at=now(),updated_at=now() WHERE id=$1",
    )
    .bind(round.get::<Uuid, _>("id"))
    .bind(request)
    .bind(unknown_cost)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

async fn start_audit(
    tx: &mut Tx<'_>,
    connection: &Connection,
    round: &PgRow,
    candidate: Uuid,
    unknown_cost: bool,
) -> ApiResult<()> {
    let id: Uuid = round.get("id");
    if connection.audit_rejected_digest(tx, candidate).await? {
        return close(
            tx,
            round,
            "Candidate content was previously audit-rejected in this epoch",
        )
        .await;
    }
    let Some(index) = connection.next_audit(tx).await? else {
        return close(tx, round, "Independent audit cohorts exhausted").await;
    };
    let request = connection
        .queue_evaluation(tx, round, candidate, &connection.audits[index], false)
        .await?;
    sqlx::query("UPDATE connected_learning_rounds SET state='audit',audit_index=$2,audit_request_id=$3,
        indeterminate_development_cost=indeterminate_development_cost OR $4,updated_at=now() WHERE id=$1")
        .bind(id).bind(index as i32).bind(request).bind(unknown_cost)
        .execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

async fn save_step_comparison(
    tx: &mut Tx<'_>,
    id: Uuid,
    comparison: Option<Uuid>,
) -> ApiResult<()> {
    sqlx::query("UPDATE connected_learning_rounds SET development_comparison_id=$2 WHERE id=$1")
        .bind(id)
        .bind(comparison)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
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
    if expire_review(tx, round).await? {
        return Ok(());
    }
    let id: Uuid = round.get("id");
    let state: String = round.get("state");
    match state.as_str() {
        "proposing" => {
            let proposal = sqlx::query("SELECT status,candidate_version_id,failure_kind FROM proposals WHERE (project_id,bundle_id,id)=($1,$2,$3)")
                .bind(&connection.project).bind(connection.bundle).bind(round.get::<Uuid, _>("proposal_id"))
                .fetch_one(&mut **tx).await.map_err(db)?;
            match proposal.get::<String, _>("status").as_str() {
                "queued" | "running" => return Ok(()),
                "succeeded" => {}
                _ => {
                    match proposal.get::<Option<String>, _>("failure_kind").as_deref() {
                        Some("scanner-rejected") => {
                            sqlx::query("UPDATE connected_learning_rounds SET decision='scanner_rejected' WHERE id=$1")
                                .bind(id).execute(&mut **tx).await.map_err(db)?;
                            return close(tx, round, "scanner-rejected").await;
                        }
                        Some("critic-rejected") => {
                            sqlx::query("UPDATE connected_learning_rounds SET decision='critic_rejected' WHERE id=$1")
                                .bind(id).execute(&mut **tx).await.map_err(db)?;
                            return close(tx, round, "critic-rejected").await;
                        }
                        Some("critic-unavailable") => {
                            return close(tx, round, "critic-unavailable").await;
                        }
                        Some("proposal-format-rejected") => {
                            close(tx, round, "proposal-format-rejected").await?;
                            let already_refunded: bool = sqlx::query_scalar("SELECT EXISTS (
                                SELECT 1 FROM connected_learning_round_corrections current
                                JOIN connected_learning_round_corrections previous USING (project_id,integration_id,correction_id)
                                JOIN connected_learning_rounds r ON r.id=previous.round_id
                                WHERE current.round_id=$1 AND r.proposal_admission_refunded)")
                                .bind(id).fetch_one(&mut **tx).await.map_err(db)?;
                            if already_refunded {
                                return Ok(());
                            }
                            sqlx::query("UPDATE connected_learning_rounds SET proposal_admission_refunded=true WHERE id=$1")
                                .bind(id).execute(&mut **tx).await.map_err(db)?;
                            sqlx::query("UPDATE connected_learning_enrollments SET proposal_admissions=proposal_admissions-1 WHERE (project_id,integration_id)=($1,$2)")
                                .bind(&connection.project).bind(connection.integration).execute(&mut **tx).await.map_err(db)?;
                            // The correction keeps its remaining allowance for future submissions.
                            sqlx::query("UPDATE connected_learning_corrections AS c SET attempts=LEAST(c.attempts,m.attempt-1),pending=true,queued_at=clock_timestamp()
                                FROM connected_learning_round_corrections m
                                WHERE (c.project_id,c.integration_id,c.correction_id)=(m.project_id,m.integration_id,m.correction_id) AND m.round_id=$1")
                                .bind(id).execute(&mut **tx).await.map_err(db)?;
                            return Ok(());
                        }
                        _ => {
                            return close(tx, round, "Proposal did not generate a candidate").await;
                        }
                    }
                }
            }
            let Some(candidate) = proposal.get::<Option<Uuid>, _>("candidate_version_id") else {
                return close(tx, round, "Successful proposal lacks a candidate").await;
            };
            if connection.audit_rejected_digest(tx, candidate).await? {
                return close(
                    tx,
                    round,
                    "Candidate content was previously audit-rejected in this epoch",
                )
                .await;
            }
            let request_id = connection
                .queue_evaluation(tx, round, candidate, &connection.development, true)
                .await?;
            sqlx::query("UPDATE connected_learning_rounds SET state='development',candidate_version_id=$2,development_request_id=$3,updated_at=now() WHERE id=$1")
                .bind(id).bind(candidate).bind(request_id).execute(&mut **tx).await.map_err(db)?;
            if round.get::<Option<String>, _>("incident_replay").is_some() {
                sqlx::query(
                    "INSERT INTO connected_learning_replay_obligations
                    (project_id,integration_id,bundle_id,version_id,baseline_revision,round_id,incident_outcome_id)
                    SELECT DISTINCT $1::text,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,c.outcome_id
                    FROM connected_learning_round_corrections m JOIN connected_learning_corrections c
                      USING (project_id,integration_id,correction_id)
                    WHERE m.round_id=$6 AND c.require_incident_replay",
                )
                .bind(&connection.project)
                .bind(connection.integration)
                .bind(connection.bundle)
                .bind(candidate)
                .bind(baseline.1)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(db)?;
            }
        }
        "development" => {
            advance_development(tx, connection, round).await?;
        }
        "audit" | "awaiting_review" => {
            let index: i32 = round.get("audit_index");
            let descriptor = connection
                .audits
                .get(index as usize)
                .ok_or_else(|| db("Unknown audit index"))?;
            let review_reason: Option<String> = sqlx::query_scalar(
                "WITH RECURSIVE release_steps AS (
                   SELECT candidate_version_id AS version_id, parent_version_id AS baseline,
                          project_id, integration_id, policy_epoch
                   FROM connected_learning_rounds WHERE id=$1
                   UNION ALL
                   SELECT v.parent_version_id, steps.baseline,
                          steps.project_id, steps.integration_id, steps.policy_epoch
                   FROM release_steps steps JOIN versions v ON v.id=steps.version_id
                   WHERE v.parent_version_id IS DISTINCT FROM steps.baseline
                 )
                 SELECT CASE
                   WHEN EXISTS (SELECT 1 FROM connected_learning_round_corrections m
                     JOIN connected_learning_corrections c USING (project_id,integration_id,correction_id)
                     WHERE m.round_id=r.id AND c.lesson IS NOT NULL)
                     THEN 'Candidate derives from app lesson instructions'
                   WHEN p.screening -> -1 -> 'structural' = 'true'::jsonb
                     THEN 'Candidate adds or removes bundle files'
                   WHEN p.screening -> -1 -> 'scannerClean' IS DISTINCT FROM 'true'::jsonb
                     THEN 'Candidate lacks a clean scanner result'
                   WHEN p.screening -> -1 -> 'result' ->> 'verdict' IS DISTINCT FROM 'accept'
                     OR p.screening -> -1 -> 'result' -> 'risky' IS DISTINCT FROM 'false'::jsonb
                     OR p.screening -> -1 -> 'structural' IS DISTINCT FROM 'false'::jsonb
                     THEN 'Candidate lacks a low-risk critic acceptance'
                 END AS reason
                 FROM release_steps steps
                 LEFT JOIN connected_learning_rounds r
                   ON (r.project_id,r.integration_id,r.policy_epoch,r.candidate_version_id)
                    = (steps.project_id,steps.integration_id,steps.policy_epoch,steps.version_id)
                 LEFT JOIN proposals p ON p.id=r.proposal_id
                 ORDER BY 1 NULLS LAST LIMIT 1"
            ).bind(id).fetch_one(&mut **tx).await.map_err(db)?;
            let can_automate = review_reason.is_none()
                && connection.automatic
                && connection.development.committed()
                && descriptor.committed();
            if state == "awaiting_review"
                && (!can_automate
                    || round.get::<Option<String>, _>("decision").as_deref()
                        == Some("policy_review"))
            {
                return Ok(());
            }
            let request = round.get("audit_request_id");
            let evidence = connection.evidence(tx, round, request, descriptor).await?;
            let unknown_cost = matches!(evidence, Evidence::Indeterminate(_))
                || round.get::<bool, _>("indeterminate_development_cost");
            match evidence {
                Evidence::Pending => {}
                Evidence::Rejected {
                    comparison,
                    reason,
                    failed_quality_policy,
                } => {
                    sqlx::query(
                        "UPDATE connected_learning_rounds SET audit_comparison_id=$2,audit_policy_rejected=$3 WHERE id=$1",
                    )
                    .bind(id)
                    .bind(comparison)
                    .bind(failed_quality_policy)
                    .execute(&mut **tx)
                    .await
                    .map_err(db)?;
                    close(tx, round, reason).await?;
                }
                Evidence::Passed(comparison) | Evidence::Indeterminate(comparison) => {
                    if !field_requalification::check_required_replays(
                        tx,
                        connection,
                        round,
                        release_candidate(round),
                    )
                    .await?
                    {
                        return Ok(());
                    }
                    if unknown_cost {
                        sqlx::query("UPDATE connected_learning_rounds SET state='awaiting_review',review_started_at=COALESCE(review_started_at,now()),audit_comparison_id=$2,decision='policy_review',reason='Evaluation cost is unknown',updated_at=now() WHERE id=$1")
                            .bind(id).bind(comparison).execute(&mut **tx).await.map_err(db)?;
                    } else if can_automate {
                        match connection
                            .promote(tx, round, comparison, WORKER, None)
                            .await
                        {
                            Ok(promotion) => {
                                connection.record_automatic(tx, promotion).await?;
                                record_promotion(tx, id, comparison, promotion, true).await?;
                                connection
                                    .sync_incumbent(tx, (release_candidate(round), baseline.1 + 1))
                                    .await?;
                            }
                            Err(error) if error.1 == "policy_override_required" => {
                                sqlx::query("UPDATE connected_learning_rounds SET state='awaiting_review',review_started_at=COALESCE(review_started_at,now()),audit_comparison_id=$2,decision='policy_review',reason='Application policy requires explicit review',updated_at=now() WHERE id=$1")
                                    .bind(id).bind(comparison).execute(&mut **tx).await.map_err(db)?;
                            }
                            Err(error) if error.0.is_client_error() => {
                                sqlx::query("UPDATE connected_learning_rounds SET audit_comparison_id=$2 WHERE id=$1")
                                    .bind(id).bind(comparison).execute(&mut **tx).await.map_err(db)?;
                                close(tx, round, "Candidate could not be promoted").await?
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        sqlx::query("UPDATE connected_learning_rounds SET state='awaiting_review',review_started_at=COALESCE(review_started_at,now()),audit_comparison_id=$2,reason=$3,updated_at=now() WHERE id=$1")
                            .bind(id).bind(comparison).bind(review_reason).execute(&mut **tx).await.map_err(db)?;
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
    automatic: bool,
) -> ApiResult<()> {
    let reason = automatic.then_some(AUTOMATIC_ROLLOUT);
    sqlx::query("UPDATE connected_learning_rounds SET state='promoted',reason=$4,decision=CASE WHEN $5 THEN 'automatic_rollout' END,audit_comparison_id=$2,promotion_id=$3,updated_at=now() WHERE id=$1")
        .bind(round).bind(comparison).bind(promotion).bind(reason).bind(automatic).execute(&mut **tx).await.map_err(db)?;
    sqlx::query("UPDATE connected_learning_rounds step SET state='promoted',
        decision='chain_promoted',chain_promotion_id=$2,updated_at=now() FROM connected_learning_rounds head
        WHERE head.id=$1 AND step.state='developed'
        AND (step.project_id,step.integration_id,step.policy_epoch)=(head.project_id,head.integration_id,head.policy_epoch)")
        .bind(round).bind(promotion).execute(&mut **tx).await.map_err(db)?;
    Ok(())
}

async fn tick(s: &AppState, project: String, integration: Uuid) -> ApiResult<bool> {
    let Some(_permit) = s.runtime.claim_permit().await else {
        return Ok(false);
    };
    let mut tx = s.db.begin().await.map_err(db)?;
    let mut locking = tx.begin().await.map_err(db)?;
    let connection = Connection::lock(&mut locking, s, project.clone(), integration).await;
    match &connection {
        Ok(_) => locking.commit().await.map_err(db)?,
        Err(_) => {
            locking.rollback().await.map_err(db)?;
            sqlx::query("SELECT 1 FROM connected_learning_enrollments WHERE (project_id,integration_id)=($1,$2) FOR UPDATE")
                .bind(&project).bind(integration).execute(&mut *tx).await.map_err(db)?;
        }
    }
    let round = sqlx::query(
        "SELECT r.*, replay.incident_replay, next_tick_at <= now() AS tick_due
         FROM connected_learning_rounds r JOIN connected_learning_round_replays replay ON replay.round_id=r.id
         WHERE (r.project_id,r.integration_id)=($1,$2)
           AND (r.state IN ('proposing','development','audit','awaiting_review')
                OR ($3 AND r.state='developed' AND r.id=(
                    SELECT h.round_id FROM connected_learning_incumbent_events h
                    JOIN connected_learning_enrollments e USING (project_id,integration_id,policy_epoch)
                    WHERE (e.project_id,e.integration_id)=($1,$2)
                    ORDER BY h.sequence DESC LIMIT 1)))
         ORDER BY (r.state='developed'),r.created_at,r.id LIMIT 1",
    )
    .bind(&project).bind(integration).bind(connection.is_err()).fetch_optional(&mut *tx).await.map_err(db)?;
    if let Some(round) = round {
        if !round.get::<bool, _>("tick_due") {
            return Ok(false);
        }
        let id: Uuid = round.get("id");
        let mut attempt = tx.begin().await.map_err(db)?;
        let result = async {
            let Some(connection) = connection? else {
                return Ok(());
            };
            let baseline = connection.baseline(&mut attempt).await?;
            if connection.sync_incumbent(&mut attempt, baseline).await? {
                close(&mut attempt, &round, "Published channel changed").await?;
                return requeue_correction(&mut attempt, &round).await;
            }
            advance(&mut attempt, &connection, &round, baseline).await
        }
        .await;
        match result {
            Ok(()) => {
                attempt.commit().await.map_err(db)?;
                sqlx::query("UPDATE connected_learning_rounds SET consecutive_failures=0,last_error=NULL,
                    first_failure_at=NULL,
                    pending_ticks=CASE WHEN (state,cumulative_request_id) IS NOT DISTINCT FROM ($2,$3)
                        THEN LEAST(pending_ticks+1,5) ELSE 0 END,
                    next_tick_at=now()+CASE WHEN (state,cumulative_request_id) IS NOT DISTINCT FROM ($2,$3)
                        THEN make_interval(secs=>LEAST(60,5*power(2,pending_ticks))) ELSE interval '0' END
                    WHERE id=$1")
                    .bind(id).bind(round.get::<String,_>("state")).bind(round.get::<Option<Uuid>,_>("cumulative_request_id"))
                    .execute(&mut *tx).await.map_err(db)?;
            }
            Err(error) => {
                attempt.rollback().await.map_err(db)?;
                let detail = format!("{}: {}", error.1, error.2);
                let expired: bool = sqlx::query_scalar(
                    "UPDATE connected_learning_rounds
                    SET consecutive_failures=consecutive_failures+1,last_error=$2,
                        first_failure_at=COALESCE(first_failure_at,now()),
                        next_tick_at=now()+make_interval(secs=>LEAST(900,30*power(2,LEAST(consecutive_failures,5))))
                    WHERE id=$1 RETURNING first_failure_at<=now()-make_interval(secs=>$3)",
                )
                .bind(id)
                .bind(&detail)
                .bind(deadline_seconds("ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS", 3600))
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
                if expired {
                    close(&mut tx, &round, &detail).await?;
                }
            }
        }
    } else {
        let Some(connection) = connection? else {
            return Ok(false);
        };
        let baseline = connection.baseline(&mut tx).await?;
        connection.sync_incumbent(&mut tx, baseline).await?;
        if !connection.active {
            tx.commit().await.map_err(db)?;
            return Ok(true);
        }
        if !connection.calibrate(&mut tx, baseline.0).await? {
            tx.commit().await.map_err(db)?;
            return Ok(true);
        }
        let head = sqlx::query("WITH head AS (
            SELECT * FROM connected_learning_incumbent_events
            WHERE (project_id,integration_id,policy_epoch)=($1,$2,$3) ORDER BY sequence DESC LIMIT 1
        )
        SELECT r.*,head.chain_length,head.indeterminate_cost,
            (head.created_at<=now()-interval '2 seconds'
            AND NOT EXISTS (SELECT 1 FROM connected_learning_correction_work w
                WHERE (w.project_id,w.integration_id)=(head.project_id,head.integration_id)
                AND w.action='ready'))
            OR EXISTS (SELECT 1 FROM connected_learning_incumbent_events first_step
                WHERE (first_step.project_id,first_step.integration_id,first_step.policy_epoch)=
                      (head.project_id,head.integration_id,head.policy_epoch)
                AND first_step.sequence=(SELECT max(sequence) FROM connected_learning_incumbent_events
                    WHERE (project_id,integration_id,policy_epoch)=($1,$2,$3)
                    AND sequence<=head.sequence AND chain_length=1)
                AND first_step.created_at<=now()-make_interval(secs=>$4)) AS flush
        FROM head JOIN connected_learning_rounds r ON r.id=head.round_id
        WHERE head.chain_length>0 AND r.state='developed'")
            .bind(&connection.project).bind(integration).bind(connection.policy_epoch)
            .bind(deadline_seconds("ACCLIMATE_LEARNING_MAX_CHAIN_AGE_SECONDS", 86_400))
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let flush = match &head {
            Some(head) => {
                !connection.has_budget
                    || head.get::<bool, _>("flush")
                    || connection.next_audit(&mut tx).await?.is_none()
            }
            None => false,
        };
        if let Some(head) = head.filter(|_| flush) {
            start_chain_check(
                &mut tx,
                &connection,
                &head,
                head.get("chain_length"),
                head.get("indeterminate_cost"),
            )
            .await?;
        } else {
            connection.admit(&mut tx, baseline).await?;
        }
    }
    tx.commit().await.map_err(db)?;
    Ok(false)
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
    if connection.sync_incumbent(tx, baseline).await? || !baseline_matches(&round, baseline) {
        close(tx, &round, "Published channel changed").await?;
        requeue_correction(tx, &round).await?;
        return Ok(false);
    }
    Ok(true)
}

pub async fn connected_learning_worker(s: AppState) {
    let mut retry_after = std::collections::HashMap::new();
    let mut next_replay_sweep = tokio::time::Instant::now();
    let mut next_abandon_sweep = tokio::time::Instant::now();
    let abandon_after = crate::evaluations::abandon_after_seconds();
    while !s.runtime.is_draining() {
        if tokio::time::Instant::now() >= next_abandon_sweep {
            next_abandon_sweep = tokio::time::Instant::now() + Duration::from_secs(30);
            if let Some(_permit) = s.runtime.claim_permit().await
                && let Err(error) =
                    crate::evaluations::abandon_inactive_evaluations(&s.db, abandon_after).await
            {
                eprintln!("Evaluation abandonment sweep failed: {error}");
            }
        }
        if tokio::time::Instant::now() >= next_replay_sweep {
            next_replay_sweep = tokio::time::Instant::now() + Duration::from_secs(5);
            if let Some(_permit) = s.runtime.claim_permit().await
                && let Err(error) = sqlx::query(
                    "UPDATE connected_learning_replay_obligations
                    SET verdict='unavailable',evaluator=$2
                    WHERE verdict IS NULL AND created_at<=now()-make_interval(secs=>$1)",
                )
                .bind(evaluation_queue_seconds())
                .bind(WORKER)
                .execute(&s.db)
                .await
            {
                eprintln!("Connected learning replay expiration failed: {error}");
            }
        }
        let now = tokio::time::Instant::now();
        retry_after.retain(|_, deadline| *deadline > now);
        let entries = sqlx::query_as::<_, (String, Uuid)>(include_str!(
            "connected_learning/worker_enrollments.sql"
        ))
        .fetch_all(&s.db)
        .await;
        match entries {
            Ok(entries) => {
                for (project, integration) in entries {
                    if s.runtime.is_draining() {
                        return;
                    }
                    if retry_after.contains_key(&(project.clone(), integration)) {
                        continue;
                    }
                    match tick(&s, project.clone(), integration).await {
                        Ok(false) => {}
                        Ok(true) => {
                            retry_after
                                .insert((project, integration), now + Duration::from_secs(2));
                        }
                        Err(error) => {
                            eprintln!(
                                "Connected learning round processing failed for {project}/{integration}: {}",
                                error.2
                            );
                            retry_after
                                .insert((project, integration), now + Duration::from_secs(10));
                        }
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    approve: bool,
    policy_override: Option<crate::PolicyOverride>,
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
    let command = crate::commands::DurableCommand::new(
        &connection.project,
        integration,
        "review",
        &actor.principal,
        round_id,
        json!({"approve":review.approve,"policyOverride":review.policy_override}),
    ).with_legacy_request(
        json!({"approve":review.approve,"policyOverride":review.policy_override.clone().map(crate::PolicyOverride::normalized)}),
    );
    let replay = command
        .replay(&mut tx, || conflict("Round already has a review"))
        .await;
    match replay {
        Ok(Some(response)) => return Ok(Json(response)),
        Err(error) if error.0 != StatusCode::CONFLICT => return Err(error),
        _ => {}
    }
    let round = sqlx::query(
        "SELECT r.*,replay.incident_replay FROM connected_learning_rounds r
         JOIN connected_learning_round_replays replay ON replay.round_id=r.id
         WHERE (project_id,integration_id,id)=($1,$2,$3)",
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
    let round_decision: Option<String> = round.get("decision");
    if state == "promoted" {
        let promotion: Uuid = round.get("promotion_id");
        let can_read = match crate::auth::actor(&headers, &s, &connection.project, "read") {
            Ok(reader) => {
                crate::auth::authorize_transaction(&mut tx, &reader, &connection.project, "read")
                    .await
                    .is_ok()
            }
            Err(_) => false,
        };
        let visible = crate::channels::visible_policy_override(4, 5);
        let decision = sqlx::query(&format!(
            "SELECT reviewer,p.policy_override,CASE WHEN $5 THEN ({visible})->>'reason' END AS visible_reason
             FROM promotions p WHERE (p.project_id,p.bundle_id,p.id)=($1,$2,$3)"
        )).bind(&connection.project).bind(connection.bundle).bind(promotion)
            .bind(&actor.principal).bind(can_read).fetch_one(&mut *tx).await.map_err(db)?;
        let reviewer: String = decision.get("reviewer");
        let automatic = round_decision.as_deref() == Some("automatic_rollout");
        let mut message = if automatic {
            "Automatic rollout already released this candidate.".to_owned()
        } else {
            format!("This rollout was already approved by {reviewer}.")
        };
        if let Some(reason) = decision.get::<Option<String>, _>("visible_reason") {
            message.push_str(&format!(" Recorded reason: {reason}"));
        }
        return Err(err(StatusCode::CONFLICT, "review_already_decided", message)
            .with_details(json!({"roundId":round_id,"state":state,"promotionId":promotion,"reviewer":reviewer})));
    }
    if !review.approve && review.policy_override.is_some() {
        return Err(conflict(
            "A declined review cannot override an application policy",
        ));
    }
    let route = format!(
        "/v1/projects/{}/integrations/{integration}/learning/rounds/{round_id}/review",
        connection.project
    );
    if state == "rejected" && round_decision.as_deref() == Some("review_declined") {
        let reviewer: Option<String> = round.get("reviewer_principal");
        let message = reviewer.as_ref().map_or_else(
            || "This rollout was already declined.".to_owned(),
            |principal| format!("This rollout was already declined by {principal}."),
        );
        return Err(err(StatusCode::CONFLICT, "review_already_decided", message)
            .with_details(json!({"roundId":round_id,"state":state,"reviewer":reviewer})));
    }
    if state != "awaiting_review" {
        return Err(conflict("Round is not awaiting review"));
    }
    if expire_review(&mut tx, &round).await? {
        tx.commit().await.map_err(db)?;
        return Err(conflict("Review deadline expired"));
    }
    if !review.approve {
        sqlx::query("UPDATE connected_learning_rounds SET decision='review_declined',reviewer_principal=$2 WHERE id=$1")
            .bind(round_id).bind(&actor.principal)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        close(&mut tx, &round, REVIEW_DECLINED).await?;
        // A decline has no promotion. Keep the deciding identity in the mutation audit.
        sqlx::query("INSERT INTO mutation_audit(project_id,actor_user_id,service_principal,principal_id,path,operation_key)
            VALUES($1,$2,$3,$4,$5,$6)")
            .bind(&connection.project).bind(actor.user_id).bind(&actor.service_principal)
            .bind(&actor.principal).bind(route).bind(round_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        return command
            .finish(tx, json!({"roundId":round_id,"state":"rejected"}))
            .await;
    }
    let baseline = connection.baseline(&mut tx).await?;
    if connection.sync_incumbent(&mut tx, baseline).await? || !baseline_matches(&round, baseline) {
        close(&mut tx, &round, "Published channel changed").await?;
        requeue_correction(&mut tx, &round).await?;
        tx.commit().await.map_err(db)?;
        return Err(conflict("Published channel changed"));
    }
    if !connection.active {
        return Err(conflict(
            "Connection authority or delivery baseline changed",
        ));
    }
    let index: i32 = round.get("audit_index");

    let descriptor = connection
        .audits
        .get(index as usize)
        .ok_or_else(|| db("Unknown audit index"))?;
    let evidence = connection
        .evidence(&mut tx, &round, round.get("audit_request_id"), descriptor)
        .await?;
    let (Evidence::Passed(comparison) | Evidence::Indeterminate(comparison)) = evidence else {
        return Err(conflict("Audit evidence is not eligible for promotion"));
    };
    let promotion = connection
        .promote(
            &mut tx,
            &round,
            comparison,
            &actor.principal,
            review.policy_override,
        )
        .await?;
    record_promotion(&mut tx, round_id, comparison, promotion, false).await?;
    connection
        .sync_incumbent(&mut tx, (release_candidate(&round), baseline.1 + 1))
        .await?;
    command
        .finish(
            tx,
            json!({"roundId":round_id,"state":"promoted","promotionId":promotion}),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CasePair, Outcome};

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
    fn rollout_requires_a_paired_confidence_bound() {
        let keys = ["policy", "guard"].map(|case_id| CaseKey {
            case_id: case_id.into(),
            repetition: 0,
        });
        let mut comparison = ComparisonRequest {
            parent_source_comparison_id: None,
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
                    parent: scored(0.5, "completed"),
                    candidate: scored(0.5, "completed"),
                })
                .collect(),
        };
        let policy = crate::connected_learning::selection::Policies::default().development;
        assert!(policy.check(&comparison).is_err());
        comparison.results[0].candidate.reward = Some(1.0);
        comparison.results[1].candidate.reward = Some(1.0);
        assert!(policy.check(&comparison).is_ok());
        comparison.results[1].candidate.reward = Some(0.0);
        assert!(policy.check(&comparison).is_err());
        comparison.results[1].candidate = scored(0.5, "task_failed");
        assert!(policy.check(&comparison).is_err());
        comparison.results[1].candidate = scored(0.5, "completed");
        comparison.results[1].candidate.reward = None;
        assert!(policy.check(&comparison).is_err());
    }
}
