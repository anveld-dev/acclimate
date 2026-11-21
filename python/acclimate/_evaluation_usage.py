"""Validate usage reported by evaluation callbacks."""
import math
from typing import Any

from ._evaluation_shared import OutputValidationError


_USAGE_KEYS = {"inputTokens": "inputTokens", "outputTokens": "outputTokens", "costUsd": "costUsd",
               "input_tokens": "inputTokens", "output_tokens": "outputTokens", "cost_usd": "costUsd"}


def reported_usage(value: Any):
    """Validate usage. Unknown keys and invalid numbers raise instead of being silently dropped."""
    if value is None:
        return None
    if type(value) is not dict:
        raise OutputValidationError("usage", "Return usage as a dict with inputTokens, outputTokens and costUsd.")
    result: dict = {}
    for key, number in value.items():
        name = _USAGE_KEYS.get(key) if type(key) is str else None
        if name is None:
            raise OutputValidationError("usage." + str(key)[:64],
                                        "Unknown usage key. Use inputTokens, outputTokens and costUsd.")
        if name in result:
            raise OutputValidationError("usage." + key, "Supply each usage value once.")
        if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
            raise OutputValidationError("usage." + key, "Use a finite, nonnegative number.")
        result[name] = number
    return result
