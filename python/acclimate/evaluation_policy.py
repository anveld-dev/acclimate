"""Pure descriptive comparison policy. No transport, filesystem, or execution access."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any, Literal, NotRequired, TypedDict
from ._evaluation_shared import EvaluationError

from ._student_t import is_confidence_level, student_t_quantile


class RewardScale(TypedDict):
    minimum: float
    maximum: float


class EvaluationMetric(TypedDict):
    name: str
    unit: str
    direction: Literal["higher", "lower"]
    scale: NotRequired[RewardScale]


class EvaluationCostPolicy(TypedDict, total=False):
    maximumCandidateUsd: float
    maximumIncreaseUsd: float


class PolicyInference(TypedDict):
    """``paired-t`` (default) treats cases as a sample; ``none`` compares point estimates only."""

    method: Literal["paired-t", "none"]
    confidence: NotRequired[float]
    minCases: NotRequired[int]
    minRepetitions: NotRequired[int]
    sdFloor: NotRequired[float]
    maximumMissingPercent: NotRequired[int]


class EvaluationPolicyV1(TypedDict):
    schemaVersion: Literal[1, 2, 3]
    id: str
    revision: str
    metric: EvaluationMetric
    aggregation: Literal["equal-case-means"]
    minimumMeanImprovement: float
    maximumCaseRegression: float
    candidateThreshold: NotRequired[float]
    requiredCases: list[str]
    maximumCandidateTaskFailures: NotRequired[int]
    cost: NotRequired[EvaluationCostPolicy]
    protectedCaseThresholds: NotRequired[dict[str, float]]
    minimumCostSavingsUsd: NotRequired[float]
    minimumRepetitionsPerCase: NotRequired[int]
    nonInferiorityMargin: NotRequired[float]
    stepMargin: NotRequired[float]
    auditMode: NotRequired[Literal["non-inferiority", "superiority"]]
    targetEffect: NotRequired[float]
    inference: NotRequired[PolicyInference]
    perCaseChecks: NotRequired[Literal["all-cases", "protected-cases"]]


EvaluationPolicy = EvaluationPolicyV1

RESERVED_POLICY_IDS = ("connected-development", "connected-audit")
DEFAULT_INFERENCE = {"method": "paired-t", "confidence": 0.95, "minCases": 10, "minRepetitions": 1,
                     "sdFloorScaleFraction": 0.1, "maximumMissingPercent": 15}
CONNECTED_POLICY_DEFAULTS = {
    stage: {"inference": {"method": "paired-t", "confidence": confidence, "minCases": 2, "minRepetitions": 1,
                          "sdFloor": 0, "maximumMissingPercent": 15},
            "perCaseChecks": "protected-cases", "scale": {"minimum": 0, "maximum": 1}}
    for stage, confidence in (("development", 0.9), ("audit", 0.95))
}


class ExpectedComparisonBinding(TypedDict):
    parentVersionId: str
    candidateVersionId: str
    parentDigest: str
    candidateDigest: str
    requestId: str
    attemptId: str
    comparisonId: NotRequired[str]
    submitter: NotRequired[str]


class PolicyCheck(TypedDict):
    code: str
    result: Literal["pass", "fail", "unknown"]


class EvidenceGap(TypedDict):
    caseId: str
    repetition: int
    side: str
    stage: str
    reason: str


class EvidenceGaps(TypedDict):
    total: int
    rows: list[EvidenceGap]


def _add_gap(gaps: EvidenceGaps, case_id: str, repetition: int, side: str, stage: str, reason: str) -> None:
    gaps["total"] += 1
    if len(gaps["rows"]) < 32:
        gaps["rows"].append({"caseId": case_id, "repetition": repetition, "side": side,
                             "stage": stage, "reason": reason})


def _scalar_gap(outcome):
    if outcome is None:
        return "collection", "missing_pair"
    if outcome["executionStatus"] == "infrastructure_failed":
        code = outcome["error"]
        return "execute", code if code in ("output_invalid", "output_reference_invalid", "cancelled", "execution_failed", "not_selected", "timeout", "deadline_exceeded", "cost_limit_reached") else "infrastructure_failed"
    if outcome["gradingStatus"] == "failed":
        return "grade", "grading_failed"
    if outcome["gradingStatus"] == "missing":
        return ("execute", "task_failed") if outcome["executionStatus"] == "task_failed" else ("grade", "missing_grade")
    if not _finite(outcome["reward"]):
        return "grade", "invalid_reward"
    return None


class PolicyCounts(TypedDict):
    distinctCases: int
    expectedPairs: int
    comparablePairs: int


class PolicySummary(TypedDict):
    parentMean: float | None
    candidateMean: float | None
    orientedMeanImprovement: float | None
    worstCaseRegression: float | None
    candidateTaskFailures: int
    protectedCandidateTaskFailures: int
    parentTaskFailures: int
    parentCostUsd: float | None
    candidateCostUsd: float | None
    costIncreaseUsd: float | None
    parentUnknownCosts: int
    candidateUnknownCosts: int


class PolicyIdentity(TypedDict):
    id: str
    revision: str
    sha256: str | None


class PolicyInferenceResult(TypedDict):
    method: Literal["paired-t", "none"]
    estimand: Literal["sampled-cases", "observed-cases"]
    status: Literal["estimated", "insufficient_data", "incomplete", "not_applicable"]
    stage: Literal["general", "development", "cumulative", "audit"]
    check: str
    confidence: float | None
    threshold: float
    thresholdSource: Literal["minimumMeanImprovement", "stepMargin", "nonInferiorityMargin"]
    n: int
    minCases: int
    minRepetitions: int
    repetitions: int
    meanDifference: float | None
    sd: float | None
    sdFloor: float | None
    sdFloorSource: Literal["declared", "scale", "observed-range"] | None
    calibratedSd: float | None
    sdUsed: float | None
    standardError: float | None
    df: int | None
    criticalValue: float | None
    lowerBound: float | None
    imputed: dict[str, int]
    maximumMissingPercent: int


class PolicyVerdict(TypedDict):
    evidenceGaps: NotRequired[EvidenceGaps]
    schemaVersion: Literal[1]
    verdict: Literal["pass", "fail", "indeterminate"]
    code: str
    policy: PolicyIdentity
    comparisonId: str
    expectedBinding: ExpectedComparisonBinding
    checks: list[PolicyCheck]
    counts: PolicyCounts
    summary: PolicySummary
    perCaseChecks: Literal["all-cases", "protected-cases"]
    inference: PolicyInferenceResult
    interpretation: Literal["descriptive-policy-check", "statistical-policy-check"]


class ParsedEvaluationPolicy(TypedDict):
    policy: EvaluationPolicyV1
    sha256: str


_REQUIRED_POLICY_FIELDS = ("schemaVersion", "id", "revision", "metric", "aggregation", "minimumMeanImprovement",
                           "maximumCaseRegression", "requiredCases")
_REQUIRED_METRIC_FIELDS = ("name", "unit", "direction")
_PUBLIC_POLICY_FIELDS = {*_REQUIRED_POLICY_FIELDS, *("metric." + key for key in _REQUIRED_METRIC_FIELDS)}


class PolicyError(EvaluationError, ValueError):
    """A fixed safe category; never carries a source value, path or raw parser error.

    ``field`` and ``reason`` may name a misspelled or unexpected policy field.
    """

    phase = "policy"
    executionState = "finished"
    nextAction = "fix_config"

    def __init__(self, code: str, missing_fields=(), *, field: str | None = None, reason: str | None = None):
        message = {
            "policy.invalid": "The evaluation policy or trusted inventory is invalid.",
            "policy.inventory_incompatible": "The policy requires cases absent from the trusted evaluation inventory.",
            "evidence.identity_mismatch": "The comparison does not match the expected evaluation identity.",
            "evidence.malformed": "The comparison evidence is malformed.",
            "evidence.reward_out_of_range": "A scored reward is outside the reward scale declared by the policy.",
        }.get(code, "The evaluation policy could not be checked.")
        if field:
            message += f" {field}" + (f": {reason}" if reason else "")
        super().__init__(code, phase="policy", execution_state="finished", next_action="fix_config",  # type: ignore[arg-type]
                         field=field, reason=reason, message=message,
                         missing_fields=[key for key in missing_fields if key in _PUBLIC_POLICY_FIELDS])


def _record(value: Any) -> bool:
    return type(value) is dict


def _string(value: Any, limit: int = 1024) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        return len(value.encode("utf-8")) <= limit
    except UnicodeEncodeError:
        return False


def _finite(value: Any) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _nonnegative(value: Any) -> bool:
    return _finite(value) and value >= 0


def _integer(value: Any) -> bool:
    return _finite(value) and float(value).is_integer()


def _fields(value: dict, allowed: list[str], required: list[str]) -> bool:
    return all(key in allowed for key in value) and all(key in value for key in required)


def _descriptor(value: Any) -> dict:
    if (not _record(value)
        or not _fields(value, ["datasetRevision", "graderRevision", "runtime", "expectedCases"],
                       ["datasetRevision", "graderRevision", "runtime", "expectedCases"])
        or not _string(value["datasetRevision"]) or not _string(value["graderRevision"])
        or not _record(value["runtime"]) or not 1 <= len(value["runtime"]) <= 64
        or not all(_string(key, 128) and _string(item, 4096) for key, item in value["runtime"].items())
        or not _string(value["runtime"].get("configId"), 128)
        or not _string(value["runtime"].get("configRevision"))
        or not isinstance(value["expectedCases"], list) or not 1 <= len(value["expectedCases"]) <= 1000):
        raise ValueError()
    seen = set()
    for item in value["expectedCases"]:
        if (not _record(item) or not _fields(item, ["caseId", "repetition"], ["caseId", "repetition"])
            or not _string(item["caseId"]) or not _integer(item["repetition"])
            or not 0 <= item["repetition"] <= 0xffffffff):
            raise ValueError()
        key = (item["caseId"], item["repetition"])
        if key in seen:
            raise ValueError()
        seen.add(key)
    return value


def _integer_in(value: Any, minimum: int, maximum: int) -> bool:
    return _integer(value) and minimum <= value <= maximum


def _validate_inference(value: Any) -> dict:
    allowed = ["method", "confidence", "minCases", "minRepetitions", "sdFloor", "maximumMissingPercent"]
    if (not _record(value) or not _fields(value, allowed, ["method"])
            or value["method"] not in ("paired-t", "none")
            or (value["method"] == "none" and ("confidence" in value or "sdFloor" in value))
            or ("confidence" in value and not is_confidence_level(value["confidence"]))
            or ("minCases" in value and not _integer_in(value["minCases"], 2 if value["method"] == "paired-t" else 1, 1000))
            or ("minRepetitions" in value and not _integer_in(value["minRepetitions"], 1, 1000))
            or ("sdFloor" in value and not _nonnegative(value["sdFloor"]))
            or ("maximumMissingPercent" in value and not _integer_in(value["maximumMissingPercent"], 0, 50))):
        raise PolicyError("policy.invalid")
    result: dict = {"method": value["method"]}
    if "confidence" in value:
        result["confidence"] = value["confidence"]
    for name in ("minCases", "minRepetitions", "maximumMissingPercent"):
        if name in value:
            result[name] = int(value[name])
    if "sdFloor" in value:
        result["sdFloor"] = value["sdFloor"]
    return result


def validate_evaluation_policy(value: Any, expected_descriptor: dict | None = None, *,
                               connected: bool = False) -> EvaluationPolicyV1:
    """Validate a policy. ``connected=True`` accepts the service's reserved connected-learning ids."""
    if not _record(value):
        raise PolicyError("policy.invalid")
    missing = [key for key in _REQUIRED_POLICY_FIELDS if key not in value]
    if _record(value.get("metric")):
        missing.extend("metric." + key for key in _REQUIRED_METRIC_FIELDS if key not in value["metric"])
    if missing:
        raise PolicyError("policy.invalid", missing)
    allowed = [*_REQUIRED_POLICY_FIELDS, "candidateThreshold", "maximumCandidateTaskFailures", "cost",
               "protectedCaseThresholds", "minimumCostSavingsUsd", "minimumRepetitionsPerCase",
               "nonInferiorityMargin", "stepMargin", "auditMode", "targetEffect", "inference", "perCaseChecks"]
    version = value["schemaVersion"]
    metric = value["metric"]
    if (not _fields(value, allowed, []) or type(version) is not int or version not in (1, 2, 3)
        or any(value.get(name) is not None and (version != 3 or not _nonnegative(value[name]) or value[name] > 1)
               for name in ("stepMargin", "targetEffect"))
        or (value.get("auditMode") is not None
            and (version != 3 or value["auditMode"] not in ("non-inferiority", "superiority")))
        or (value.get("nonInferiorityMargin") is not None
            and (version == 1 or not _nonnegative(value["nonInferiorityMargin"])))
        or not _string(value["id"], 128) or (not connected and value["id"] in RESERVED_POLICY_IDS)
        or not _string(value["revision"])
        or value["aggregation"] != "equal-case-means"
        or not _finite(value["minimumMeanImprovement"]) or not _nonnegative(value["maximumCaseRegression"])
        or not _record(metric)
        or not _fields(metric, ["name", "unit", "direction", "scale", "component"], ["name", "unit", "direction"])
        or ("component" in metric and (not isinstance(metric["component"], str)
                                       or not _COMPONENT_NAME.fullmatch(metric["component"])))
        or not _string(metric["name"], 128) or not _string(metric["unit"], 128)
        or metric["direction"] not in ("higher", "lower")
        or ("scale" in metric and (
            not _record(metric["scale"]) or not _fields(metric["scale"], ["minimum", "maximum"], ["minimum", "maximum"])
            or not _finite(metric["scale"]["minimum"]) or not _finite(metric["scale"]["maximum"])
            or not metric["scale"]["maximum"] > metric["scale"]["minimum"]
            or not math.isfinite(metric["scale"]["maximum"] - metric["scale"]["minimum"])))
        or (value.get("perCaseChecks") is not None and value["perCaseChecks"] not in ("all-cases", "protected-cases"))
        or not isinstance(value["requiredCases"], list) or len(value["requiredCases"]) > 1000
        or not all(_string(item) for item in value["requiredCases"])):
        raise PolicyError("policy.invalid")
    if len(set(value["requiredCases"])) != len(value["requiredCases"]):
        raise PolicyError("policy.invalid")
    if value.get("candidateThreshold") is not None and not _finite(value["candidateThreshold"]):
        raise PolicyError("policy.invalid")
    if value.get("maximumCandidateTaskFailures") is not None and (
        not _integer(value["maximumCandidateTaskFailures"])
        or not 0 <= value["maximumCandidateTaskFailures"] <= 2**53 - 1
    ):
        raise PolicyError("policy.invalid")
    if value.get("minimumCostSavingsUsd") is not None and not _nonnegative(value["minimumCostSavingsUsd"]):
        raise PolicyError("policy.invalid")
    if value.get("minimumRepetitionsPerCase") is not None and not _integer_in(value["minimumRepetitionsPerCase"], 1, 1000):
        raise PolicyError("policy.invalid")
    inference = _validate_inference(value["inference"]) if value.get("inference") is not None else None
    if value.get("cost") is not None and (
        not _record(value["cost"]) or not value["cost"]
        or not _fields(value["cost"], ["maximumCandidateUsd", "maximumIncreaseUsd"], [])
        or not any(_nonnegative(item) for item in value["cost"].values())
        or not all(item is None or _nonnegative(item) for item in value["cost"].values())
    ):
        raise PolicyError("policy.invalid")
    thresholds = None
    if "protectedCaseThresholds" in value:
        thresholds = value["protectedCaseThresholds"]
        if (not _record(thresholds) or len(thresholds) > 1000
                or not all(_string(key) and _finite(item) for key, item in thresholds.items())):
            raise PolicyError("policy.invalid")
    if expected_descriptor is not None:
        try:
            descriptor = _descriptor(expected_descriptor)
        except (ValueError, TypeError, KeyError):
            raise PolicyError("policy.invalid") from None
        counts: dict[str, int] = {}
        for item in descriptor["expectedCases"]:
            counts[item["caseId"]] = counts.get(item["caseId"], 0) + 1
        if (any(item not in counts for item in [*value["requiredCases"], *(thresholds or {})])
                or (value.get("minimumRepetitionsPerCase") is not None
                    and any(count < value["minimumRepetitionsPerCase"] for count in counts.values()))):
            raise PolicyError("policy.inventory_incompatible")
    result: dict = {"schemaVersion": version}
    if version == 3:
        for name in ("stepMargin", "targetEffect", "auditMode"):
            if value.get(name) is not None:
                result[name] = value[name]
    if version != 1 and value.get("nonInferiorityMargin") is not None:
        result["nonInferiorityMargin"] = value["nonInferiorityMargin"]
    result_metric = {"name": metric["name"], "unit": metric["unit"], "direction": metric["direction"]}
    if "scale" in metric:
        result_metric["scale"] = {"minimum": metric["scale"]["minimum"], "maximum": metric["scale"]["maximum"]}
    if "component" in metric:
        result_metric["component"] = metric["component"]
    result.update({
        "id": value["id"], "revision": value["revision"], "metric": result_metric,
        "aggregation": "equal-case-means",
        "minimumMeanImprovement": float(value["minimumMeanImprovement"]),
        "maximumCaseRegression": float(value["maximumCaseRegression"]),
        "requiredCases": list(value["requiredCases"]),
    })
    if value.get("candidateThreshold") is not None:
        result["candidateThreshold"] = float(value["candidateThreshold"])
    if value.get("maximumCandidateTaskFailures") is not None:
        result["maximumCandidateTaskFailures"] = int(value["maximumCandidateTaskFailures"])
    if value.get("cost") is not None:
        result["cost"] = {key: float(item) for key, item in value["cost"].items() if item is not None}
    if thresholds:
        result["protectedCaseThresholds"] = dict(thresholds)
    if value.get("minimumCostSavingsUsd") is not None:
        result["minimumCostSavingsUsd"] = value["minimumCostSavingsUsd"]
    if value.get("minimumRepetitionsPerCase") is not None:
        result["minimumRepetitionsPerCase"] = int(value["minimumRepetitionsPerCase"])
    if inference is not None:
        result["inference"] = inference
    if value.get("perCaseChecks") is not None:
        result["perCaseChecks"] = value["perCaseChecks"]
    return result  # type: ignore[return-value]


def resolve_inference(policy: EvaluationPolicyV1) -> dict:
    """Fill omitted inference fields with the documented defaults."""
    declared = policy.get("inference") or {"method": "paired-t"}
    statistical = declared["method"] == "paired-t"
    result = {
        "method": declared["method"],
        "confidence": declared.get("confidence", DEFAULT_INFERENCE["confidence"]),
        "minCases": declared.get("minCases", DEFAULT_INFERENCE["minCases"] if statistical else 1),
        "minRepetitions": declared.get("minRepetitions", DEFAULT_INFERENCE["minRepetitions"]),
        "maximumMissingPercent": declared.get(
            "maximumMissingPercent", DEFAULT_INFERENCE["maximumMissingPercent"] if statistical else 0),
    }
    if "sdFloor" in declared:
        result["sdFloor"] = declared["sdFloor"]
    return result


def parse_evaluation_policy(text: str, expected_descriptor: dict | None = None, *,
                            connected: bool = False) -> ParsedEvaluationPolicy:
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError()

    try:
        if not isinstance(text, str):
            raise ValueError()
        encoded = text.encode("utf-8")
        if len(encoded) > 2 * 1024 * 1024:
            raise ValueError()
        value = json.loads(text, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    except (ValueError, TypeError, UnicodeEncodeError, RecursionError):
        raise PolicyError("policy.invalid") from None
    return {"policy": validate_evaluation_policy(value, expected_descriptor, connected=connected),
            "sha256": "sha256:" + hashlib.sha256(encoded).hexdigest()}


#: Names of grade components on the wire, such as ``correctness`` or ``rubric.citations``.
_COMPONENT_NAME = re.compile(r"[A-Za-z0-9_.:-]{1,64}")


def _component_pair(pair: dict, component: str) -> dict:
    """Read a named grade component as the pair's metric without changing the input.

    A scored arm without the component becomes missing evidence (``missing_component``).
    """
    def arm(outcome):
        if outcome["gradingStatus"] != "scored":
            return outcome
        value = (outcome.get("components") or {}).get(component)
        if _finite(value):
            return {**outcome, "reward": value}
        return {**outcome, "gradingStatus": "missing", "reward": None, "error": "missing_component"}
    return {**pair, "parent": arm(pair["parent"]), "candidate": arm(pair["candidate"])}


def check_comparison(*, comparison: dict, expected_descriptor: dict,
                     expected_binding: ExpectedComparisonBinding, policy: EvaluationPolicyV1,
                     policy_digest: str | None = None,
                     stage: Literal["development", "cumulative", "audit"] | None = None,
                     replay_passed: bool | None = None,
                     calibrated_standard_deviation: float | None = None,
                     calibration_effective_repetitions: float | None = None) -> PolicyVerdict:
    """Check a comparison against a policy.

    Without ``stage`` the mean-difference check compares the bound with ``minimumMeanImprovement``.
    Connected learning passes ``stage`` to select its threshold; the policy id never changes the
    calculation. The algorithm matches the TypeScript ``checkComparison`` bit for bit.
    """
    try:
        descriptor = _descriptor(expected_descriptor)
    except (ValueError, TypeError, KeyError):
        raise PolicyError("policy.invalid") from None
    policy = validate_evaluation_policy(policy, descriptor, connected=stage is not None)
    if ((stage is not None and stage not in ("development", "cumulative", "audit"))
            or (replay_passed is not None and type(replay_passed) is not bool)):
        raise PolicyError("policy.invalid")
    binding = expected_binding
    if (not _record(binding) or not _fields(binding,
        ["parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest", "requestId", "attemptId", "comparisonId", "submitter"],
        ["parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest", "requestId", "attemptId"])
        or not all(_string(item) for item in binding.values())
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", binding["parentDigest"])
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", binding["candidateDigest"])
        or (policy_digest is not None and (not isinstance(policy_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", policy_digest)))):
        raise PolicyError("policy.invalid")
    if (not _record(comparison) or not _fields(comparison,
        ["id", "complete", "submitter", "createdAt", "parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest",
         "datasetRevision", "graderRevision", "runtime", "expectedCases", "results", "evaluation"],
        ["id", "complete", "submitter", "createdAt", "parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest",
         "datasetRevision", "graderRevision", "runtime", "expectedCases", "results"])
        or not _string(comparison["id"], 128) or not _string(comparison["submitter"])
        or not _string(comparison["createdAt"], 128) or type(comparison["complete"]) is not bool
        or not isinstance(comparison["results"], list) or len(comparison["results"]) > 1000):
        raise PolicyError("evidence.malformed")
    if any(comparison[name] != binding[name] for name in ["parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest"]):
        raise PolicyError("evidence.identity_mismatch")
    if (("comparisonId" in binding and comparison["id"] != binding["comparisonId"])
        or ("submitter" in binding and comparison["submitter"] != binding["submitter"])
        or not _record(comparison.get("evaluation"))
        or not _fields(comparison["evaluation"], ["requestId", "attemptId"], ["requestId", "attemptId"])
        or comparison["evaluation"]["requestId"] != binding["requestId"]
        or comparison["evaluation"]["attemptId"] != binding["attemptId"]):
        raise PolicyError("evidence.identity_mismatch")
    try:
        observed_descriptor = _descriptor({name: comparison[name] for name in ["datasetRevision", "graderRevision", "runtime", "expectedCases"]})
    except (ValueError, TypeError, KeyError):
        raise PolicyError("evidence.malformed") from None
    if (any(observed_descriptor[name] != descriptor[name] for name in ["datasetRevision", "graderRevision", "runtime"])
        or {(item["caseId"], item["repetition"]) for item in observed_descriptor["expectedCases"]}
        != {(item["caseId"], item["repetition"]) for item in descriptor["expectedCases"]}):
        raise PolicyError("evidence.identity_mismatch")
    expected = {(item["caseId"], item["repetition"]): item for item in descriptor["expectedCases"]}
    pairs = {}
    for pair in comparison["results"]:
        if (not _record(pair) or not _fields(pair, ["caseId", "repetition", "parent", "candidate"], ["caseId", "repetition", "parent", "candidate"])
            or not _string(pair["caseId"]) or not _integer(pair["repetition"]) or not 0 <= pair["repetition"] <= 0xffffffff):
            raise PolicyError("evidence.malformed")
        key = (pair["caseId"], pair["repetition"])
        if key not in expected or key in pairs:
            raise PolicyError("evidence.malformed")
        for outcome in (pair["parent"], pair["candidate"]):
            if (not _record(outcome)
                or not _fields(outcome, ["executionStatus", "gradingStatus", "reward", "outputRef", "error", "usage", "components"],
                               ["executionStatus", "gradingStatus", "reward", "outputRef", "error", "usage"])
                or ("components" in outcome and (
                    not _record(outcome["components"]) or outcome["gradingStatus"] != "scored"
                    or len(outcome["components"]) > 32
                    or not all(isinstance(name, str) and _COMPONENT_NAME.fullmatch(name) and _finite(item)
                               for name, item in outcome["components"].items())))
                or outcome["executionStatus"] not in ("completed", "task_failed", "infrastructure_failed")
                or outcome["gradingStatus"] not in ("scored", "missing", "failed")
                or (outcome["reward"] is not None and type(outcome["reward"]) not in (int, float))
                or (outcome["outputRef"] is not None and not isinstance(outcome["outputRef"], str))
                or (outcome["error"] is not None and not isinstance(outcome["error"], str))
                or (outcome["usage"] is not None and (not _record(outcome["usage"])
                    or not _fields(outcome["usage"], ["inputTokens", "outputTokens", "costUsd"], [])
                    or not all(_nonnegative(item) for item in outcome["usage"].values())))):
                raise PolicyError("evidence.malformed")
            if outcome["gradingStatus"] != "scored" and outcome["reward"] is not None:
                raise PolicyError("evidence.malformed")
        pairs[key] = _component_pair(pair, policy["metric"]["component"]) if policy["metric"].get("component") else pair
    ordered = sorted(expected, key=lambda item: (item[0].encode("utf-8"), item[1]))

    def usable(outcome) -> bool:
        return outcome is not None and outcome["executionStatus"] != "infrastructure_failed" and _finite(outcome["reward"])

    comparable = [key for key in ordered if key in pairs and all(
        usable(item) and item["gradingStatus"] == "scored" for item in (pairs[key]["parent"], pairs[key]["candidate"]))]
    repetitions_by_case: dict[str, int] = {}
    for key in ordered:
        repetitions_by_case[key[0]] = repetitions_by_case.get(key[0], 0) + 1
    distinct_cases = len(repetitions_by_case)
    gaps: EvidenceGaps = {"total": 0, "rows": []}
    cost_policy = policy.get("cost", {})
    for key in ordered:
        for side in ("parent", "candidate"):
            outcome = pairs.get(key, {}).get(side)
            gap = _scalar_gap(outcome)
            if gap:
                _add_gap(gaps, *key, side, *gap)
            if (outcome and "costUsd" not in (outcome["usage"] or {}) and
                ("maximumIncreaseUsd" in cost_policy or (side == "candidate" and "maximumCandidateUsd" in cost_policy))):
                _add_gap(gaps, *key, side, "usage", "missing_cost")
    settings = resolve_inference(policy)
    statistical = settings["method"] == "paired-t"
    stage_name = stage or "general"
    audit = stage_name == "audit"
    version = policy["schemaVersion"]
    modern = version == 3
    if audit and (not modern or policy.get("auditMode") != "superiority"):
        margin = 0 if version == 1 else policy.get("nonInferiorityMargin", 0.03 if modern else 0)
        decision = {"check": "policy.non_inferiority", "threshold": -margin,
                    "thresholdSource": "nonInferiorityMargin"}
    elif modern and stage_name == "development":
        decision = {"check": "policy.step_non_inferiority", "threshold": -policy.get("stepMargin", 0.03),
                    "thresholdSource": "stepMargin"}
    else:
        decision = {"check": "policy.minimum_mean_improvement", "threshold": policy["minimumMeanImprovement"],
                    "thresholdSource": "minimumMeanImprovement"}
    per_case_checks = policy.get("perCaseChecks", "all-cases")
    inference: PolicyInferenceResult = {
        "method": settings["method"], "estimand": "sampled-cases" if statistical else "observed-cases",
        "status": "incomplete", "stage": stage_name, **decision,  # type: ignore[typeddict-item]
        "confidence": settings["confidence"] if statistical else None,
        "n": distinct_cases, "minCases": settings["minCases"], "minRepetitions": settings["minRepetitions"],
        "repetitions": min(repetitions_by_case.values()),
        "meanDifference": None, "sd": None, "sdFloor": None, "sdFloorSource": None, "calibratedSd": None,
        "sdUsed": None, "standardError": None, "df": None, "criticalValue": None, "lowerBound": None,
        "imputed": {"parent": 0, "candidate": 0}, "maximumMissingPercent": settings["maximumMissingPercent"],
    }
    result: PolicyVerdict = {"schemaVersion": 1, "verdict": "indeterminate", "code": "evidence.incomplete",
              "policy": {"id": policy["id"], "revision": policy["revision"], "sha256": policy_digest},
              "comparisonId": comparison["id"], "expectedBinding": dict(binding), "checks": [],
              "counts": {"distinctCases": distinct_cases, "expectedPairs": len(ordered), "comparablePairs": len(comparable)},
              "summary": {"parentMean": None, "candidateMean": None, "orientedMeanImprovement": None,
                          "worstCaseRegression": None, "candidateTaskFailures": 0,
                          "protectedCandidateTaskFailures": 0, "parentTaskFailures": 0,
                          "parentCostUsd": None, "candidateCostUsd": None, "costIncreaseUsd": None,
                          "parentUnknownCosts": 0, "candidateUnknownCosts": 0},
              "perCaseChecks": per_case_checks, "inference": inference,
              "interpretation": "statistical-policy-check" if statistical else "descriptive-policy-check"}
    if gaps["total"]:
        result = {"evidenceGaps": gaps, **result}  # type: ignore[assignment]
    summary = result["summary"]
    for side in ("parent", "candidate"):
        summary[side + "UnknownCosts"] = len([key for key in ordered if key not in pairs or pairs[key][side]["usage"] is None
                                              or "costUsd" not in pairs[key][side]["usage"]])
    thresholds = policy.get("protectedCaseThresholds", {})

    def protected_case(case_id: str) -> bool:
        return case_id in policy["requiredCases"] or case_id in thresholds

    def task_failed(outcome) -> bool:
        return outcome is not None and (outcome["executionStatus"] == "task_failed" or not usable(outcome))

    def failures(side, only=None) -> int:
        return len([key for key in ordered if (only is None or only(key[0]))
                    and task_failed(pairs.get(key, {}).get(side))])

    summary["candidateTaskFailures"] = failures("candidate")
    summary["protectedCandidateTaskFailures"] = failures("candidate", protected_case)
    summary["parentTaskFailures"] = failures("parent")

    def missing(side) -> int:
        return len([key for key in ordered if not usable(pairs.get(key, {}).get(side))])

    if (len(pairs) != len(ordered)
            or any(missing(side) * 100 > len(ordered) * settings["maximumMissingPercent"] for side in ("parent", "candidate"))):
        result["checks"].append({"code": "evidence.incomplete", "result": "unknown"})
        return result
    inference["imputed"] = {"parent": missing("parent"), "candidate": missing("candidate")}

    def total(values):
        number = +0.0
        for item in values:
            number = number + float(item)
            if not math.isfinite(number):
                raise ArithmeticError()
        return number

    def mean(values):
        value = total(values) / len(values)
        if not math.isfinite(value):
            raise ArithmeticError()
        return value

    def arithmetic(value):
        if not math.isfinite(value):
            raise ArithmeticError()
        return value

    def check(code, passed):
        result["checks"].append({"code": code, "result": "pass" if passed else "fail"})

    scale = policy["metric"].get("scale")
    minimum, maximum = math.inf, -math.inf
    for key in ordered:
        for outcome in (pairs[key]["parent"], pairs[key]["candidate"]):
            if not usable(outcome):
                continue
            reward = outcome["reward"]
            if scale is not None and (reward < scale["minimum"] or reward > scale["maximum"]):
                raise PolicyError("evidence.reward_out_of_range")
            minimum, maximum = min(minimum, reward), max(maximum, reward)

    try:
        groups: dict[str, list] = {}
        for key in ordered:
            groups.setdefault(key[0], []).append(pairs[key])
        parent_means, candidate_means, improvements = [], [], []
        orientation = 1 if policy["metric"]["direction"] == "higher" else -1
        worst_reward = minimum if orientation > 0 else maximum
        best_reward = maximum if orientation > 0 else minimum

        def reward_of(outcome, fallback):
            return outcome["reward"] if usable(outcome) else fallback

        checked_regression = 0
        for case_id, rows in groups.items():
            parent = mean([reward_of(row["parent"], best_reward) for row in rows])
            candidate = mean([reward_of(row["candidate"], worst_reward) for row in rows])
            gain = arithmetic(orientation * arithmetic(candidate - parent))
            parent_means.append(parent)
            candidate_means.append(candidate)
            improvements.append(gain)
            if per_case_checks == "all-cases" or protected_case(case_id):
                checked_regression = max(checked_regression, -gain)
            if case_id in thresholds:
                check("policy.protected_case_threshold", all(
                    row["candidate"]["executionStatus"] == "completed" and usable(row["candidate"])
                    and orientation * row["candidate"]["reward"] >= orientation * thresholds[case_id]
                    for row in rows))
        parent_mean, candidate_mean, improvement = mean(parent_means), mean(candidate_means), mean(improvements)
        summary.update(parentMean=parent_mean, candidateMean=candidate_mean, orientedMeanImprovement=improvement,
                       worstCaseRegression=max(0, *(-value for value in improvements)))
        n = len(improvements)
        inference["meanDifference"] = improvement
        if n < 2:
            sd = None
        elif all(gain == improvements[0] for gain in improvements):
            sd = 0
        else:
            sd = math.sqrt(total([(gain - improvement) * (gain - improvement) for gain in improvements]) / (n - 1))
        inference["sd"] = sd
        insufficient = []
        if n < settings["minCases"]:
            insufficient.append("inference.minimum_cases")
        if inference["repetitions"] < settings["minRepetitions"]:
            insufficient.append("inference.minimum_repetitions")
        if not statistical:
            inference["status"] = "not_applicable"
            passed = improvement >= decision["threshold"]
        else:
            calibrated = 0 if calibrated_standard_deviation is None else calibrated_standard_deviation
            if not _nonnegative(calibrated):
                raise ArithmeticError()
            if calibration_effective_repetitions is not None:
                if not _nonnegative(calibration_effective_repetitions):
                    raise ArithmeticError()
                inverse_repetitions = total([1 / len(rows) for rows in groups.values()])
                evaluated = len(groups) / inverse_repetitions
                calibrated *= math.sqrt(calibration_effective_repetitions / evaluated)
            inference["calibratedSd"] = None if calibrated_standard_deviation is None else calibrated
            if "sdFloor" in settings:
                floor, source = settings["sdFloor"], "declared"
            elif scale is not None:
                floor, source = 0.1 * (scale["maximum"] - scale["minimum"]), "scale"
            else:
                floor, source = 0.1 * arithmetic(maximum - minimum), "observed-range"
            inference["sdFloor"], inference["sdFloorSource"] = floor, source  # type: ignore[typeddict-item]
            if n >= 2:
                used = max(sd or 0, floor, calibrated)
                critical = student_t_quantile(settings["confidence"], n - 1)
                inference.update(sdUsed=used, df=n - 1, criticalValue=critical, standardError=used / math.sqrt(n))
                if used == 0:
                    insufficient.append("inference.zero_variance")
                else:
                    inference["lowerBound"] = arithmetic(improvement - (critical * used) / math.sqrt(n))
            inference["status"] = "insufficient_data" if insufficient else "estimated"
            passed = None if insufficient else inference["lowerBound"] > decision["threshold"]
        if insufficient:
            passed = None
            for code in insufficient:
                result["checks"].append({"code": code, "result": "unknown"})
            inference["status"] = "insufficient_data"
        if passed is not None:
            check(decision["check"], passed)
        check("policy.maximum_case_regression", checked_regression <= policy["maximumCaseRegression"])
        if "candidateThreshold" in policy:
            check("policy.candidate_threshold",
                  arithmetic(orientation * candidate_mean) >= arithmetic(orientation * policy["candidateThreshold"]))
        if "maximumCandidateTaskFailures" in policy:
            counted = summary["candidateTaskFailures"] if per_case_checks == "all-cases" else summary["protectedCandidateTaskFailures"]
            check("policy.maximum_candidate_task_failures", counted <= policy["maximumCandidateTaskFailures"])
        for side in ("parent", "candidate"):
            if summary[side + "UnknownCosts"] == 0:
                summary[side + "CostUsd"] = total([pairs[key][side]["usage"]["costUsd"] for key in ordered])
        if summary["parentCostUsd"] is not None and summary["candidateCostUsd"] is not None:
            summary["costIncreaseUsd"] = arithmetic(summary["candidateCostUsd"] - summary["parentCostUsd"])
        if "maximumCandidateUsd" in cost_policy:
            if summary["candidateCostUsd"] is None:
                result["checks"].append({"code": "cost.unknown", "result": "unknown"})
            else:
                check("policy.maximum_candidate_cost", summary["candidateCostUsd"] <= cost_policy["maximumCandidateUsd"])
        if "maximumIncreaseUsd" in cost_policy:
            if summary["costIncreaseUsd"] is None:
                result["checks"].append({"code": "cost.unknown", "result": "unknown"})
            else:
                check("policy.maximum_cost_increase", summary["costIncreaseUsd"] <= cost_policy["maximumIncreaseUsd"])
        if modern and stage_name == "development":
            # A step needs a benefit beyond non-inferiority: a positive point gain reaching
            # minimumMeanImprovement, an attested replay, or a cost saving.
            increase = summary["costIncreaseUsd"]
            check("policy.development_benefit",
                  (improvement > 0 and improvement >= policy["minimumMeanImprovement"])
                  or replay_passed is True
                  or ("cost" in policy and increase is not None and increase < 0
                      and -increase >= policy.get("minimumCostSavingsUsd", 0)))
        if not modern and "minimumCostSavingsUsd" in policy:
            if summary["costIncreaseUsd"] is None:
                result["checks"].append({"code": "cost.unknown", "result": "unknown"})
            else:
                check("policy.minimum_cost_savings", -summary["costIncreaseUsd"] >= policy["minimumCostSavingsUsd"])
    except (ArithmeticError, OverflowError):
        result["code"] = "analysis.nonfinite"
        result["checks"].append({"code": "analysis.nonfinite", "result": "unknown"})
        return result
    failed = any(item["result"] == "fail" for item in result["checks"])
    if not failed and any(item["result"] == "unknown" for item in result["checks"]):
        result["code"] = ("inference.insufficient_data" if any(
            item["result"] == "unknown" and item["code"].startswith("inference.") for item in result["checks"])
            else "cost.unknown")
        return result
    result["verdict"] = "fail" if failed else "pass"
    result["code"] = "policy.pass" if result["verdict"] == "pass" else "policy.fail"
    return result
