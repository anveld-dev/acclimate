"""Optional memory-only reporting with a bounded, lazy daemon worker."""
from collections import deque
from datetime import datetime, timezone
from threading import Condition, Thread
import math
import time
import uuid


def _timestamp(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def _deadline(timeout):
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 <= timeout <= 30:
        raise ValueError("timeout must be between 0 and 30 seconds")
    return time.monotonic() + timeout


class DeliveryReporter:
    def __init__(self, client, project_id, integration_id, *, max_queue=100, clock=time.time):
        if type(max_queue) is not int or not 1 <= max_queue <= 1000:
            raise ValueError("max_queue must be 1..1000")
        self.client, self.project_id, self.integration_id = client, project_id, integration_id
        self.max_queue, self.clock = max_queue, clock
        self._ready, self._failed = deque(), deque()
        self._condition = Condition()
        self._worker = None
        self._active = False
        self._closed = False

    def bind(self, bundle_id, bundle, source):
        if source not in ("network", "cache", "offline"):
            raise ValueError("invalid receipt source")
        return BoundDeliveryReporter(self, bundle_id, bundle, source)

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
                    self.client.report_delivery_receipt(self.project_id, self.integration_id, receipt)
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
    def __init__(self, reporter, bundle_id, bundle, source):
        self.reporter, self.bundle_id, self.bundle, self.source = reporter, bundle_id, bundle, source

    def report(self, stage):
        if stage not in ("resolved", "downloaded", "verified", "prepared", "started"):
            raise ValueError("invalid receipt stage")
        resolution = self.bundle.get("resolution")
        if stage == "resolved" and resolution is None or stage == "downloaded" and self.source != "network":
            raise ValueError("impossible receipt stage/source")
        r = self.reporter
        receipt = dict(eventId=str(uuid.uuid4()), integrationId=r.integration_id,
                       projectId=r.project_id, bundleId=self.bundle_id,
                       versionId=self.bundle["version"]["id"], digest=self.bundle["version"]["digest"],
                       stage=stage, occurredAt=_timestamp(r.clock()), source=self.source)
        if resolution is not None:
            receipt.update(channel=resolution["channel"], revision=resolution["revision"],
                           resolvedAt=_timestamp(self.bundle["resolvedAt"] / 1000), stale=self.bundle["stale"])
        try:
            r._enqueue(receipt)
        except Exception:
            pass

    def report_prepared(self):
        self.report("prepared")

    def report_started(self):
        self.report("started")
