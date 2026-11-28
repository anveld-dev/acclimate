"""Acclimate integration for the OpenAI Agents Python SDK (`openai-agents`)."""

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


def _make_run_hooks(
    report_started: Callable[[], DeliveryReceiptRequest | None],
    cleanup: Callable[[], None],
    *,
    cleanup_on_end: bool = False,
) -> Any:
    """Return an `agents.RunHooks` subclass if installed, else a duck-typed RunHooks object."""
    try:
        from agents import RunHooks  # type: ignore[import-not-found]
    except ImportError:
        RunHooks = object  # type: ignore[assignment,misc]

    class _AcclimateRunHooks(RunHooks):  # type: ignore[misc,valid-type]
        async def on_agent_start(self, context: Any = None, agent: Any = None) -> None:
            del context, agent
            report_started()

        async def on_agent_end(
            self, context: Any = None, agent: Any = None, output: Any = None
        ) -> None:
            del context, agent, output
            if cleanup_on_end:
                await run_cleanup_async(cleanup)

        async def on_llm_start(
            self,
            context: Any = None,
            agent: Any = None,
            system_prompt: Any = None,
            input_items: Any = None,
        ) -> None:
            del context, agent, system_prompt, input_items

        async def on_llm_end(
            self, context: Any = None, agent: Any = None, response: Any = None
        ) -> None:
            del context, agent, response

        async def on_handoff(
            self, context: Any = None, from_agent: Any = None, to_agent: Any = None
        ) -> None:
            del context, from_agent, to_agent

        async def on_tool_start(
            self, context: Any = None, agent: Any = None, tool: Any = None
        ) -> None:
            del context, agent, tool

        async def on_tool_end(
            self, context: Any = None, agent: Any = None, tool: Any = None, result: Any = None
        ) -> None:
            del context, agent, tool, result

    return _AcclimateRunHooks()


class PreparedOpenAiAgentsVersion:
    """Prepared Acclimate bundle for `openai-agents` (`Agent`, `Runner`, `RunHooks`)."""

    def __init__(
        self,
        *,
        version_id: str,
        digest: str,
        system_prompt: str,
        skills: tuple[BundleSkill, ...],
        memory_files: list[dict[str, str]],
        trace_metadata: dict[str, str],
        payload: Any,
        report_started: Callable[[], DeliveryReceiptRequest | None],
        release: Callable[[], None],
        cleanup_on_end: bool = False,
    ):
        self.version_id = version_id
        self.digest = digest
        self.system_prompt = system_prompt
        self.skills = skills
        self.memory_files = memory_files
        self.trace_metadata = trace_metadata
        self._payload = payload
        self._lookup: SkillLookup | None = None
        self._report_started = report_started
        self._release = release
        self._cleanup_on_end = cleanup_on_end
        self._cleaned = False

    def _get_lookup(self) -> SkillLookup:
        if self._lookup is None:
            self._lookup = SkillLookup(self._payload)
        return self._lookup

    def instructions(self, context: Any = None, agent: Any = None) -> str:
        """Dynamic instructions callback for `Agent(instructions=prepared.instructions)`."""
        del context, agent
        self._report_started()
        return self.system_prompt

    def run_hooks(self) -> Any:
        """Return an `agents.RunHooks`-compatible lifecycle hooks object for `Runner.run(..., hooks=...)`."""
        return _make_run_hooks(
            self._report_started, self.cleanup, cleanup_on_end=self._cleanup_on_end
        )

    def skill_tools(self) -> tuple[Callable[[], list[dict[str, Any]]], Callable[[str, str | None], str]]:
        """Return `(list_acclimate_skills, read_acclimate_skill)` callables ready for `@function_tool`."""
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

    def __enter__(self) -> PreparedOpenAiAgentsVersion:
        return self

    def __exit__(self, *args: Any) -> None:
        self.cleanup()

    async def __aenter__(self) -> PreparedOpenAiAgentsVersion:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.acleanup()


def prepare(
    source: DeliveryInput,
    *,
    include_skills_in_prompt: bool = True,
    approved_memory_paths: Sequence[str] | None = None,
    cleanup_on_end: bool = False,
) -> PreparedOpenAiAgentsVersion:
    """Prepare a verified Acclimate bundle for the OpenAI Agents Python SDK."""
    verified, report_started, release = unwrap_source(source)
    payload = verified["payload"]
    prompt = render_bundle_prompt(
        payload,
        include_skills=include_skills_in_prompt,
        approved_memory_paths=approved_memory_paths,
    )
    memory_files = select_approved_memory(payload, approved_memory_paths)
    skills = tuple(extract_bundle_skills(payload))
    trace_metadata = {
        key: str(value).lower() if isinstance(value, bool) else str(value)
        for key, value in telemetry_attributes(verified).items()
    }
    return PreparedOpenAiAgentsVersion(
        version_id=verified["version"]["id"],
        digest=verified["version"]["digest"],
        system_prompt=prompt,
        skills=skills,
        memory_files=memory_files,
        trace_metadata=trace_metadata,
        payload=payload,
        report_started=report_started,
        release=release,
        cleanup_on_end=cleanup_on_end,
    )


__all__ = ["PreparedOpenAiAgentsVersion", "prepare"]
