import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import tempfile
from pathlib import Path
from typing import Any, Literal
from .types import *
from .receipts import DeliveryReporter
from .errors import AcclimateError, UsageError


class ApiError(AcclimateError):
    """An HTTP error response from the service.

    ``status`` is the HTTP status, ``code`` the stable error code, ``request_id``
    the service request ID for support, and ``details`` optional structured data.
    """

    def __init__(self, status: int, code: str, message: str, request_id: str = "", details=None):
        super().__init__(code, message)
        self.status, self.request_id = status, request_id
        self.details = details


class TransportError(AcclimateError):
    """The SDK could not reach the service. Only this error means "outage".

    An explicitly configured offline policy may apply.
    """

    def __init__(self, message: str = "HTTP transport failed", service_url: str | None = None):
        super().__init__("transport.unreachable", message)
        self.service_url = service_url


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AcclimateClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        scope: str,
        *,
        retries: int = 2,
        timeout: float = 30,
        max_payload_bytes: int = 1048576,
        max_json_response_bytes: int = 4194304,
        connection_id: str | None = None,
    ):
        """Create a client for one authenticated principal.

        ``scope`` is a stable application identity that namespaces the local
        cache; it is never a token. Set ``connection_id`` to the connection UUID
        when this application reads content for a connection.
        """
        u = urllib.parse.urlsplit(base_url)
        if (
            u.scheme not in ("http", "https")
            or not u.hostname
            or u.username
            or u.password
            or u.query
            or u.fragment
            or not token
            or not scope
        ):
            raise UsageError(
                "base_url, token and scope are required; base_url must be an HTTP(S) URL without credentials, query or fragment",
                "base_url" if token and scope else "token" if scope else "scope",
            )
        if (
            not isinstance(retries, int)
            or not 0 <= retries <= 3
            or not 0 < timeout <= 120
            or not 1 <= max_payload_bytes <= 2097152
            or type(max_json_response_bytes) is not int
            or not 1 <= max_json_response_bytes <= 8388608
        ):
            raise UsageError("invalid retries, timeout or payload limit", "retries")
        if connection_id is not None and (
            not isinstance(connection_id, str)
            or not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", connection_id)
        ):
            raise UsageError("connection_id must be a UUID", "connection_id")
        self.connection_id = connection_id.lower() if connection_id is not None else None
        self.base_url, self.scope, self._token = base_url.rstrip("/"), scope, token
        self.retries, self.timeout, self.max_payload_bytes = (
            retries,
            timeout,
            max_payload_bytes,
        )
        self._opener = urllib.request.build_opener(_NoRedirect())
        self.max_json_response_bytes = max_json_response_bytes

    def prepare(
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
    ) -> "PreparedDelivery":
        """Resolve and stage verified content for one job. Use as a context manager or call cleanup.

        ``offline`` permits fallback on a transport failure or HTTP 503 only:
        ``{"max_age_ms": 300_000}`` for a cached channel, or
        ``{"pinned_version_id": version_id}`` for one exact cached version.
        """
        from .delivery import prepare_files, resolve_and_cache, _remove_job_directory

        if cache_dir is None:
            cache_dir = Path.home().resolve() / ".cache" / "acclimate" / "python"
        version = resolve_and_cache(
            self, workspace_id, bundle_id, channel=channel, version_id=version_id,
            cache_dir=str(cache_dir),
            offline=offline,
            max_cache_bytes=max_cache_bytes, reporter=reporter,
        )
        if destination is None:
            directory = tempfile.mkdtemp(prefix="acclimate-job-", dir=os.path.realpath(tempfile.gettempdir()))
        else:
            directory = os.path.abspath(destination)
        try:
            staged = prepare_files(version, directory)
        except BaseException:
            if destination is None:
                _remove_job_directory(directory)
            raise
        return PreparedDelivery(version, staged, directory, destination is None)

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        key: str | None = None,
        *,
        raw: bool = False,
        etag: str | None = None,
        auth: bool = True,
        channel_resolution: bool = False,
        delivery: bool = False,
        _body_bytes: bytes | None = None,
        _retained: bool = False,
    ):
        mutation = method != "GET"
        if mutation and (
            not isinstance(key, str) or not re.fullmatch(r"[\x20-\x7e]{1,128}", key)
        ):
            raise UsageError(
                "mutations require a printable ASCII idempotency key (1..128 characters)", "key"
            )
        data = _body_bytes if _body_bytes is not None else (
            json.dumps(
                body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
            if body is not None
            else None
        )
        headers = {"Authorization": "Bearer " + self._token} if auth else {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if key is not None:
            headers["Idempotency-Key"] = key
        if etag:
            headers["If-None-Match"] = etag
        if delivery and self.connection_id is not None:
            headers["X-Acclimate-Connection-Id"] = self.connection_id
        if _retained:
            headers["X-Acclimate-Durable-Operation"] = "true"
        for attempt in range(self.retries + 1 if mutation else 1):
            req = urllib.request.Request(
                self.base_url + path, data=data, headers=headers, method=method
            )
            try:
                try:
                    response = self._opener.open(req, timeout=self.timeout)
                except urllib.error.HTTPError as e:
                    response = e
                with response:
                    status = response.status
                    limit = self.max_payload_bytes if raw and status < 300 else self.max_json_response_bytes
                    content = response.read(limit + 1)
                    if len(content) > limit:
                        raise ApiError(
                            413,
                            "payload_too_large" if raw else "response_too_large",
                            "Response exceeds configured limit",
                        )
                    if status == 304:
                        return None, response.headers.get("ETag"), True
                    if not 200 <= status < 300:
                        try:
                            error = json.loads(content).get("error", {})
                        except (ValueError, AttributeError):
                            error = {}
                        if not isinstance(error, dict):
                            error = {}
                        if mutation and status >= 500 and attempt < self.retries:
                            continue
                        raise ApiError(
                            status,
                            error.get("code", "http_error"),
                            error.get("message", f"HTTP {status}"),
                            error.get(
                                "requestId", response.headers.get("X-Request-Id", "")
                            ),
                            error.get("details"),
                        )
                    if raw:
                        return content
                    if not auth:
                        return content.decode("utf-8")
                    if status == 204:
                        return None
                    value = json.loads(content)
                    return (
                        (value, response.headers.get("ETag"), False)
                        if channel_resolution
                        else value
                    )
            except (
                urllib.error.URLError,
                TimeoutError,
                socket.timeout,
                ConnectionError,
                OSError,
            ) as e:
                if attempt == (self.retries if mutation else 0):
                    raise TransportError(
                        f"Could not reach the Acclimate service at {self.base_url}. "
                        "Check that the service is running and reachable from this machine.",
                        self.base_url,
                    ) from e

    @staticmethod
    def _part(value: str) -> str:
        if not isinstance(value, str) or not value or value in (".", ".."):
            raise UsageError("path identifiers must be nonempty and not dot segments", "path")
        return urllib.parse.quote(value, safe="")

    def _base(self, p: str, b: str | None = None) -> str:
        path = "/v1/workspaces/" + self._part(p) + "/bundles"
        return path if b is None else path + "/" + self._part(b)

    def health(self) -> str:
        return self._request("GET", "/health", auth=False)

    def _workspace(self, workspace_id: str) -> str:
        return "/v1/workspaces/" + self._part(workspace_id)

    def list_workspaces(self, *, cursor: str | None = None, limit: int = 50) -> Page[Workspace]:
        return self._request("GET", "/v1/workspaces" + self._listing(cursor, limit))

    def list_bundles(self, workspace_id: str, *, cursor: str | None = None, limit: int = 50) -> Page[Bundle]:
        return self._request("GET", self._base(workspace_id) + self._listing(cursor, limit))

    def list_channels(
        self, workspace_id: str, bundle_id: str, *, cursor: str | None = None, limit: int = 50
    ) -> Page[Channel]:
        return self._request(
            "GET", self._base(workspace_id, bundle_id) + "/channels" + self._listing(cursor, limit)
        )

    def create_bundle_setup(self, workspace_id: str, request: BundleSetupRequest, key: str) -> BundleSetup:
        """Create a bundle, its first version and its first release on ``channel`` in one write."""
        return self._request("POST", self._workspace(workspace_id) + "/bundle-setups", request, key)

    def list_proposals(
        self, workspace_id: str, bundle_id: str, *, cursor: str | None = None, limit: int = 50
    ) -> Page[Proposal]:
        return self._request(
            "GET", self._base(workspace_id, bundle_id) + "/proposals" + self._listing(cursor, limit)
        )

    def list_comparisons(
        self, workspace_id: str, bundle_id: str, *, cursor: str | None = None, limit: int = 50
    ) -> Page[Comparison]:
        return self._request(
            "GET", self._base(workspace_id, bundle_id) + "/comparisons" + self._listing(cursor, limit)
        )

    def create_bundle(
        self, workspace_id: str, request: CreateBundleRequest, key: str
    ) -> Bundle:
        return self._request("POST", self._base(workspace_id), request, key)

    def create_version(
        self, workspace_id: str, bundle_id: str, request: CreateVersionRequest, key: str
    ) -> VersionMetadata:
        return self._request(
            "POST", self._base(workspace_id, bundle_id) + "/versions", request, key
        )

    def get_version(
        self, workspace_id: str, bundle_id: str, version_id: str
    ) -> VersionMetadata:
        return self._request(
            "GET",
            self._base(workspace_id, bundle_id) + "/versions/" + self._part(version_id),
            delivery=True,
        )

    def get_payload(self, workspace_id: str, bundle_id: str, version_id: str) -> bytes:
        return self._request(
            "GET",
            self._base(workspace_id, bundle_id)
            + "/versions/"
            + self._part(version_id)
            + "/payload",
            raw=True,
            delivery=True,
        )

    def resolve_channel(
        self, workspace_id: str, bundle_id: str, channel: str, *, etag: str | None = None
    ) -> tuple[ChannelResolution | None, str | None, bool]:
        return self._request(
            "GET",
            self._base(workspace_id, bundle_id) + "/channels/" + self._part(channel),
            etag=etag,
            channel_resolution=True,
            delivery=True,
        )

    def list_releases(
        self, workspace_id: str, bundle_id: str, channel: str, *,
        limit: int = 20, before_revision: str | None = None,
    ) -> ReleasePage:
        query = {"limit": str(limit)}
        if before_revision is not None:
            query["beforeRevision"] = before_revision
        return self._request(
            "GET", self._base(workspace_id, bundle_id) + "/channels/" + self._part(channel)
            + "/releases?" + urllib.parse.urlencode(query),
        )

    def create_release(
        self,
        workspace_id: str,
        bundle_id: str,
        channel: str,
        request: CreateReleaseRequest,
        key: str,
    ) -> Release:
        return self._request(
            "POST",
            self._base(workspace_id, bundle_id)
            + "/channels/"
            + self._part(channel)
            + "/releases",
            request,
            key,
        )

    def create_proposal(
        self, workspace_id: str, bundle_id: str, request: ProposalRequest, key: str
    ) -> Proposal:
        return self._request(
            "POST", self._base(workspace_id, bundle_id) + "/proposals", request, key
        )

    def get_proposal(
        self, workspace_id: str, bundle_id: str, proposal_id: str
    ) -> Proposal:
        return self._request(
            "GET",
            self._base(workspace_id, bundle_id) + "/proposals/" + self._part(proposal_id),
        )

    def create_comparison(
        self, workspace_id: str, bundle_id: str, request: ComparisonRequest, key: str
    ) -> Comparison:
        return self._request(
            "POST", self._base(workspace_id, bundle_id) + "/comparisons", request, key
        )

    def get_comparison(
        self, workspace_id: str, bundle_id: str, comparison_id: str
    ) -> Comparison:
        return self._request(
            "GET",
            self._base(workspace_id, bundle_id)
            + "/comparisons/"
            + self._part(comparison_id),
        )

    def _comparison_policy_path(self, workspace_id: str, bundle_id: str, comparison_id: str) -> str:
        return self._base(workspace_id, bundle_id) + "/comparisons/" + self._part(comparison_id) + "/policy-receipts"

    def list_comparison_policy_receipts(self, workspace_id: str, bundle_id: str, comparison_id: str) -> ComparisonPolicyReceipts:
        return self._request("GET", self._comparison_policy_path(workspace_id, bundle_id, comparison_id))

    def list_candidate_policy_receipts(self, workspace_id: str, bundle_id: str, version_id: str) -> ComparisonPolicyReceipts:
        return self._request("GET", self._base(workspace_id, bundle_id) + "/versions/" + self._part(version_id) + "/policy-receipts")

    def report_comparison_policy_receipt(self, workspace_id: str, bundle_id: str, comparison_id: str,
                                         report: ComparisonPolicyReport) -> ComparisonPolicyReceipt:
        key = "policy:" + comparison_id + ":" + report["policy"]["sha256"]
        return self._request("POST", self._comparison_policy_path(workspace_id, bundle_id, comparison_id), report, key)

    def create_connection(self, workspace_id: str, request: CreateConnectionRequest, key: str) -> Connection:
        return self._request("POST", "/v1/workspaces/" + self._part(workspace_id) + "/connections", request, key)

    def list_connections(self, workspace_id: str, *, cursor: str | None = None, limit: int = 50) -> Page[Connection]:
        query = {"limit": str(limit)}
        if cursor is not None:
            query["cursor"] = cursor
        return self._request("GET", "/v1/workspaces/" + self._part(workspace_id) + "/connections?" + urllib.parse.urlencode(query))

    def _connection(self, workspace_id: str, connection_id: str) -> str:
        return "/v1/workspaces/" + self._part(workspace_id) + "/connections/" + self._part(connection_id)

    def create_connection_credential(
        self, workspace_id: str, connection_id: str, kind: ConnectionCredentialKind, key: str
    ) -> ConnectionCredential:
        return self._request("POST", self._connection(workspace_id, connection_id) + "/credentials", {"kind": kind}, key)

    def revoke_connection(self, workspace_id: str, connection_id: str, key: str) -> Connection:
        return self._request("POST", self._connection(workspace_id, connection_id) + "/revoke", {}, key)

    def revoke_connection_credential(self, workspace_id: str, connection_id: str, credential_id: str, key: str) -> None:
        self._request("POST", self._connection(workspace_id, connection_id) + "/credentials/" + self._part(credential_id) + "/revoke", {}, key)

    def report_delivery_receipt(
        self, workspace_id: str, connection_id: str, receipt: DeliveryReceiptRequest
    ) -> DeliveryReceipt:
        return self._request("POST", self._connection(workspace_id, connection_id) + "/receipts", receipt, receipt["eventId"])

    def list_delivery_receipts(
        self, workspace_id: str, connection_id: str, *, cursor: str | None = None, limit: int = 50
    ) -> Page[DeliveryReceipt]:
        query = {"limit": str(limit)}
        if cursor is not None:
            query["cursor"] = cursor
        return self._request("GET", self._connection(workspace_id, connection_id) + "/receipts?" + urllib.parse.urlencode(query))

    def _listing(self, cursor=None, limit=50):
        query = {"limit": str(limit)}
        if cursor is not None:
            query["cursor"] = cursor
        return "?" + urllib.parse.urlencode(query)

    def _draft(self, workspace_id, bundle_id, channel, draft_id=None):
        path = self._base(workspace_id, bundle_id) + "/channels/" + self._part(channel) + "/drafts"
        return path if draft_id is None else path + "/" + self._part(draft_id)

    def create_draft(self, workspace_id: str, bundle_id: str, channel: str, request: CreateDraftRequest, key: str) -> Draft:
        return self._request("POST", self._draft(workspace_id, bundle_id, channel), request, key)

    def list_drafts(
        self, workspace_id: str, bundle_id: str, channel: str, *,
        cursor: str | None = None, limit: int = 50,
        status: Literal["open", "discarded", "published", "all"] | None = None,
    ) -> DraftPage:
        query = self._listing(cursor, limit)
        if status is not None:
            query += "&" + urllib.parse.urlencode({"status": status})
        return self._request("GET", self._draft(workspace_id, bundle_id, channel) + query)

    def get_draft(self, workspace_id: str, bundle_id: str, channel: str, draft_id: str) -> Draft:
        return self._request("GET", self._draft(workspace_id, bundle_id, channel, draft_id))

    def get_draft_history(self, workspace_id: str, bundle_id: str, channel: str, draft_id: str, *, cursor: str | None = None, limit: int = 50) -> DraftSnapshotPage:
        return self._request("GET", self._draft(workspace_id, bundle_id, channel, draft_id) + "/history" + self._listing(cursor, limit))

    def save_draft(self, workspace_id: str, bundle_id: str, channel: str, draft_id: str, request: SaveDraftRequest, key: str) -> Draft:
        return self._request("POST", self._draft(workspace_id, bundle_id, channel, draft_id) + "/save", request, key)

    def discard_draft(self, workspace_id: str, bundle_id: str, channel: str, draft_id: str, request: DiscardDraftRequest, key: str) -> Draft:
        return self._request("POST", self._draft(workspace_id, bundle_id, channel, draft_id) + "/discard", request, key)

    def publish_draft(self, workspace_id: str, bundle_id: str, channel: str, draft_id: str, request: PublishDraftRequest, key: str) -> Draft:
        return self._request("POST", self._draft(workspace_id, bundle_id, channel, draft_id) + "/publish", request, key)

    def create_evaluation(self, workspace_id: str, bundle_id: str, request: EvaluationRequest, key: str) -> Evaluation:
        return self._request("POST", self._base(workspace_id, bundle_id) + "/evaluation-requests", request, key)

    def get_evaluation(self, workspace_id: str, bundle_id: str, evaluation_id: str) -> Evaluation:
        return self._request("GET", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id))

    def list_evaluations(self, workspace_id: str, bundle_id: str, *, cursor: str | None = None, limit: int = 50) -> EvaluationPage:
        return self._request("GET", self._base(workspace_id, bundle_id) + "/evaluation-requests" + self._listing(cursor, limit))

    def start_evaluation(self, workspace_id: str, bundle_id: str, evaluation_id: str, request: StartEvaluationRequest, key: str) -> Evaluation:
        return self._request("POST", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id) + "/start", request, key)

    def finish_evaluation(self, workspace_id: str, bundle_id: str, evaluation_id: str, request: FinishEvaluationRequest, key: str) -> Evaluation:
        return self._request("POST", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id) + "/finish", request, key)

    def abandon_evaluation(self, workspace_id: str, bundle_id: str, evaluation_id: str, request: AbandonEvaluationRequest, key: str) -> Evaluation:
        """Abandon an attempt whose outcome is unknown, such as a cancelled CI job.

        Its evidence never counts and a new request for the same candidate may then
        start. This does not prove the original worker stopped.
        """
        return self._request("POST", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id) + "/abandon", request, key)

    def interrupt_evaluation(self, workspace_id: str, bundle_id: str, evaluation_id: str, request: InterruptEvaluationRequest, key: str) -> Evaluation:
        return self._request("POST", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id) + "/interrupt", request, key)

    def get_evaluation_capabilities(self, workspace_id: str) -> EvaluationCapabilities:
        return self._request("GET", "/v1/workspaces/" + self._part(workspace_id) + "/evaluation-capabilities")

    def get_evaluation_progress(self, workspace_id: str, bundle_id: str, evaluation_id: str) -> EvaluationProgressView:
        return self._request("GET", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id) + "/progress")

    def report_evaluation_progress(self, workspace_id: str, bundle_id: str, evaluation_id: str, report: EvaluationProgressRequest) -> EvaluationProgressView:
        # Attempt + sequence provide server idempotency; no retained key rows.
        return self._request("POST", self._base(workspace_id, bundle_id) + "/evaluation-requests/" + self._part(evaluation_id) + "/progress", report, "progress:" + str(report["sequence"]))

    def list_connection_observations(self, workspace_id: str, *, cursor: str | None = None, limit: int = 50) -> ConnectionObservationPage:
        return self._request("GET", "/v1/workspaces/" + self._part(workspace_id) + "/connection-observations" + self._listing(cursor, limit))

    def get_operation(self, workspace_id: str, operation_id: str, *, operation_path: str | None = None) -> Operation:
        query = "?" + urllib.parse.urlencode({"operationPath": operation_path}) if operation_path is not None else ""
        return self._request("GET", "/v1/workspaces/" + self._part(workspace_id) + "/operations/" + self._part(operation_id) + query)

    def close_operation(self, workspace_id: str, operation_id: str, *, operation_path: str) -> Operation:
        return self._request("POST", "/v1/workspaces/" + self._part(workspace_id) + "/operations/" + self._part(operation_id) + "/close", {"operationPath": operation_path}, operation_id)

    def _learning(self, workspace_id: str, connection_id: str) -> str:
        return self._connection(workspace_id, connection_id) + "/learning"

    def enroll_learning(
        self, workspace_id: str, connection_id: str, request: LearningEnrollmentRequest, key: str
    ) -> LearningEnrollment:
        return self._request("PUT", self._learning(workspace_id, connection_id), request, key)

    def get_learning_enrollment(self, workspace_id: str, connection_id: str) -> LearningEnrollmentStatus:
        return self._request("GET", self._learning(workspace_id, connection_id))

    def stop_learning(self, workspace_id: str, connection_id: str, key: str) -> LearningEnrollment:
        return self._request("POST", self._learning(workspace_id, connection_id) + "/stop", None, key)

    def get_learning_outcome(self, workspace_id: str, connection_id: str, outcome_id: str) -> LearningOutcomeStatus:
        return self._request(
            "GET", self._learning(workspace_id, connection_id) + "/outcomes/" + self._part(outcome_id)
        )

    def report_learning_incident_replay(
        self, workspace_id: str, connection_id: str, replay: LearningIncidentReplay
    ) -> LearningAccepted:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/incident-replays", replay, replay["roundId"]
        )

    def report_learning_outcome(
        self, workspace_id: str, connection_id: str, outcome: LearningOutcomeRequest, key: str | None = None
    ) -> LearningOutcomeReceipt:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/outcomes", outcome,
            outcome["outcomeId"] if key is None else key,
        )

    def report_learning_correction(
        self, workspace_id: str, connection_id: str, correction: LearningCorrectionRequest
    ) -> LearningCorrectionReceipt:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/corrections", correction,
            correction["correctionId"],
        )

    def report_learning_recheck(
        self, workspace_id: str, connection_id: str, recheck: LearningRecheckRequest
    ) -> LearningRecheckReceipt:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/rechecks", recheck,
            recheck["correctionId"] + ":" + recheck["revision"],
        )

    def get_learning_work(self, workspace_id: str, connection_id: str) -> LearningWork:
        return self._request("GET", self._learning(workspace_id, connection_id) + "/work")

    def get_learning_field_requalification(
        self, workspace_id: str, connection_id: str, version_id: str
    ) -> LearningFieldRequalification:
        return self._request(
            "GET",
            self._learning(workspace_id, connection_id) + "/field-requalifications/" + self._part(version_id),
        )

    def report_learning_field_replay(
        self, workspace_id: str, connection_id: str, replay: LearningFieldReplay
    ) -> LearningAccepted:
        key = ":".join((replay["outcomeId"], replay["versionId"], replay["baselineRevision"]))
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/field-requalifications", replay, key
        )

    def report_learning_field_audit(
        self, workspace_id: str, connection_id: str, audit: LearningFieldAuditRequest, key: str | None = None
    ) -> LearningFieldAuditReceipt:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/field-audits", audit,
            audit["outcomeId"] if key is None else key,
        )

    def review_learning_round(
        self, workspace_id: str, connection_id: str, round_id: str, approve: bool, key: str, *,
        policy_override: PolicyOverride | None = None,
    ) -> LearningReviewReceipt:
        body: dict[str, Any] = {"approve": approve}
        if policy_override is not None:
            body["policyOverride"] = policy_override
        return self._request(
            "POST",
            self._learning(workspace_id, connection_id) + "/rounds/" + self._part(round_id) + "/review",
            body, key,
        )

    def renew_learning(
        self, workspace_id: str, connection_id: str, renewal: LearningRenewalRequest, key: str | None = None
    ) -> LearningRenewalReceipt:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/renew", renewal,
            renewal["renewalId"] if key is None else key,
        )

    def restore_learning(
        self, workspace_id: str, connection_id: str, restore: LearningRestoreRequest, key: str | None = None
    ) -> Release:
        return self._request(
            "POST", self._learning(workspace_id, connection_id) + "/restore", restore,
            restore["restoreId"] if key is None else key,
        )


# Delivery uses this client for service reads. Load its public return type once the client exists.
from .delivery import PreparedDelivery
