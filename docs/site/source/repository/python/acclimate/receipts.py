"""Optional memory-only reporting with a bounded, lazy daemon worker."""
from collections import deque
from datetime import datetime, timezone
from threading import Condition, Thread
import math
import time
import uuid

from .errors import UsageError


def _timestamp(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def _deadline(timeout):
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 <= timeout <= 30:
        raise UsageError("timeout must be between 0 and 30 seconds")
    return time.monotonic() + timeout


class DeliveryReporter:
    def __init__(self, client, workspace_id, connection_id, *, max_queue=100, clock=time.time):
        if type(max_queue) is not int or not 1 <= max_queue <= 1000:
            raise UsageError("max_queue must be 1..1000")
        self.client, self.workspace_id, self.connection_id = client, workspace_id, connection_id
        self.max_queue, self.clock = max_queue, clock
        self._ready, self._failed = deque(), deque()
        self._condition = Condition()
        self._worker = None
        self._active = False
        self._closed = False

    def bind(self, bundle_id, version, source):
        if source not in ("network", "cache", "offline"):
            raise UsageError("invalid receipt source")
        metadata = version.get("version") if isinstance(version, dict) else None
        if not isinstance(metadata, dict):
            raise UsageError("version must be a verified version")
        # A receipt must describe delivery in this reporter's scope, as in TypeScript.
        connection = version.get("connection")
        if ("bundleId" in metadata and metadata["bundleId"] != bundle_id) or (
                connection is not None and (
                    connection.get("workspaceId") != self.workspace_id
                    or str(connection.get("connectionId", "")).lower() != str(self.connection_id).lower())):
            raise UsageError("Delivery scope must match reporter scope")
        return BoundDeliveryReporter(self, bundle_id, version, source)

    def _expire(self):
        now = self.clock()
        self._ready = deque((t, r) for t, r in self._ready if now - t < 86400)
        self._failed = deque((t, r) for t, r in self._failed if now - t < 86400)

    def _start(self):
        if self._worker is None and self._ready:
            self._worker = Thread(target=self._run, name="acclimate-receipts", daemon=True)
            self._worker.start()
        self._condition.notify_all()

    def _enqueue(self, receipt):
        with self._condition:
            if self._closed:
                return False
            self._expire()
            if len(self._ready) + len(self._failed) + int(self._active) >= self.max_queue:
                return False
            self._ready.append((self.clock(), receipt.copy()))
            self._start()
            return True

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or bool(self._ready))
                if self._closed:
                    return
                created, receipt = self._ready.popleft()
                self._active = True
            failed = False
            try:
                if self.clock() - created < 86400:
                    self.client.report_delivery_receipt(self.workspace_id, self.connection_id, receipt)
            except Exception:
                failed = True
            with self._condition:
                if failed:
                    # Only explicit flush retries failures. Fresh arrivals still drain.
                    self._failed.append((created, receipt))
                self._active = False
                self._condition.notify_all()

    def flush(self):
        """Schedule one retry of retained events; never refresh their IDs or times."""
        with self._condition:
            if self._closed:
                return False
            self._expire()
            self._ready.extend(self._failed)
            self._failed.clear()
            self._start()
            return True

    def wait(self, timeout=1.0):
        """Wait at most timeout seconds for scheduled work; failed events remain retained.

        Return False if a client is still blocked or queued work remains. This never
        cancels an injected client. Timeout is bounded to 0..30 seconds.
        """
        deadline = _deadline(timeout)
        with self._condition:
            while self._active or self._ready:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self._closed and not self._active:
                    return False
                self._condition.wait(remaining)
            return True

    def close(self, timeout=0.1):
        """Stop claiming events and wait at most timeout seconds for an in-flight call.

        An already claimed call may finish after close. The daemon never holds up
        interpreter exit, even if an injected client never returns.
        """
        deadline = _deadline(timeout)
        with self._condition:
            self._closed = True
            self._condition.notify_all()
            worker = self._worker
        if worker is not None:
            worker.join(max(0, deadline - time.monotonic()))
        return worker is None or not worker.is_alive()

    @property
    def pending_count(self):
        with self._condition:
            return len(self._ready) + len(self._failed) + int(self._active)


class BoundDeliveryReporter:
    def __init__(self, reporter, bundle_id, version, source):
        self.reporter, self.bundle_id, self.version, self.source = reporter, bundle_id, version, source

    def _make_receipt(self, stage):
        if stage not in ("resolved", "downloaded", "verified", "prepared", "started"):
            raise UsageError("invalid receipt stage")
        resolution = self.version.get("resolution")
        if stage == "resolved" and resolution is None or stage == "downloaded" and self.source != "network":
            raise UsageError("impossible receipt stage/source")
        r = self.reporter
        receipt = dict(eventId=str(uuid.uuid4()), connectionId=r.connection_id,
                       workspaceId=r.workspace_id, bundleId=self.bundle_id,
                       versionId=self.version["version"]["id"], digest=self.version["version"]["digest"],
                       stage=stage, occurredAt=_timestamp(r.clock()), source=self.source)
        if resolution is not None:
            receipt.update(channel=resolution["channel"], revision=resolution["revision"],
                           resolvedAt=_timestamp(self.version["resolvedAt"] / 1000), stale=self.version["stale"])
        return receipt

    def _queue_prepared_start(self, prior):
        receipt = prior if prior is not None else self._make_receipt("started")
        return receipt, self.reporter._enqueue(receipt)

    def report(self, stage):
        receipt = self._make_receipt(stage)
        try:
            return receipt if self.reporter._enqueue(receipt) else None
        except Exception:
            pass

    def report_prepared(self):
        self.report("prepared")

    def report_started(self):
        return self.report("started")
