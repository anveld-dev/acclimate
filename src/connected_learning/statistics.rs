//! Inference uses independent cases, with repetitions averaged within each case.

pub(super) const DEVELOPMENT_Z: f64 = 1.2815515655446004;
pub(super) const AUDIT_Z: f64 = 1.6448536269514722;
pub(crate) const MAX_MISSING_PERCENT: usize = 15;

pub(super) fn lower_bound(gains: &[f64], calibrated_sd: f64, z: f64) -> f64 {
    let n = gains.len() as f64;
    let mean = gains.iter().sum::<f64>() / n;
    let variance = gains.iter().map(|gain| (gain - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    mean - z * variance.sqrt().max(calibrated_sd) / n.sqrt()
}

#[derive(Debug, PartialEq)]
pub(crate) enum FieldDecision {
    Pending,
    Withdraw,
    Validate,
}

/// Wald SPRT with alpha=.05, beta=.20, comparing loss probabilities .50 and .75.
pub(crate) fn field_decision(wins: i64, losses: i64) -> FieldDecision {
    let likelihood = losses as f64 * 1.5_f64.ln() + wins as f64 * 0.5_f64.ln();
    if likelihood >= (0.8_f64 / 0.05).ln() {
        FieldDecision::Withdraw
    } else if likelihood <= (0.2_f64 / 0.95).ln() {
        FieldDecision::Validate
    } else {
        FieldDecision::Pending
    }
}

pub(super) fn worst_reward(rewards: impl Iterator<Item = f64>, higher_is_better: bool) -> f64 {
    if higher_is_better {
        rewards.fold(0.0, f64::min)
    } else {
        rewards.fold(1.0, f64::max)
    }
}

pub(crate) fn scored_reward(outcome: &crate::Outcome) -> Option<f64> {
    if outcome.execution_status == "infrastructure_failed" {
        None
    } else {
        outcome.reward
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Calibration {
    case_count: usize,
    flip_rate: f64,
    paired_standard_deviation: f64,
    standard_error: f64,
    pub(crate) minimum_detectable_effect: f64,
}

pub(crate) fn calibrate(
    comparison: &crate::ComparisonRequest,
    reward: impl Fn(&crate::Outcome) -> Option<f64>,
) -> Calibration {
    let mut cases = std::collections::BTreeMap::new();
    for pair in &comparison.results {
        let (sum, repetitions) = cases.entry(&pair.key.case_id).or_insert((0.0, 0usize));
        if let (Some(parent), Some(candidate)) = (reward(&pair.parent), reward(&pair.candidate)) {
            *sum += candidate - parent;
            *repetitions += 1;
        }
    }
    let n = cases.len();
    let differences: Vec<_> = cases
        .values()
        .filter(|(_, count)| *count > 0)
        .map(|(sum, count)| sum / *count as f64)
        .collect();
    let flips = differences
        .iter()
        .filter(|difference| **difference != 0.0)
        .count();
    // One unit-scale pseudo-observation protects a calibration that sees no flips.
    let sd = ((1.0 + differences.iter().map(|d| d * d).sum::<f64>())
        / (differences.len() + 1) as f64)
        .sqrt();
    let se = sd / (n as f64).sqrt();
    Calibration {
        case_count: n,
        flip_rate: flips as f64 / differences.len().max(1) as f64,
        paired_standard_deviation: sd,
        standard_error: se,
        minimum_detectable_effect: (DEVELOPMENT_Z + 0.8416212335729143) * se,
    }
}

/// An independent evaluator attests to three bounded attempts per obligation.
pub(crate) fn valid_replays(verdict: &str, attempts: &[String], allow_unavailable: bool) -> bool {
    if attempts.is_empty() {
        return verdict != "pass";
    }
    attempts.len() == 3
        && attempts.iter().all(|a| {
            matches!(a.as_str(), "pass" | "regression") || (allow_unavailable && a == "unavailable")
        })
        && verdict
            == if attempts.iter().filter(|a| *a == "pass").count() >= 2 {
                "pass"
            } else if attempts.iter().filter(|a| *a == "unavailable").count() >= 2 {
                "unavailable"
            } else {
                "regression"
            }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibrated_floor_and_large_gain() {
        assert!(lower_bound(&[0.0; 24], 0.2, DEVELOPMENT_Z) < 0.0);
        assert!(lower_bound(&[0.0; 24], 0.2, AUDIT_Z) > -0.1);
        assert!(lower_bound(&[1.0; 24], 0.2, DEVELOPMENT_Z) > 0.5);
    }

    #[test]
    fn missing_trials_use_the_worst_oriented_score() {
        assert_eq!(worst_reward([0.2, 0.8].into_iter(), true), 0.0);
        assert_eq!(worst_reward([0.2, 0.8].into_iter(), false), 1.0);
        assert_eq!(worst_reward([-5.0, 20.0].into_iter(), true), -5.0);
        assert_eq!(worst_reward([-5.0, 20.0].into_iter(), false), 20.0);
    }

    #[test]
    fn identical_bernoulli_candidates() {
        let mut seed = 53u64;
        let mut draw = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            f64::from(u8::from((seed >> 56) < 205))
        };
        let (mut developmental, mut noninferior) = (0, 0);
        for _ in 0..2000 {
            let gains: Vec<_> = (0..100).map(|_| draw() - draw()).collect();
            developmental += usize::from(lower_bound(&gains, 0.56, DEVELOPMENT_Z) > 0.0);
            noninferior += usize::from(lower_bound(&gains, 0.56, AUDIT_Z) > -0.15);
        }
        assert!(developmental < 250);
        assert!(noninferior > 1400);
    }

    #[test]
    fn sequential_boundaries() {
        assert_eq!(field_decision(0, 6), FieldDecision::Pending);
        assert_eq!(field_decision(0, 7), FieldDecision::Withdraw);
        assert_eq!(field_decision(2, 0), FieldDecision::Pending);
        assert_eq!(field_decision(3, 0), FieldDecision::Validate);
        assert_eq!(field_decision(30, 30), FieldDecision::Validate);
    }
}
