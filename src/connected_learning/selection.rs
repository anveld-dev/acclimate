use super::statistics::{AUDIT_Z, DEVELOPMENT_Z, lower_bound};
use super::{Descriptor, bounded, invalid};
use crate::{ApiResult, ComparisonRequest};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Policies {
    pub development: SelectionPolicy,
    pub audit: SelectionPolicy,
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
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Metric {
    name: String,
    unit: String,
    direction: Direction,
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

impl Default for Policies {
    fn default() -> Self {
        let audit = SelectionPolicy {
            schema_version: 2,
            id: "connected-audit".into(),
            revision: "1".into(),
            metric: Metric {
                name: "reward".into(),
                unit: "reward".into(),
                direction: Direction::Higher,
            },
            aggregation: "equal-case-means".into(),
            minimum_mean_improvement: 0.0,
            maximum_case_regression: 0.0,
            non_inferiority_margin: Some(0.0),
            candidate_threshold: None,
            required_cases: vec![],
            maximum_candidate_task_failures: Some(0),
            cost: None,
            protected_case_thresholds: BTreeMap::new(),
            minimum_cost_savings_usd: None,
            minimum_repetitions_per_case: None,
        };
        let development = SelectionPolicy {
            id: "connected-development".into(),
            minimum_mean_improvement: 0.0,
            non_inferiority_margin: None,
            ..audit.clone()
        };
        Self { development, audit }
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
        if self
            .minimum_repetitions_per_case
            .is_some_and(|n| !(1..=1000).contains(&n))
            || !matches!(self.schema_version, 1 | 2)
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

    fn protected(&self, case: &str) -> bool {
        self.protected_case_thresholds.contains_key(case)
            || self.required_cases.iter().any(|id| id == case)
    }

    pub(crate) fn higher_is_better(&self) -> bool {
        self.metric.direction == Direction::Higher
    }

    pub(crate) fn audit_margin(&self) -> f64 {
        self.non_inferiority_margin.unwrap_or(0.0)
    }

    pub(crate) fn minimum_mean_improvement(&self) -> f64 {
        self.minimum_mean_improvement
    }

    #[cfg(test)]
    pub(crate) fn check(&self, comparison: &ComparisonRequest) -> Result<(), &'static str> {
        self.check_calibrated(comparison, self.id == "connected-audit", 0.0)
    }

    /// Called only after the service verifies a complete, bound comparison.
    pub(crate) fn check_calibrated(
        &self,
        comparison: &ComparisonRequest,
        audit: bool,
        calibrated_sd: f64,
    ) -> Result<(), &'static str> {
        let sign = if self.metric.direction == Direction::Higher {
            1.0
        } else {
            -1.0
        };
        // Evaluate in the same stable UTF-8 case/repetition order as the SDK.
        let mut pairs: Vec<_> = comparison.results.iter().collect();
        pairs.sort_by_key(|p| (&p.key.case_id, p.key.repetition));
        let mut means = BTreeMap::new();
        let (mut parent_cost, mut candidate_cost) = (Some(0.0), Some(0.0));
        let mut failed = 0;
        let worst = super::statistics::worst_reward(
            pairs
                .iter()
                .flat_map(|pair| [&pair.parent, &pair.candidate])
                .filter_map(super::statistics::scored_reward),
            self.higher_is_better(),
        );
        for pair in pairs {
            let p = super::statistics::scored_reward(&pair.parent).unwrap_or(worst);
            let c = super::statistics::scored_reward(&pair.candidate).unwrap_or(worst);
            if self.protected(&pair.key.case_id)
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
        for (id, (parent, candidate, count)) in means {
            if self
                .minimum_repetitions_per_case
                .is_some_and(|n| (count as usize) < n)
            {
                return Err("Case inventory has too few paired repetitions");
            }
            let candidate_mean = candidate / f64::from(count);
            let gain = sign * (candidate_mean - parent / f64::from(count));
            if !gain.is_finite() || (self.protected(id) && -gain > self.maximum_case_regression) {
                return Err("Maximum case regression exceeded");
            }
            gains.push(gain);
            candidates += candidate_mean;
        }
        if !candidates.is_finite() {
            return Err("Nonfinite selection arithmetic");
        }
        let (z, threshold) = if audit {
            (AUDIT_Z, -self.audit_margin())
        } else {
            (DEVELOPMENT_Z, self.minimum_mean_improvement)
        };
        let bound = lower_bound(&gains, calibrated_sd, z);
        if !bound.is_finite() || bound <= threshold {
            return Err("Minimum mean improvement was not reached");
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
        if self.cost.is_some() || self.minimum_cost_savings_usd.is_some() {
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
            if maximum_increase.is_some() || self.minimum_cost_savings_usd.is_some() {
                let parent_cost = parent_cost
                    .filter(|v| v.is_finite())
                    .ok_or("Parent cost is unknown")?;
                let increase = candidate_cost - parent_cost;
                if maximum_increase.is_some_and(|cap| increase > cap)
                    || self
                        .minimum_cost_savings_usd
                        .is_some_and(|floor| -increase < floor)
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
            calibrated_standard_deviation: f64,
            non_inferiority_margin: Option<f64>,
            gains: Vec<f64>,
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
            policy.non_inferiority_margin = decision.non_inferiority_margin;
            let ids: Vec<_> = (0..decision.gains.len())
                .map(|index| index.to_string())
                .collect();
            let cases: Vec<_> = ids
                .iter()
                .zip(decision.gains)
                .map(|(id, gain)| (id.as_str(), 0.0, gain))
                .collect();
            assert_eq!(
                policy
                    .check_calibrated(
                        &comparison(&cases),
                        audit,
                        decision.calibrated_standard_deviation
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
        let tied = comparison(&[("ordinary", 1., 1.)]);
        assert!(policies.development.check(&tied).is_err());
        assert!(policies.audit.check(&tied).is_err());
        let regressed = comparison(&[("ordinary", 0., 2.), ("invariant", 1., 0.)]);
        assert!(policies.audit.check(&regressed).is_err());
    }

    #[test]
    fn repetitions_average_per_case_and_protected_threshold_applies_to_each_repeat() {
        let mut policy = Policies::default().development;
        let measurements = comparison(&[("a", 1., 0.), ("a", 0., 1.), ("b", 1., 2.)]);
        policy.minimum_mean_improvement = -0.2;
        assert!(policy.check(&measurements).is_ok()); // LCB = .5 - 1.282 * .5.
        policy.minimum_repetitions_per_case = Some(2);
        assert!(policy.check(&measurements).is_err());
        policy.minimum_repetitions_per_case = None;
        policy.protected_case_thresholds.insert("a".into(), 1.);
        assert!(policy.check(&measurements).is_err());
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
        for pair in evidence.results.iter_mut().take(3) {
            pair.candidate.reward = None;
            pair.candidate.grading_status = "missing".into();
        }
        assert_eq!(crate::improvement::validate_comparison(&evidence), Ok(true));
        let mut policy = Policies::default().development;
        policy.minimum_mean_improvement = 0.8;
        assert!(policy.check(&evidence).is_err());
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
        policy.minimum_cost_savings_usd = Some(0.5);
        policy.non_inferiority_margin = Some(0.1);
        let mut results = comparison(&[("a", 1., 1.)]);
        assert!(policy.check(&results).is_err());
        results.results[0]
            .candidate
            .usage
            .as_mut()
            .unwrap()
            .cost_usd = Some(0.5);
        assert!(policy.check(&results).is_ok());
        results.results[0].parent.usage = None;
        assert!(policy.check(&results).is_err());
    }

    #[test]
    fn lower_metrics_orient_thresholds_and_reject_nonfinite_aggregation() {
        let mut policy = Policies::default().audit;
        policy.metric.direction = Direction::Lower;
        policy.protected_case_thresholds.insert("a".into(), 0.5);
        policy.candidate_threshold = Some(0.5);
        assert!(policy.check(&comparison(&[("a", 3., 0.5)])).is_ok());
        assert!(policy.check(&comparison(&[("a", 3., 1.)])).is_err());
        assert!(
            policy
                .check(&comparison(&[
                    ("b", f64::MAX, f64::MAX),
                    ("b", f64::MAX, f64::MAX)
                ]))
                .is_err()
        );
    }
}
