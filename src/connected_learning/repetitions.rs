use super::{
    Descriptor,
    statistics::{Calibration, critical_value, harmonic_repetitions},
};
use crate::CaseKey;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const DEFAULT_MAX_REPETITIONS: u32 = 3;
pub(super) const DEFAULT_PAIR_BUDGET: u32 = 1000;

type Counts = BTreeMap<String, u32>;

fn inventory(descriptor: &Descriptor) -> Counts {
    let mut counts = Counts::new();
    for key in &descriptor.expected_cases {
        *counts.entry(key.case_id.clone()).or_default() += 1;
    }
    counts
}

fn keys(counts: &Counts) -> Vec<CaseKey> {
    counts
        .iter()
        .flat_map(|(id, count)| {
            (0..*count).map(|repetition| CaseKey {
                case_id: id.clone(),
                repetition,
            })
        })
        .collect()
}

fn fixed(descriptor: &Descriptor) -> bool {
    let counts = inventory(descriptor);
    descriptor
        .runtime
        .contains_key("acclimate.collection.schedule")
        || descriptor
            .expected_cases
            .iter()
            .any(|key| key.repetition >= counts[&key.case_id])
}

// The connected SDK preflights a 2 MiB report with worst-case trial outcomes.
fn report_pair_limit(descriptor: &Descriptor) -> u32 {
    const REPORT_BYTES: usize = 2 * 1024 * 1024;
    const PAIR_OUTCOME_BYTES: usize = 5_000;
    let fixed_bytes = 8_192
        + serde_json::to_vec(&descriptor.evaluation_runtime()).map_or(REPORT_BYTES, |v| v.len())
        + 6 * (descriptor.dataset_revision.len() + descriptor.grader_revision.len());
    let case_id_bytes = descriptor
        .expected_cases
        .iter()
        .map(|key| serde_json::to_vec(&key.case_id).map_or(REPORT_BYTES, |v| v.len()))
        .max()
        .unwrap_or(0);
    let pair_limit =
        REPORT_BYTES.saturating_sub(fixed_bytes) / (PAIR_OUTCOME_BYTES + 2 * case_id_bytes);
    descriptor.expected_cases.len().max(pair_limit.min(1000)) as u32
}

fn setting(name: &str, default: u32, maximum: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| (1..=maximum).contains(n))
        .unwrap_or(default)
}

pub(crate) fn calibration_keys(descriptor: &Descriptor) -> Vec<CaseKey> {
    if fixed(descriptor) {
        return descriptor.expected_cases.clone();
    }
    let minimum = setting("ACCLIMATE_LEARNING_CALIBRATION_REPETITIONS", 2, 5).max(2);
    let mut counts = inventory(descriptor);
    let mut remaining = report_pair_limit(descriptor) - descriptor.expected_cases.len() as u32;
    for _ in 1..minimum {
        for count in counts.values_mut().filter(|count| **count < minimum) {
            if remaining == 0 {
                break;
            }
            *count += 1;
            remaining -= 1;
        }
    }
    keys(&counts)
}

fn uniform_count(descriptor: &Descriptor, cases: usize, maximum: u32, budget: u32) -> u32 {
    (budget.min(report_pair_limit(descriptor)) / cases.max(1) as u32).clamp(1, maximum)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    development_repetitions: Counts,
    audit_repetitions: Vec<u32>,
    // Earlier epochs stored a minimum for each audit rather than an exact count.
    #[serde(default)]
    uniform_audit_from: Option<usize>,
    flaky_case_count: usize,
    pair_budget: u32,
    trial_budget: u32,
    max_repetitions: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    case_count: usize,
    effective_repetitions: f64,
    projected_mde: Option<f64>,
    lower_mde: Option<f64>,
    upper_mde: Option<f64>,
    decision: AdmissionDecision,
    reason: String,
    power_at_effect: Option<f64>,
    effect: f64,
    paired_trials: u32,
    cases_needed_at_target: Option<usize>,
}

#[derive(PartialEq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum AdmissionDecision {
    Stop,
    Warn,
    Admit,
}

impl Projection {
    fn assess(&mut self, target: Option<f64>) {
        let Some(target) = target else {
            self.reason = "No target effect configured".to_owned();
            return;
        };
        self.decision = if self.lower_mde.is_some_and(|mde| mde > target) {
            AdmissionDecision::Stop
        } else if self.projected_mde.is_none_or(|mde| mde > target) {
            AdmissionDecision::Warn
        } else {
            AdmissionDecision::Admit
        };
        let describe = |mde: Option<f64>| {
            mde.map_or_else(|| "unavailable".to_owned(), |mde| format!("{mde:.3}"))
        };
        let needed = self.cases_needed_at_target.map_or_else(
            || "no finite case count at the current threshold and repetition mix".to_owned(),
            |n| {
                format!(
                    "approximately {n} cases at the same repetition mix are needed for 80% power"
                )
            },
        );
        self.reason = format!(
            "target {target:.3}, projected 80% MDE {} (95% interval {} to {}) with {} cases, {} pairs, and {:.2} effective repetitions; {needed} at the point estimate",
            describe(self.projected_mde),
            describe(self.lower_mde),
            describe(self.upper_mde),
            self.case_count,
            self.paired_trials,
            self.effective_repetitions
        );
    }

    pub(crate) fn stop_reason(&self, stage: &str) -> Option<String> {
        (self.decision == AdmissionDecision::Stop).then(|| format!("{stage}: {}", self.reason))
    }

    pub(crate) fn warning(&self, stage: &str) -> Option<String> {
        (self.decision == AdmissionDecision::Warn).then(|| format!("{stage}: {}", self.reason))
    }
}

impl Plan {
    pub(crate) fn new(
        development: &Descriptor,
        audits: &[Descriptor],
        calibration: &Calibration,
    ) -> Self {
        let max_repetitions = setting(
            "ACCLIMATE_LEARNING_MAX_REPETITIONS",
            DEFAULT_MAX_REPETITIONS,
            5,
        );
        let pair_budget = setting("ACCLIMATE_LEARNING_PAIR_BUDGET", DEFAULT_PAIR_BUDGET, 1000).max(
            std::iter::once(development)
                .chain(audits)
                .map(|d| d.expected_cases.len() as u32)
                .max()
                .unwrap_or(1),
        );
        Self::with_budget(
            development,
            audits,
            calibration,
            max_repetitions,
            pair_budget,
        )
    }

    pub(super) fn with_budget(
        development: &Descriptor,
        audits: &[Descriptor],
        calibration: &Calibration,
        max_repetitions: u32,
        pair_budget: u32,
    ) -> Self {
        let flaky_case_count = calibration
            .case_variability
            .values()
            .filter(|&&v| v > 0.0)
            .count();
        let mut counts = inventory(development);
        if !fixed(development) {
            let repeats = uniform_count(development, counts.len(), max_repetitions, pair_budget);
            counts.values_mut().for_each(|count| *count = repeats);
        }
        let mut plan = Self {
            development_repetitions: counts,
            audit_repetitions: Vec::new(),
            uniform_audit_from: None,
            flaky_case_count,
            pair_budget,
            trial_budget: 2 * pair_budget,
            max_repetitions,
        };
        plan.extend_audits(audits);
        plan
    }

    pub(super) fn extend_audits(&mut self, audits: &[Descriptor]) {
        self.uniform_audit_from
            .get_or_insert(self.audit_repetitions.len());
        self.audit_repetitions.extend(audits.iter().map(|audit| {
            if fixed(audit) {
                return 1;
            }
            uniform_count(
                audit,
                inventory(audit).len(),
                self.max_repetitions,
                self.pair_budget,
            )
        }));
    }

    fn counts(&self, descriptor: &Descriptor, audit: Option<usize>) -> Counts {
        let mut counts = inventory(descriptor);
        if !fixed(descriptor) {
            if let Some(index) = audit {
                let repeats = self.audit_repetitions.get(index).copied().unwrap_or(1);
                let uniform = self.uniform_audit_from.is_some_and(|first| index >= first);
                for count in counts.values_mut() {
                    *count = if uniform {
                        repeats
                    } else {
                        (*count).max(repeats)
                    };
                }
            } else {
                counts = self.development_repetitions.clone();
            }
        }
        counts
    }

    pub(crate) fn expected_cases(
        &self,
        descriptor: &Descriptor,
        audit: Option<usize>,
    ) -> Vec<CaseKey> {
        if fixed(descriptor) {
            descriptor.expected_cases.clone()
        } else {
            keys(&self.counts(descriptor, audit))
        }
    }

    pub(crate) fn project(
        &self,
        descriptor: &Descriptor,
        audit: Option<usize>,
        noise: (&Calibration, usize),
        threshold: f64,
        z: f64,
        target: Option<f64>,
    ) -> Projection {
        let (calibration, guard_observations) = noise;
        let counts = self.counts(descriptor, audit);
        let n = counts.len();
        let effective = harmonic_repetitions(counts.values().map(|&n| n as usize));
        let mean_variance = calibration.case_variability.values().sum::<f64>()
            / calibration.case_variability.len().max(1) as f64;
        let variance = counts
            .iter()
            .map(|(id, &r)| {
                let v = if audit.is_some() {
                    mean_variance
                } else {
                    calibration.case_variability.get(id).copied().unwrap_or(1.0)
                };
                v / f64::from(r)
            })
            .sum::<f64>()
            / n as f64;
        let floor = calibration.paired_standard_deviation.powi(2)
            * calibration.effective_repetitions
            / effective;
        let sd = variance.max(floor).sqrt();
        let se = sd / (n as f64).sqrt();
        let effect = target.unwrap_or(0.05);
        let critical = critical_value(n, z);
        let detect = |n| critical_value(n, z) + critical_value(n, 0.8416212335729143);
        let cases_needed_at_target = target.filter(|&effect| effect > threshold).map(|effect| {
            let gap = effect - threshold;
            // Find the first case count meeting the same projection, holding per-case noise fixed.
            let mut low = 2;
            let mut high = (detect(2) * sd / gap).powi(2).ceil().max(2.0) as usize;
            while low < high {
                let mid = low + (high - low) / 2;
                if detect(mid) * sd / (mid as f64).sqrt() <= gap {
                    high = mid;
                } else {
                    low = mid + 1;
                }
            }
            low
        });
        let bounds = (n > 1)
            .then(|| super::statistics::sd_interval(sd, guard_observations))
            .flatten();
        let mde = |sd| threshold + detect(n) * sd / (n as f64).sqrt();
        let mut projection = Projection {
            case_count: n,
            effective_repetitions: effective,
            projected_mde: (n > 1).then(|| mde(sd)),
            lower_mde: bounds.map(|(lower, _)| mde(lower)),
            upper_mde: bounds.map(|(_, upper)| mde(upper)),
            decision: AdmissionDecision::Admit,
            reason: String::new(),
            power_at_effect: (n > 1)
                .then(|| 0.5 * libm::erfc((critical - (effect - threshold) / se) / 2.0_f64.sqrt())),
            effect,
            paired_trials: counts.values().sum(),
            cases_needed_at_target,
        };
        projection.assess(target);
        projection
    }
}
