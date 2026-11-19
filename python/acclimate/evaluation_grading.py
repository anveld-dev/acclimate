"""Grader helpers that run inside your ``grade`` callback; they match the TypeScript SDK.

The combined value becomes the scalar reward and per-call detail goes into ``explanation``, so a
review export or analysis ``observations`` can carry components and agreement.
"""
from __future__ import annotations

import math
from typing import Any, Callable


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _combine(values: list[float], method: str) -> float:
    if method == "median":
        ordered = sorted(values)
        middle = len(ordered) // 2
        return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    if method == "majority":
        if not all(value in (0, 1) for value in values):
            raise ValueError("Majority grading needs rewards of 0 or 1")
        ones = sum(1 for value in values if value == 1)
        if ones * 2 == len(values):
            raise ValueError("Use an odd number of grader calls")
        return 1 if ones * 2 > len(values) else 0
    if method != "mean":
        raise ValueError("combine must be mean, median or majority")
    total = 0.0
    for value in values:
        total += value
    return total / len(values)


def grade_agreement(rewards: list[float], combined: float) -> dict:
    """Share of calls matching the combined reward, sample SD and range across calls."""
    if not isinstance(rewards, list) or len(rewards) < 2 or not all(_finite(value) for value in rewards) \
            or not _finite(combined):
        raise ValueError("Agreement needs at least two finite rewards")
    total = 0.0
    for value in rewards:
        total += value
    mean = total / len(rewards)
    squares = 0.0
    for value in rewards:
        squares += (value - mean) * (value - mean)
    return {"repetitions": len(rewards), "agreement": sum(1 for value in rewards if value == combined) / len(rewards),
            "sd": math.sqrt(squares / (len(rewards) - 1)), "range": [min(rewards), max(rewards)]}


def repeat_grade(grade: Callable[[], dict], *, repetitions: int, combine: str = "mean") -> dict:
    """Call ``grade`` several times and combine rewards; components are averaged per name."""
    if type(repetitions) is not int or not 2 <= repetitions <= 15:
        raise ValueError("repetitions must be an integer from 2 to 15")
    calls = []
    for _ in range(repetitions):
        result = grade()
        if not isinstance(result, dict) or not _finite(result.get("reward")):
            raise ValueError("Each grade needs a finite reward")
        if not all(_finite(value) for value in (result.get("components") or {}).values()):
            raise ValueError("Grade components must be finite numbers")
        calls.append(result)
    rewards = [call["reward"] for call in calls]
    reward = _combine(rewards, combine)
    names = sorted({name for call in calls for name in (call.get("components") or {})})
    components = {name: _combine([call["components"][name] for call in calls
                                  if name in (call.get("components") or {})], "mean") for name in names}
    agreement = grade_agreement(rewards, reward)
    explanation = {"combine": combine, "rewards": rewards}
    if names:
        explanation["components"] = components
    explanation.update(agreement=agreement, calls=[call.get("explanation") for call in calls])
    return {"reward": reward, "agreement": agreement, "explanation": explanation}


def pass_at_k(n: int, successes: int, k: int) -> float:
    """Unbiased pass@k for one case (Chen et al. 2021): 1 - C(n - c, k) / C(n, k)."""
    if (not all(type(value) is int for value in (n, successes, k)) or n < 1 or k < 1 or k > n
            or not 0 <= successes <= n):
        raise ValueError("pass@k needs integers with 1 <= k <= n and 0 <= successes <= n")
    if n - successes < k:
        return 1.0
    failure = 1.0
    for index in range(n - successes + 1, n + 1):
        failure *= 1 - k / index
    return 1 - failure
