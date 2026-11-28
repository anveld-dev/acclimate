"""Framework integrations for Acclimate Python deliveries.

All integrations accept a ``VerifiedVersion``, ``PreparedDelivery``, or
``AsyncPreparedDelivery`` and require no third-party packages at import time.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from ..async_client import AsyncPreparedDelivery
from ..delivery import PreparedDelivery
from ..types import DeliveryReceiptRequest, VerifiedVersion

DeliveryInput = VerifiedVersion | PreparedDelivery | AsyncPreparedDelivery


def unwrap_source(
    source: DeliveryInput,
) -> tuple[
    VerifiedVersion,
    Callable[[], DeliveryReceiptRequest | None],
    Callable[[], None],
]:
    """Split a verified version or prepared delivery into version + lifecycle callbacks."""
    if isinstance(source, AsyncPreparedDelivery):
        return source.version, source.report_started, source.cleanup_sync
    if isinstance(source, PreparedDelivery):
        return source.version, source.report_started, source.cleanup
    return source, (lambda: None), (lambda: None)


async def run_cleanup_async(cleanup_fn: Callable[[], None]) -> None:
    await asyncio.to_thread(cleanup_fn)


def make_skill_tool_callables(
    list_skills: Callable[[], list[Any]],
    read_skill: Callable[[str, str | None], str],
) -> tuple[Callable[[], list[Any]], Callable[[str, str | None], str]]:
    """Build documented, strictly-typed tool functions for progressive skill disclosure."""

    def list_acclimate_skills() -> list[dict[str, Any]]:
        """List available Acclimate bundle skills with their names, descriptions, and supporting files."""
        return list_skills()

    def read_acclimate_skill(name: str, file_path: str | None = None) -> str:
        """Read a skill manifest (SKILL.md) or a supporting file from a named Acclimate bundle skill.

        Args:
            name: Skill name returned by list_acclimate_skills.
            file_path: Optional relative supporting file path inside the skill folder; defaults to SKILL.md.
        """
        return read_skill(name, file_path)

    return list_acclimate_skills, read_acclimate_skill


__all__ = ["DeliveryInput"]
