"""Pure descriptive comparison policy. No transport, filesystem, or execution access."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any, Literal, NotRequired, TypedDict
from ._evaluation_shared import EvaluationError


class EvaluationMetric(TypedDict):
    name: str
    unit: str
    direction: Literal["higher", "lower"]


class EvaluationCostPolicy(TypedDict, total=False):
    maximumCandidateUsd: float
    maximumIncreaseUsd: float


class EvaluationPolicyV1(TypedDict):
    schemaVersion: Literal[1]
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
    parentCostUsd: float | None
    candidateCostUsd: float | None
    costIncreaseUsd: float | None
    parentUnknownCosts: int
    candidateUnknownCosts: int


class PolicyIdentity(TypedDict):
    id: str
    revision: str
    sha256: str | None


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
    interpretation: Literal["descriptive-policy-check"]


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


def validate_evaluation_policy(value: Any, expected_descriptor: dict | None = None) -> EvaluationPolicyV1:
    if not _record(value):
        raise PolicyError("policy.invalid")
    missing = [key for key in _REQUIRED_POLICY_FIELDS if key not in value]
    if _record(value.get("metric")):
        missing.extend("metric." + key for key in _REQUIRED_METRIC_FIELDS if key not in value["metric"])
    if missing:
        raise PolicyError("policy.invalid", missing)
    allowed = [*_REQUIRED_POLICY_FIELDS, "candidateThreshold", "maximumCandidateTaskFailures", "cost"]
    if (not _fields(value, allowed, []) or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
        or not _string(value["id"], 128) or not _string(value["revision"])
        or value["aggregation"] != "equal-case-means"
        or not _finite(value["minimumMeanImprovement"]) or not _nonnegative(value["maximumCaseRegression"])
        or not _record(value["metric"])
        or not _fields(value["metric"], ["name", "unit", "direction"], ["name", "unit", "direction"])
        or not _string(value["metric"]["name"], 128) or not _string(value["metric"]["unit"], 128)
        or value["metric"]["direction"] not in ("higher", "lower")
        or not isinstance(value["requiredCases"], list) or len(value["requiredCases"]) > 1000
        or not all(_string(item) for item in value["requiredCases"])):
        raise PolicyError("policy.invalid")
    if len(set(value["requiredCases"])) != len(value["requiredCases"]):
        raise PolicyError("policy.invalid")
    if "candidateThreshold" in value and not _finite(value["candidateThreshold"]):
        raise PolicyError("policy.invalid")
    if "maximumCandidateTaskFailures" in value and (
        not _integer(value["maximumCandidateTaskFailures"])
        or not 0 <= value["maximumCandidateTaskFailures"] <= 2**53 - 1
    ):
        raise PolicyError("policy.invalid")
    if "cost" in value and (
        not _record(value["cost"]) or not value["cost"]
        or not _fields(value["cost"], ["maximumCandidateUsd", "maximumIncreaseUsd"], [])
        or not all(_nonnegative(item) for item in value["cost"].values())
    ):
        raise PolicyError("policy.invalid")
    if expected_descriptor is not None:
        try:
            descriptor = _descriptor(expected_descriptor)
        except (ValueError, TypeError, KeyError):
            raise PolicyError("policy.invalid") from None
        cases = {item["caseId"] for item in descriptor["expectedCases"]}
        if any(item not in cases for item in value["requiredCases"]):
            raise PolicyError("policy.inventory_incompatible")
    result = {
        "schemaVersion": 1, "id": value["id"], "revision": value["revision"],
        "metric": dict(value["metric"]), "aggregation": "equal-case-means",
        "minimumMeanImprovement": float(value["minimumMeanImprovement"]),
        "maximumCaseRegression": float(value["maximumCaseRegression"]),
        "requiredCases": list(value["requiredCases"]),
    }
    if "candidateThreshold" in value:
        result["candidateThreshold"] = float(value["candidateThreshold"])
    if "maximumCandidateTaskFailures" in value:
        result["maximumCandidateTaskFailures"] = int(value["maximumCandidateTaskFailures"])
    if "cost" in value:
        result["cost"] = {key: float(item) for key, item in value["cost"].items()}
    return result  # type: ignore[return-value]


def parse_evaluation_policy(text: str, expected_descriptor: dict | None = None) -> ParsedEvaluationPolicy:
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
    return {"policy": validate_evaluation_policy(value, expected_descriptor),
            "sha256": "sha256:" + hashlib.sha256(encoded).hexdigest()}


def check_comparison(*, comparison: dict, expected_descriptor: dict,
                     expected_binding: ExpectedComparisonBinding, policy: EvaluationPolicyV1,
                     policy_digest: str | None = None) -> PolicyVerdict:
    try:
        descriptor = _descriptor(expected_descriptor)
    except (ValueError, TypeError, KeyError):
        raise PolicyError("policy.invalid") from None
    policy = validate_evaluation_policy(policy, descriptor)
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
                or not _fields(outcome, ["executionStatus", "gradingStatus", "reward", "outputRef", "error", "usage"],
                               ["executionStatus", "gradingStatus", "reward", "outputRef", "error", "usage"])
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
        pairs[key] = pair
    ordered = sorted(expected, key=lambda item: (item[0].encode("utf-8"), item[1]))
    comparable = [key for key in ordered if key in pairs and all(
        item["executionStatus"] != "infrastructure_failed" and item["gradingStatus"] == "scored" and _finite(item["reward"])
        for item in (pairs[key]["parent"], pairs[key]["candidate"]))]
    result: PolicyVerdict = {"schemaVersion": 1, "verdict": "indeterminate", "code": "evidence.incomplete",
              "policy": {"id": policy["id"], "revision": policy["revision"], "sha256": policy_digest},
              "comparisonId": comparison["id"], "expectedBinding": dict(binding), "checks": [],
              "counts": {"distinctCases": len({key[0] for key in ordered}), "expectedPairs": len(ordered), "comparablePairs": len(comparable)},
              "summary": {"parentMean": None, "candidateMean": None, "orientedMeanImprovement": None, "worstCaseRegression": None,
                          "candidateTaskFailures": 0, "parentCostUsd": None, "candidateCostUsd": None, "costIncreaseUsd": None,
                          "parentUnknownCosts": 0, "candidateUnknownCosts": 0}, "interpretation": "descriptive-policy-check"}
    gaps: EvidenceGaps = {"total": 0, "rows": []}
    for key in ordered:
        for side in ("parent", "candidate"):
            outcome = pairs.get(key, {}).get(side)
            gap = _scalar_gap(outcome)
            if gap:
                _add_gap(gaps, *key, side, *gap)
            cost_policy = policy.get("cost", {})
            if (outcome and "costUsd" not in (outcome["usage"] or {}) and
                ("maximumIncreaseUsd" in cost_policy or (side == "candidate" and "maximumCandidateUsd" in cost_policy))):
                _add_gap(gaps, *key, side, "usage", "missing_cost")
    if gaps["total"]:
        result["evidenceGaps"] = gaps
    summary = result["summary"]
    for side in ("parent", "candidate"):
        summary[side + "UnknownCosts"] = len([key for key in ordered if key not in pairs or pairs[key][side]["usage"] is None
                                              or "costUsd" not in pairs[key][side]["usage"]])
    summary["candidateTaskFailures"] = len([key for key in ordered if key in pairs and pairs[key]["candidate"]["executionStatus"] == "task_failed"])
    if len(comparable) != len(ordered):
        result["checks"].append({"code": "evidence.incomplete", "result": "unknown"})
        return result

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

    try:
        groups = {}
        for key in ordered:
            groups.setdefault(key[0], []).append(pairs[key])
        parent_means, candidate_means, improvements = [], [], []
        orientation = 1 if policy["metric"]["direction"] == "higher" else -1
        for rows in groups.values():
            parent = mean([row["parent"]["reward"] for row in rows])
            candidate = mean([row["candidate"]["reward"] for row in rows])
            parent_means.append(parent)
            candidate_means.append(candidate)
            improvements.append(arithmetic(orientation * arithmetic(candidate - parent)))
        parent_mean, candidate_mean, improvement = mean(parent_means), mean(candidate_means), mean(improvements)
        worst_regression = max(0, max(-value for value in improvements))
        summary.update(parentMean=parent_mean, candidateMean=candidate_mean,
                       orientedMeanImprovement=improvement, worstCaseRegression=worst_regression)
        check("policy.minimum_mean_improvement", improvement >= policy["minimumMeanImprovement"])
        check("policy.maximum_case_regression", worst_regression <= policy["maximumCaseRegression"])
        if "candidateThreshold" in policy:
            check("policy.candidate_threshold", arithmetic(orientation * candidate_mean) >= arithmetic(orientation * policy["candidateThreshold"]))
        if "maximumCandidateTaskFailures" in policy:
            check("policy.maximum_candidate_task_failures", summary["candidateTaskFailures"] <= policy["maximumCandidateTaskFailures"])
        for side in ("parent", "candidate"):
            if summary[side + "UnknownCosts"] == 0:
                summary[side + "CostUsd"] = total([pairs[key][side]["usage"]["costUsd"] for key in ordered])
        if summary["parentCostUsd"] is not None and summary["candidateCostUsd"] is not None:
            summary["costIncreaseUsd"] = arithmetic(summary["candidateCostUsd"] - summary["parentCostUsd"])
        cost = policy.get("cost", {})
        if "maximumCandidateUsd" in cost:
            if summary["candidateCostUsd"] is None:
                result["checks"].append({"code": "cost.unknown", "result": "unknown"})
            else:
                check("policy.maximum_candidate_cost", summary["candidateCostUsd"] <= cost["maximumCandidateUsd"])
        if "maximumIncreaseUsd" in cost:
            if summary["costIncreaseUsd"] is None:
                result["checks"].append({"code": "cost.unknown", "result": "unknown"})
            else:
                check("policy.maximum_cost_increase", summary["costIncreaseUsd"] <= cost["maximumIncreaseUsd"])
    except (ArithmeticError, OverflowError):
        result["code"] = "analysis.nonfinite"
        result["checks"].append({"code": "analysis.nonfinite", "result": "unknown"})
        return result
    if not any(item["result"] == "fail" for item in result["checks"]) and any(item["result"] == "unknown" for item in result["checks"]):
        result["code"] = "cost.unknown"
        return result
    result["verdict"] = "fail" if any(item["result"] == "fail" for item in result["checks"]) else "pass"
    result["code"] = "policy.pass" if result["verdict"] == "pass" else "policy.fail"
    return result
