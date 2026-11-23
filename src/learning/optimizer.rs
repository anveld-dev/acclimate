use super::{
    Tx,
    evaluations::{CaseReport, Report, case_passes, mean_score, passed_rollouts},
    history, memory,
};
use crate::{
    AppState, BundlePayload,
    proposal_edits::{Changes, changed_files, reconstruct},
    proposal_scanner::{Field, findings},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
};
use uuid::Uuid;

mod client;
mod instructions;
pub use client::OpenAiModel;
use instructions::system_text;

#[derive(Debug)]
pub enum ModelError {
    Provider(String),
    ContextTooLarge,
    Format(String),
}

// Scoped to a durable call so parser retries are charged to the same bundle.
tokio::task_local! { static RESPONSE_TOKENS: std::cell::Cell<i64>; }

pub type ModelFuture<'a> = Pin<Box<dyn Future<Output = Result<String, ModelError>> + Send + 'a>>;

pub trait OptimizerModel: Send + Sync {
    fn model(&self) -> &str;
    fn reasoning_effort(&self) -> Option<&str> {
        None
    }
    fn propose<'a>(&'a self, data: &'a Value) -> ModelFuture<'a>;
    fn screen<'a>(&'a self, data: &'a Value) -> ModelFuture<'a>;
    fn select<'a>(&'a self, data: &'a Value) -> ModelFuture<'a>;
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Kind {
    Propose,
    Screen,
    Select,
}

impl Kind {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Propose => "propose",
            Self::Screen => "screen",
            Self::Select => "select",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct CallKey {
    pub round: Uuid,
    pub kind: Kind,
    pub sample: i16,
}

#[derive(FromRow)]
pub(super) struct Pins {
    pub id: Uuid,
    pub project_id: String,
    pub bundle_id: Uuid,
    pub number: i32,
    pub parent_version_id: Uuid,
    pub channel: String,
    pub channel_revision: i64,
    pub evolve_revision: i64,
    pub memory_revision: i64,
    pub setting: Value,
    pub optimizer_model: Option<String>,
    pub optimizer_reasoning_effort: Option<String>,
    history_digest: Option<String>,
    memory_digest: Option<String>,
}

impl Pins {
    pub(super) async fn load(tx: &mut Tx<'_>, id: Uuid) -> Result<Self, sqlx::Error> {
        sqlx::query_as(
            "SELECT id,project_id,bundle_id,number,parent_version_id,channel,channel_revision,
            evolve_revision,memory_revision,setting,optimizer_model,optimizer_reasoning_effort,history_digest,memory_digest
            FROM learning_rounds WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await
    }

    pub(super) async fn target(&self, tx: &mut Tx<'_>) -> Result<String, sqlx::Error> {
        sqlx::query_scalar("SELECT compatibility_target FROM bundles WHERE (project_id,id)=($1,$2)")
            .bind(&self.project_id)
            .bind(self.bundle_id)
            .fetch_one(&mut **tx)
            .await
    }
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Candidate {
    pub sample: i16,
    pub status: String,
    pub drop_reason: Option<String>,
    pub rationale: Option<String>,
    pub changes: Option<Value>,
    pub diagnosis: Option<Value>,
    pub scan: Option<Value>,
    pub screen: Option<Value>,
    pub version_id: Option<Uuid>,
    pub evaluation_id: Option<Uuid>,
    pub evolve_score: Option<f64>,
}

pub(super) async fn candidates(
    tx: &mut Tx<'_>,
    round: Uuid,
) -> Result<Vec<Candidate>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM learning_candidates WHERE round_id=$1 ORDER BY sample")
        .bind(round)
        .fetch_all(&mut **tx)
        .await
}

pub(super) fn invariant(message: impl Into<String>) -> sqlx::Error {
    sqlx::Error::Protocol(message.into())
}

pub(super) fn digest(value: &Value) -> String {
    crate::digest(value.to_string().as_bytes())
}

pub(super) async fn version(
    tx: &mut Tx<'_>,
    id: Uuid,
) -> Result<(BundlePayload, String), sqlx::Error> {
    let (bytes, digest): (Vec<u8>, _) =
        sqlx::query_as("SELECT payload,digest FROM versions WHERE id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    Ok((
        serde_json::from_slice(&bytes).map_err(|_| invariant("Invalid stored payload"))?,
        digest,
    ))
}

#[derive(FromRow)]
pub(super) struct EvolveEvaluation {
    pub status: String,
    pub score: Option<f64>,
    pub version_id: Uuid,
    pub evolve_revision: i64,
    pub report: sqlx::types::Json<Report>,
}

pub(super) async fn evolve_evaluation(
    tx: &mut Tx<'_>,
    round: Uuid,
    role: &str,
    id: Option<Uuid>,
) -> Result<Option<EvolveEvaluation>, sqlx::Error> {
    sqlx::query_as("SELECT status,score,version_id,evolve_revision,report
        FROM learning_evaluations WHERE round_id=$1 AND role=$2 AND split='evolve' AND ($3::uuid IS NULL OR id=$3)")
        .bind(round).bind(role).bind(id).fetch_optional(&mut **tx).await
}

impl EvolveEvaluation {
    pub(super) fn scored(&self, revision: i64) -> bool {
        self.status == "scored" && self.evolve_revision == revision
    }

    pub(super) fn summary(&self, full: bool) -> Value {
        let cases: BTreeMap<_, _> = self.report.cases.iter().map(|c| (&c.case_id, c)).collect();
        json!({"score": self.score, "cases": cases.values().map(|case| case_summary(case, full)).collect::<Vec<_>>()})
    }
}

fn case_summary(case: &CaseReport, full: bool) -> Value {
    let mut result = json!({
        "caseId": case.case_id, "passedRollouts": passed_rollouts(case), "meanScore": mean_score(case),
    });
    if full {
        result["rollouts"] = json!(case.rollouts);
    }
    result
}

async fn render_feedback(
    tx: &mut Tx<'_>,
    round: &Pins,
    incumbent: &EvolveEvaluation,
) -> Result<Value, sqlx::Error> {
    let inputs: BTreeMap<String,Value> = sqlx::query_as("SELECT task_id,input FROM learning_tasks
        WHERE (project_id,bundle_id)=($1,$2) AND added_revision <= $3 AND (retired_revision IS NULL OR retired_revision > $3)")
        .bind(&round.project_id).bind(round.bundle_id).bind(round.evolve_revision)
        .fetch_all(&mut **tx).await?.into_iter().collect();
    let mut doc = incumbent.summary(true);
    doc["versionId"] = json!(incumbent.version_id);
    doc["evolveRevision"] = json!(incumbent.evolve_revision);
    for case in doc["cases"].as_array_mut().expect("case array") {
        let id = case["caseId"].as_str().expect("case id");
        case["input"] = inputs
            .get(id)
            .cloned()
            .ok_or_else(|| invariant("Missing pinned case"))?;
    }
    Ok(doc)
}

struct Input {
    data: Value,
    parent: BundlePayload,
}

async fn render(tx: &mut Tx<'_>, round: &Pins, kind: Kind) -> Result<Input, sqlx::Error> {
    let (parent, parent_digest) = version(tx, round.parent_version_id).await?;
    let mut harness = json!(parent);
    harness["versionId"] = json!(round.parent_version_id);
    harness["digest"] = json!(parent_digest);
    let incumbent = evolve_evaluation(tx, round.id, "incumbent", None)
        .await?
        .filter(|evaluation| evaluation.scored(round.evolve_revision))
        .ok_or_else(|| invariant("Missing scored incumbent"))?;
    let feedback = render_feedback(tx, round, &incumbent).await?;
    let history = history::render_history(tx, round).await?;
    let memory = memory::render_memory(
        tx,
        &round.project_id,
        round.bundle_id,
        round.memory_revision,
    )
    .await?;
    let mut data = json!({
        "setting": round.setting, "harness": harness, "feedback": feedback,
        "history": history, "improvementMemory": memory,
    });
    let status = match kind {
        Kind::Propose => return Ok(Input { data, parent }),
        Kind::Screen => "generated",
        Kind::Select => "evaluated",
    };
    let mut entries = Vec::new();
    for candidate in candidates(tx, round.id)
        .await?
        .into_iter()
        .filter(|c| c.status == status)
    {
        let mut entry = json!({
            "sample": candidate.sample, "rationale": candidate.rationale,
            "diagnosis": candidate.diagnosis, "changes": candidate.changes,
        });
        if matches!(kind, Kind::Select) {
            let eval_id = candidate
                .evaluation_id
                .ok_or_else(|| invariant("Missing candidate evaluation ID"))?;
            let evaluation = evolve_evaluation(tx, round.id, "candidate", Some(eval_id))
                .await?
                .filter(|evaluation| evaluation.scored(round.evolve_revision))
                .ok_or_else(|| invariant("Missing scored candidate evaluation"))?;
            let diagnosis: Diagnosis = stored(&entry["diagnosis"])?;
            let outcome = memory::attempt_outcome(
                &incumbent.report,
                &evaluation.report,
                &diagnosis.predicted,
            )
            .map_err(invariant)?;
            let mut evolve = evaluation.summary(true);
            evolve["fixed"] = json!(outcome.fixed);
            evolve["missed"] = json!(outcome.missed);
            let previously_passing: BTreeSet<_> = incumbent
                .report
                .cases
                .iter()
                .filter(|case| case_passes(case))
                .map(|case| &case.case_id)
                .collect();
            let regressed: BTreeSet<_> = evaluation
                .report
                .cases
                .iter()
                .filter(|case| !case_passes(case) && previously_passing.contains(&case.case_id))
                .map(|case| &case.case_id)
                .collect();
            evolve["regressed"] = json!(regressed);
            evolve["passed"] = json!(outcome.passed);
            evolve["total"] = json!(outcome.total);
            entry["evolve"] = evolve;
            entry["screen"] = json!(candidate.screen);
        }
        entries.push(entry);
    }
    data["candidates"] = json!(entries);
    Ok(Input { data, parent })
}

pub(super) fn stored<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, sqlx::Error> {
    serde_json::from_value(value.clone()).map_err(|_| invariant("Invalid stored optimizer data"))
}

pub(super) async fn enqueue(
    tx: &mut Tx<'_>,
    round: &Pins,
    kind: Kind,
    sample: i16,
) -> Result<(), sqlx::Error> {
    let input = render(tx, round, kind).await?;
    if matches!(kind, Kind::Propose) {
        if sample == 1 {
            sqlx::query(
                "UPDATE learning_rounds SET history_digest=$2,memory_digest=$3 WHERE id=$1",
            )
            .bind(round.id)
            .bind(digest(&input.data["history"]))
            .bind(digest(&input.data["improvementMemory"]))
            .execute(&mut **tx)
            .await?;
        }
        sqlx::query("INSERT INTO learning_candidates(round_id,sample) VALUES($1,$2)")
            .bind(round.id)
            .bind(sample)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("INSERT INTO learning_optimizer_calls(round_id,kind,sample,input_digest) VALUES($1,$2,$3,$4)")
        .bind(round.id).bind(kind.name()).bind(sample).bind(digest(&input.data)).execute(&mut **tx).await?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    schema_version: u8,
    rationale: String,
    edits: Vec<crate::proposal_edits::Edit>,
    files: Vec<crate::proposal_edits::FileOp>,
    diagnosis: Diagnosis,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Diagnosis {
    pub problem: DiagnosisProblem,
    pub predicted: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DiagnosisProblem {
    Id(String),
    New(String),
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Screen {
    pub samples: Vec<ScreenSample>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ScreenSample {
    pub sample: i16,
    pub verdict: Verdict,
    pub reason: String,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Verdict {
    Evaluate,
    Skip,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "decision", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Selection {
    Adopt { sample: i16, reason: String },
    Keep { reason: String },
}

fn parse<T: serde::de::DeserializeOwned>(content: &str) -> Result<T, String> {
    serde_json::from_str(content)
        .map_err(|e| format!("Invalid output at line {} column {}", e.line(), e.column()))
}

fn trim(text: &mut String, max: usize, field: &str) -> Result<(), String> {
    *text = text.trim().to_owned();
    if text.is_empty() || text.len() > max || text.contains('\0') {
        return Err(format!("Invalid {field} length or characters"));
    }
    Ok(())
}

fn validate_diagnosis(diagnosis: &mut Diagnosis, data: &Value) -> Result<(), String> {
    match &mut diagnosis.problem {
        DiagnosisProblem::Id(id) => {
            if !data["improvementMemory"]["problems"]
                .as_array()
                .expect("problem array")
                .iter()
                .any(|problem| problem["id"].as_str() == Some(id))
            {
                return Err("Unknown problem ID".into());
            }
        }
        DiagnosisProblem::New(text) => {
            *text = memory::normalize_root_cause(text).ok_or("Invalid root cause")?;
        }
    }
    diagnosis.predicted.sort_unstable();
    if diagnosis
        .predicted
        .windows(2)
        .any(|pair| pair[0] == pair[1])
        || diagnosis.predicted.iter().any(|id| {
            !data["feedback"]["cases"]
                .as_array()
                .expect("feedback cases")
                .iter()
                .any(|case| case["caseId"].as_str() == Some(id))
        })
    {
        return Err("Prediction has duplicate or unknown case IDs".into());
    }
    Ok(())
}

fn validate_proposal(
    content: &str,
    input: &Input,
    target: &str,
) -> Result<(Value, BundlePayload, Diagnosis, String), String> {
    let mut proposal: Proposal = parse(content)?;
    if proposal.schema_version != 2 {
        return Err("Expected schemaVersion 2".into());
    }
    trim(&mut proposal.rationale, 4096, "rationale")?;
    let changes = Changes {
        edits: proposal.edits,
        files: proposal.files,
    };
    let candidate = reconstruct(&input.parent, &changes, target)?;
    validate_diagnosis(&mut proposal.diagnosis, &input.data)?;
    let changes = json!(changes);
    if has_nul(&changes) {
        return Err("Changes contain a NUL character".into());
    }
    Ok((changes, candidate, proposal.diagnosis, proposal.rationale))
}

fn has_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(entries) => entries.iter().any(has_nul),
        Value::Object(entries) => entries.values().any(has_nul),
        _ => false,
    }
}

fn validate_screen(content: &str, samples: &BTreeSet<i16>) -> Result<Screen, String> {
    let mut output: Screen = parse(content)?;
    let mut expected = samples.clone();
    for sample in &mut output.samples {
        if !expected.remove(&sample.sample) {
            return Err("Unknown or duplicate screened sample".into());
        }
        trim(&mut sample.reason, 1024, "screen reason")?;
    }
    if !expected.is_empty() {
        return Err("Missing screened sample".into());
    }
    Ok(output)
}

fn validate_select(content: &str, samples: &BTreeSet<i16>) -> Result<Selection, String> {
    let mut output: Selection = parse(content)?;
    let reason = match &mut output {
        Selection::Adopt { sample, reason } => {
            if !samples.contains(sample) {
                return Err("Selection must name an evaluated sample".into());
            }
            reason
        }
        Selection::Keep { reason } => reason,
    };
    trim(reason, 1024, "selection reason")?;
    Ok(output)
}

async fn call_with_retry<T>(
    model: &dyn OptimizerModel,
    kind: Kind,
    data: &Value,
    validate: impl Fn(&str) -> Result<T, String>,
) -> Result<T, ModelError> {
    let mut retry_data = None;
    loop {
        let input = retry_data.as_ref().unwrap_or(data);
        let result = match kind {
            Kind::Propose => model.propose(input),
            Kind::Screen => model.screen(input),
            Kind::Select => model.select(input),
        }
        .await
        .and_then(|content| validate(&content).map_err(ModelError::Format));
        match result {
            Err(ModelError::Format(error)) if retry_data.is_none() => {
                let mut retry = data.clone();
                retry["parserError"] = json!(error);
                retry_data = Some(retry);
            }
            _ => return result,
        }
    }
}

enum CallOutput {
    Clean(Value),
    Rejected(Value),
}

fn scan_proposal(
    parent: &BundlePayload,
    changes: Value,
    candidate: BundlePayload,
    diagnosis: Diagnosis,
    rationale: String,
) -> CallOutput {
    let mut items = vec![(Field::Rationale, None, rationale.as_str())];
    if let DiagnosisProblem::New(root) = &diagnosis.problem {
        items.push((Field::RootCause, None, root.as_str()));
    }
    let changed = changed_files(parent, &candidate);
    for file in candidate
        .files
        .iter()
        .filter(|file| changed.contains(file.path.as_str()))
    {
        let path = file.path.as_str();
        if !parent.files.iter().any(|old| old.path == path) {
            items.push((Field::Path, Some(path), path));
        }
        items.push((Field::Text, Some(path), &file.text));
    }
    let findings = findings(&items, parent);
    if findings.is_empty() {
        CallOutput::Clean(json!({
            "schemaVersion": 2, "rationale": rationale, "diagnosis": diagnosis,
            "edits": changes["edits"], "files": changes["files"],
        }))
    } else {
        let diagnosis = (!findings
            .iter()
            .any(|finding| finding.field == Field::RootCause))
        .then_some(diagnosis);
        CallOutput::Rejected(
            json!({"scan": {"clean": false, "findings": findings}, "diagnosis": diagnosis}),
        )
    }
}

async fn request(
    model: &dyn OptimizerModel,
    kind: Kind,
    input: &Input,
    target: &str,
) -> Result<CallOutput, ModelError> {
    let data = &input.data;
    if matches!(kind, Kind::Propose) {
        let (changes, candidate, diagnosis, rationale) =
            call_with_retry(model, kind, data, |content| {
                validate_proposal(content, input, target)
            })
            .await?;
        return Ok(scan_proposal(
            &input.parent,
            changes,
            candidate,
            diagnosis,
            rationale,
        ));
    }
    let samples = data["candidates"]
        .as_array()
        .expect("candidate array")
        .iter()
        .map(|entry| entry["sample"].as_i64().expect("sample number") as i16)
        .collect();
    let output = call_with_retry(model, kind, data, |content| match kind {
        Kind::Screen => validate_screen(content, &samples).map(|output| json!(output)),
        Kind::Select => validate_select(content, &samples).map(|output| json!(output)),
        Kind::Propose => unreachable!(),
    })
    .await?;
    Ok(CallOutput::Clean(output))
}

pub(super) async fn run_call(s: &AppState, key: CallKey) -> Result<(), sqlx::Error> {
    let name = key.kind.name();
    let Some((attempt, input_digest)): Option<(i32, String)> = sqlx::query_as(
        "UPDATE learning_optimizer_calls SET status='running',attempts=attempts+1,claimed_at=now()
         WHERE (round_id,kind,sample)=($1,$2,$3) AND status='queued' AND attempts<3 RETURNING attempts,input_digest")
        .bind(key.round).bind(name).bind(key.sample).fetch_optional(&s.db).await?
    else { return Ok(()); };
    let mut tx = s.db.begin().await?;
    let round = Pins::load(&mut tx, key.round).await?;
    let input = render(&mut tx, &round, key.kind).await?;
    let target = round.target(&mut tx).await?;
    tx.commit().await?;
    let data = &input.data;
    let mut tokens = 0;
    let result = if digest(data) != input_digest
        || round.history_digest.as_deref() != Some(&digest(&data["history"]))
        || round.memory_digest.as_deref() != Some(&digest(&data["improvementMemory"]))
    {
        Err(ModelError::Provider("input drift".into()))
    } else if let Some(model) = &s.optimizer {
        if Some(model.model()) != round.optimizer_model.as_deref() {
            Err(ModelError::Provider("model changed".into()))
        } else if model.reasoning_effort() != round.optimizer_reasoning_effort.as_deref() {
            Err(ModelError::Provider("reasoning effort changed".into()))
        } else {
            RESPONSE_TOKENS
                .scope(std::cell::Cell::new(0), async {
                    let result = request(model.as_ref(), key.kind, &input, &target).await;
                    tokens = RESPONSE_TOKENS.with(|t| t.get());
                    result
                })
                .await
        }
    } else {
        Err(ModelError::Provider("optimizer unavailable".into()))
    };
    let (status, output, code, error) = match result {
        Ok(CallOutput::Clean(output)) => ("succeeded", Some(output), None, None),
        Ok(CallOutput::Rejected(output)) => {
            ("failed", Some(output), Some("scanner-rejected"), None)
        }
        Err(ModelError::Provider(error)) => ("failed", None, Some("provider-failed"), Some(error)),
        Err(ModelError::Format(error)) => ("failed", None, Some("format-rejected"), Some(error)),
        Err(ModelError::ContextTooLarge) => {
            let bytes = data.to_string().len();
            eprintln!(
                "learning optimizer context too large for {} ({name}, {bytes} input bytes)",
                key.round
            );
            (
                "failed",
                None,
                Some("optimizer-context-too-large"),
                Some(bytes.to_string()),
            )
        }
    };
    let mut tx = s.db.begin().await?;
    sqlx::query(
        "UPDATE learning_optimizer_calls SET status=$4,output=$5,error_code=$6,error=$7
        WHERE (round_id,kind,sample)=($1,$2,$3) AND status='running' AND attempts=$8",
    )
    .bind(key.round)
    .bind(name)
    .bind(key.sample)
    .bind(status)
    .bind(output)
    .bind(code)
    .bind(error)
    .bind(attempt)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO learning_usage(project_id,bundle_id,day,optimizer_tokens) VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,$3) ON CONFLICT(project_id,bundle_id,day) DO UPDATE SET optimizer_tokens=learning_usage.optimizer_tokens+excluded.optimizer_tokens").bind(round.project_id).bind(round.bundle_id).bind(tokens).execute(&mut *tx).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnosis_data() -> Value {
        json!({"improvementMemory":{"problems":[{"id":"P1"}]},"feedback":{"cases":[{"caseId":"a"},{"caseId":"b"}]}})
    }

    #[test]
    fn diagnosis_requires_exactly_one_known_problem_or_a_valid_new_cause() {
        let data = diagnosis_data();
        for content in [
            r#"{"problem":{"id":"P1"},"predicted":[]}"#,
            r#"{"problem":{"new":" a  b "},"predicted":["b","a"]}"#,
        ] {
            let mut diagnosis = parse(content).unwrap();
            validate_diagnosis(&mut diagnosis, &data).unwrap();
        }
        for content in [
            r#"{"problem":{"id":"P9"},"predicted":[]}"#,
            r#"{"problem":{"new":" "},"predicted":[]}"#,
            r#"{"problem":{"id":"P1","new":"cause"},"predicted":[]}"#,
            r#"{"problem":{},"predicted":[]}"#,
            r#"{"problem":{"id":"P1"},"predicted":["a","a"]}"#,
            r#"{"problem":{"id":"P1"},"predicted":["outsider"]}"#,
            r#"{"problem":{"id":"P1"},"predicted":[],"extra":"secret"}"#,
        ] {
            let error =
                parse(content).and_then(|mut diagnosis| validate_diagnosis(&mut diagnosis, &data));
            assert!(error.is_err(), "{content}");
            assert!(!error.unwrap_err().contains("secret"));
        }
        let mut diagnosis = parse(r#"{"problem":{"id":"P1"},"predicted":[]}"#).unwrap();
        assert!(
            validate_diagnosis(
                &mut diagnosis,
                &json!({"improvementMemory":{"problems":[]}})
            )
            .is_err()
        );
    }

    #[test]
    fn screen_requires_each_sample_exactly_once_and_a_bounded_reason() {
        let samples = BTreeSet::from([1, 2]);
        let a = json!({"sample":1,"verdict":"skip","reason":"Reason"});
        let b = json!({"sample":2,"verdict":"evaluate","reason":"Reason"});
        assert!(validate_screen(&json!({"samples":[a,b]}).to_string(), &samples).is_ok());
        for invalid in [
            json!([a]),
            json!([a, a]),
            json!([a,{"sample":3,"verdict":"evaluate","reason":"Reason"}]),
            json!([a,{"sample":2,"verdict":"accept","reason":"Reason"}]),
            json!([a,{"sample":2,"verdict":"evaluate","reason":" "}]),
            json!([a,{"sample":2,"verdict":"evaluate","reason":"a".repeat(1025)}]),
        ] {
            assert!(validate_screen(&json!({"samples":invalid}).to_string(), &samples).is_err());
        }
    }

    #[test]
    fn selection_can_only_adopt_an_evaluated_sample() {
        let samples = BTreeSet::from([1, 2]);
        for content in [
            r#"{"decision":"adopt","sample":1,"reason":"Reason"}"#,
            r#"{"decision":"keep","reason":"Reason"}"#,
        ] {
            assert!(validate_select(content, &samples).is_ok());
        }
        for content in [
            r#"{"decision":"adopt","reason":"Reason"}"#,
            r#"{"decision":"adopt","sample":3,"reason":"Reason"}"#,
            r#"{"decision":"keep","sample":null,"reason":"Reason"}"#,
            r#"{"decision":"keep","sample":1,"reason":"Reason"}"#,
            r#"{"decision":"keep","reason":" "}"#,
        ] {
            assert!(validate_select(content, &samples).is_err(), "{content}");
        }
    }

    #[test]
    fn obsolete_or_extended_proposal_envelopes_are_invalid() {
        let input = Input {
            data: diagnosis_data(),
            parent: serde_json::from_value(json!({"schemaVersion":1,"files":[{"kind":"instruction","path":"guide.md","text":"old"}]})).unwrap(),
        };
        let mut proposal = json!({"schemaVersion":2,"rationale":"Reason","edits":[],
            "files":[{"op":"write","path":"guide.md","text":"new"}],"diagnosis":{"problem":{"id":"P1"},"predicted":["a"]}});
        assert!(validate_proposal(&proposal.to_string(), &input, "generic").is_ok());
        proposal["schemaVersion"] = 1.into();
        assert!(validate_proposal(&proposal.to_string(), &input, "generic").is_err());
        proposal["schemaVersion"] = 2.into();
        proposal["extra"] = json!("extra");
        assert!(validate_proposal(&proposal.to_string(), &input, "generic").is_err());
    }
}
