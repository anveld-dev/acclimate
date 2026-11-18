use super::{
    Descriptor,
    statistics::{Calibration, critical_value, harmonic_repetitions},
};
use crate::CaseKey;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

// The greatest marginal reduction minimizes the sum of per-case variances.
fn allocate(
    mut counts: Counts,
    variance: impl Fn(&String) -> f64,
    fill: bool,
    maximum: u32,
    budget: u32,
) -> Counts {
    for _ in counts.values().sum::<u32>()..budget {
        let next = counts
            .iter()
            .filter(|(_, r)| **r < maximum)
            .map(|(id, &r)| (id, variance(id) / f64::from(r * (r + 1)), r))
            .filter(|(_, gain, _)| *gain > 0.0 || fill)
            .max_by(|a, b| {
                a.1.total_cmp(&b.1)
                    .then_with(|| b.2.cmp(&a.2))
                    .then_with(|| b.0.cmp(a.0))
            });
        let Some((id, _, _)) = next else {
            break;
        };
        let id = id.clone();
        *counts.get_mut(&id).unwrap() += 1;
    }
    counts
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    development_repetitions: Counts,
    audit_repetitions: Vec<u32>,
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
    power_at_effect: Option<f64>,
    effect: f64,
    paired_trials: u32,
    cases_needed_at_target: Option<usize>,
}

impl Projection {
    pub(crate) fn stop_reason(&self, target: Option<f64>, stage: &str) -> Option<String> {
        let target = target?;
        if self.projected_mde.is_some_and(|mde| mde <= target) {
            return None;
        }
        let needed = self.cases_needed_at_target.map_or_else(
            || "the target must exceed the gate threshold".to_owned(),
            |n| {
                format!(
                    "approximately {n} cases at the same repetition mix are needed for 80% power"
                )
            },
        );
        let mde = self
            .projected_mde
            .map_or_else(|| "unavailable".to_owned(), |mde| format!("{mde:.3}"));
        Some(format!(
            "{stage} target {target:.3} exceeds achievable power within budget: projected 80% MDE {mde} with {} cases, {} pairs, and {:.2} effective repetitions; {needed}",
            self.case_count, self.paired_trials, self.effective_repetitions
        ))
    }
}

impl Plan {
    pub(crate) fn new(
        development: &Descriptor,
        audits: &[Descriptor],
        calibration: &Calibration,
        target: Option<f64>,
    ) -> Self {
        let max_repetitions = setting("ACCLIMATE_LEARNING_MAX_REPETITIONS", 3, 5);
        let pair_budget = setting("ACCLIMATE_LEARNING_PAIR_BUDGET", 1000, 1000).max(
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
            target.is_some(),
            max_repetitions,
            pair_budget,
        )
    }

    pub(super) fn with_budget(
        development: &Descriptor,
        audits: &[Descriptor],
        calibration: &Calibration,
        use_full_budget: bool,
        max_repetitions: u32,
        pair_budget: u32,
    ) -> Self {
        let flaky_case_count = calibration
            .case_variability
            .values()
            .filter(|&&v| v > 0.0)
            .count();
        let variance = |id: &String| calibration.case_variability.get(id).copied().unwrap_or(1.0);
        let baseline = inventory(development);
        let mut counts = baseline.clone();
        if !fixed(development) {
            let development_budget = pair_budget.min(report_pair_limit(development));
            counts = allocate(
                baseline.clone(),
                variance,
                use_full_budget,
                max_repetitions,
                development_budget,
            );
            if use_full_budget {
                let balanced =
                    allocate(baseline, |_| 1.0, true, max_repetitions, development_budget);
                let noise = |counts: &Counts| {
                    let empirical = counts
                        .iter()
                        .map(|(id, &r)| variance(id) / f64::from(r))
                        .sum::<f64>()
                        / counts.len() as f64;
                    let floor = calibration.paired_standard_deviation.powi(2)
                        * calibration.effective_repetitions
                        / harmonic_repetitions(counts.values().map(|&r| r as usize));
                    empirical.max(floor)
                };
                if noise(&balanced) < noise(&counts) {
                    counts = balanced;
                }
            }
        }
        let mut plan = Self {
            development_repetitions: counts,
            audit_repetitions: Vec::new(),
            flaky_case_count,
            pair_budget,
            trial_budget: 2 * pair_budget,
            max_repetitions,
        };
        plan.extend_audits(audits, use_full_budget);
        plan
    }

    pub(super) fn extend_audits(&mut self, audits: &[Descriptor], use_full_budget: bool) {
        let repeat_audit = self.flaky_case_count * 4 >= self.development_repetitions.len();
        self.audit_repetitions.extend(audits.iter().map(|audit| {
            if fixed(audit) || !(repeat_audit || use_full_budget) {
                return 1;
            }
            let counts = inventory(audit);
            let budget = self.pair_budget.min(report_pair_limit(audit));
            (2..=self.max_repetitions)
                .rev()
                .find(|&r| counts.values().map(|&n| n.max(r)).sum::<u32>() <= budget)
                .unwrap_or(1)
        }));
    }

    fn counts(&self, descriptor: &Descriptor, audit: Option<usize>) -> Counts {
        let mut counts = inventory(descriptor);
        if !fixed(descriptor) {
            if let Some(index) = audit {
                let repeats = self.audit_repetitions.get(index).copied().unwrap_or(1);
                for count in counts.values_mut() {
                    *count = (*count).max(repeats);
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
        calibration: &Calibration,
        threshold: f64,
        z: f64,
        target: Option<f64>,
    ) -> Projection {
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
        Projection {
            case_count: n,
            effective_repetitions: effective,
            projected_mde: (n > 1).then(|| threshold + detect(n) * se),
            power_at_effect: (n > 1)
                .then(|| 0.5 * libm::erfc((critical - (effect - threshold) / se) / 2.0_f64.sqrt())),
            effect,
            paired_trials: counts.values().sum(),
            cases_needed_at_target,
        }
    }
}
