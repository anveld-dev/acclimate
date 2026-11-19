//! Inference uses independent cases, with repetitions averaged within each case.

pub(crate) const DEVELOPMENT_Z: f64 = 1.2815515655446004;
pub(crate) const AUDIT_Z: f64 = 1.6448536269514722;
pub(crate) const MAX_MISSING_PERCENT: usize = 15;

/// One-sided confidence levels a connected policy may declare, with their normal quantiles.
pub(crate) const CONFIDENCE_LEVELS: [f64; 5] = [0.8, 0.9, 0.95, 0.975, 0.99];
pub(crate) const NORMAL_QUANTILES: [f64; 5] = [
    0.8416212335729143,
    DEVELOPMENT_Z,
    AUDIT_Z,
    1.959963984540054,
    2.3263478740408408,
];

// Tabulated quantiles through 60 df, shared with the SDKs through
// contracts/fixtures/evaluation-analysis/student-t.json, then a third-order expansion.
const T_QUANTILES: [[f64; 5]; 60] = [
    [
        1.376381920492,
        3.077683537208,
        6.313751514801,
        12.706204736432,
        31.820515953758,
    ],
    [
        1.06066017178,
        1.885618083164,
        2.919985580356,
        4.302652729696,
        6.964556734283,
    ],
    [
        0.978472312363,
        1.637744353696,
        2.353363434802,
        3.182446305284,
        4.540702858471,
    ],
    [
        0.940964577245,
        1.533206274059,
        2.131846786327,
        2.776445105198,
        3.746947387981,
    ],
    [
        0.919543780236,
        1.475884048856,
        2.015048373333,
        2.570581835636,
        3.364929998907,
    ],
    [
        0.90570328518,
        1.439755747258,
        1.943180280515,
        2.446911851145,
        3.142668403291,
    ],
    [
        0.896029644314,
        1.414923927649,
        1.894578605061,
        2.364624251593,
        2.997951566869,
    ],
    [
        0.888889517767,
        1.396815309743,
        1.859548037523,
        2.306004135204,
        2.89645944771,
    ],
    [
        0.883403859686,
        1.383028738396,
        1.833112932654,
        2.262157162854,
        2.821437925026,
    ],
    [
        0.879057828551,
        1.37218364111,
        1.812461122811,
        2.228138851965,
        2.763769458113,
    ],
    [
        0.875529978074,
        1.363430318021,
        1.795884818704,
        2.200985160083,
        2.718079183814,
    ],
    [
        0.872609291588,
        1.356217334023,
        1.782287555649,
        2.178812829663,
        2.68099799313,
    ],
    [
        0.870151533968,
        1.35017128878,
        1.770933395987,
        2.160368656461,
        2.650308837853,
    ],
    [
        0.868054781557,
        1.345030374455,
        1.761310135775,
        2.144786687917,
        2.62449406756,
    ],
    [
        0.866244973195,
        1.34060560785,
        1.753050355693,
        2.131449545559,
        2.602480294995,
    ],
    [
        0.864667001798,
        1.336757167327,
        1.745883676276,
        2.119905299221,
        2.583487185267,
    ],
    [
        0.86327901742,
        1.333379389722,
        1.739606726075,
        2.109815577833,
        2.56693398372,
    ],
    [
        0.86204866799,
        1.33039094357,
        1.734063606618,
        2.100922040241,
        2.552379630179,
    ],
    [
        0.860950550269,
        1.327728209027,
        1.729132811521,
        2.093024054408,
        2.539483190622,
    ],
    [
        0.859964439732,
        1.325340706985,
        1.724718242921,
        2.085963447266,
        2.527977002741,
    ],
    [
        0.859074035195,
        1.323187873865,
        1.720742902812,
        2.079613844728,
        2.517648016044,
    ],
    [
        0.858266051658,
        1.321236741613,
        1.71714437438,
        2.073873067904,
        2.508324552899,
    ],
    [
        0.857529553688,
        1.319460239816,
        1.713871527747,
        2.068657610419,
        2.499866739494,
    ],
    [
        0.856855458076,
        1.317835933673,
        1.710882079909,
        2.063898561628,
        2.492159473158,
    ],
    [
        0.856236157676,
        1.316345072674,
        1.708140761252,
        2.059538552753,
        2.485107175411,
    ],
    [
        0.855665233328,
        1.314971864271,
        1.705617919759,
        2.055529438643,
        2.478629823591,
    ],
    [
        0.855137230694,
        1.313702912829,
        1.703288445722,
        2.05183051648,
        2.472659911956,
    ],
    [
        0.854647485582,
        1.312526781593,
        1.701130934266,
        2.048407141795,
        2.467140097967,
    ],
    [
        0.854191985882,
        1.311433647302,
        1.699127026533,
        2.045229642133,
        2.46202136015,
    ],
    [
        0.853767261471,
        1.310415025391,
        1.697260886594,
        2.042272456301,
        2.457261542401,
    ],
    [
        0.853370295697,
        1.309463549495,
        1.695518782546,
        2.039513446396,
        2.452824193403,
    ],
    [
        0.852998453652,
        1.30857279313,
        1.693888748384,
        2.03693334346,
        2.448677633672,
    ],
    [
        0.852649423648,
        1.307737124451,
        1.69236030903,
        2.034515297449,
        2.444794199808,
    ],
    [
        0.852321169135,
        1.306951587126,
        1.690924255187,
        2.032244509318,
        2.441149627906,
    ],
    [
        0.852011888951,
        1.306211802016,
        1.68957245778,
        2.03010792825,
        2.437722547144,
    ],
    [
        0.851719984276,
        1.305513885536,
        1.688297714117,
        2.02809400098,
        2.434494061231,
    ],
    [
        0.851444030995,
        1.304854381498,
        1.687093619596,
        2.026192463029,
        2.431447400465,
    ],
    [
        0.851182756468,
        1.304230203891,
        1.685954460167,
        2.024394163912,
        2.428567630859,
    ],
    [
        0.85093501992,
        1.303638588621,
        1.684875121711,
        2.022690920037,
        2.425841409736,
    ],
    [
        0.85069979579,
        1.303077052607,
        1.683851013336,
        2.021075390306,
        2.423256779335,
    ],
    [
        0.850476159547,
        1.302543358953,
        1.682878002133,
        2.019540970441,
        2.420802991729,
    ],
    [
        0.850263275548,
        1.302035487183,
        1.681952357468,
        2.018081702818,
        2.418470359635,
    ],
    [
        0.850060386606,
        1.301551607682,
        1.681070703203,
        2.016692199228,
        2.416250128763,
    ],
    [
        0.849866804997,
        1.301090059689,
        1.680229976572,
        2.015367574444,
        2.414134368169,
    ],
    [
        0.849681904671,
        1.30064933225,
        1.679427392652,
        2.014103388881,
        2.412115875703,
    ],
    [
        0.849505114492,
        1.300228047707,
        1.678660413557,
        2.012895598919,
        2.410188096201,
    ],
    [
        0.849335912344,
        1.299824947312,
        1.677926721642,
        2.01174051373,
        2.408345050443,
    ],
    [
        0.849173819987,
        1.299438878671,
        1.677224196124,
        2.010634757624,
        2.406581273276,
    ],
    [
        0.849018398534,
        1.299068784748,
        1.676550892617,
        2.009575237129,
        2.404891759538,
    ],
    [
        0.848869244501,
        1.298713694195,
        1.675905025163,
        2.008559112101,
        2.403271916674,
    ],
    [
        0.848725986293,
        1.298372712848,
        1.675284950425,
        2.007583770316,
        2.401717523085,
    ],
    [
        0.848588281124,
        1.29804501621,
        1.674689153726,
        2.006646805062,
        2.400224691418,
    ],
    [
        0.84845581227,
        1.297729842791,
        1.674116236703,
        2.005745995318,
        2.398789836141,
    ],
    [
        0.848328286645,
        1.297426488209,
        1.673564906352,
        2.004879288188,
        2.397409644808,
    ],
    [
        0.848205432635,
        1.297134299931,
        1.67303396529,
        2.004044783289,
        2.396081052553,
    ],
    [
        0.848086998208,
        1.29685267259,
        1.672522303076,
        2.003240718848,
        2.394801219387,
    ],
    [
        0.847972749019,
        1.296581043795,
        1.672028888461,
        2.002465459291,
        2.393567509946,
    ],
    [
        0.847862467119,
        1.296318890396,
        1.671552762455,
        2.001717484145,
        2.392377475394,
    ],
    [
        0.847755949396,
        1.296065725109,
        1.671093032104,
        2.000995378088,
        2.391228837207,
    ],
    [
        0.847653006374,
        1.295821093498,
        1.670648864905,
        2.000297822014,
        2.390119472625,
    ],
];

/// The normal quantile for a supported one-sided confidence level.
pub(crate) fn normal_quantile(confidence: f64) -> Option<f64> {
    CONFIDENCE_LEVELS
        .iter()
        .position(|level| *level == confidence)
        .map(|index| NORMAL_QUANTILES[index])
}

pub(super) fn critical_value(n: usize, z: f64) -> f64 {
    let df = n.saturating_sub(1);
    if df == 0 {
        return f64::INFINITY;
    }
    let column = NORMAL_QUANTILES.iter().position(|q| *q == z);
    if let Some(column) = column
        && df <= T_QUANTILES.len()
    {
        return T_QUANTILES[df - 1][column];
    }
    // Explicit products keep the result bit-identical with the SDK implementations.
    let d = df as f64;
    let z2 = z * z;
    z + z * (z2 + 1.0) / (4.0 * d)
        + z * (5.0 * z2 * z2 + 16.0 * z2 + 3.0) / (96.0 * (d * d))
        + z * (3.0 * (z2 * z2 * z2) + 19.0 * z2 * z2 + 17.0 * z2 - 15.0) / (384.0 * (d * d * d))
}

/// Observed standard deviation of case differences. Identical differences have exactly zero
/// variance whatever the rounding of their mean.
pub(super) fn sample_sd(gains: &[f64]) -> f64 {
    if gains.len() < 2 || gains.iter().all(|gain| *gain == gains[0]) {
        return 0.0;
    }
    let n = gains.len() as f64;
    let mean = gains.iter().sum::<f64>() / n;
    (gains
        .iter()
        .map(|gain| (gain - mean) * (gain - mean))
        .sum::<f64>()
        / (n - 1.0))
        .sqrt()
}

#[cfg(test)]
pub(super) fn lower_bound(gains: &[f64], calibrated_sd: f64, z: f64) -> f64 {
    let n = gains.len() as f64;
    let mean = gains.iter().sum::<f64>() / n;
    mean - critical_value(gains.len(), z) * sample_sd(gains).max(calibrated_sd) / n.sqrt()
}

#[derive(Debug, PartialEq)]
pub(crate) enum FieldDecision {
    Pending,
    Withdraw,
    Validate,
}

/// Wald SPRT with alpha=.05, beta=.20, comparing loss probabilities .50 and .75.
pub(crate) fn field_log_likelihood(wins: i64, losses: i64) -> f64 {
    losses as f64 * 1.5_f64.ln() + wins as f64 * 0.5_f64.ln()
}

pub(crate) fn field_decision(wins: i64, losses: i64) -> FieldDecision {
    let likelihood = field_log_likelihood(wins, losses);
    if likelihood >= (0.8_f64 / 0.05).ln() {
        FieldDecision::Withdraw
    } else if likelihood <= (0.2_f64 / 0.95).ln() {
        FieldDecision::Validate
    } else {
        FieldDecision::Pending
    }
}

pub(crate) fn scored_reward(outcome: &crate::Outcome) -> Option<f64> {
    if outcome.execution_status == "infrastructure_failed" {
        None
    } else {
        outcome.reward
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Calibration {
    pub(super) case_count: usize,
    flip_rate: f64,
    pub(crate) paired_standard_deviation: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    standard_error: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) minimum_detectable_effect: Option<f64>,
    pub(crate) effective_repetitions: f64,
    pub(crate) case_variability: std::collections::BTreeMap<String, f64>,
}

/// Pool independent A/A draws at the same case and repetition precision.
pub(crate) fn pool_calibrations(
    current: &Calibration,
    history: &[Calibration],
) -> (Calibration, usize) {
    let mut pooled = current.clone();
    let pseudo_variance = 1.0 / current.effective_repetitions.max(1.0);
    let sum_squares = |sample: &Calibration| {
        (sample.paired_standard_deviation.powi(2) * (sample.case_count + 1) as f64
            - pseudo_variance)
            .max(0.0)
    };
    let mut squares = sum_squares(current);
    let mut observations = current.case_count;
    for sample in history {
        squares += sum_squares(sample);
        observations += sample.case_count;
        for (id, variance) in &sample.case_variability {
            *pooled.case_variability.entry(id.clone()).or_default() += variance;
        }
    }
    for variance in pooled.case_variability.values_mut() {
        *variance /= (history.len() + 1) as f64;
    }
    pooled.paired_standard_deviation =
        ((squares + pseudo_variance) / (observations + 1) as f64).sqrt();
    (pooled, observations)
}

/// Approximate two-sided 95% interval, using the A/A null mean of zero.
pub(crate) fn sd_interval(sd: f64, observations: usize) -> Option<(f64, f64)> {
    use statrs::distribution::{ChiSquared, ContinuousCDF};
    let df = observations as f64;
    let distribution = ChiSquared::new(df).ok()?;
    // Bracket and bisect the CDF. Newton iteration can leave the positive
    // domain in the lower tail at small degrees of freedom.
    let quantile = |probability| {
        let mut low = 0.0;
        let mut high = df;
        while distribution.cdf(high) < probability {
            high *= 2.0;
        }
        for _ in 0..64 {
            let middle = (low + high) / 2.0;
            if distribution.cdf(middle) < probability {
                low = middle;
            } else {
                high = middle;
            }
        }
        (low + high) / 2.0
    };
    Some((
        sd * (df / quantile(0.975)).sqrt(),
        sd * (df / quantile(0.025)).sqrt(),
    ))
}

pub(crate) fn calibrate(
    comparison: &crate::ComparisonRequest,
    threshold: f64,
    reward: impl Fn(&crate::Outcome) -> Option<f64>,
) -> Calibration {
    let mut cases = std::collections::BTreeMap::new();
    for pair in &comparison.results {
        let (sum, squared, repetitions) =
            cases.entry(&pair.key.case_id).or_insert((0.0, 0.0, 0usize));
        if let (Some(parent), Some(candidate)) = (reward(&pair.parent), reward(&pair.candidate)) {
            *sum += candidate - parent;
            *squared += (candidate - parent).powi(2);
            *repetitions += 1;
        }
    }
    let differences: Vec<_> = cases
        .values()
        .filter(|(_, _, count)| *count > 0)
        .map(|(sum, _, count)| sum / *count as f64)
        .collect();
    let flips = differences
        .iter()
        .filter(|difference| **difference != 0.0)
        .count();
    let effective_repetitions = harmonic_repetitions(cases.values().map(|(_, _, count)| *count));
    // Express one unit-scale paired-trial pseudo-observation at case-mean precision.
    let pseudo_variance = 1.0 / effective_repetitions.max(1.0);
    let sd = ((pseudo_variance + differences.iter().map(|d| d * d).sum::<f64>())
        / (differences.len() + 1) as f64)
        .sqrt();
    let n = differences.len();
    let se = (n > 1).then(|| sd / (n as f64).sqrt());
    Calibration {
        case_count: n,
        flip_rate: flips as f64 / differences.len().max(1) as f64,
        paired_standard_deviation: sd,
        standard_error: se,
        minimum_detectable_effect: se.map(|se| {
            threshold
                + (critical_value(n, DEVELOPMENT_Z) + critical_value(n, 0.8416212335729143)) * se
        }),
        effective_repetitions,
        case_variability: cases
            .into_iter()
            .filter(|(_, (_, _, count))| *count > 0)
            .map(|(id, (_, squared, count))| (id.to_owned(), squared / count as f64))
            .collect(),
    }
}

pub(crate) fn harmonic_repetitions(counts: impl Iterator<Item = usize>) -> f64 {
    let (n, inverse_sum) = counts.filter(|n| *n > 0).fold((0, 0.0), |(n, sum), count| {
        (n + 1, sum + 1.0 / count as f64)
    });
    if n == 0 { 0.0 } else { n as f64 / inverse_sum }
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
    fn chi_square_sd_interval_matches_reference_quantiles() {
        for (df, q025, q975) in [(1, 0.000982069, 5.023886), (40, 24.43304, 59.34171)] {
            let (lower, upper) = sd_interval(2.0, df).unwrap();
            assert!(((2.0 / lower).powi(2) * df as f64 - q975).abs() < 0.00001);
            assert!(((2.0 / upper).powi(2) * df as f64 - q025).abs() < 0.00001);
        }
    }

    #[test]
    fn calibrated_floor_and_large_gain() {
        assert!(lower_bound(&[0.0; 24], 0.2, DEVELOPMENT_Z) < 0.0);
        assert!(lower_bound(&[0.0; 24], 0.2, AUDIT_Z) > -0.1);
        assert!(lower_bound(&[1.0; 24], 0.2, DEVELOPMENT_Z) > 0.5);
    }

    #[test]
    fn student_t_table_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/fixtures/evaluation-analysis/student-t.json"
        ))
        .unwrap();
        let levels: Vec<f64> = serde_json::from_value(fixture["confidenceLevels"].clone()).unwrap();
        let normal: Vec<f64> = serde_json::from_value(fixture["normalQuantiles"].clone()).unwrap();
        let table: Vec<Vec<f64>> = serde_json::from_value(fixture["quantiles"].clone()).unwrap();
        assert_eq!(levels, CONFIDENCE_LEVELS);
        assert_eq!(normal, NORMAL_QUANTILES);
        assert_eq!(table, T_QUANTILES.map(Vec::from).to_vec());
        for check in fixture["checks"].as_array().unwrap() {
            let z = normal_quantile(check["confidence"].as_f64().unwrap()).unwrap();
            let df = check["df"].as_u64().unwrap() as usize;
            assert!((critical_value(df + 1, z) - check["value"].as_f64().unwrap()).abs() < 5e-7);
        }
    }

    #[test]
    fn student_t_critical_values() {
        assert!((critical_value(30, DEVELOPMENT_Z) - 1.311434).abs() < 1e-6);
        assert!((critical_value(30, AUDIT_Z) - 1.699127).abs() < 1e-6);
        assert!((critical_value(101, AUDIT_Z) - 1.660234).abs() < 1e-6);
        assert!(!lower_bound(&[1.0], 0.0, AUDIT_Z).is_finite());
    }

    #[test]
    fn unequal_repetitions_scale_the_variance_floor() {
        assert_eq!(harmonic_repetitions([0, 1, 3].into_iter()), 1.5);
        assert_eq!(harmonic_repetitions([4; 5].into_iter()), 4.0);
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
    fn audit_size_at_null_boundary_and_power_at_five_point_gain() {
        let mut seed = 87u64;
        let mut draw = |probability| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let uniform = (seed >> 32) as f64 / 4294967296.0;
            f64::from(u8::from(uniform < probability))
        };
        let (mut false_pass, mut new_power, mut old_power) = (0, 0, 0);
        for _ in 0..5000 {
            let null: Vec<_> = (0..30).map(|_| draw(0.77) - draw(0.80)).collect();
            let gain: Vec<_> = (0..30).map(|_| draw(0.85) - draw(0.80)).collect();
            false_pass += usize::from(lower_bound(&null, 0.56, AUDIT_Z) > -0.03);
            let bound = lower_bound(&gain, 0.56, AUDIT_Z);
            new_power += usize::from(bound > -0.03);
            let mean = gain.iter().sum::<f64>() / 30.0;
            let sd = (gain.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / 29.0).sqrt();
            old_power += usize::from(mean - AUDIT_Z * sd.max(0.56) / 30.0_f64.sqrt() > 0.0);
        }
        assert!(false_pass <= 300, "{false_pass}");
        assert!(new_power > old_power, "{new_power} vs {old_power}");
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
