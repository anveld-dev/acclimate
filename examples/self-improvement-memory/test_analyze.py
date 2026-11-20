import numpy as np
import pytest
from scipy import stats

import analyze
from analyze import curve_score, holm, paired, signed_rank
from run import read, write


def test_pilot_records_target_ceiling_before_stopping(tmp_path, monkeypatch):
    target = tmp_path / "S0c" / "b1" / "B"
    target.mkdir(parents=True)
    (target / "ledger.json").touch()
    write(tmp_path / "key.json", {"1": {"B": "cold"}})
    monkeypatch.setattr(analyze, "evidence", lambda _: ({"roundZero": {"score": .85}}, [], []))

    with pytest.raises(ValueError, match="Stop before S1 for a maintainer decision"):
        analyze.pilot_report(tmp_path, 272_000, "fixture-seed")

    report = read(tmp_path / "S0c" / "pilot.json")
    assert report["targetRoundZero"] == {"cold": .85}
    assert report["targetCeilingReached"]
    assert not report["passed"]


def test_paired_statistics_match_known_ten_block_effect():
    differences = np.array([.01, .03, .06, .10, .14, -.02, .04, .08, .11, .025])
    result = paired(differences)
    reference = stats.ttest_1samp(differences, 0)
    assert result["mean"] == pytest.approx(.0575)
    assert result["n"] == 10
    assert result["df"] == 9
    assert result["t"] == pytest.approx(reference.statistic)
    assert result["p"] == pytest.approx(reference.pvalue)
    assert result["ci95"] == pytest.approx(reference.confidence_interval())
    assert result["signedRank"]["p"] == pytest.approx(stats.wilcoxon(differences, method="exact").pvalue)
    assert result["dz"] == pytest.approx(reference.statistic / np.sqrt(10))
    assert [stats.nct.cdf(reference.statistic, 9, endpoint * np.sqrt(10))
            for endpoint in result["dzCi95"]] == pytest.approx([.975, .025])
    assert result["hodgesLehmann"]["estimate"] == pytest.approx(.06)


def test_exact_sign_enumeration_handles_ties_and_zero_differences():
    result = signed_rank([-1, -1, 2, 2, 0])
    assert result == {"p": .5, "signedStatistic": 4, "zeros": 1}
    assert signed_rank(np.arange(1, 11))["p"] == 2 / 1024
    assert signed_rank([0, 0])["p"] == 1


def test_retention_and_holm():
    values = np.array([-.025, .030, .018, .010, .024])
    result = paired(values, margin=-.03)
    assert result["p"] == pytest.approx(stats.ttest_1samp(values, -.03, alternative="greater").pvalue)
    assert result["oneSidedLower95"] == pytest.approx(
        stats.ttest_1samp(values, -.03, alternative="greater").confidence_interval().low
    )
    assert holm({"T2": .021, "T3": .033}) == {"T2": .042, "T3": .042}
    assert holm({"T2": None, "T3": .03}) == {"T2": None, "T3": .06}


def test_case_weighted_held_out_and_reproducible_bootstrap():
    rows = [
        {"id": "trial", "caseId": case, "rollout": index, "score": score}
        for case, scores in [("stable", [1] * 5), ("flaky", [0, 1, 0, 0, 0])]
        for index, score in enumerate(scores)
    ]
    reference = {"id": "trial", "score": .6}
    result = curve_score(rows, reference, "seed")
    assert result == curve_score(rows, reference, "seed")
    assert result["score"] == pytest.approx(.6)
    assert result["bootstrapSe"] == pytest.approx(.4 / np.sqrt(2), abs=.015)
    assert curve_score(rows, reference, "seed", ["flaky"]) == {"score": 1., "bootstrapSe": 0.}
    with pytest.raises(ValueError, match="differs"):
        curve_score(rows, {"id": "trial", "score": .7}, "seed")
    with pytest.raises(ValueError, match="Incomplete or duplicate"):
        curve_score([*rows, rows[0]], reference, "seed")
