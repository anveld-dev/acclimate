use super::*;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use commands::MutationStart;
use serde::Serialize;
use sqlx::types::Json as DbJson;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const ROLLOUTS_PER_CASE: usize = 5;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvolveRollout {
    score: f64,
    #[serde(rename = "passed")]
    _passed: bool,
    #[serde(rename = "trace")]
    _trace: Option<String>,
    #[serde(rename = "error")]
    _error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HeldOutRollout {
    score: f64,
    passed: bool,
}

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
    attempt_id: Option<String>,
    report: DbJson<Report>,
    held_out_reported_cases: Option<i32>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    deadline_at: DateTime<Utc>,
    error: Option<String>,
    held_out: Value,
    app_principal: String,
    expired: bool,
}

impl Evaluation {
    fn work_is_current(&self) -> bool {
        !matches!(self.status.as_str(), "failed" | "cancelled")
            && (!self.expired || self.status == "scored")
    }

    async fn evolve_cases(
        &self,
        tx: &mut Tx<'_>,
        project: &str,
        bundle: Uuid,
    ) -> ApiResult<Option<Vec<evolve::EvolveCase>>> {
        match self.evolve_revision {
            Some(revision) => Ok(Some(
                evolve::cases_at(tx, project, bundle, revision)
                    .await
                    .map_err(db)?,
            )),
            None => Ok(None),
        }
    }

    fn case_count(&self, cases: Option<&[evolve::EvolveCase]>) -> usize {
        cases.map_or_else(
            || {
                self.held_out["cases"]
                    .as_u64()
                    .expect("validated held-out count") as usize
            },
            <[_]>::len,
        )
    }

    fn document(&self, count: usize, full_report: bool) -> Value {
        let mut doc = json!({
            "id":self.id, "roundId":self.round_id, "role":self.role, "sample":self.sample,
            "split":wire_split(&self.split), "versionId":self.version_id, "digest":self.digest,
            "evolveRevision":self.evolve_revision, "status":self.status, "score":self.score, "cases":count,
            "reportedCases":self.held_out_reported_cases.map_or_else(|| self.report.cases.len(), |count| count as usize), "createdAt":self.created_at, "startedAt":self.started_at,
            "deadlineAt":self.deadline_at, "error":self.error
        });
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

    fn assignment(&self, cases: Option<&[evolve::EvolveCase]>) -> Value {
        let held_out = (self.split == "held_out").then_some(&self.held_out);
        let reported: Vec<_> = self.report.cases.iter().map(|c| &c.case_id).collect();
        json!({
            "evaluation": self.document(self.case_count(cases),false), "cases":cases,
            "heldOut":held_out, "reportedCaseIds":reported
        })
    }
}

pub(super) fn mean_score(case: &CaseReport) -> f64 {
    case.rollouts
        .iter()
        .map(|r| r["score"].as_f64().expect("validated score"))
        .sum::<f64>()
        / ROLLOUTS_PER_CASE as f64
}

fn wire_split(split: &str) -> &str {
    if split == "held_out" {
        "heldOut"
    } else {
        split
    }
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkItem {
    evaluation_id: Uuid,
    round_id: Uuid,
    round_number: i32,
    role: String,
    sample: Option<i16>,
    split: String,
    version_id: Uuid,
    digest: String,
    evolve_revision: Option<i64>,
    held_out: Option<Value>,
    status: String,
    deadline_at: DateTime<Utc>,
}

pub(super) async fn work(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    h: HeaderMap,
) -> Reply {
    let bundle = path(&bundle)?;
    let (mut tx, actor) = actor_tx(&s, &h, &project, "evaluate").await?;
    let row = require_loop(&mut tx, &project, bundle, false).await?;
    require_app(&actor, &row.app_principal)?;
    let items = if row.status == "stopped" {
        vec![]
    } else {
        sqlx::query_as::<_,WorkItem>(
            "SELECT e.id AS evaluation_id,e.round_id,r.number AS round_number,e.role,e.sample,
                 CASE WHEN e.split='held_out' THEN 'heldOut' ELSE e.split END AS split,
                 e.version_id,e.digest,e.evolve_revision,CASE WHEN e.split='held_out' THEN r.held_out END AS held_out,e.status,e.deadline_at
             FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id
             JOIN learning_loops l USING (project_id,bundle_id)
             WHERE l.app_principal=$3 AND l.status<>'stopped' AND (r.project_id,r.bundle_id)=($1,$2) AND e.status IN ('queued','running') AND e.deadline_at>now()
             ORDER BY e.created_at,e.id LIMIT 100")
            .bind(&project).bind(bundle).bind(&actor.principal).fetch_all(&mut *tx).await.map_err(db)?
    };
    Ok(Json(
        json!({"bundleId":bundle,"status":row.status,"items":items}),
    ))
}

const EVALUATION_SCOPE: &str =
    "FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id
    JOIN learning_loops l USING (project_id,bundle_id)
    WHERE (r.project_id,r.bundle_id)=($1,$2)";

async fn authorize_evaluation(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    evaluation: Uuid,
    actor: &auth::Actor,
) -> ApiResult<Evaluation> {
    let row: Evaluation =
        sqlx::query_as(&format!("SELECT e.*,r.held_out,l.app_principal,e.deadline_at<=clock_timestamp() AS expired,
                NULL::int AS held_out_reported_cases {EVALUATION_SCOPE} AND e.id=$3 FOR UPDATE OF e"))
            .bind(project)
            .bind(bundle)
            .bind(evaluation)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?
            .ok_or_else(|| missing("Learning evaluation not found"))?;
    require_app(actor, &row.app_principal)?;
    Ok(row)
}

pub(super) async fn round_documents(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    round: Uuid,
    requested: Option<Uuid>,
) -> ApiResult<Vec<Value>> {
    let rows: Vec<Evaluation> = sqlx::query_as(&format!(
        "SELECT e.id,e.round_id,e.role,e.sample,e.split,e.version_id,e.digest,e.evolve_revision,
                e.status,e.score,e.attempt_id,e.created_at,e.started_at,e.deadline_at,e.error,r.held_out,l.app_principal,
                false AS expired,
                CASE WHEN e.split='evolve' THEN e.report ELSE '{{
                    \"cases\": []
                }}'::jsonb END AS report,
                CASE WHEN e.split='held_out' THEN jsonb_array_length(e.report->'cases') END AS held_out_reported_cases
         {EVALUATION_SCOPE} AND e.round_id=$3 ORDER BY e.created_at,e.id"
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
        let count = match row.evolve_revision {
            Some(revision) => evolve::live_count(tx, project, bundle, revision)
                .await
                .map_err(db)? as usize,
            None => row.case_count(None),
        };
        documents.push(row.document(count, requested == Some(row.id)));
    }
    Ok(documents)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    attempt_id: String,
}

fn validate_attempt(id: &str) -> ApiResult<()> {
    if id.is_empty() || id.len() > 128 || id.contains('\0') {
        return Err(invalid("Attempt ID must be 1 to 128 bytes"));
    }
    Ok(())
}

fn command_path(project: &str, bundle: Uuid, id: Uuid, action: &str) -> String {
    format!("/v1/workspaces/{project}/bundles/{bundle}/learning/evaluations/{id}/{action}")
}

pub(super) async fn start(
    State(s): State<AppState>,
    Path((project, bundle, id)): Path<(String, String, String)>,
    h: HeaderMap,
    raw: Body,
) -> ApiResult<Response> {
    let (bundle, id) = (path(&bundle)?, path(&id)?);
    let (mut tx, actor) = actor_tx(&s, &h, &project, "evaluate").await?;
    let mut row = authorize_evaluation(&mut tx, &project, bundle, id, &actor).await?;
    let request = body(raw)?;
    let input: Start = parse(&request)?;
    validate_attempt(&input.attempt_id)?;
    if !row.work_is_current()
        || (row.status != "queued" && row.attempt_id.as_deref() != Some(&input.attempt_id))
    {
        return Err(conflict(
            "Evaluation is closed or belongs to another attempt",
        ));
    }
    let cases = row.evolve_cases(&mut tx, &project, bundle).await?;
    let route = command_path(&project, bundle, id, "start");
    let bytes = serde_json::to_vec(&request).map_err(db)?;
    let mut cmd = match commands::begin_authorized_mutation(
        tx, &actor, &project, &route, &h, &bytes,
    )
    .await?
    {
        // Return current progress to a runner resuming the same journaled attempt.
        MutationStart::Replay(_) => {
            return Ok(Json(row.assignment(cases.as_deref())).into_response());
        }
        MutationStart::Execute(cmd) => cmd,
    };
    if row.status == "queued" {
        let seconds = positive_setting("ACCLIMATE_LEARNING_EVALUATION_SECONDS", 86400);
        let (started,deadline): (DateTime<Utc>,DateTime<Utc>) = sqlx::query_as(
            "UPDATE learning_evaluations SET status='running',attempt_id=$2,started_at=now(),
                deadline_at=now()+make_interval(secs=>$3) WHERE id=$1 AND deadline_at>clock_timestamp()
             RETURNING started_at,deadline_at")
            .bind(id).bind(&input.attempt_id).bind(f64::from(seconds)).fetch_optional(&mut *cmd.tx).await.map_err(db)?
            .ok_or_else(|| conflict("Evaluation queue deadline passed"))?;
        row.status = "running".into();
        row.started_at = Some(started);
        row.deadline_at = deadline;
    }
    // Store only a command acknowledgement. The assignment is rendered from current rows on every start.
    commands::finish_mutation(cmd, StatusCode::OK, Value::Null).await?;
    Ok(Json(row.assignment(cases.as_deref())).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportRequest {
    attempt_id: String,
    cases: Option<Vec<CaseReport>>,
    error: Option<String>,
}

pub(super) async fn report(
    State(s): State<AppState>,
    Path((project, bundle, id)): Path<(String, String, String)>,
    h: HeaderMap,
    raw: Body,
) -> ApiResult<Response> {
    let (bundle, id) = (path(&bundle)?, path(&id)?);
    let (mut tx, actor) = actor_tx(&s, &h, &project, "evaluate").await?;
    let mut row = authorize_evaluation(&mut tx, &project, bundle, id, &actor).await?;
    let request = body(raw)?;
    let input: ReportRequest = parse(&request)?;
    validate_attempt(&input.attempt_id)?;
    if row.status == "cancelled"
        || (row.status != "failed" && !row.work_is_current())
        || row.attempt_id.as_deref() != Some(&input.attempt_id)
    {
        return Err(conflict(
            "Evaluation is closed or belongs to another attempt",
        ));
    }
    let route = command_path(&project, bundle, id, "report");
    let bytes = serde_json::to_vec(&request).map_err(db)?;
    let mut cmd = match commands::begin_authorized_mutation(
        tx, &actor, &project, &route, &h, &bytes,
    )
    .await?
    {
        MutationStart::Replay(reply) => return Ok(reply),
        MutationStart::Execute(cmd) => cmd,
    };
    if row.status != "running" {
        return Err(conflict("Evaluation is not running"));
    }
    let evolve_cases = row.evolve_cases(&mut cmd.tx, &project, bundle).await?;
    let count = row.case_count(evolve_cases.as_deref());
    match (input.cases, input.error) {
        (Some(cases), None)
            if !cases.is_empty() && !request.as_object().unwrap().contains_key("error") =>
        {
            apply_cases(&mut row, evolve_cases.as_deref(), cases, count)?;
        }
        (None, Some(error))
            if !error.is_empty()
                && error.len() <= 1024
                && !error.contains('\0')
                && !request.as_object().unwrap().contains_key("cases") =>
        {
            row.status = "failed".into();
            row.error = Some(error);
        }
        _ => {
            return Err(invalid(
                "Report one or more whole cases or a nonempty evaluation error up to 1 KiB",
            ));
        }
    }
    let saved = sqlx::query(
        "UPDATE learning_evaluations SET status=$2,report=$3,score=$4,error=$5
                            WHERE id=$1 AND status='running' AND deadline_at>clock_timestamp()",
    )
    .bind(id)
    .bind(&row.status)
    .bind(&row.report)
    .bind(row.score)
    .bind(&row.error)
    .execute(&mut *cmd.tx)
    .await
    .map_err(db)?;
    if saved.rows_affected() == 0 {
        return Err(conflict("Evaluation run deadline passed"));
    }
    commands::finish_mutation(cmd, StatusCode::OK, row.document(count, false)).await
}

fn apply_cases(
    row: &mut Evaluation,
    evolve_cases: Option<&[evolve::EvolveCase]>,
    incoming: Vec<CaseReport>,
    count: usize,
) -> ApiResult<()> {
    let allowed = evolve_cases.map(|cases| {
        cases
            .iter()
            .map(|c| c.case_id.as_str())
            .collect::<BTreeSet<_>>()
    });
    let mut stored: BTreeMap<_, _> = std::mem::take(&mut row.report.cases)
        .into_iter()
        .map(|case| (case.case_id.clone(), case))
        .collect();
    let mut seen = BTreeSet::new();
    for case in incoming {
        if !evolve::valid_case_id(&case.case_id)
            || !seen.insert(case.case_id.clone())
            || allowed
                .as_ref()
                .is_some_and(|ids| !ids.contains(case.case_id.as_str()))
        {
            return Err(invalid("Invalid, duplicate or unassigned evaluation case"));
        }
        if case.rollouts.len() != ROLLOUTS_PER_CASE {
            return Err(invalid("Every case requires five rollouts"));
        }
        for rollout in &case.rollouts {
            let score = if allowed.is_some() {
                let r: EvolveRollout = parse(rollout)?;
                r.score
            } else {
                let r: HeldOutRollout = parse(rollout)
                    .map_err(|_| invalid("Held-out reports carry only score and passed"))?;
                let HeldOutRollout {
                    score,
                    passed: _passed,
                } = r;
                score
            };
            if !(0.0..=1.0).contains(&score) {
                return Err(invalid("Rollout score must be in [0, 1]"));
            }
        }
        if let Some(previous) = stored.get(&case.case_id) {
            if previous.rollouts != case.rollouts {
                return Err(conflict(
                    "Case was already reported with different rollouts",
                ));
            }
        } else {
            stored.insert(case.case_id.clone(), case);
        }
    }
    if stored.len() > count {
        return Err(invalid("Report exceeds the pinned case count"));
    }
    row.report.cases = stored.into_values().collect();
    if row.report.cases.len() == count {
        row.score = Some(row.report.cases.iter().map(mean_score).sum::<f64>() / count as f64);
        row.status = "scored".into();
    }
    Ok(())
}

pub(super) fn passed_rollouts(case: &CaseReport) -> usize {
    case.rollouts
        .iter()
        .filter(|rollout| rollout["passed"] == true)
        .count()
}

pub(super) fn case_passes(case: &CaseReport) -> bool {
    passed_rollouts(case) >= 3
}
