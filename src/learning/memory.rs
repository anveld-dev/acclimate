use super::*;
use super::{
    evaluations::{ROLLOUTS_PER_CASE, Report, case_passes, passed_rollouts},
    optimizer::{
        Diagnosis, DiagnosisProblem, Pins, candidates, digest, evolve_evaluation, invariant,
        stored, version,
    },
};
use crate::proposal_edits::changed_files;
use std::collections::BTreeMap;

const ROOT_CAUSE_MAX_BYTES: usize = 1024;

pub(super) fn normalize_root_cause(text: &str) -> Option<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    ((1..=ROOT_CAUSE_MAX_BYTES).contains(&normalized.len())
        && !normalized.chars().any(char::is_control))
    .then_some(normalized)
}

fn root_cause_key(normalized: &str) -> String {
    crate::digest(format!("acclimate-root-cause-v1\n{normalized}").as_bytes())["sha256:".len()..]
        .to_owned()
}

pub(super) struct AttemptOutcome {
    pub fixed: Vec<String>,
    pub missed: Vec<String>,
    pub passed: i32,
    pub total: i32,
}

pub(super) fn attempt_outcome(
    incumbent: &Report,
    candidate: &Report,
    predicted: &[String],
) -> Result<AttemptOutcome, &'static str> {
    let passes = |report: &Report| {
        report
            .cases
            .iter()
            .map(|case| (case.case_id.clone(), case_passes(case)))
            .collect::<BTreeMap<_, _>>()
    };
    let before = passes(incumbent);
    let after = passes(candidate);
    if before.len() != incumbent.cases.len()
        || after.len() != candidate.cases.len()
        || before.is_empty()
        || !before.keys().eq(after.keys())
        || incumbent
            .cases
            .iter()
            .chain(&candidate.cases)
            .any(|case| case.rollouts.len() != ROLLOUTS_PER_CASE)
        || predicted.iter().any(|id| !before.contains_key(id))
    {
        return Err("Invalid evolve reports or prediction for attempt");
    }
    let (mut fixed, mut missed): (Vec<_>, Vec<_>) = predicted
        .iter()
        .cloned()
        .partition(|id| !before[id] && after[id]);
    fixed.sort_unstable();
    missed.sort_unstable();
    let passed = candidate.cases.iter().map(passed_rollouts).sum::<usize>();
    let total = candidate.cases.len() * ROLLOUTS_PER_CASE;
    Ok(AttemptOutcome {
        fixed,
        missed,
        passed: i32::try_from(passed).map_err(|_| "Rollout count overflow")?,
        total: i32::try_from(total).map_err(|_| "Rollout count overflow")?,
    })
}

pub(super) async fn render_memory(
    tx: &mut Tx<'_>,
    project: &str,
    bundle: Uuid,
    revision: i64,
) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT jsonb_build_object('schemaVersion',1,'memoryRevision',$3::bigint,'problems',
          COALESCE(jsonb_agg(jsonb_build_object('id',p.problem_id,'rootCause',p.root_cause,
            'openedRound',p.opened_round,'attempts',(
              SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'round',a.round,'sample',a.sample,'accepted',true,'backfilled',a.backfilled,
                'what',a.what,
                'files',ARRAY(SELECT item FROM unnest(a.files) item ORDER BY item COLLATE \"C\"),
                'predicted',ARRAY(SELECT item FROM unnest(a.predicted) item ORDER BY item COLLATE \"C\"),
                'fixed',ARRAY(SELECT item FROM unnest(a.fixed) item ORDER BY item COLLATE \"C\"),
                'missed',ARRAY(SELECT item FROM unnest(a.missed) item ORDER BY item COLLATE \"C\"),
                'passed',a.passed,'total',a.total,'domain',a.domain,
                'provenance',jsonb_build_object('domain',a.provenance->'domain',
                    'benchmark',a.provenance->'benchmark','policyModel',a.provenance->'policyModel',
                    'round',a.provenance->'round'))
                ORDER BY a.revision),'[]'::jsonb)
              FROM learning_memory_attempts a
              WHERE (a.project_id,a.bundle_id,a.problem_id)=(p.project_id,p.bundle_id,p.problem_id)
                AND a.revision<=$3
            )) ORDER BY p.opened_revision),'[]'::jsonb))
         FROM learning_memory_problems p WHERE (p.project_id,p.bundle_id)=($1,$2) AND p.opened_revision<=$3")
        .bind(project).bind(bundle).bind(revision).fetch_one(&mut **tx).await
}

async fn resolve_problem(
    tx: &mut Tx<'_>,
    round: &Pins,
    problem: DiagnosisProblem,
    revision: i32,
) -> Result<String, sqlx::Error> {
    let root = match problem {
        DiagnosisProblem::Id(id) => return Ok(id),
        DiagnosisProblem::New(root) => root,
    };
    let key = root_cause_key(&root);
    if let Some(id) = sqlx::query_scalar(
        "SELECT problem_id FROM learning_memory_problems
        WHERE (project_id,bundle_id,root_cause_key)=($1,$2,$3)",
    )
    .bind(&round.project_id)
    .bind(round.bundle_id)
    .bind(&key)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(id);
    }
    sqlx::query_scalar("INSERT INTO learning_memory_problems(project_id,bundle_id,problem_id,root_cause,root_cause_key,opened_round,opened_revision)
        SELECT $1,$2,'P'||(COUNT(*)+1),$3,$4,$5,$6 FROM learning_memory_problems
        WHERE (project_id,bundle_id)=($1,$2) RETURNING problem_id")
        .bind(&round.project_id).bind(round.bundle_id).bind(root).bind(key).bind(round.number).bind(revision)
        .fetch_one(&mut **tx).await
}

pub(super) async fn write_back(tx: &mut Tx<'_>, round: &Pins) -> Result<i32, sqlx::Error> {
    let round_id = round.id;
    if let Some(revision) =
        sqlx::query_scalar("SELECT revision FROM learning_memory_attempts WHERE round_id=$1")
            .bind(round_id)
            .fetch_optional(&mut **tx)
            .await?
    {
        return Ok(revision);
    }
    let current: i64 = sqlx::query_scalar(
        "SELECT memory_revision FROM learning_loops
        WHERE (project_id,bundle_id)=($1,$2) FOR UPDATE",
    )
    .bind(&round.project_id)
    .bind(round.bundle_id)
    .fetch_one(&mut **tx)
    .await?;
    if current != round.memory_revision {
        return Err(invariant(format!(
            "Memory revision moved for round {round_id}"
        )));
    }
    let (sample, adopted_version, held_out_digest): (i16, Uuid, String) = sqlx::query_as(
        "SELECT adopted_sample,adopted_version_id,held_out->>'digest' FROM learning_rounds WHERE id=$1 AND decision='adopted'")
        .bind(round_id).fetch_one(&mut **tx).await?;
    let candidate = candidates(tx, round_id)
        .await?
        .into_iter()
        .find(|candidate| {
            candidate.sample == sample
                && candidate.status == "evaluated"
                && candidate
                    .scan
                    .as_ref()
                    .is_some_and(|scan| scan["clean"] == true)
                && candidate.version_id == Some(adopted_version)
                && candidate.evaluation_id.is_some()
        })
        .ok_or_else(|| invariant(format!("Invalid adopted candidate for round {round_id}")))?;
    let diagnosis: Diagnosis = stored(
        &candidate
            .diagnosis
            .ok_or_else(|| invariant("Missing adopted diagnosis"))?,
    )?;
    let incumbent = evolve_evaluation(tx, round_id, "incumbent", None)
        .await?
        .filter(|evaluation| {
            evaluation.scored(round.evolve_revision)
                && evaluation.version_id == round.parent_version_id
        })
        .ok_or_else(|| invariant(format!("Invalid incumbent evaluation for round {round_id}")))?;
    let evaluation = evolve_evaluation(tx, round_id, "candidate", candidate.evaluation_id)
        .await?
        .filter(|evaluation| {
            evaluation.scored(round.evolve_revision) && evaluation.version_id == adopted_version
        })
        .ok_or_else(|| invariant(format!("Invalid candidate evaluation for round {round_id}")))?;
    let revision = i32::try_from(current + 1).map_err(|_| invariant("Memory revision overflow"))?;
    let outcome = attempt_outcome(&incumbent.report, &evaluation.report, &diagnosis.predicted)
        .map_err(invariant)?;
    let id = resolve_problem(tx, round, diagnosis.problem, revision).await?;
    let (parent, _) = version(tx, round.parent_version_id).await?;
    let (adopted, _) = version(tx, adopted_version).await?;
    let paths: Vec<_> = changed_files(&parent, &adopted).into_iter().collect();
    let what = json!({"rationale": candidate.rationale, "changes": candidate.changes});
    let domain = round.setting["domain"]
        .as_str()
        .ok_or_else(|| invariant("Missing domain pin"))?;
    let provenance = json!({
        "domain": domain, "benchmark": round.setting["benchmark"], "policyModel": round.setting["policyModel"],
        "round": round.number, "evolveRevision": round.evolve_revision, "heldOutDigest": held_out_digest,
        "optimizerModel": round.optimizer_model
    });
    sqlx::query("INSERT INTO learning_memory_attempts(
        project_id,bundle_id,revision,problem_id,round_id,round,sample,what,files,predicted,fixed,missed,passed,total,domain,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)")
        .bind(&round.project_id).bind(round.bundle_id).bind(revision).bind(id).bind(round_id).bind(round.number)
        .bind(sample).bind(what).bind(paths).bind(diagnosis.predicted).bind(outcome.fixed).bind(outcome.missed)
        .bind(outcome.passed).bind(outcome.total).bind(domain).bind(provenance).execute(&mut **tx).await?;
    sqlx::query(
        "UPDATE learning_loops SET memory_revision=$3 WHERE (project_id,bundle_id)=($1,$2)",
    )
    .bind(&round.project_id)
    .bind(round.bundle_id)
    .bind(i64::from(revision))
    .execute(&mut **tx)
    .await?;
    Ok(revision)
}

#[derive(Deserialize)]
pub(super) struct MemoryQuery {
    revision: Option<i64>,
}

pub(super) async fn get(
    State(s): State<AppState>,
    Path((project, bundle)): Path<(String, String)>,
    headers: HeaderMap,
    query: Result<Query<MemoryQuery>, axum::extract::rejection::QueryRejection>,
) -> Reply {
    let Query(query) = query.map_err(|_| invalid("Invalid memory revision"))?;
    if query.revision.is_some_and(|revision| revision < 0) {
        return Err(invalid("Invalid memory revision"));
    }
    let bundle = path(&bundle)?;
    let (mut tx, actor) = actor_tx(&s, &headers, &project, "read").await?;
    let row = require_loop(&mut tx, &project, bundle, false).await?;
    admin_is_not_app(&actor, &row.app_principal)?;
    let revision = query.revision.unwrap_or(row.memory_revision);
    if revision > row.memory_revision {
        return Err(missing("Memory revision not found"));
    }
    let memory = render_memory(&mut tx, &project, bundle, revision)
        .await
        .map_err(db)?;
    let records: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object(
        'revision',a.revision,'problemId',a.problem_id,'roundId',a.round_id,'round',a.round,
        'versionId',r.adopted_version_id,'provenance',a.provenance)
        FROM learning_memory_attempts a JOIN learning_rounds r ON r.id=a.round_id
        WHERE (a.project_id,a.bundle_id)=($1,$2) AND a.revision<=$3 ORDER BY a.revision",
    )
    .bind(&project)
    .bind(bundle)
    .bind(revision)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    Ok(Json(json!({
        "currentRevision":row.memory_revision,"memoryRevision":revision,"memoryDigest":digest(&memory),
        "improvementMemory":memory,"records":records
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning::evaluations::CaseReport;

    fn report(counts: &[usize]) -> Report {
        Report {
            cases: counts
                .iter()
                .enumerate()
                .map(|(id, count)| CaseReport {
                    case_id: id.to_string(),
                    rollouts: (0..5)
                        .map(|rollout| json!({"passed": rollout < *count}))
                        .collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn normalizes_whitespace_and_checks_utf8_byte_limits() {
        let normalized = |text| normalize_root_cause(text).unwrap();
        assert_eq!(normalized(" a\tb\n"), normalized("a  b"));
        assert_ne!(
            root_cause_key(&normalized("A b")),
            root_cause_key(&normalized("a b"))
        );
        assert_eq!(root_cause_key("a b").len(), 64);
        assert_ne!(
            root_cause_key("a b"),
            crate::digest(b"a b")["sha256:".len()..]
        );
        assert_eq!(normalized(&"é".repeat(512)).len(), 1024);
        assert!(normalize_root_cause(&"x".repeat(1025)).is_none());
        assert!(normalize_root_cause("  \n ").is_none());
        assert!(normalize_root_cause("a\u{0007}b").is_none());
    }

    #[test]
    fn derives_fixed_missed_and_rollout_totals() {
        let before = report(&[2, 2, 3, 3]);
        let after = report(&[3, 2, 2, 5]);
        let outcome = attempt_outcome(
            &before,
            &after,
            &["3".into(), "1".into(), "0".into(), "2".into()],
        )
        .unwrap();
        assert_eq!(outcome.fixed, ["0"]);
        assert_eq!(outcome.missed, ["1", "2", "3"]);
        assert_eq!(outcome.passed, 12);
        let before = report(&[1; 30]);
        let after = report(&[4; 30]);
        let outcome = attempt_outcome(&before, &after, &[]).unwrap();
        assert_eq!((outcome.passed, outcome.total), (120, 150));
    }

    #[test]
    fn rejects_mismatched_cases_predictions_and_incomplete_rollouts() {
        let before = report(&[2]);
        assert!(attempt_outcome(&before, &report(&[3, 3]), &[]).is_err());
        assert!(attempt_outcome(&before, &report(&[3]), &["unknown".into()]).is_err());
        let mut after = report(&[3]);
        after.cases[0].rollouts.pop();
        assert!(attempt_outcome(&before, &after, &[]).is_err());
    }

    #[test]
    fn canonical_memory_fixture_and_empty_document_have_stable_digests() {
        let memory = json!({"schemaVersion":1,"memoryRevision":0,"problems":[]});
        assert_eq!(
            memory.to_string(),
            r#"{"memoryRevision":0,"problems":[],"schemaVersion":1}"#
        );
        let fixture: Value = serde_json::from_str(include_str!(
            "../../contracts/fixtures/learning-memory-v1.json"
        ))
        .unwrap();
        assert_eq!(
            fixture["memoryDigest"],
            digest(&fixture["improvementMemory"])
        );
    }
}
