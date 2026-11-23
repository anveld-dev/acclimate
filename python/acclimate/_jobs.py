"""Resolve channel versions and bind production outcomes to them."""

from copy import deepcopy
import hashlib
import os
from pathlib import Path
from enum import Enum
from uuid import uuid4

from .client import AcclimateClient
from .delivery import PreparedDelivery, _stage_delivery, resolve_and_cache
from .errors import UsageError
from .types import (
    LearningGrading, LearningJson, LearningOutcomeRequest, LearningOutcomeReceipt, VerifiedVersion,
)


def _setting(value: str | None, name: str) -> str:
    value = os.getenv(name) if value is None else value
    if not value:
        raise UsageError(f"Set {name}.", name)
    return value


class Acclimate:
    def __init__(
        self, url: str | None = None, workspace: str | None = None, token: str | None = None,
        *, cache_dir: str | Path | None = None,
    ):
        url = _setting(url, "ACCLIMATE_URL")
        workspace = _setting(workspace, "ACCLIMATE_WORKSPACE")
        token = _setting(token, "ACCLIMATE_TOKEN")
        scope = "python:" + hashlib.sha256(token.encode()).hexdigest()
        self.client = AcclimateClient(url, token, scope)
        self.workspace = workspace
        self.cache_dir = Path(cache_dir) if cache_dir is not None else (
            Path.home().resolve() / ".cache" / "acclimate" / "python"
        )

    @classmethod
    def from_env(cls, *, cache_dir: str | Path | None = None) -> "Acclimate":
        """Read ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN."""
        return cls(cache_dir=cache_dir)

    def _bundle_id(self, name: str) -> str:
        cursor = None
        while True:
            page = self.client.list_bundles(self.workspace, cursor=cursor)
            for bundle in page["items"]:
                if bundle["name"] == name:
                    return bundle["id"]
            cursor = page["nextCursor"]
            if cursor is None:
                raise UsageError(f"No bundle named {name!r} in workspace {self.workspace!r}.", "bundle")

    def job(self, bundle: str, *, channel: str = "stable", input: LearningJson) -> "Job":
        """Pin a verified channel version for one production job."""
        bundle_id = self._bundle_id(bundle)
        version = resolve_and_cache(
            self.client, self.workspace, bundle_id, channel=channel, cache_dir=str(self.cache_dir)
        )
        return Job(self.client, self.workspace, version, input)


class _Missing(Enum):
    VALUE = 0


class Job:
    def __init__(
        self, client: AcclimateClient, workspace: str, version: VerifiedVersion, input: LearningJson
    ):
        self._client = client
        self._workspace = workspace
        self._version = deepcopy(version)
        self._input = deepcopy(input)
        self._outcome_id = str(uuid4())

    @property
    def version(self) -> VerifiedVersion:
        return deepcopy(self._version)

    @property
    def outcome_id(self) -> str:
        return self._outcome_id

    def prepare(self, destination: str | Path | None = None) -> PreparedDelivery:
        """Stage the pinned payload using the SDK's delivery context manager."""
        return _stage_delivery(self.version, destination)

    def expect(self, expected: LearningJson, input: LearningJson = None, *,
               output: LearningJson | _Missing = _Missing.VALUE,
               grading: LearningGrading | None = None) -> LearningOutcomeReceipt:
        """Record one correction. Repeat the same call to retry its durable outcome.

        ``grading`` chooses how the expected answer is graded. By default a short single-line
        string or any non-string JSON value is compared exactly, and a longer answer is judged
        against criteria drafted from it.
        """
        if grading not in (None, "exact", "criteria"):
            raise UsageError('grading must be "exact" or "criteria"', "grading")
        version = self._version["version"]
        body: LearningOutcomeRequest = {
            "outcomeId": self.outcome_id,
            "versionId": version["id"],
            "digest": version["digest"],
            "input": self._input if input is None else input,
            "expected": expected,
        }
        if not isinstance(output, _Missing):
            body["output"] = output
        if grading is not None:
            body["grading"] = grading
        return self._client.report_learning_outcome(self._workspace, version["bundleId"], body)
