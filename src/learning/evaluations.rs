use super::*;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::types::Json as DbJson;

pub(super) const PASS_COUNT: usize = 3;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CaseReport {
    pub case_id: String,
    pub rollouts: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Report {
    pub cases: Vec<CaseReport>,
}

#[derive(FromRow)]
struct Evaluation {
    id: Uuid,
    round_id: Uuid,
    role: String,
    sample: Option<i16>,
    split: String,
    version_id: Uuid,
    digest: String,
    evolve_revision: Option<i64>,
    status: String,
    score: Option<f64>,
    mean_task_tokens: Option<f64>,
    report: DbJson<Report>,
    held_out_reported_cases: Option<i32>,
    #[sqlx(default)]
    held_out_passed_cases: Option<i64>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    case_count: i64,
    error: Option<String>,
}

impl Evaluation {
    fn document(&self, full_report: bool) -> Value {
        let mut doc = json!({
            "id":self.id, "roundId":self.round_id, "role":self.role, "sample":self.sample,
            "split":wire_split(&self.split), "versionId":self.version_id, "digest":self.digest,
            "evolveRevision":self.evolve_revision, "status":self.status, "score":self.score, "meanTaskTokens":self.mean_task_tokens, "cases":self.case_count,
            "reportedCases":self.held_out_reported_cases.map_or_else(|| self.report.cases.len(), |count| count as usize), "createdAt":self.created_at, "startedAt":self.started_at,
            "error":self.error
        });
        if self.split == "held_out" {
            doc["passedCases"] = json!(self.held_out_passed_cases.unwrap_or_else(|| {
                self.report.cases.iter().filter(|c| case_passes(c)).count() as i64
            }));
            doc["error"] = json!(self.error.as_deref().map(safe_held_out_error));
        }
        if self.split == "evolve" {
            doc["caseSummaries"] = json!(self.report.cases.iter().map(|case| {
                let passes = passed_rollouts(case);
                json!({"caseId":case.case_id,"passedRollouts":passes,"meanScore":mean_score(case)})
            }).collect::<Vec<_>>());
            if full_report {
                doc["report"] = json!(self.report.0);
            }
        }
        doc
    }
}

pub(super) fn mean_score(case: &CaseReport) -> f64 {
    case.rollouts
        .iter()
        .map(|r| r["score"].as_f64().expect("validated score"))
        .sum::<f64>()
        / case.rollouts.len().max(1) as f64
}

pub(super) fn safe_held_out_error(_: &str) -> &str {
    "held-out-evaluation-failed"
}

fn wire_split(split: &str) -> &str {
    if split == "held_out" {
        "heldOut"
    } else {
        split
    }
}

const EVALUATION_SCOPE: &str =
    "FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id
    JOIN learning_loops l USING (project_id,bundle_id)
    WHERE (r.project_id,r.bundle_id)=($1,$2)";

pub(super) async fn round_documents(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    round: Uuid,
    requested: Option<Uuid>,
) -> ApiResult<Vec<Value>> {
    let rows: Vec<Evaluation> = sqlx::query_as(&format!(
        "SELECT e.id,e.round_id,e.role,e.sample,e.split,e.version_id,e.digest,e.evolve_revision,
                e.status,e.score,e.mean_task_tokens,e.created_at,e.started_at,e.error,
                greatest(jsonb_array_length(e.report->'cases'),(SELECT count(DISTINCT task_id) FROM learning_rollouts WHERE evaluation_id=e.id)) AS case_count,
                CASE WHEN e.split='held_out' THEN (SELECT count(*) FROM jsonb_array_elements(e.report->'cases') c WHERE
                (SELECT count(*) FROM jsonb_array_elements(c->'rollouts') v WHERE v->>'passed'='true')>={PASS_COUNT}) END AS held_out_passed_cases,
                CASE WHEN e.split='evolve' THEN e.report ELSE '{{
                    \"cases\": []
                }}'::jsonb END AS report,
                CASE WHEN e.split='held_out' THEN jsonb_array_length(e.report->'cases') END AS held_out_reported_cases
         {EVALUATION_SCOPE} AND e.round_id=$3 AND e.measurement='initial' ORDER BY e.created_at,e.id"
    ))
    .bind(project)
    .bind(bundle)
    .bind(round)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    if let Some(id) = requested {
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| missing("Learning evaluation not found in this round"))?;
        if row.split == "held_out" {
            return Err(invalid("Held-out evaluations have no readable report"));
        }
    }
    let mut documents = Vec::with_capacity(rows.len());
    for row in rows {
        documents.push(row.document(requested == Some(row.id)));
    }
    Ok(documents)
}

pub(super) fn passed_rollouts(case: &CaseReport) -> usize {
    case.rollouts
        .iter()
        .filter(|rollout| rollout["passed"] == true)
        .count()
}

pub(super) fn case_passes(case: &CaseReport) -> bool {
    passed_rollouts(case) >= PASS_COUNT
}
