"""Commit to the held-out cases retained by a learning evaluator."""

import hashlib
from collections.abc import Sequence

from .evaluation_manifest import canonical_evaluation_json
from .types import LearningEvolveCase, LearningJson

__all__ = ["held_out_digest"]


def _hash(value: LearningJson) -> str:
    return hashlib.sha256(canonical_evaluation_json(value).encode("utf-8")).hexdigest()


def held_out_digest(cases: Sequence[LearningEvolveCase]) -> str:
    """Return the same order-independent commitment as the TypeScript SDK."""
    identities: list[LearningJson] = [
        {"caseId": case["caseId"], "input": _hash(case["input"]), "expected": _hash(case["expected"])}
        for case in sorted(cases, key=lambda case: case["caseId"].encode("utf-8"))
    ]
    return "sha256:" + _hash(identities)
