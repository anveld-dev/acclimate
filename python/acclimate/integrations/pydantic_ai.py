"""Acclimate integration for PydanticAI (`pydantic-ai`)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from ..skills import (
    BundleSkill,
    SkillLookup,
    extract_bundle_skills,
    render_bundle_prompt,
    select_approved_memory,
)
from ..telemetry import telemetry_attributes
from ..types import DeliveryReceiptRequest
from . import DeliveryInput, make_skill_tool_callables, run_cleanup_async, unwrap_source


class PreparedPydanticAiVersion:
    """Prepared Acclimate bundle for PydanticAI (`Agent`, `@agent.instructions`, toolsets)."""

    def __init__(
        self,
        *,
        version_id: str,
        digest: str,
        system_prompt: str,
        skills: tuple[BundleSkill, ...],
        memory_files: list[dict[str, str]],
        telemetry: dict[str, str | bool],
        payload: Any,
        report_started: Callable[[], DeliveryReceiptRequest | None],
        release: Callable[[], None],
    ):
        self.version_id = version_id
        self.digest = digest
        self.system_prompt = system_prompt
        self.skills = skills
        self.memory_files = memory_files
        self.telemetry_attributes = telemetry
        self._payload = payload
        self._lookup: SkillLookup | None = None
        self._report_started = report_started
        self._release = release
        self._cleaned = False

    def _get_lookup(self) -> SkillLookup:
        if self._lookup is None:
            self._lookup = SkillLookup(self._payload)
        return self._lookup

    def instructions(self, ctx: Any = None) -> str:
        """Instructions provider compatible with `Agent(instructions=...)` and `@agent.instructions`."""
        del ctx
        self._report_started()
        return self.system_prompt

    def skill_tools(self) -> tuple[Callable[[], list[dict[str, Any]]], Callable[[str, str | None], str]]:
        """Return `(list_acclimate_skills, read_acclimate_skill)` callables for `agent.tool_plain` / `FunctionToolset`."""
        lookup = self._get_lookup()
        return make_skill_tool_callables(lookup.list_skills, lookup.read_skill)

    def report_started(self) -> DeliveryReceiptRequest | None:
        return self._report_started()

    def cleanup(self) -> None:
        if self._cleaned:
            return
        self._release()
        self._cleaned = True

    async def acleanup(self) -> None:
        await run_cleanup_async(self.cleanup)

    def __enter__(self) -> PreparedPydanticAiVersion:
        return self

    def __exit__(self, *args: Any) -> None:
        self.cleanup()

    async def __aenter__(self) -> PreparedPydanticAiVersion:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.acleanup()


def prepare(
    source: DeliveryInput,
    *,
    include_skills_in_prompt: bool = True,
    approved_memory_paths: Sequence[str] | None = None,
) -> PreparedPydanticAiVersion:
    """Prepare a verified Acclimate bundle for PydanticAI."""
    verified, report_started, release = unwrap_source(source)
    payload = verified["payload"]
    prompt = render_bundle_prompt(
        payload,
        include_skills=include_skills_in_prompt,
        approved_memory_paths=approved_memory_paths,
    )
    memory_files = select_approved_memory(payload, approved_memory_paths)
    skills = tuple(extract_bundle_skills(payload))
    return PreparedPydanticAiVersion(
        version_id=verified["version"]["id"],
        digest=verified["version"]["digest"],
        system_prompt=prompt,
        skills=skills,
        memory_files=memory_files,
        telemetry=telemetry_attributes(verified),
        payload=payload,
        report_started=report_started,
        release=release,
    )


__all__ = ["PreparedPydanticAiVersion", "prepare"]
