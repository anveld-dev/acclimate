"""Acclimate integration for LangChain and LangGraph (Python)."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
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


def _make_callback_handler(report_started: Callable[[], DeliveryReceiptRequest | None]) -> Any:
    """Return a LangChain `BaseCallbackHandler` subclass if installed, else a duck-typed handler."""
    try:
        from langchain_core.callbacks import BaseCallbackHandler  # type: ignore[import-not-found]
    except ImportError:
        BaseCallbackHandler = object  # type: ignore[assignment,misc]

    class _AcclimateCallbackHandler(BaseCallbackHandler):  # type: ignore[misc,valid-type]
        name = "acclimate_delivery_callback"

        def on_chain_start(self, serialized: Any = None, inputs: Any = None, **kwargs: Any) -> None:
            del serialized, inputs, kwargs
            report_started()

        def on_llm_start(self, serialized: Any = None, prompts: Any = None, **kwargs: Any) -> None:
            del serialized, prompts, kwargs
            report_started()

        def on_chat_model_start(
            self, serialized: Any = None, messages: Any = None, **kwargs: Any
        ) -> None:
            del serialized, messages, kwargs
            report_started()

    return _AcclimateCallbackHandler()


class PreparedLangChainVersion:
    """Prepared Acclimate bundle for LangChain and LangGraph runs."""

    def __init__(
        self,
        *,
        version_id: str,
        digest: str,
        system_prompt: str,
        skills: tuple[BundleSkill, ...],
        memory_files: list[dict[str, str]],
        metadata: dict[str, str | bool],
        tags: list[str],
        payload: Any,
        report_started: Callable[[], DeliveryReceiptRequest | None],
        release: Callable[[], None],
    ):
        self.version_id = version_id
        self.digest = digest
        self.system_prompt = system_prompt
        self.system_message: tuple[str, str] = ("system", system_prompt)
        self.system_message_dict: dict[str, str] = {"role": "system", "content": system_prompt}
        self.skills = skills
        self.memory_files = memory_files
        self.metadata = metadata
        self.tags = tags
        self._payload = payload
        self._lookup: SkillLookup | None = None
        self._report_started = report_started
        self._release = release
        self._cleaned = False

    def _get_lookup(self) -> SkillLookup:
        if self._lookup is None:
            self._lookup = SkillLookup(self._payload)
        return self._lookup

    def callback_handler(self) -> Any:
        """Return a LangChain callback handler that fires `report_started()` on chain/LLM start."""
        return _make_callback_handler(self._report_started)

    def runnable_config(self, base: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Merge Acclimate metadata, tags, and callback handler into a LangChain `RunnableConfig`."""
        config: dict[str, Any] = dict(base) if base is not None else {}
        existing_meta = config.get("metadata")
        merged_meta = dict(self.metadata)
        if isinstance(existing_meta, Mapping):
            merged_meta.update(existing_meta)
        config["metadata"] = merged_meta

        raw_tags = config.get("tags")
        existing_tags = (
            list(raw_tags)
            if isinstance(raw_tags, Sequence) and not isinstance(raw_tags, (str, bytes))
            else []
        )
        merged_tags = list(dict.fromkeys([*existing_tags, *self.tags]))
        config["tags"] = merged_tags

        handler = self.callback_handler()
        existing_callbacks = config.get("callbacks")
        if (
            not isinstance(existing_callbacks, (list, tuple, Sequence))
            and hasattr(existing_callbacks, "copy")
            and callable(existing_callbacks.copy)
            and hasattr(existing_callbacks, "add_handler")
            and callable(existing_callbacks.add_handler)
        ):
            copied = existing_callbacks.copy()
            copied.add_handler(handler)
            config["callbacks"] = copied
        elif isinstance(existing_callbacks, Sequence) and not isinstance(
            existing_callbacks, (str, bytes)
        ):
            config["callbacks"] = [*existing_callbacks, handler]
        else:
            config["callbacks"] = [handler]
        return config

    def skill_tools(self) -> tuple[Callable[[], list[dict[str, Any]]], Callable[[str, str | None], str]]:
        """Return `(list_acclimate_skills, read_acclimate_skill)` callables ready for `@tool`."""
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

    def __enter__(self) -> PreparedLangChainVersion:
        return self

    def __exit__(self, *args: Any) -> None:
        self.cleanup()

    async def __aenter__(self) -> PreparedLangChainVersion:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.acleanup()


def prepare(
    source: DeliveryInput,
    *,
    include_skills_in_prompt: bool = True,
    approved_memory_paths: Sequence[str] | None = None,
) -> PreparedLangChainVersion:
    """Prepare a verified Acclimate bundle for LangChain and LangGraph."""
    verified, report_started, release = unwrap_source(source)
    payload = verified["payload"]
    prompt = render_bundle_prompt(
        payload,
        include_skills=include_skills_in_prompt,
        approved_memory_paths=approved_memory_paths,
    )
    memory_files = select_approved_memory(payload, approved_memory_paths)
    skills = tuple(extract_bundle_skills(payload))
    metadata = telemetry_attributes(verified)
    tags = [
        "acclimate",
        f"acclimate:bundle:{verified['version']['bundleId']}",
        f"acclimate:version:{verified['version']['id']}",
    ]
    resolution = verified.get("resolution")
    if isinstance(resolution, dict) and isinstance(resolution.get("channel"), str):
        tags.append(f"acclimate:channel:{resolution['channel']}")
    return PreparedLangChainVersion(
        version_id=verified["version"]["id"],
        digest=verified["version"]["digest"],
        system_prompt=prompt,
        skills=skills,
        memory_files=memory_files,
        metadata=metadata,
        tags=tags,
        payload=payload,
        report_started=report_started,
        release=release,
    )


__all__ = ["PreparedLangChainVersion", "prepare"]
