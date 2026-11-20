"""Plan an evaluation before running it: sufficiency, detectable effect and simulated pass rates.

Nothing here runs an agent or grader. The simulation feeds synthetic Bernoulli trials through the
same ``check_comparison`` used for real verdicts, with the same generator as the TypeScript SDK,
so both SDKs report identical plans.
"""
from __future__ import annotations

import math
import re
from typing import Any

from ._student_t import student_t_quantile
from .evaluation_policy import _descriptor, check_comparison, resolve_inference, validate_evaluation_policy


class PlanError(ValueError):
    def __init__(self) -> None:
        self.code = "plan.invalid"
        super().__init__("The plan options are invalid.")


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _calibrate(comparison: dict, direction: int) -> dict:
    cases: dict[str, list[float]] = {}
    for pair in comparison["results"]:
        if all(side["executionStatus"] != "infrastructure_failed" and _finite(side["reward"])
               for side in (pair["parent"], pair["candidate"])):
            cases.setdefault(pair["caseId"], []).append(
                direction * (pair["candidate"]["reward"] - pair["parent"]["reward"]))
    means = []
    for rows in cases.values():
        total = 0.0
        for value in rows:
            total += value
        means.append(total / len(rows))
    if len(means) < 2:
        raise PlanError()
    center = 0.0
    squares = 0.0
    for value in means:
        center += value
        squares += value * value
    return {"sd": math.sqrt(squares / len(means)), "cases": len(means),
            "flipRate": len([value for value in means if value != 0]) / len(means), "center": center / len(means)}


def _width(policy: dict) -> float:
    scale = policy["metric"].get("scale")
    return scale["maximum"] - scale["minimum"] if scale else 1


def plan_evaluation(*, policy: dict, descriptor: dict, calibration: dict | None = None,
                    effects: list[float] | None = None, simulations: int = 400, seed: int = 1) -> dict:
    """Return the same plan as the TypeScript ``planEvaluation``."""
    try:
        descriptor = _descriptor(descriptor)
    except (ValueError, TypeError, KeyError):
        raise PlanError() from None
    policy = validate_evaluation_policy(policy, descriptor)
    if (type(simulations) is not int or not 0 <= simulations <= 5000 or type(seed) is not int
            or not 0 <= seed <= 0xffffffff
            or (effects is not None and (not isinstance(effects, list) or len(effects) > 16
                                         or not all(_finite(effect) and abs(effect) <= _width(policy)
                                                    for effect in effects)))):
        raise PlanError()
    settings = resolve_inference(policy)
    counts: dict[str, int] = {}
    for item in descriptor["expectedCases"]:
        counts[item["caseId"]] = counts.get(item["caseId"], 0) + 1
    cases, repetitions = len(counts), min(counts.values())
    scale = policy["metric"].get("scale", {"minimum": 0, "maximum": 1})
    width = scale["maximum"] - scale["minimum"]
    direction = 1 if policy["metric"]["direction"] == "higher" else -1
    threshold = policy["minimumMeanImprovement"]
    warnings = []
    aa = _calibrate(calibration, direction) if calibration is not None else None
    sd = aa["sd"] if aa else width * math.sqrt(0.5 / repetitions)
    statistical = settings["method"] == "paired-t"
    sufficient = cases >= settings["minCases"] and repetitions >= settings["minRepetitions"]
    if cases < settings["minCases"]:
        warnings.append(f"The inventory has {cases} cases; the policy needs at least {settings['minCases']}. "
                        "Every verdict will be indeterminate.")
    if repetitions < settings["minRepetitions"]:
        warnings.append(f"Some cases have {repetitions} repetition(s); the policy needs {settings['minRepetitions']}. "
                        "Every verdict will be indeterminate.")
    elif repetitions < 2:
        warnings.append("Cases run once. Repetitions 2-3 separate run-to-run noise from real case differences "
                        "and are required for the fixed-case bootstrap.")
    per_case_checks = policy.get("perCaseChecks", "protected-cases")
    if (per_case_checks == "all-cases" and policy["maximumCaseRegression"] == 0
            and "maximumRegressedCases" not in policy):
        warnings.append("perCaseChecks is all-cases with maximumCaseRegression 0: one noisy case can fail the gate. "
                        "Use protected-cases, a nonzero maximumCaseRegression or maximumRegressedCases.")
    protected_cases = {*policy["requiredCases"], *policy.get("protectedCaseThresholds", {})}
    case_limits = [name for name in ("maximumCandidateTaskFailures", "maximumRegressedCases") if name in policy]
    if per_case_checks == "protected-cases" and not protected_cases and case_limits:
        warnings.append(f"perCaseChecks is protected-cases and the policy protects no case, so {' and '.join(case_limits)} "
                        "never fails. Declare requiredCases or protectedCaseThresholds, or set perCaseChecks to all-cases.")
    if not statistical:
        warnings.append("inference.method is none: the policy compares point estimates and its false-pass rate "
                        "is not controlled.")
    if aa and abs(aa["center"]) > (2 * aa["sd"]) / math.sqrt(aa["cases"]):
        warnings.append("The A/A comparison has a nonzero mean difference. Check that both arms ran the same "
                        "version and grader.")
    floor = settings.get("sdFloor", 0.1 * width)
    sd_used = max(sd, floor if statistical else 0)
    mde = (threshold + ((student_t_quantile(settings["confidence"], cases - 1) + student_t_quantile(0.8, cases - 1))
                        * sd_used) / math.sqrt(cases)) if statistical and cases >= 2 else None
    if effects is None:
        effects = [value for value in (threshold, 0, mde) if value is not None and abs(value) <= width]
    effects = sorted(set(float(effect) for effect in effects))
    state = seed

    def uniform() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        value = ((state ^ (state >> 15)) * (state | 1)) & 0xFFFFFFFF
        value ^= (value + ((value ^ (value >> 7)) * (value | 61))) & 0xFFFFFFFF
        return ((value ^ (value >> 14)) & 0xFFFFFFFF) / 4294967296

    def outcome(success: bool) -> dict:
        return {"executionStatus": "completed", "gradingStatus": "scored",
                "reward": scale["maximum"] if success == (direction > 0) else scale["minimum"],
                "outputRef": None, "error": None, "usage": None}

    binding = {"parentVersionId": "plan-parent", "candidateVersionId": "plan-candidate",
               "parentDigest": "sha256:" + "0" * 64, "candidateDigest": "sha256:" + "1" * 64,
               "requestId": "plan-request", "attemptId": "plan-attempt"}
    results = []
    for effect in effects:
        passed = indeterminate = 0
        shift = effect / width
        for _ in range(simulations):
            rows = []
            for case_id, count in counts.items():
                base = 0.2 + 0.6 * uniform()
                better = min(1, max(0, base + shift))
                for repetition in range(count):
                    rows.append({"caseId": case_id, "repetition": repetition, "parent": outcome(uniform() < base),
                                 "candidate": outcome(uniform() < better)})
            comparison = {"id": "plan-comparison", "complete": True, "submitter": "plan",
                          "createdAt": "1970-01-01T00:00:00Z",
                          **{name: binding[name] for name in ("parentVersionId", "candidateVersionId",
                                                              "parentDigest", "candidateDigest")},
                          "datasetRevision": descriptor["datasetRevision"], "graderRevision": descriptor["graderRevision"],
                          "runtime": descriptor["runtime"], "expectedCases": descriptor["expectedCases"],
                          "results": rows, "evaluation": {"requestId": "plan-request", "attemptId": "plan-attempt"}}
            verdict = check_comparison(comparison=comparison, expected_descriptor=descriptor,
                                       expected_binding=binding, policy=policy)["verdict"]
            passed += verdict == "pass"
            indeterminate += verdict == "indeterminate"
        results.append({"effect": effect, "passRate": passed / simulations if simulations else 0,
                        "indeterminateRate": indeterminate / simulations if simulations else 0})
    return {"schemaVersion": 1, "method": settings["method"], "confidence": settings["confidence"] if statistical else None,
            "threshold": threshold, "cases": cases, "repetitions": repetitions, "minCases": settings["minCases"],
            "minRepetitions": settings["minRepetitions"], "sufficient": sufficient,
            "noise": {"source": "aa-calibration" if aa else "binary-worst-case", "sd": sd,
                      "aaCases": aa["cases"] if aa else None, "aaFlipRate": aa["flipRate"] if aa else None},
            "minimumDetectableEffect": mde,
            "simulation": {"model": "bernoulli-cases-uniform-0.2-0.8", "runs": simulations, "seed": seed,
                           "results": results},
            "warnings": warnings}


PLAN_USAGE = "plan --policy POLICY [--aa A_A_COMPARISON.json] [--effects 0,0.05] [--simulations N] [--seed N]"


def plan_command(descriptor: dict, flags: dict, read_bytes, read_json, error_type=None) -> tuple[int, dict]:
    """``python -m acclimate plan --policy FILE [--aa FILE] [--effects 0,0.05] [--simulations N] [--seed N]``.

    Exits 0 when the inventory can support the declared inference and 3 (indeterminate) otherwise.
    """
    from ._evaluation_shared import EXIT_CODES, EvaluationUsageError
    from .evaluation_policy import parse_evaluation_policy

    if not flags.get("policy"):
        raise EvaluationUsageError("usage.missing_flag", field="--policy", hint=PLAN_USAGE)

    def integer(name):
        value = flags.get(name)
        if value is None:
            return None
        if not re.fullmatch(r"\d{1,10}", value):
            raise EvaluationUsageError("usage.invalid_flag", field="--" + name, reason="Use a nonnegative integer.")
        return int(value)

    effects = None
    if flags.get("effects"):
        if not all(re.fullmatch(r"-?\d+(\.\d+)?", item.strip()) for item in flags["effects"].split(",")):
            raise EvaluationUsageError("usage.invalid_flag", field="--effects",
                                       reason="Use comma-separated numbers, such as 0,0.05.")
        effects = [float(item) for item in flags["effects"].split(",")]
    policy = parse_evaluation_policy(read_bytes(flags["policy"]).decode(), descriptor)["policy"]
    options = {"policy": policy, "descriptor": descriptor}
    if flags.get("aa"):
        options["calibration"] = read_json(flags["aa"], 64 * 1024 * 1024)
    if effects is not None:
        options["effects"] = effects
    for name in ("simulations", "seed"):
        if integer(name) is not None:
            options[name] = integer(name)
    try:
        plan = plan_evaluation(**options)
    except PlanError:
        raise EvaluationUsageError("usage.invalid_flag", field="--aa" if flags.get("aa") else "--effects",
                                   reason="Use at most 16 effects within the metric scale, 0-5000 simulations, a seed "
                                          "below 2^32, and an A/A comparison with at least two cases.") from None
    return (EXIT_CODES["ok"] if plan["sufficient"] else EXIT_CODES["indeterminate"]), plan


def policy_readiness(policy: dict, descriptor: dict) -> dict:
    """Doctor's policy summary: sufficiency, detectable effect and repetition warnings."""
    plan = plan_evaluation(policy=policy, descriptor=descriptor, simulations=0, effects=[])
    return {name: plan[name] for name in ("method", "confidence", "cases", "repetitions", "sufficient",
                                          "minimumDetectableEffect", "warnings")}
