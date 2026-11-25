"""Shared base classes for every error the SDK raises on purpose.

Catch ``AcclimateError`` to handle any SDK failure, then narrow on ``code``.
"""
from __future__ import annotations

from typing import Literal


class AcclimateError(Exception):
    """Base class for SDK errors. ``code`` is a stable, documented string."""

    code: str

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


UsageErrorCode = Literal["usage.invalid_argument"]


class UsageError(AcclimateError, ValueError):
    """The caller passed an invalid argument. A bug in the calling code, never an outage.

    It subclasses ``ValueError`` so existing ``except ValueError`` handlers keep working.
    """

    code: UsageErrorCode

    def __init__(self, message: str, field: str | None = None):
        super().__init__("usage.invalid_argument", message)
        self.field = field


__all__ = ["AcclimateError", "UsageError", "UsageErrorCode"]
