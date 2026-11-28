"""Asyncio-friendly Acclimate client and job helpers with zero third-party dependencies."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
import threading
from typing import Any

from ._jobs import Acclimate, Job
from .client import AcclimateClient
from .delivery import PreparedDelivery, system_prompt as render_system_prompt
from .receipts import DeliveryReporter
from .types import (
    Bundle,
    BundlePayload,
    ChannelResolution,
    CreateReleaseRequest,
    CreateVersionRequest,
    DeliveryReceiptRequest,
    OfflinePolicy,
    Page,
    Release,
    ReleasePage,
    ReleaseResult,
    VerifiedVersion,
    VersionMetadata,
)


async def _run_prepare_cancellable(fn: Callable[[], PreparedDelivery]) -> AsyncPreparedDelivery:
    """Run blocking delivery staging on a worker thread, cleaning up if cancelled mid-flight."""
    state_lock = threading.Lock()
    cancelled = False
    produced: list[PreparedDelivery] = []

    def _worker() -> PreparedDelivery | None:
        delivery = fn()
        with state_lock:
            if cancelled:
                should_cleanup = True
            else:
                produced.append(delivery)
                should_cleanup = False
        if should_cleanup:
            try:
                delivery.cleanup()
            except Exception:
                pass
            return None
        return delivery

    task = asyncio.create_task(asyncio.to_thread(_worker))
    try:
        delivery = await asyncio.shield(task)
    except asyncio.CancelledError:
        with state_lock:
            cancelled = True
            orphaned = produced.pop() if produced else None
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        if orphaned is not None:
            threading.Thread(target=orphaned.cleanup, daemon=True).start()
        raise
    assert delivery is not None
    return AsyncPreparedDelivery(delivery)


class AsyncPreparedDelivery:
    """Async context manager wrapping ``PreparedDelivery`` for ``asyncio`` agent frameworks."""

    def __init__(self, delivery: PreparedDelivery):
        self._delivery = delivery
        self._cleanup_lock = threading.Lock()
        self._cleaned = False

    @property
    def version(self) -> VerifiedVersion:
        return self._delivery.version

    @property
    def directory(self) -> str:
        return self._delivery.directory

    @property
    def files(self) -> list[dict[str, Any]]:
        return self._delivery.files

    @property
    def instructions(self) -> str:
        return self._delivery.instructions

    @property
    def system_prompt(self) -> str:
        return self._delivery.system_prompt

    @property
    def skill_files(self) -> list[dict[str, Any]]:
        return self._delivery.skill_files

    def report_started(self) -> DeliveryReceiptRequest | None:
        """Queue this job's start receipt once. Non-blocking."""
        return self._delivery.report_started()

    def cleanup_sync(self) -> None:
        with self._cleanup_lock:
            if self._cleaned:
                return
            self._delivery.cleanup()
            self._cleaned = True

    async def cleanup(self) -> None:
        await asyncio.to_thread(self.cleanup_sync)

    async def __aenter__(self) -> AsyncPreparedDelivery:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.cleanup()


class AsyncAcclimateClient:
    """Asyncio wrapper over ``AcclimateClient``.

    Delegates blocking HTTP and private filesystem I/O to worker threads via
    ``asyncio.to_thread`` while preserving all security invariants of
    ``AcclimateClient`` (no redirects, bounded payloads, SHA-256 verification,
    atomic cache writes) with zero third-party dependencies.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        scope: str | None = None,
        *,
        retries: int = 2,
        timeout: float = 30,
        max_payload_bytes: int = 1048576,
        max_json_response_bytes: int = 4194304,
        connection_id: str | None = None,
        session_token: str | None = None,
    ):
        self._sync = AcclimateClient(
            base_url,
            token,
            scope,
            retries=retries,
            timeout=timeout,
            max_payload_bytes=max_payload_bytes,
            max_json_response_bytes=max_json_response_bytes,
            connection_id=connection_id,
            session_token=session_token,
        )

    @classmethod
    def from_sync(cls, client: AcclimateClient) -> AsyncAcclimateClient:
        instance = cls.__new__(cls)
        instance._sync = client
        return instance

    @property
    def sync_client(self) -> AcclimateClient:
        return self._sync

    @property
    def base_url(self) -> str:
        return self._sync.base_url

    @property
    def scope(self) -> str | None:
        return self._sync.scope

    @property
    def connection_id(self) -> str | None:
        return self._sync.connection_id

    async def prepare(
        self,
        workspace_id: str,
        bundle_id: str,
        *,
        channel: str | None = None,
        version_id: str | None = None,
        cache_dir: str | Path | None = None,
        destination: str | Path | None = None,
        offline: OfflinePolicy | None = None,
        max_cache_bytes: int = 20 * 1024 * 1024,
        reporter: DeliveryReporter | None = None,
    ) -> AsyncPreparedDelivery:
        return await _run_prepare_cancellable(
            lambda: self._sync.prepare(
                workspace_id,
                bundle_id,
                channel=channel,
                version_id=version_id,
                cache_dir=cache_dir,
                destination=destination,
                offline=offline,
                max_cache_bytes=max_cache_bytes,
                reporter=reporter,
            )
        )

    async def list_bundles(
        self, workspace_id: str, *, cursor: str | None = None, limit: int = 50
    ) -> Page[Bundle]:
        return await asyncio.to_thread(
            self._sync.list_bundles, workspace_id, cursor=cursor, limit=limit
        )

    async def resolve_channel(
        self,
        workspace_id: str,
        bundle_id: str,
        channel: str,
        *,
        etag: str | None = None,
    ) -> tuple[ChannelResolution | None, str | None, bool]:
        return await asyncio.to_thread(
            self._sync.resolve_channel, workspace_id, bundle_id, channel, etag=etag
        )

    async def inspect_source(
        self, workspace_id: str, bundle_id: str, channel: str
    ) -> ChannelResolution | None:
        return await asyncio.to_thread(
            self._sync.inspect_source, workspace_id, bundle_id, channel
        )

    async def get_version(
        self, workspace_id: str, bundle_id: str, version_id: str
    ) -> VersionMetadata:
        return await asyncio.to_thread(
            self._sync.get_version, workspace_id, bundle_id, version_id
        )

    async def get_payload(
        self, workspace_id: str, bundle_id: str, version_id: str
    ) -> bytes:
        return await asyncio.to_thread(
            self._sync.get_payload, workspace_id, bundle_id, version_id
        )

    async def create_version(
        self,
        workspace_id: str,
        bundle_id: str,
        body: CreateVersionRequest,
        idempotency_key: str,
    ) -> VersionMetadata:
        return await asyncio.to_thread(
            self._sync.create_version, workspace_id, bundle_id, body, idempotency_key
        )

    async def create_release(
        self,
        workspace_id: str,
        bundle_id: str,
        channel: str,
        body: CreateReleaseRequest,
        idempotency_key: str,
    ) -> Release:
        return await asyncio.to_thread(
            self._sync.create_release,
            workspace_id,
            bundle_id,
            channel,
            body,
            idempotency_key,
        )

    async def list_releases(
        self,
        workspace_id: str,
        bundle_id: str,
        channel: str,
        *,
        before_revision: str | None = None,
        limit: int = 20,
    ) -> ReleasePage:
        return await asyncio.to_thread(
            self._sync.list_releases,
            workspace_id,
            bundle_id,
            channel,
            before_revision=before_revision,
            limit=limit,
        )


class AsyncJob:
    """Async counterpart to ``Job`` returned by ``AsyncAcclimate.job(...)``."""

    def __init__(self, job: Job):
        self._job = job

    @property
    def version(self) -> VerifiedVersion:
        return self._job.version

    @property
    def instructions(self) -> str:
        return "\n\n".join(
            file["text"]
            for file in self._job.version["payload"]["files"]
            if file["kind"] == "instruction"
        )

    @property
    def system_prompt(self) -> str:
        return render_system_prompt(self._job.version["payload"])

    async def prepare(self, destination: str | Path | None = None) -> AsyncPreparedDelivery:
        return await _run_prepare_cancellable(lambda: self._job.prepare(destination))


class AsyncAcclimate:
    """Async high-level entry point mirroring ``Acclimate``."""

    def __init__(
        self,
        url: str | None = None,
        workspace: str | None = None,
        token: str | None = None,
        *,
        cache_dir: str | Path | None = None,
    ):
        self._sync = Acclimate(url, workspace, token, cache_dir=cache_dir)
        self.client = AsyncAcclimateClient.from_sync(self._sync.client)
        self.workspace = self._sync.workspace
        self.cache_dir = self._sync.cache_dir

    @classmethod
    def from_env(cls, *, cache_dir: str | Path | None = None) -> AsyncAcclimate:
        return cls(cache_dir=cache_dir)

    async def release(
        self,
        bundle: str,
        payload: BundlePayload,
        *,
        channel: str = "stable",
        reason: str,
    ) -> ReleaseResult:
        return await asyncio.to_thread(
            self._sync.release, bundle, payload, channel=channel, reason=reason
        )

    async def rollback(
        self, bundle: str, *, channel: str = "stable", reason: str
    ) -> ReleaseResult:
        return await asyncio.to_thread(
            self._sync.rollback, bundle, channel=channel, reason=reason
        )

    async def job(self, bundle: str, *, channel: str = "stable") -> AsyncJob:
        job = await asyncio.to_thread(self._sync.job, bundle, channel=channel)
        return AsyncJob(job)
