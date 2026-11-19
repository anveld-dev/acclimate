use super::statistics::{critical_value, normal_quantile, sample_sd};
use super::{Descriptor, bounded, invalid};
use crate::{ApiResult, ComparisonRequest};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// Stored and submitted connected policies. Omitted inference, per-case scope and reward scale
/// settings are filled with the connected defaults so every stored policy states them explicitly.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, from = "PoliciesWire")]
pub(crate) struct Policies {
    pub development: SelectionPolicy,
    pub audit: SelectionPolicy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PoliciesWire {
    development: SelectionPolicy,
    audit: SelectionPolicy,
}

impl From<PoliciesWire> for Policies {
    fn from(wire: PoliciesWire) -> Self {
        Self {
            development: wire.development.with_defaults(0.9),
            audit: wire.audit.with_defaults(0.95),
        }
    }
}

/// The statistical settings a connected policy declares. Only `paired-t` is supported here.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Inference {
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_cases: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_repetitions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sd_floor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum_missing_percent: Option<usize>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum PerCaseChecks {
    AllCases,
    ProtectedCases,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Scale {
    minimum: f64,
    maximum: f64,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionPolicy {
    schema_version: u8,
    id: String,
    revision: String,
    metric: Metric,
    aggregation: String,
    minimum_mean_improvement: f64,
    maximum_case_regression: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    non_inferiority_margin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step_margin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audit_mode: Option<AuditMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_effect: Option<f64>,
    required_cases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum_candidate_task_failures: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost: Option<Cost>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    protected_case_thresholds: BTreeMap<String, f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_cost_savings_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_repetitions_per_case: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inference: Option<Inference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    per_case_checks: Option<PerCaseChecks>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Metric {
    name: String,
    unit: String,
    direction: Direction,
    #[serde(skip_serializing_if = "Option::is_none")]
    scale: Option<Scale>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Higher,
    Lower,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cost {
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum_candidate_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximum_increase_usd: Option<f64>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum AuditMode {
    NonInferiority,
    Superiority,
}

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    Development { replay_passed: bool },
    Cumulative,
    Audit,
}

impl Default for Policies {
    fn default() -> Self {
        let audit = SelectionPolicy {
            schema_version: 3,
            id: "connected-audit".into(),
            revision: "1".into(),
            metric: Metric {
                name: "reward".into(),
                unit: "reward".into(),
                direction: Direction::Higher,
                scale: None,
            },
            aggregation: "equal-case-means".into(),
            minimum_mean_improvement: 0.0,
            maximum_case_regression: 0.0,
            non_inferiority_margin: None,
            step_margin: None,
            audit_mode: None,
            target_effect: None,
            candidate_threshold: None,
            required_cases: vec![],
            maximum_candidate_task_failures: Some(0),
            cost: None,
            protected_case_thresholds: BTreeMap::new(),
            minimum_cost_savings_usd: None,
            minimum_repetitions_per_case: None,
            inference: None,
            per_case_checks: None,
        };
        let development = SelectionPolicy {
            id: "connected-development".into(),
            minimum_mean_improvement: 0.0,
            non_inferiority_margin: None,
            ..audit.clone()
        };
        Self {
            development: development.with_defaults(0.9),
            audit: audit.with_defaults(0.95),
        }
    }
}

impl SelectionPolicy {
    pub(super) fn validate(
        &self,
        descriptors: &[&Descriptor],
        prior: Option<&Self>,
    ) -> ApiResult<()> {
        let cost_ok = self.cost.as_ref().is_none_or(|c| {
            (c.maximum_candidate_usd.is_some() || c.maximum_increase_usd.is_some())
                && [c.maximum_candidate_usd, c.maximum_increase_usd]
                    .into_iter()
                    .flatten()
                    .all(|n| n.is_finite() && n >= 0.0)
        });
        let inference_ok = self.inference.as_ref().is_none_or(|i| {
            i.method == "paired-t"
                && i.confidence.is_none_or(|c| normal_quantile(c).is_some())
                && i.min_cases.is_none_or(|n| (2..=1000).contains(&n))
                && i.min_repetitions.is_none_or(|n| (1..=1000).contains(&n))
                && i.sd_floor.is_none_or(|v| v.is_finite() && v >= 0.0)
                && i.maximum_missing_percent.is_none_or(|n| n <= 50)
        });
        // Connected rewards are always on the [0,1] scale.
        let scale_ok = self
            .metric
            .scale
            .is_none_or(|s| s.minimum == 0.0 && s.maximum == 1.0);
        if !inference_ok
            || !scale_ok
            || self
                .minimum_repetitions_per_case
                .is_some_and(|n| !(1..=1000).contains(&n))
            || !matches!(self.schema_version, 1..=3)
            || (self.schema_version < 3
                && (self.step_margin.is_some()
                    || self.audit_mode.is_some()
                    || self.target_effect.is_some()))
            || [self.step_margin, self.target_effect]
                .into_iter()
                .flatten()
                .any(|v| !(0.0..=1.0).contains(&v))
            || self
                .non_inferiority_margin
                .is_some_and(|v| self.schema_version == 1 || !v.is_finite() || v < 0.0)
            || !bounded(&self.id, 128)
            || !bounded(&self.revision, 1024)
            || !bounded(&self.metric.name, 128)
            || !bounded(&self.metric.unit, 128)
            || self.aggregation != "equal-case-means"
            || !self.minimum_mean_improvement.is_finite()
            || !self.maximum_case_regression.is_finite()
            || self.maximum_case_regression < 0.0
            || self.candidate_threshold.is_some_and(|v| !v.is_finite())
            || !cost_ok
            || self
                .minimum_cost_savings_usd
                .is_some_and(|v| !v.is_finite() || v < 0.0)
            || self.required_cases.len() > 1000
            || self.protected_case_thresholds.len() > 1000
            || self.required_cases.iter().collect::<HashSet<_>>().len() != self.required_cases.len()
            || self
                .maximum_candidate_task_failures
                .is_some_and(|n| n > (1u64 << 53) - 1)
        {
            return Err(invalid("Invalid connected selection policy"));
        }
        // Required cases are universal for the stage. Named protections can target an
        // individual held-out cohort because audit case IDs are disjoint across cohorts.
        let present = |d: &Descriptor, id: &str| d.expected_cases.iter().any(|k| k.case_id == id);
        if self
            .required_cases
            .iter()
            .any(|id| !bounded(id, 1024) || descriptors.iter().any(|d| !present(d, id)))
            || self
                .protected_case_thresholds
                .iter()
                .any(|(id, threshold)| {
                    !bounded(id, 1024)
                        || !threshold.is_finite()
                        || (!descriptors.iter().any(|d| present(d, id))
                            && !prior.is_some_and(|p| p.protected_case_thresholds.contains_key(id)))
                })
        {
            return Err(invalid(
                "Selection policy names cases outside the evaluation inventory",
            ));
        }
        if let Some(minimum) = self.minimum_repetitions_per_case {
            for descriptor in descriptors {
                let mut counts = BTreeMap::new();
                for key in &descriptor.expected_cases {
                    *counts.entry(&key.case_id).or_insert(0usize) += 1;
                }
                if counts.values().any(|n| *n < minimum) {
                    return Err(invalid(
                        "Selection policy requires more repetitions per case",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Fill omitted connected settings so stored policies state them explicitly.
    fn with_defaults(mut self, confidence: f64) -> Self {
        let inference = self.inference.get_or_insert(Inference {
            method: "paired-t".into(),
            confidence: None,
            min_cases: None,
            min_repetitions: None,
            sd_floor: None,
            maximum_missing_percent: None,
        });
        inference.confidence.get_or_insert(confidence);
        inference.min_cases.get_or_insert(2);
        inference.min_repetitions.get_or_insert(1);
        inference.sd_floor.get_or_insert(0.0);
        inference
            .maximum_missing_percent
            .get_or_insert(super::statistics::MAX_MISSING_PERCENT);
        self.per_case_checks
            .get_or_insert(PerCaseChecks::ProtectedCases);
        self.metric.scale.get_or_insert(Scale {
            minimum: 0.0,
            maximum: 1.0,
        });
        self
    }

    /// Resolved (confidence, minimum cases, minimum repetitions, SD floor, missing percent).
    fn settings(&self) -> (f64, usize, usize, f64, usize) {
        let i = self.inference.as_ref();
        (
            i.and_then(|i| i.confidence).unwrap_or(0.95),
            i.and_then(|i| i.min_cases).unwrap_or(2),
            i.and_then(|i| i.min_repetitions).unwrap_or(1),
            i.and_then(|i| i.sd_floor).unwrap_or(0.0),
            i.and_then(|i| i.maximum_missing_percent)
                .unwrap_or(super::statistics::MAX_MISSING_PERCENT),
        )
    }

    /// The normal quantile for the policy's declared one-sided confidence.
    pub(crate) fn z(&self) -> f64 {
        normal_quantile(self.settings().0).unwrap_or(super::statistics::AUDIT_Z)
    }

    fn checked(&self, case: &str) -> bool {
        self.per_case_checks == Some(PerCaseChecks::AllCases) || self.protected(case)
    }

    fn protected(&self, case: &str) -> bool {
        self.protected_case_thresholds.contains_key(case)
            || self.required_cases.iter().any(|id| id == case)
    }

    pub(crate) fn higher_is_better(&self) -> bool {
        self.metric.direction == Direction::Higher
    }

    pub(crate) fn audit_margin(&self) -> f64 {
        self.non_inferiority_margin
            .unwrap_or(if self.schema_version == 3 { 0.03 } else { 0.0 })
    }

    pub(crate) fn modern(&self) -> bool {
        self.schema_version == 3
    }

    pub(crate) fn threshold(&self, stage: Stage) -> f64 {
        match stage {
            Stage::Audit if self.audit_mode != Some(AuditMode::Superiority) => -self.audit_margin(),
            Stage::Development { .. } if self.modern() => -self.step_margin.unwrap_or(0.03),
            _ => self.minimum_mean_improvement,
        }
    }

    #[cfg(test)]
    pub(crate) fn check(
        &self,
        comparison: &ComparisonRequest,
        audit: bool,
    ) -> Result<(), &'static str> {
        // Connected checks always carry an A/A calibration floor; a small one keeps tied
        // fixtures informative instead of insufficient.
        self.check_calibrated(comparison, audit, 0.005)
    }

    #[cfg(test)]
    pub(crate) fn check_calibrated(
        &self,
        comparison: &ComparisonRequest,
        audit: bool,
        calibrated_sd: f64,
    ) -> Result<(), &'static str> {
        self.check_with_summary(
            comparison,
            if audit {
                Stage::Audit
            } else {
                Stage::Development {
                    replay_passed: false,
                }
            },
            calibrated_sd,
            &mut None,
        )
    }

    pub(crate) fn check_with_summary(
        &self,
        comparison: &ComparisonRequest,
        stage: Stage,
        calibrated_sd: f64,
        summary: &mut Option<(f64, f64)>,
    ) -> Result<(), &'static str> {
        let sign = if self.metric.direction == Direction::Higher {
            1.0
        } else {
            -1.0
        };
        let (_, min_cases, min_repetitions, sd_floor, missing_percent) = self.settings();
        // Evaluate in the same stable UTF-8 case/repetition order as the SDK.
        let mut pairs: Vec<_> = comparison.results.iter().collect();
        pairs.sort_by_key(|p| (&p.key.case_id, p.key.repetition));
        let mut means = BTreeMap::new();
        let (mut parent_cost, mut candidate_cost) = (Some(0.0), Some(0.0));
        let mut failed = 0;
        let mut observed = pairs
            .iter()
            .flat_map(|pair| [&pair.parent, &pair.candidate])
            .filter_map(super::statistics::scored_reward);
        let first = observed
            .next()
            .ok_or("Selection policy lacks scored evidence")?;
        let (minimum, maximum) = observed.fold((first, first), |(lo, hi), reward| {
            (lo.min(reward), hi.max(reward))
        });
        if minimum < 0.0 || maximum > 1.0 {
            return Err("Connected rewards must be in [0,1]");
        }
        if [true, false].into_iter().any(|parent| {
            pairs
                .iter()
                .filter(|pair| {
                    super::statistics::scored_reward(if parent {
                        &pair.parent
                    } else {
                        &pair.candidate
                    })
                    .is_none()
                })
                .count()
                * 100
                > pairs.len() * missing_percent
        }) {
            return Err("Evidence is incomplete");
        }
        let (worst, best) = if self.higher_is_better() {
            (minimum, maximum)
        } else {
            (maximum, minimum)
        };
        for pair in pairs {
            let p = super::statistics::scored_reward(&pair.parent).unwrap_or(best);
            let c = super::statistics::scored_reward(&pair.candidate).unwrap_or(worst);
            if self.checked(&pair.key.case_id)
                && (pair.candidate.execution_status == "task_failed"
                    || super::statistics::scored_reward(&pair.candidate).is_none())
            {
                failed += 1;
            }
            if let Some(threshold) = self.protected_case_thresholds.get(&pair.key.case_id)
                && (pair.candidate.execution_status != "completed"
                    || super::statistics::scored_reward(&pair.candidate).is_none()
                    || sign * c < sign * threshold)
            {
                return Err("Protected case threshold failed");
            }
            let (parent, candidate, count) =
                means.entry(&pair.key.case_id).or_insert((0.0, 0.0, 0u32));
            *parent += p;
            *candidate += c;
            *count += 1;
            parent_cost = parent_cost
                .zip(pair.parent.usage.as_ref().and_then(|u| u.cost_usd))
                .map(|(s, n)| s + n);
            candidate_cost = candidate_cost
                .zip(pair.candidate.usage.as_ref().and_then(|u| u.cost_usd))
                .map(|(s, n)| s + n);
        }
        if means.is_empty() || self.required_cases.iter().any(|k| !means.contains_key(k)) {
            return Err("Selection policy lacks required case evidence");
        }
        let case_count = means.len() as f64;
        let (mut gains, mut candidates) = (Vec::new(), 0.0);
        if means.len() < min_cases {
            return Err("Evidence has too few cases for the declared inference");
        }
        for (id, (parent, candidate, count)) in means {
            if self
                .minimum_repetitions_per_case
                .is_some_and(|n| (count as usize) < n)
                || (count as usize) < min_repetitions
            {
                return Err("Case inventory has too few paired repetitions");
            }
            let candidate_mean = candidate / f64::from(count);
            let gain = sign * (candidate_mean - parent / f64::from(count));
            if !gain.is_finite() || (self.checked(id) && -gain > self.maximum_case_regression) {
                return Err("Maximum case regression exceeded");
            }
            gains.push(gain);
            candidates += candidate_mean;
        }
        if !candidates.is_finite() {
            return Err("Nonfinite selection arithmetic");
        }
        let threshold = self.threshold(stage);
        let estimate = gains.iter().sum::<f64>() / case_count;
        let used = sample_sd(&gains).max(sd_floor).max(calibrated_sd);
        if used == 0.0 {
            return Err("Zero observed variance without an SD floor is insufficient evidence");
        }
        let bound = estimate - critical_value(gains.len(), self.z()) * used / case_count.sqrt();
        if bound.is_finite() {
            *summary = Some((estimate, bound));
        }
        if !bound.is_finite() || bound <= threshold {
            return Err(match (stage, self.modern()) {
                (Stage::Audit, _) if self.audit_mode != Some(AuditMode::Superiority) => {
                    "Audit non-inferiority bound was not reached"
                }
                (Stage::Development { .. }, true) => "Step non-inferiority bound was not reached",
                _ => "Minimum mean improvement was not reached",
            });
        }
        if self
            .candidate_threshold
            .is_some_and(|t| sign * candidates / case_count < sign * t)
        {
            return Err("Candidate reward threshold was not reached");
        }
        if self
            .maximum_candidate_task_failures
            .is_some_and(|limit| failed > limit)
        {
            return Err("Maximum candidate task failures exceeded");
        }
        // A step needs a benefit beyond non-inferiority: a positive point gain that reaches
        // minimumMeanImprovement, an attested replay, or a cost saving.
        if let Stage::Development { replay_passed } = stage
            && self.modern()
            && !(estimate > 0.0 && estimate >= self.minimum_mean_improvement)
            && !replay_passed
        {
            let savings = parent_cost.zip(candidate_cost).map(|(p, c)| p - c);
            if !(self.cost.is_some()
                && savings.is_some_and(|amount| {
                    amount.is_finite()
                        && amount > 0.0
                        && amount >= self.minimum_cost_savings_usd.unwrap_or(0.0)
                }))
            {
                return Err("Development step lacks evidence of benefit");
            }
        }
        let minimum_savings = if self.modern() {
            None
        } else {
            self.minimum_cost_savings_usd
        };
        if self.cost.is_some() || minimum_savings.is_some() {
            let candidate_cost = candidate_cost
                .filter(|v| v.is_finite())
                .ok_or("Candidate cost is unknown")?;
            if self
                .cost
                .as_ref()
                .and_then(|c| c.maximum_candidate_usd)
                .is_some_and(|cap| candidate_cost > cap)
            {
                return Err("Maximum candidate cost exceeded");
            }
            let maximum_increase = self.cost.as_ref().and_then(|c| c.maximum_increase_usd);
            if maximum_increase.is_some() || minimum_savings.is_some() {
                let parent_cost = parent_cost
                    .filter(|v| v.is_finite())
                    .ok_or("Parent cost is unknown")?;
                let increase = candidate_cost - parent_cost;
                if maximum_increase.is_some_and(|cap| increase > cap)
                    || minimum_savings.is_some_and(|floor| -increase < floor)
                {
                    return Err("Candidate cost change exceeds policy");
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CaseKey, CasePair, Outcome, Usage};

    #[test]
    fn shared_selection_policy_conformance() {
        #[derive(Deserialize)]
        struct Fixture {
            descriptor: Descriptor,
            cases: Vec<Case>,
        }

        #[derive(Deserialize)]
        struct Case {
            name: String,
            valid: bool,
            policy: Box<serde_json::value::RawValue>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../contracts/fixtures/connected-selection-policy.json"
        ))
        .unwrap();
        for case in fixture.cases {
            let accepted = serde_json::from_str::<SelectionPolicy>(case.policy.get())
                .is_ok_and(|policy| policy.validate(&[&fixture.descriptor], None).is_ok());
            assert_eq!(accepted, case.valid, "{}", case.name);
        }
    }

    fn comparison(values: &[(&str, f64, f64)]) -> ComparisonRequest {
        let outcome = |reward| Outcome {
            execution_status: "completed".into(),
            grading_status: "scored".into(),
            reward: Some(reward),
            output_ref: None,
            error: None,
            usage: Some(Usage {
                input_tokens: None,
                output_tokens: None,
                cost_usd: Some(1.0),
            }),
        };
        let mut count = BTreeMap::new();
        let results: Vec<_> = values
            .iter()
            .map(|(id, p, c)| {
                let repetition = count.entry(id).or_insert(0);
                let key = CaseKey {
                    case_id: (*id).to_owned(),
                    repetition: *repetition,
                };
                *repetition += 1;
                CasePair {
                    key,
                    parent: outcome(*p),
                    candidate: outcome(*c),
                }
            })
            .collect();
        ComparisonRequest {
            parent_source_comparison_id: None,
            evaluation: None,
            parent_version_id: String::new(),
            candidate_version_id: String::new(),
            parent_digest: String::new(),
            candidate_digest: String::new(),
            dataset_revision: "test".into(),
            grader_revision: "test".into(),
            runtime: Default::default(),
            expected_cases: results.iter().map(|v| v.key.clone()).collect(),
            results,
        }
    }

    #[test]
    fn shared_confidence_decisions() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Decision {
            name: String,
            stage: String,
            schema_version: Option<u8>,
            audit_mode: Option<AuditMode>,
            #[serde(default)]
            replay_passed: bool,
            #[serde(default)]
            missing_parent: Vec<usize>,
            #[serde(default)]
            missing_candidate: Vec<usize>,
            calibrated_standard_deviation: f64,
            calibration_effective_repetitions: Option<f64>,
            evaluation_repetitions: Option<usize>,
            non_inferiority_margin: Option<f64>,
            minimum_mean_improvement: Option<f64>,
            gains: Vec<f64>,
            #[serde(default)]
            reward_offset: f64,
            pass: bool,
        }
        let decisions: Vec<Decision> = serde_json::from_str(include_str!(
            "../../contracts/fixtures/connected-confidence-decisions.json"
        ))
        .unwrap();
        for decision in decisions {
            let audit = decision.stage == "audit";
            let policies = Policies::default();
            let mut policy = if audit {
                policies.audit
            } else {
                policies.development
            };
            policy.schema_version = decision.schema_version.unwrap_or(2);
            policy.audit_mode = decision.audit_mode;
            policy.non_inferiority_margin = decision.non_inferiority_margin;
            policy.minimum_mean_improvement = decision.minimum_mean_improvement.unwrap_or(0.0);
            let ids: Vec<_> = (0..decision.gains.len())
                .map(|index| index.to_string())
                .collect();
            let repetitions = decision.evaluation_repetitions.unwrap_or(1);
            let offset = decision.reward_offset;
            let cases: Vec<_> = ids
                .iter()
                .zip(decision.gains)
                .flat_map(|(id, gain)| {
                    std::iter::repeat_n(
                        (
                            id.as_str(),
                            offset + (-gain).max(0.0),
                            offset + gain.max(0.0),
                        ),
                        repetitions,
                    )
                })
                .collect();
            let mut evidence = comparison(&cases);
            for index in decision.missing_parent {
                evidence.results[index].candidate.reward = Some(1.0);
                evidence.results[index].parent.reward = None;
            }
            for index in decision.missing_candidate {
                evidence.results[index].candidate.reward = None;
            }
            let stage = match decision.stage.as_str() {
                "audit" => Stage::Audit,
                "cumulative" => Stage::Cumulative,
                _ => Stage::Development {
                    replay_passed: decision.replay_passed,
                },
            };
            assert_eq!(
                policy
                    .check_with_summary(
                        &evidence,
                        stage,
                        decision.calibrated_standard_deviation
                            * decision
                                .calibration_effective_repetitions
                                .map_or(1.0, |r| (r / repetitions as f64).sqrt()),
                        &mut None,
                    )
                    .is_ok(),
                decision.pass,
                "{}",
                decision.name
            );
        }
    }

    #[test]
    fn default_stages_require_positive_evidence() {
        let policies = Policies::default();
        let tied = comparison(&[("ordinary", 1., 1.), ("other", 1., 1.)]);
        assert!(policies.development.check(&tied, false).is_err());
        assert!(policies.audit.check(&tied, true).is_ok());
        let regressed = comparison(&[("ordinary", 0., 1.), ("invariant", 1., 0.)]);
        assert!(policies.audit.check(&regressed, true).is_err());
        // Without any SD floor, identical case differences are insufficient evidence.
        assert!(policies.audit.check_calibrated(&tied, true, 0.0).is_err());
    }

    #[test]
    fn stored_policies_state_their_inference_explicitly() {
        let stored: Policies = serde_json::from_value(serde_json::json!({
            "development": {"schemaVersion": 1, "id": "connected-development", "revision": "1",
                "metric": {"name": "reward", "unit": "reward", "direction": "higher"},
                "aggregation": "equal-case-means", "minimumMeanImprovement": 0,
                "maximumCaseRegression": 0, "requiredCases": []},
            "audit": {"schemaVersion": 1, "id": "connected-audit", "revision": "1",
                "metric": {"name": "reward", "unit": "reward", "direction": "higher"},
                "aggregation": "equal-case-means", "minimumMeanImprovement": 0,
                "maximumCaseRegression": 0, "requiredCases": [],
                "inference": {"method": "paired-t", "confidence": 0.975}}
        }))
        .unwrap();
        let value = serde_json::to_value(&stored).unwrap();
        assert_eq!(
            value["development"]["inference"],
            serde_json::json!({"method": "paired-t", "confidence": 0.9, "minCases": 2,
                "minRepetitions": 1, "sdFloor": 0.0, "maximumMissingPercent": 15})
        );
        assert_eq!(value["audit"]["inference"]["confidence"], 0.975);
        assert_eq!(value["audit"]["perCaseChecks"], "protected-cases");
        assert_eq!(
            value["audit"]["metric"]["scale"],
            serde_json::json!({"minimum": 0.0, "maximum": 1.0})
        );
        assert!(stored.audit.z() > stored.development.z());
        let mut invalid = stored.audit.clone();
        invalid.inference.as_mut().unwrap().confidence = Some(0.93);
        assert!(invalid.validate(&[], None).is_err());
        invalid.inference.as_mut().unwrap().confidence = Some(0.95);
        invalid.metric.scale = Some(Scale {
            minimum: 0.0,
            maximum: 10.0,
        });
        assert!(invalid.validate(&[], None).is_err());
    }

    #[test]
    fn repetitions_average_per_case_and_protected_threshold_applies_to_each_repeat() {
        let mut policy = Policies::default().development;
        let measurements = comparison(&[("a", 0., 0.), ("a", 0., 1.), ("b", 0., 1.)]);
        assert!(policy.check(&measurements, false).is_ok());
        policy.minimum_repetitions_per_case = Some(2);
        assert!(policy.check(&measurements, false).is_err());
        policy.minimum_repetitions_per_case = None;
        policy.protected_case_thresholds.insert("a".into(), 1.);
        assert!(policy.check(&measurements, false).is_err());
    }

    #[test]
    fn explicit_missing_arms_keep_the_inventory_and_denominator() {
        let ids: Vec<_> = (0..10).map(|index| index.to_string()).collect();
        let cases: Vec<_> = ids.iter().map(|id| (id.as_str(), 0.0, 1.0)).collect();
        let mut evidence = comparison(&cases);
        evidence.runtime.insert("app".into(), "test".into());
        evidence.evaluation = Some(crate::EvaluationBinding {
            request_id: "request".into(),
            attempt_id: "attempt".into(),
        });
        for pair in evidence.results.iter_mut().take(1) {
            pair.candidate.reward = None;
            pair.candidate.grading_status = "missing".into();
        }
        assert_eq!(crate::improvement::validate_comparison(&evidence), Ok(true));
        let mut policy = Policies::default().development;
        policy.schema_version = 2;
        policy.minimum_mean_improvement = 0.8;
        assert!(policy.check(&evidence, false).is_err());
        evidence.results[3].candidate.reward = None;
        evidence.results[3].candidate.grading_status = "missing".into();
        assert_eq!(
            crate::improvement::validate_comparison(&evidence),
            Ok(false)
        );
        evidence.results.remove(3);
        assert_eq!(
            crate::improvement::validate_comparison(&evidence),
            Ok(false)
        );
    }

    #[test]
    fn cost_optimization_requires_observed_savings() {
        let mut policy = Policies::default().audit;
        policy.schema_version = 2;
        policy.minimum_cost_savings_usd = Some(0.5);
        policy.non_inferiority_margin = Some(0.1);
        let mut results = comparison(&[("a", 1., 1.), ("b", 1., 1.)]);
        assert!(policy.check(&results, true).is_err());
        results.results[0]
            .candidate
            .usage
            .as_mut()
            .unwrap()
            .cost_usd = Some(0.5);
        assert!(policy.check(&results, true).is_ok());
        results.results[0].parent.usage = None;
        assert!(policy.check(&results, true).is_err());
    }

    #[test]
    fn v3_cost_savings_prove_benefit_without_a_reward_gain() {
        let mut policy = Policies::default().development;
        policy.cost = Some(Cost {
            maximum_candidate_usd: Some(2.0),
            maximum_increase_usd: None,
        });
        policy.minimum_cost_savings_usd = Some(0.5);
        let mut evidence = comparison(&[("a", 1., 1.), ("b", 1., 1.)]);
        assert!(policy.check(&evidence, false).is_err());
        evidence.results[0]
            .candidate
            .usage
            .as_mut()
            .unwrap()
            .cost_usd = Some(0.5);
        assert!(policy.check(&evidence, false).is_ok());
        assert!(
            policy
                .check_with_summary(&evidence, Stage::Cumulative, 0.0, &mut None)
                .is_err()
        );
    }

    #[test]
    fn repetition_plan_power_simulation() {
        use crate::connected_learning::{
            repetitions::{DEFAULT_MAX_REPETITIONS, DEFAULT_PAIR_BUDGET, Plan},
            statistics::{AUDIT_Z, calibrate, harmonic_repetitions, lower_bound, scored_reward},
        };
        let ids: Vec<_> = (0..30).map(|i| format!("case-{i:02}")).collect();
        let probabilities: Vec<_> = (0..30)
            .map(|i| match i {
                0..=8 => 0.0,
                9..=17 => 1.0,
                _ => 0.50,
            })
            .collect();
        let cohort = |prefix: &str| Descriptor {
            dataset_revision: prefix.into(),
            expected_cases: ids
                .iter()
                .map(|id| CaseKey {
                    case_id: format!("{prefix}{id}"),
                    repetition: 0,
                })
                .collect(),
            grader_revision: "test".into(),
            runtime: Default::default(),
            fixture_protocol: None,
            dataset_digest: None,
            case_fingerprints: Vec::new(),
            family_fingerprints: Vec::new(),
        };
        let development = cohort("");
        let audits = [cohort("audit-")];
        let mut rng = 0x38a7_aefe_4dec_e53c_u64;
        let mut sample = |p: f64| {
            rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if ((rng >> 32) as f64) < p * 4294967296.0 {
                1.0
            } else {
                0.0
            }
        };
        const RUNS: usize = 5000;
        let mut baseline_passes = [0; 3];
        let mut audit_passes = [0; 3];
        let mut audit_pairs = 0;
        for _ in 0..RUNS {
            let mut observations = Vec::new();
            for (id, &p) in ids.iter().zip(&probabilities) {
                for _ in 0..2 {
                    observations.push((id.as_str(), sample(p), sample(p)));
                }
            }
            let calibration = calibrate(&comparison(&observations), 0.0, scored_reward);
            let plan = Plan::with_budget(
                &development,
                &audits,
                &calibration,
                DEFAULT_MAX_REPETITIONS,
                DEFAULT_PAIR_BUDGET,
            );
            let audit = plan.expected_cases(&audits[0], Some(0));
            let development_keys = plan.expected_cases(&development, None);
            let repeats = audit.len() / ids.len();
            for keys in [&audit, &development_keys] {
                assert_eq!(keys.len(), ids.len() * repeats);
                assert!(keys.chunks_exact(repeats).all(|case| {
                    case.iter().enumerate().all(|(index, key)| {
                        key.case_id == case[0].case_id && key.repetition as usize == index
                    })
                }));
            }
            audit_pairs += audit.len();
            let mut passes = |repeats: &[usize], effect: f64| {
                let gains: Vec<_> = probabilities
                    .iter()
                    .zip(repeats)
                    .enumerate()
                    .map(|(i, (&p, &r))| {
                        let q = if i >= 18 { p + effect / 0.4 } else { p };
                        (0..r).map(|_| sample(q) - sample(p)).sum::<f64>() / r as f64
                    })
                    .collect();
                let floor = calibration.paired_standard_deviation
                    * (calibration.effective_repetitions
                        / harmonic_repetitions(repeats.iter().copied()))
                    .sqrt();
                usize::from(lower_bound(&gains, floor, AUDIT_Z) > -0.03)
            };
            for (i, effect) in [-0.03, 0.0, 0.05].into_iter().enumerate() {
                baseline_passes[i] += passes(&[1; 30], effect);
                audit_passes[i] += passes(&[repeats; 30], effect);
            }
        }
        let rates = |passes: [usize; 3]| passes.map(|n| n as f64 / RUNS as f64);
        eprintln!(
            "Audit pass rates (−3pp, 0pp, +5pp): 30×1 {:?} at 30 pairs, uniform {:?} at {:.1} pairs",
            rates(baseline_passes),
            rates(audit_passes),
            audit_pairs as f64 / RUNS as f64,
        );
        assert_eq!(audit_pairs, 90 * RUNS);
        assert!(audit_passes[0] <= RUNS * 6 / 100);
        assert!(baseline_passes[0] <= RUNS * 6 / 100);
        assert!(audit_passes[2] >= baseline_passes[2] + RUNS / 20);
    }

    #[test]
    fn power_guard_reports_when_the_budget_cannot_support_the_target() {
        use crate::connected_learning::{
            repetitions::Plan,
            statistics::{DEVELOPMENT_Z, calibrate, scored_reward},
        };
        let evidence = comparison(&[
            ("stable", 0., 0.),
            ("stable", 0., 0.),
            ("flaky", 0., 1.),
            ("flaky", 1., 0.),
        ]);
        let descriptor = Descriptor {
            dataset_revision: "test".into(),
            expected_cases: vec![
                evidence.expected_cases[0].clone(),
                evidence.expected_cases[2].clone(),
            ],
            grader_revision: "test".into(),
            runtime: Default::default(),
            fixture_protocol: None,
            dataset_digest: None,
            case_fingerprints: Vec::new(),
            family_fingerprints: Vec::new(),
        };
        let calibration = calibrate(&evidence, 0.0, scored_reward);
        assert_eq!(calibration.case_variability["flaky"], 1.0);
        assert_eq!(calibration.case_variability["stable"], 0.0);
        let plan = Plan::with_budget(&descriptor, &[], &calibration, 3, 5);
        let projection = plan.project(
            &descriptor,
            None,
            (&calibration, 2),
            0.0,
            DEVELOPMENT_Z,
            Some(0.05),
        );
        let reason = projection.stop_reason("Cumulative").unwrap();
        assert!(reason.contains("2 cases, 4 pairs"));
        assert!(reason.contains("cases at the same repetition mix are needed"));
    }

    #[test]
    fn admission_guard_handles_noisy_boundary_and_pools_matching_epochs() {
        use super::super::{
            repetitions::Plan,
            statistics::{DEVELOPMENT_Z, calibrate, pool_calibrations, scored_reward, sd_interval},
        };

        for (cases, se, decision) in [
            (40, 0.0428, "admit"),
            (40, 0.0428, "admit"),
            (40, 0.0552, "warn"),
            (10, 0.30, "stop"),
        ] {
            let ids: Vec<_> = (0..cases).map(|id| id.to_string()).collect();
            let difference =
                ((se * se * cases as f64 * (cases + 1) as f64 - 0.5) / cases as f64).sqrt();
            let comparison = comparison(
                &ids.iter()
                    .flat_map(|id| [(id.as_str(), 0.0, difference); 2])
                    .collect::<Vec<_>>(),
            );
            let descriptor: Descriptor = serde_json::from_value(serde_json::json!({
                "datasetRevision": "test",
                "graderRevision": "grader",
                "runtime": {},
                "expectedCases": comparison.expected_cases,
            }))
            .unwrap();
            let calibration = calibrate(&comparison, 0.0, scored_reward);
            let plan = Plan::with_budget(&descriptor, &[], &calibration, 2, 1000);
            let (guard, observations) = pool_calibrations(&calibration, &[]);
            let projection = serde_json::to_value(plan.project(
                &descriptor,
                None,
                (&guard, observations),
                0.0,
                DEVELOPMENT_Z,
                Some(0.10),
            ))
            .unwrap();
            assert_eq!(projection["decision"], decision, "{projection}");
            if cases == 40 {
                let original = guard.paired_standard_deviation;
                let (pooled, total) =
                    pool_calibrations(&calibration, std::slice::from_ref(&calibration));
                assert_eq!(total, 80);
                assert!(pooled.paired_standard_deviation < original);
                let (lower, upper) = sd_interval(original, observations).unwrap();
                let (pooled_lower, pooled_upper) =
                    sd_interval(pooled.paired_standard_deviation, total).unwrap();
                assert!(pooled_upper - pooled_lower < upper - lower);
            }
        }
    }

    #[test]
    fn calibration_counts_only_scored_case_means() {
        use super::super::statistics::{calibrate, scored_reward};
        let mut evidence = comparison(&[("a", 0., 0.), ("b", 0., 0.), ("c", 0., 0.)]);
        evidence.results[2].parent.reward = None;
        let report = serde_json::to_value(calibrate(&evidence, 0.05, scored_reward)).unwrap();
        assert_eq!(report["caseCount"], 2);
        assert_eq!(report["effectiveRepetitions"], 1.0);
        assert!((report["standardError"].as_f64().unwrap() - 1.0 / 6.0_f64.sqrt()).abs() < 1e-12);
        let zero_threshold = calibrate(&evidence, 0.0, scored_reward);
        assert!(
            (report["minimumDetectableEffect"].as_f64().unwrap()
                - zero_threshold.minimum_detectable_effect.unwrap()
                - 0.05)
                .abs()
                < 1e-12
        );
    }

    #[test]
    fn lower_metrics_orient_thresholds_and_reject_nonfinite_aggregation() {
        let mut policy = Policies::default().audit;
        policy.metric.direction = Direction::Lower;
        policy.protected_case_thresholds.insert("a".into(), 0.5);
        policy.candidate_threshold = Some(0.5);
        assert!(
            policy
                .check(&comparison(&[("a", 1., 0.5), ("b", 1., 0.5)]), true)
                .is_ok()
        );
        assert!(
            policy
                .check(&comparison(&[("a", 1., 1.), ("b", 1., 1.)]), true)
                .is_err()
        );
        assert!(
            policy
                .check(
                    &comparison(&[("b", f64::MAX, f64::MAX), ("b", f64::MAX, f64::MAX)]),
                    true
                )
                .is_err()
        );
    }
}
