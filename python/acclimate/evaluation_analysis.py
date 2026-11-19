"""App-asserted named metrics and optional paired interval analysis.

No execution attestation, policy verdict or release action. Intervals are labeled by question:
``paired-within-case-bootstrap`` answers "these tasks again" (fixed cases) and ``paired-t``
answers "tasks like these" (cases sampled from the tasks you care about).
"""
from __future__ import annotations

import math
from typing import Any, Literal, NotRequired, TypedDict

from ._student_t import student_t_quantile
from .evaluation_policy import EvidenceGaps, _add_gap, _scalar_gap, check_comparison
from .types import Comparison, EvaluationDescriptor


class AnalysisMetric(TypedDict):
    id: str
    name: str
    unit: str
    direction: Literal["higher", "lower"]
    source: Literal["reward", "component"]


class ComponentObservation(TypedDict):
    requestId: str
    attemptId: str
    comparisonId: str
    graderRevision: str
    caseId: str
    repetition: int
    side: Literal["parent", "candidate"]
    versionId: str
    bundleDigest: str
    values: dict[str, float | None]


class FixedCaseBootstrap(TypedDict):
    """These tasks again: variance-scaled within-case bootstrap, at least 3 repetitions."""

    method: Literal["paired-within-case-bootstrap"]
    estimand: Literal["fixed-cases"]
    samplingProtocol: str
    independentStochasticPairs: Literal[True]
    confidenceLevel: float
    resamples: int
    seed: int


class SampledCaseT(TypedDict):
    """Tasks like these: two-sided Student t interval on case means, at least 2 cases."""

    method: Literal["paired-t"]
    estimand: Literal["sampled-cases"]
    samplingProtocol: str
    confidenceLevel: float


PairedUncertainty = FixedCaseBootstrap | SampledCaseT
_TWO_SIDED_T = {0.8: 0.9, 0.9: 0.95, 0.95: 0.975, 0.98: 0.99}
MINIMUM_BOOTSTRAP_REPETITIONS = 3


class AnalysisComparisonBinding(TypedDict):
    parentVersionId: str
    candidateVersionId: str
    parentDigest: str
    candidateDigest: str
    requestId: str
    attemptId: str
    comparisonId: str
    submitter: NotRequired[str]


class AnalysisSummary(TypedDict):
    parentMean: float
    candidateMean: float
    orientedMeanImprovement: float


class AnalysisCase(AnalysisSummary):
    caseId: str
    pairs: int


class AnalysisCounts(TypedDict):
    distinctCases: int
    expectedPairs: int
    comparablePairs: int
    missingPairs: int


class AnalysisInterval(TypedDict):
    lower: float
    upper: float


class MetricUncertainty(TypedDict):
    status: Literal["not_requested", "insufficient_data", "estimated", "indeterminate"]
    code: str
    interval: AnalysisInterval | None
    estimand: Literal["fixed-cases", "sampled-cases"] | None


class MetricAnalysis(TypedDict):
    evidenceGaps: NotRequired[EvidenceGaps]
    metric: AnalysisMetric
    status: Literal["descriptive", "indeterminate"]
    code: str
    counts: AnalysisCounts
    summary: AnalysisSummary | None
    cases: list[AnalysisCase]
    uncertainty: MetricUncertainty


class ComparisonAnalysis(TypedDict):
    schemaVersion: Literal[1]
    interpretation: Literal["app-asserted-fixed-case-analysis", "app-asserted-sampled-case-analysis"]
    executionAttested: Literal[False]
    aggregation: Literal["equal-case-means"]
    expectedBinding: AnalysisComparisonBinding
    graderRevision: str
    uncertaintyProtocol: PairedUncertainty | None
    metrics: list[MetricAnalysis]


class AnalysisError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__("The analysis configuration or component observation is invalid or does not match trusted evidence.")


def _record(value: Any) -> bool:
    return type(value) is dict


def _fields(value: dict, names: list[str]) -> bool:
    return set(value) == set(names)


def _string(value: Any) -> bool:
    try:
        return isinstance(value, str) and bool(value.strip()) and len(value.encode("utf-8")) <= 1024
    except UnicodeEncodeError:
        return False


def _finite(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(float(value))
    except (ValueError, OverflowError):
        return False


def _integer(value: Any) -> bool:
    return _finite(value) and float(value).is_integer()


def _arithmetic(value: float) -> float:
    if not math.isfinite(value):
        raise ArithmeticError()
    return value


def _mean(values: list[float]) -> float:
    total = 0.0
    for value in values:
        total = _arithmetic(total + float(value))
    return _arithmetic(total / len(values))


def analyze_comparison(*, comparison: Comparison, expected_descriptor: EvaluationDescriptor,
                       expected_binding: AnalysisComparisonBinding,
                       metrics: list[AnalysisMetric] | None = None,
                       observations: list[ComponentObservation] | None = None,
                       uncertainty: PairedUncertainty | None = None) -> ComparisonAnalysis:
    """Equal-case named means; optional approximate interval for these fixed tasks.

    The default scalar interpretation is higher-is-better reward units. Supply
    explicit metadata when the application's scalar has different semantics.
    Component values are never extracted or inferred from grader explanations.
    """
    if metrics is None:
        metrics = [{"id": "reward", "name": "Scalar reward", "unit": "reward", "direction": "higher", "source": "reward"}]
    if (not isinstance(metrics, list) or not 1 <= len(metrics) <= 32 or any(
        not _record(metric) or not _fields(metric, ["id", "name", "unit", "direction", "source"])
        or not all(_string(metric[name]) for name in ("id", "name", "unit"))
        or metric["direction"] not in ("higher", "lower") or metric["source"] not in ("reward", "component")
        for metric in metrics) or len({metric["id"] for metric in metrics}) != len(metrics)
        or not _record(expected_binding) or not _string(expected_binding.get("comparisonId"))):
        raise AnalysisError("analysis.invalid_config")
    protocol = uncertainty
    if protocol is not None and (
        not _record(protocol) or not _string(protocol.get("samplingProtocol"))
        or (not _fields(protocol, ["method", "estimand", "samplingProtocol", "confidenceLevel"])
            or protocol["estimand"] != "sampled-cases"
            or not (_finite(protocol["confidenceLevel"]) and protocol["confidenceLevel"] in _TWO_SIDED_T)
            if protocol.get("method") == "paired-t" else
            not _fields(protocol, ["method", "estimand", "samplingProtocol", "independentStochasticPairs",
                                   "confidenceLevel", "resamples", "seed"])
            or protocol["method"] != "paired-within-case-bootstrap" or protocol["estimand"] != "fixed-cases"
            or protocol["independentStochasticPairs"] is not True
            or not _finite(protocol["confidenceLevel"]) or not 0.8 <= protocol["confidenceLevel"] <= 0.99
            or not _integer(protocol["resamples"]) or not 100 <= protocol["resamples"] <= 10000
            or not _integer(protocol["seed"]) or not 0 <= protocol["seed"] <= 0xffffffff)
    ):
        raise AnalysisError("analysis.invalid_config")
    estimand = protocol["estimand"] if protocol is not None else None
    # Strict supported descriptor/inventory/outcome/binding validation; no gate is inferred.
    check_comparison(comparison=comparison, expected_descriptor=expected_descriptor, expected_binding=expected_binding,
                     policy={"schemaVersion": 1, "id": "analysis-validation", "revision": "1",
                             "metric": {"name": "Scalar reward", "unit": "reward", "direction": "higher"},
                             "aggregation": "equal-case-means", "minimumMeanImprovement": 0,
                             "maximumCaseRegression": 0, "requiredCases": [], "inference": {"method": "none"}})
    descriptor, binding = expected_descriptor, expected_binding
    ordered = sorted(descriptor["expectedCases"], key=lambda row: (row["caseId"].encode("utf-8"), row["repetition"]))
    expected = {(row["caseId"], row["repetition"]) for row in ordered}
    pairs = {(row["caseId"], row["repetition"]): row for row in comparison["results"]}
    observations = [] if observations is None else observations
    components = {metric["id"] for metric in metrics if metric["source"] == "component"}
    if not isinstance(observations, list) or len(observations) > len(ordered) * 2:
        raise AnalysisError("analysis.invalid_observations")
    observed = {}
    for row in observations:
        if (not _record(row) or not _fields(row, ["requestId", "attemptId", "comparisonId", "graderRevision", "caseId", "repetition",
                                                "side", "versionId", "bundleDigest", "values"])
            or not _string(row["caseId"]) or not _integer(row["repetition"]) or row["side"] not in ("parent", "candidate")
            or (row["caseId"], row["repetition"]) not in expected or not _record(row["values"]) or not row["values"]
            or any(name not in components or (value is not None and not _finite(value)) for name, value in row["values"].items())):
            raise AnalysisError("analysis.invalid_observations")
        if (row["requestId"] != binding["requestId"] or row["attemptId"] != binding["attemptId"]
            or row["comparisonId"] != binding["comparisonId"] or row["graderRevision"] != descriptor["graderRevision"]
            or row["versionId"] != binding[row["side"] + "VersionId"] or row["bundleDigest"] != binding[row["side"] + "Digest"]):
            raise AnalysisError("analysis.identity_mismatch")
        identity = (row["caseId"], row["repetition"], row["side"])
        if identity in observed:
            raise AnalysisError("analysis.invalid_observations")
        observed[identity] = row
    results: list[MetricAnalysis] = []
    for metric in metrics:
        groups: dict[str, list[dict[str, float]]] = {}
        incomplete_cases = set()
        gaps: EvidenceGaps = {"total": 0, "rows": []}
        comparable, nonfinite = 0, False
        for row in ordered:
            groups.setdefault(row["caseId"], [])
            pair = pairs.get((row["caseId"], row["repetition"]))
            values = []
            for side in ("parent", "candidate"):
                outcome = pair[side] if pair else None
                gap = _scalar_gap(outcome)
                if gap:
                    _add_gap(gaps, row["caseId"], row["repetition"], side, *gap)
                    if gap[1] == "invalid_reward" and type(outcome["reward"]) in (int, float):
                        nonfinite = True
                    values.append(None)
                    continue
                value = outcome["reward"] if metric["source"] == "reward" else observed.get(
                    (row["caseId"], row["repetition"], side), {}).get("values", {}).get(metric["id"])
                if type(value) in (int, float) and not _finite(value):
                    nonfinite = True
                if not _finite(value):
                    _add_gap(gaps, row["caseId"], row["repetition"], side, "metric", "missing_component")
                values.append(float(value) if _finite(value) else None)
            if values[0] is not None and values[1] is not None:
                comparable += 1
                groups[row["caseId"]].append({"parent": values[0], "candidate": values[1]})
            else:
                incomplete_cases.add(row["caseId"])
        result: MetricAnalysis = {"metric": dict(metric), "status": "indeterminate",
            "code": "analysis.nonfinite" if nonfinite else "evidence.incomplete",
            "counts": {"distinctCases": len(groups), "expectedPairs": len(ordered), "comparablePairs": comparable,
                       "missingPairs": len(ordered) - comparable}, "summary": None, "cases": [],
            "uncertainty": {"status": "indeterminate" if protocol else "not_requested",
                            "code": "evidence.incomplete" if protocol else "uncertainty.not_requested", "interval": None,
                            "estimand": estimand}}
        results.append(result)
        if gaps["total"]:
            result["evidenceGaps"] = gaps
        direction = 1 if metric["direction"] == "higher" else -1
        try:
            differences = []
            for case_id, rows in groups.items():
                if case_id in incomplete_cases:
                    continue
                parent_mean = _mean([row["parent"] for row in rows])
                candidate_mean = _mean([row["candidate"] for row in rows])
                result["cases"].append({"caseId": case_id, "pairs": len(rows), "parentMean": parent_mean,
                    "candidateMean": candidate_mean,
                    "orientedMeanImprovement": _arithmetic(direction * _arithmetic(candidate_mean - parent_mean))})
                differences.append([_arithmetic(direction * _arithmetic(row["candidate"] - row["parent"])) for row in rows])
            if comparable != len(ordered):
                continue
            result["summary"] = {"parentMean": _mean([row["parentMean"] for row in result["cases"]]),
                "candidateMean": _mean([row["candidateMean"] for row in result["cases"]]),
                "orientedMeanImprovement": _mean([row["orientedMeanImprovement"] for row in result["cases"]])}
            result["status"], result["code"] = "descriptive", "analysis.descriptive"
            if protocol is None:
                continue
            def insufficient(code):
                result["uncertainty"] = {"status": "insufficient_data", "code": code, "interval": None, "estimand": estimand}

            if protocol["method"] == "paired-t":
                means = [row["orientedMeanImprovement"] for row in result["cases"]]
                if len(means) < 2:
                    insufficient("uncertainty.insufficient_cases")
                    continue
                if all(value == means[0] for value in means):
                    insufficient("uncertainty.no_observed_paired_variation")
                    continue
                center = result["summary"]["orientedMeanImprovement"]
                squares = 0.0
                for value in means:
                    squares = _arithmetic(squares + _arithmetic((value - center) * (value - center)))
                half_width = _arithmetic((student_t_quantile(_TWO_SIDED_T[protocol["confidenceLevel"]], len(means) - 1)
                                          * math.sqrt(squares / (len(means) - 1))) / math.sqrt(len(means)))
                result["uncertainty"] = {"status": "estimated", "code": "uncertainty.sampled_case_t_interval",
                                         "interval": {"lower": _arithmetic(center - half_width),
                                                      "upper": _arithmetic(center + half_width)},
                                         "estimand": estimand}
                continue
            if len(groups) < 2 or any(len(rows) < MINIMUM_BOOTSTRAP_REPETITIONS for rows in differences):
                insufficient("uncertainty.insufficient_repetitions")
                continue
            if all(all(value == rows[0] for value in rows) for rows in differences):
                insufficient("uncertainty.no_observed_paired_variation")
                continue
            state = int(protocol["seed"])

            def draw(length: int) -> int:
                nonlocal state
                state = (1664525 * state + 1013904223) & 0xffffffff
                return math.floor(state / 4294967296 * length)

            # Resampling r values understates case-mean variance by (r - 1) / r; scale it back.
            centers = [_mean(rows) for rows in differences]
            factors = [math.sqrt(len(rows) / (len(rows) - 1)) for rows in differences]
            draws = []
            for _ in range(int(protocol["resamples"])):
                draws.append(_mean([
                    _arithmetic(centers[index] + factors[index] * (_mean([rows[draw(len(rows))] for _ in rows]) - centers[index]))
                    for index, rows in enumerate(differences)]))
            draws.sort()

            def quantile(p: float) -> float:
                return draws[max(0, math.ceil(p * len(draws)) - 1)]

            alpha = (1 - protocol["confidenceLevel"]) / 2
            lower, upper = quantile(alpha), quantile(1 - alpha)
            result["uncertainty"] = (
                {"status": "insufficient_data", "code": "uncertainty.degenerate_resamples", "interval": None,
                 "estimand": estimand} if lower == upper else
                {"status": "estimated", "code": "uncertainty.approximate_fixed_case_interval",
                 "interval": {"lower": lower, "upper": upper}, "estimand": estimand})
        except (ArithmeticError, OverflowError):
            result["status"], result["code"], result["summary"], result["cases"] = "indeterminate", "analysis.nonfinite", None, []
            result["uncertainty"] = {"status": "indeterminate" if protocol else "not_requested",
                "code": "analysis.nonfinite" if protocol else "uncertainty.not_requested", "interval": None,
                "estimand": estimand}
    return {"schemaVersion": 1,
        "interpretation": "app-asserted-sampled-case-analysis" if estimand == "sampled-cases"
        else "app-asserted-fixed-case-analysis", "executionAttested": False,
        "aggregation": "equal-case-means", "expectedBinding": dict(binding), "graderRevision": descriptor["graderRevision"],
        "uncertaintyProtocol": dict(protocol) if protocol is not None else None, "metrics": results}
