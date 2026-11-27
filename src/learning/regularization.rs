use super::evaluations::{Report, case_passes};
use crate::{BundleFile, proposal_edits::file_kind_for_path};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Relative task-token increase allowed at zero score gain (RRSI beta_0).
pub(super) const COST_BETA0: f64 = 0.20;
/// Additional relative task-token increase bought per +1.00 score gain (RRSI beta_1).
pub(super) const COST_BETA1: f64 = 4.0;
/// Absolute task-token allowance floor so tiny initial harnesses are not blocked from adding
/// their first procedures before token baselines mature.
pub(super) const MIN_ABS_TOKEN_ALLOWANCE: f64 = 500.0;
/// Rounds without improvement above `noise_band` before flagging a stall (RRSI w).
const STALL_WINDOW: usize = 2;
/// Recent completed rounds inspected for per-kind yield and pruning (RRSI n_prune).
const PRUNE_WINDOW: usize = 4;
/// Maximum recent rejected/dropped candidate summaries surfaced to the proposer.
const MAX_REJECTED_DIRECTIONS: usize = 8;
const EPS: f64 = 1e-9;
const ALL_KINDS: [&str; 3] = ["instruction", "skill", "memory"];

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Admissibility {
    pub admissible: bool,
    pub delta_score: f64,
    pub delta_task_tokens: Option<f64>,
    pub guardrail_reason: Option<&'static str>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(super) struct LineageRound {
    pub parent_version_id: Uuid,
    pub adopted_version_id: Option<Uuid>,
    pub channel_revision: i64,
    pub decision: Option<String>,
    pub reverted: bool,
    pub incumbent_score: Option<f64>,
    pub adopted_score: Option<f64>,
}

#[derive(Debug, Clone)]
pub(super) struct Signals {
    pub noise_band: f64,
    pub best_score: f64,
    pub incumbent_mean_task_tokens: Option<f64>,
    pub stalled: bool,
    pub untried_kinds: Vec<&'static str>,
    pub prune_candidates: Vec<Value>,
    pub rejected_directions: Vec<Value>,
}

impl Signals {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "noiseBand": self.noise_band,
            "bestScore": self.best_score,
            "incumbentMeanTaskTokens": self.incumbent_mean_task_tokens,
            "costBudget": {
                "beta0": COST_BETA0,
                "beta1": COST_BETA1,
                "minAbsTokenAllowance": MIN_ABS_TOKEN_ALLOWANCE,
            },
            "stalled": self.stalled,
            "untriedKinds": self.untried_kinds,
            "pruneCandidates": self.prune_candidates,
            "rejectedDirections": self.rejected_directions,
        })
    }
}

/// Empirical 1-SE noise band `delta`: standard error of the difference between two evaluations on
/// the same tasks, estimated from within-task repeat-rollout variance.
pub(super) fn noise_band(report: &Report) -> f64 {
    let n = report.cases.len();
    if n == 0 {
        return 0.0;
    }
    let mut sum_mean_var = 0.0;
    for case in &report.cases {
        let scores: Vec<f64> = case
            .rollouts
            .iter()
            .filter_map(|r| r["score"].as_f64())
            .collect();
        let r = scores.len();
        if r < 2 {
            continue;
        }
        let mean = scores.iter().sum::<f64>() / r as f64;
        let sample_var = scores
            .iter()
            .map(|s| {
                let d = s - mean;
                d * d
            })
            .sum::<f64>()
            / (r - 1) as f64;
        sum_mean_var += sample_var / r as f64;
    }
    let eval_var = sum_mean_var / ((n * n) as f64);
    (2.0 * eval_var).sqrt()
}

/// Partition evolve case IDs into passing and failing sets so the proposer protects passing tasks.
pub(super) fn case_split(report: &Report) -> (Vec<String>, Vec<String>) {
    let mut passing = Vec::new();
    let mut failing = Vec::new();
    for case in &report.cases {
        if case_passes(case) {
            passing.push(case.case_id.clone());
        } else {
            failing.push(case.case_id.clone());
        }
    }
    passing.sort_unstable();
    failing.sort_unstable();
    (passing, failing)
}

/// Compute `bestScore` (`S*`) strictly over the retained lineage of `(current_parent,
/// current_channel_revision)` on the same channel, setting, task revision and runtime. Reverted
/// adoptions, rolled-back branches, and manual re-releases at a newer channel revision are
/// excluded so the noise floor never becomes unreachable.
pub(super) fn retained_best_score(
    lineage_desc: &[LineageRound],
    current_parent: Uuid,
    current_channel_revision: i64,
    incumbent_score: f64,
) -> f64 {
    let mut head_version = current_parent;
    let mut head_revision = current_channel_revision;
    let mut best = incumbent_score;
    for round in lineage_desc {
        if round.decision.as_deref() == Some("adopted")
            && !round.reverted
            && round.adopted_version_id == Some(head_version)
            && round.channel_revision + 1 == head_revision
        {
            if let Some(score) = round.adopted_score {
                best = best.max(score);
            }
            if let Some(score) = round.incumbent_score {
                best = best.max(score);
            }
            head_version = round.parent_version_id;
            head_revision = round.channel_revision;
        } else if round.parent_version_id == head_version
            && round.channel_revision == head_revision
            && let Some(score) = round.incumbent_score
        {
            best = best.max(score);
        }
    }
    best
}

fn allowed_token_increase(incumbent_tokens: f64, delta_score: f64) -> f64 {
    (COST_BETA0 * incumbent_tokens).max(MIN_ABS_TOKEN_ALLOWANCE)
        + COST_BETA1 * delta_score.max(0.0) * incumbent_tokens
}

/// Deterministic RRSI admissibility gate: enforces the noise-adjusted score floor `S' >= S* - delta`
/// and task-token cost budget `cand - inc <= max(beta0 * inc, minAbsTokenAllowance) + beta1 * max(delta_S, 0) * inc`.
pub(super) fn admissibility(
    incumbent_score: f64,
    best_score: f64,
    candidate_score: f64,
    delta: f64,
    incumbent_tokens: Option<f64>,
    candidate_tokens: Option<f64>,
) -> Admissibility {
    let delta_score = candidate_score - incumbent_score;
    let delta_task_tokens = match (incumbent_tokens, candidate_tokens) {
        (Some(inc), Some(cand)) if inc > 0.0 => Some((cand - inc) / inc),
        (Some(inc), Some(cand)) if inc == 0.0 && cand == 0.0 => Some(0.0),
        _ => None,
    };
    let floor = best_score - delta;
    if candidate_score + EPS < floor {
        return Admissibility {
            admissible: false,
            delta_score,
            delta_task_tokens,
            guardrail_reason: Some("below-noise-floor"),
        };
    }
    if let (Some(inc), Some(cand)) = (incumbent_tokens, candidate_tokens)
        && inc >= 0.0
        && cand >= 0.0
    {
        let allowed = allowed_token_increase(inc, delta_score);
        if (cand - inc) > allowed + EPS {
            return Admissibility {
                admissible: false,
                delta_score,
                delta_task_tokens,
                guardrail_reason: Some("token-cost-exceeded"),
            };
        }
    }
    Admissibility {
        admissible: true,
        delta_score,
        delta_task_tokens,
        guardrail_reason: None,
    }
}

fn kind_for_path(path: &str, declared: &BTreeMap<&str, &'static str>) -> &'static str {
    declared
        .get(path)
        .copied()
        .unwrap_or_else(|| file_kind_for_path(path))
}

fn declared_kind_map(files: &[BundleFile]) -> BTreeMap<&str, &'static str> {
    files
        .iter()
        .filter_map(|file| {
            let kind = match file.kind.as_str() {
                "instruction" => "instruction",
                "skill" => "skill",
                "memory" => "memory",
                _ => return None,
            };
            Some((file.path.as_str(), kind))
        })
        .collect()
}

fn candidate_kinds(
    changes: &Value,
    declared: &BTreeMap<&str, &'static str>,
) -> BTreeSet<&'static str> {
    let mut kinds = BTreeSet::new();
    for key in ["edits", "files"] {
        if let Some(items) = changes.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    kinds.insert(kind_for_path(path, declared));
                }
            }
        }
    }
    kinds
}

/// Compute RRSI-inspired search regularization signals from same-setting history, lineage baseline
/// and current incumbent evaluation.
pub(super) fn compute_signals(
    history: &Value,
    harness_files: &[BundleFile],
    task_revision: i64,
    incumbent_score: f64,
    best_score: f64,
    incumbent_report: &Report,
    incumbent_tokens: Option<f64>,
) -> Signals {
    let delta = noise_band(incumbent_report);
    let declared = declared_kind_map(harness_files);
    let rounds = history.as_array().map(Vec::as_slice).unwrap_or(&[]);

    // Track score trajectory over completed rounds on the current task revision.
    let mut trajectory: Vec<f64> = Vec::new();
    for round in rounds {
        if round["evolveRevision"].as_i64() == Some(task_revision)
            && round["state"].as_str() == Some("completed")
            && let Some(inc) = round["incumbent"]["score"].as_f64()
        {
            trajectory.push(inc);
        }
    }
    let stalled = trajectory.len() >= STALL_WINDOW
        && (incumbent_score - trajectory[trajectory.len() - STALL_WINDOW]) <= delta + EPS;

    // Recent pruning window spans the last PRUNE_WINDOW *completed* rounds.
    let completed_indices: Vec<usize> = rounds
        .iter()
        .enumerate()
        .filter_map(|(idx, round)| (round["state"].as_str() == Some("completed")).then_some(idx))
        .collect();
    let recent_completed: BTreeSet<usize> = completed_indices
        .iter()
        .rev()
        .take(PRUNE_WINDOW)
        .copied()
        .collect();

    let mut tried_kinds: BTreeSet<&'static str> = BTreeSet::new();
    let mut adopted_rounds_by_kind: BTreeMap<&'static str, Vec<i64>> = BTreeMap::new();
    let mut recent_yield_by_kind: BTreeMap<&'static str, f64> = BTreeMap::new();
    let mut rejected: Vec<Value> = Vec::new();

    for (idx, round) in rounds.iter().enumerate() {
        let round_num = round["round"].as_i64().unwrap_or(0);
        let inc_score = round["incumbent"]["score"].as_f64();
        let inc_tokens = round["incumbent"]["meanTaskTokens"].as_f64();
        let decision = round["decision"].as_str();
        let round_reason = round["reason"].as_str();
        let adopted_sample = if decision == Some("adopted") {
            round["selection"]["sample"].as_i64()
        } else {
            None
        };
        let Some(cands) = round["candidates"].as_array() else {
            continue;
        };
        for cand in cands {
            let sample = cand["sample"].as_i64().unwrap_or(0);
            let status = cand["status"].as_str().unwrap_or("");
            let kinds = candidate_kinds(&cand["changes"], &declared);
            let cand_score = cand["evolve"]["score"].as_f64();
            let cand_tokens = cand["evolve"]["meanTaskTokens"].as_f64();
            let is_adopted = adopted_sample == Some(sample);

            if let (Some(cs), Some(is)) = (cand_score, inc_score) {
                let ds = cs - is;
                for kind in &kinds {
                    tried_kinds.insert(kind);
                    if recent_completed.contains(&idx) {
                        recent_yield_by_kind
                            .entry(kind)
                            .and_modify(|best| *best = best.max(ds))
                            .or_insert(ds);
                    }
                    if is_adopted {
                        adopted_rounds_by_kind
                            .entry(kind)
                            .or_default()
                            .push(round_num);
                    }
                }
            }

            if round_reason == Some("channel-moved") {
                continue;
            }
            if !is_adopted && matches!(status, "evaluated" | "screened_out") {
                let ds = match (cand_score, inc_score) {
                    (Some(cs), Some(is)) => Some(cs - is),
                    _ => None,
                };
                let cost_exceeded = match (inc_tokens, cand_tokens, ds) {
                    (Some(inc), Some(cand), Some(d)) if inc >= 0.0 && cand >= 0.0 => {
                        (cand - inc) > allowed_token_increase(inc, d) + EPS
                    }
                    _ => false,
                };
                let reason = if status == "screened_out" {
                    cand["screen"]["reason"].clone()
                } else if cost_exceeded {
                    json!("token-cost-exceeded")
                } else if decision == Some("adopted") {
                    json!("not-selected")
                } else if !round["selection"]["reason"].is_null() {
                    round["selection"]["reason"].clone()
                } else if round_reason == Some("no-admissible-candidates") {
                    json!("below-noise-floor")
                } else {
                    json!(round_reason)
                };
                rejected.push(json!({
                    "round": round_num,
                    "sample": sample,
                    "status": status,
                    "kinds": kinds.into_iter().collect::<Vec<_>>(),
                    "rationale": cand["rationale"],
                    "deltaScore": ds,
                    "reason": reason,
                }));
            }
        }
    }

    if rejected.len() > MAX_REJECTED_DIRECTIONS {
        let keep_from = rejected.len() - MAX_REJECTED_DIRECTIONS;
        rejected.drain(0..keep_from);
    }

    let untried_kinds: Vec<&'static str> = ALL_KINDS
        .into_iter()
        .filter(|k| !tried_kinds.contains(k))
        .collect();

    let mut prune_candidates = Vec::new();
    for kind in &tried_kinds {
        let best_recent = recent_yield_by_kind.get(kind).copied();
        let adopted_rounds = adopted_rounds_by_kind.get(kind);
        if adopted_rounds.is_some_and(|r| !r.is_empty())
            && matches!(best_recent, Some(gain) if gain <= EPS)
        {
            prune_candidates.push(json!({
                "kind": kind,
                "recentBestDeltaScore": best_recent,
                "adoptedRounds": adopted_rounds,
            }));
        }
    }

    Signals {
        noise_band: delta,
        best_score,
        incumbent_mean_task_tokens: incumbent_tokens,
        stalled,
        untried_kinds,
        prune_candidates,
        rejected_directions: rejected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning::evaluations::CaseReport;

    fn report_from(rows: &[(&str, &[f64])]) -> Report {
        Report {
            cases: rows
                .iter()
                .map(|(id, scores)| CaseReport {
                    case_id: (*id).to_owned(),
                    rollouts: scores
                        .iter()
                        .map(|s| json!({"score": *s, "passed": *s >= 1.0}))
                        .collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn noise_band_is_zero_for_deterministic_rollouts_and_scales_by_total_cases() {
        let det = report_from(&[("a", &[1.0; 5]), ("b", &[0.0; 5])]);
        assert_eq!(noise_band(&det), 0.0);

        // Two tasks, each with scores [0, 0, 1, 1, 1]: sample var = 3/10 = 0.3 per task.
        // sum_mean_var = 2 * (0.3 / 5) = 0.12; eval_var = 0.12 / 4 = 0.03; delta = sqrt(0.06).
        let noisy_two = report_from(&[
            ("a", &[0.0, 0.0, 1.0, 1.0, 1.0]),
            ("b", &[0.0, 0.0, 1.0, 1.0, 1.0]),
        ]);
        let expected_two = (0.06_f64).sqrt();
        assert!((noise_band(&noisy_two) - expected_two).abs() < 1e-12);

        // A single-rollout case contributes zero variance while remaining in the N=3 mean denominator.
        let noisy_three = report_from(&[
            ("a", &[0.0, 0.0, 1.0, 1.0, 1.0]),
            ("b", &[0.0, 0.0, 1.0, 1.0, 1.0]),
            ("single", &[1.0]),
        ]);
        let expected_three = (2.0 * (0.12_f64 / 9.0)).sqrt();
        assert!((noise_band(&noisy_three) - expected_three).abs() < 1e-12);
    }

    #[test]
    fn admissibility_enforces_noise_adjusted_floor_and_token_cost_budget_with_small_harness_floor()
    {
        // Above floor, within cost budget -> admissible.
        let ok = admissibility(0.50, 0.55, 0.54, 0.02, Some(3000.0), Some(3450.0));
        assert!(ok.admissible);
        assert_eq!(ok.guardrail_reason, None);

        // Below S* - delta (0.55 - 0.02 = 0.53) -> rejected even if equal to incumbent.
        let floor_fail = admissibility(0.50, 0.55, 0.52, 0.02, Some(3000.0), Some(2800.0));
        assert!(!floor_fail.admissible);
        assert_eq!(floor_fail.guardrail_reason, Some("below-noise-floor"));

        // Mature harness (3000 tokens): zero gain with +25% (+750 > 600) exceeds beta0 -> rejected.
        let cost_fail = admissibility(0.50, 0.50, 0.50, 0.01, Some(3000.0), Some(3750.0));
        assert!(!cost_fail.admissible);
        assert_eq!(cost_fail.guardrail_reason, Some("token-cost-exceeded"));

        // +10pp gain buys beta0 + beta1 * 0.10 = 0.60 (+1800 tokens) -> +50% (+1500) is admissible.
        let paid_gain = admissibility(0.50, 0.50, 0.60, 0.01, Some(3000.0), Some(4500.0));
        assert!(paid_gain.admissible);

        // Small initial harness (400 tokens): adding 350 tokens (<= MIN_ABS_TOKEN_ALLOWANCE=500)
        // is allowed even at zero gain, while adding 600 tokens at zero gain is rejected.
        let small_ok = admissibility(0.40, 0.40, 0.40, 0.01, Some(400.0), Some(750.0));
        assert!(small_ok.admissible);
        let small_fail = admissibility(0.40, 0.40, 0.40, 0.01, Some(400.0), Some(1000.0));
        assert!(!small_fail.admissible);
        assert_eq!(small_fail.guardrail_reason, Some("token-cost-exceeded"));

        // Equal score and equal tokens (zero noise) -> admissible.
        let tie = admissibility(0.0, 0.0, 0.0, 0.0, Some(3.0), Some(3.0));
        assert!(tie.admissible);
    }

    #[test]
    fn retained_best_score_ignores_reverted_rolled_back_and_rereleased_branches() {
        let v0 = Uuid::new_v4();
        let v1 = Uuid::new_v4();
        let v2 = Uuid::new_v4();
        let v_ext = Uuid::new_v4();

        // Round 1 adopted v1 (0.80) at rev 1->2, later reverted to v0 at rev 3 (0.60).
        let after_revert = vec![LineageRound {
            parent_version_id: v0,
            adopted_version_id: Some(v1),
            channel_revision: 1,
            decision: Some("adopted".into()),
            reverted: true,
            incumbent_score: Some(0.60),
            adopted_score: Some(0.80),
        }];
        assert_eq!(retained_best_score(&after_revert, v0, 3, 0.60), 0.60);

        // Unbroken chain v0 (rev 1, 0.50) -> v1 (rev 2, 0.70) -> v2 (rev 3, 0.85).
        let chain = vec![
            LineageRound {
                parent_version_id: v1,
                adopted_version_id: Some(v2),
                channel_revision: 2,
                decision: Some("adopted".into()),
                reverted: false,
                incumbent_score: Some(0.70),
                adopted_score: Some(0.85),
            },
            LineageRound {
                parent_version_id: v0,
                adopted_version_id: Some(v1),
                channel_revision: 1,
                decision: Some("adopted".into()),
                reverted: false,
                incumbent_score: Some(0.50),
                adopted_score: Some(0.70),
            },
        ];
        // Active head (v2, rev 3) with noisy re-measurement 0.83 retains 0.85 from its lineage.
        assert_eq!(retained_best_score(&chain, v2, 3, 0.83), 0.85);
        // Toggling only `reverted = true` on Round 2 excludes its 0.85 even at the same (v2, 3).
        let mut reverted_chain = chain.clone();
        reverted_chain[0].reverted = true;
        assert_eq!(retained_best_score(&reverted_chain, v2, 3, 0.83), 0.83);
        // Active head (v1, rev 2) keeps 0.70 from Round 1 and ignores v2's 0.85.
        assert_eq!(retained_best_score(&chain, v1, 2, 0.68), 0.70);
        // External release at rev 4 resets baseline to the new version's incumbent score.
        assert_eq!(retained_best_score(&chain, v_ext, 4, 0.45), 0.45);

        // Re-releasing previously adopted v1 (originally adopted from v0 at 0.95 -> 0.60 at rev 1->2)
        // after an intermediate release (rev 3) puts v1 at rev 4; must NOT resurrect v0's 0.95.
        let rereleased = vec![LineageRound {
            parent_version_id: v0,
            adopted_version_id: Some(v1),
            channel_revision: 1,
            decision: Some("adopted".into()),
            reverted: false,
            incumbent_score: Some(0.95),
            adopted_score: Some(0.60),
        }];
        assert_eq!(retained_best_score(&rereleased, v1, 4, 0.60), 0.60);
    }

    #[test]
    fn signals_detect_stall_declared_kinds_prune_and_clean_rejected_reasons() {
        let report = report_from(&[("a", &[1.0; 5]), ("b", &[0.0; 5])]);
        let (passing, failing) = case_split(&report);
        assert_eq!(passing, ["a"]);
        assert_eq!(failing, ["b"]);

        let harness = vec![
            BundleFile {
                path: "AGENTS.md".into(),
                kind: "instruction".into(),
                text: "x".into(),
            },
            BundleFile {
                path: "notes.md".into(),
                kind: "memory".into(),
                text: "m".into(),
            },
        ];

        let history = json!([
            {
                "round": 1,
                "state": "completed",
                "decision": "adopted",
                "evolveRevision": 1,
                "incumbent": {"score": 0.4, "meanTaskTokens": 3000.0},
                "selection": {"decision": "adopt", "sample": 1, "reason": "Winner rationale."},
                "candidates": [
                    {
                        "sample": 1, "status": "evaluated", "rationale": "Add instruction rule.",
                        "changes": {"edits": [], "files": [{"op": "write", "path": "AGENTS.md", "text": "x"}]},
                        "evolve": {"score": 0.5, "meanTaskTokens": 3100.0}
                    },
                    {
                        "sample": 2, "status": "evaluated", "rationale": "Try different phrasing.",
                        "changes": {"edits": [], "files": [{"op": "write", "path": "AGENTS.md", "text": "y"}]},
                        "evolve": {"score": 0.45, "meanTaskTokens": 3050.0}
                    }
                ]
            },
            {
                "round": 2,
                "state": "completed",
                "decision": "kept",
                "reason": "no-admissible-candidates",
                "evolveRevision": 1,
                "incumbent": {"score": 0.5, "meanTaskTokens": 3100.0},
                "selection": null,
                "candidates": [
                    {
                        "sample": 1, "status": "evaluated", "rationale": "Bloated memory note.",
                        "changes": {"edits": [], "files": [{"op": "write", "path": "notes.md", "text": "z"}]},
                        "evolve": {"score": 0.5, "meanTaskTokens": 4500.0}
                    }
                ]
            },
            {
                "round": 3,
                "state": "completed",
                "decision": "kept",
                "reason": "channel-moved",
                "evolveRevision": 1,
                "incumbent": {"score": 0.5, "meanTaskTokens": 3100.0},
                "selection": {"decision": "adopt", "sample": 1, "reason": "Would have adopted."},
                "candidates": [
                    {
                        "sample": 1, "status": "evaluated", "rationale": "Ignored channel-moved.",
                        "changes": {"edits": [], "files": [{"op": "write", "path": "AGENTS.md", "text": "m"}]},
                        "evolve": {"score": 0.55, "meanTaskTokens": 3100.0}
                    }
                ]
            },
            {
                "round": 4,
                "state": "completed",
                "decision": "kept",
                "reason": "selector-kept",
                "evolveRevision": 1,
                "incumbent": {"score": 0.5, "meanTaskTokens": 3100.0},
                "selection": {"decision": "keep", "reason": "Still flat."},
                "candidates": [
                    {
                        "sample": 1, "status": "screened_out", "rationale": "Hardcoded case.",
                        "changes": {"edits": [], "files": [{"op": "write", "path": "AGENTS.md", "text": "w"}]},
                        "screen": {"verdict": "skip", "reason": "Hard-codes case."}
                    }
                ]
            }
        ]);
        let signals = compute_signals(&history, &harness, 1, 0.5, 0.5, &report, Some(3100.0));
        assert_eq!(signals.best_score, 0.5);
        assert!(signals.stalled);
        // notes.md has declared kind "memory", so only "skill" remains untried.
        assert_eq!(signals.untried_kinds, ["skill"]);
        assert!(signals.prune_candidates.is_empty());
        // Channel-moved round is excluded; 3 rejected directions remain.
        assert_eq!(signals.rejected_directions.len(), 3);
        // Losing sibling in adopted round does NOT inherit "Winner rationale.".
        assert_eq!(signals.rejected_directions[0]["reason"], "not-selected");
        // Bloated candidate in no-admissible-candidates round surfaces token-cost-exceeded.
        assert_eq!(
            signals.rejected_directions[1]["reason"],
            "token-cost-exceeded"
        );
        assert_eq!(signals.rejected_directions[2]["status"], "screened_out");
    }
}
