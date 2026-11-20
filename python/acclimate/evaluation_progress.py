"""Optional app-owned activity reports; no threads, lifecycle control or takeover."""
from __future__ import annotations

from .client import AcclimateClient
from .types import CaseKey, EvaluationProgressRequest
from ._evaluation_shared import guided_workspace, guided_uuid, json_bytes
from typing import Literal


class EvaluationProgressReporter:
    """Report manually from callbacks. Failed reporting never authorizes replay.

    The application owns sequence persistence across restart. This object owns
    no evaluator execution, background timer, credential or lifecycle transition.
    """
    def __init__(self, client: AcclimateClient, *, workspace_id: str, bundle_id: str,
                 request_id: str, attempt_id: str):
        self._client = client
        self._workspace_id, self._bundle_id = workspace_id, bundle_id
        self._request_id, self._attempt_id = request_id, attempt_id

    def report(self, *, sequence: int, phase: Literal["preparing", "executing", "grading", "submitting"],
               completed: int, total: int, case: CaseKey | None = None) -> bool:
        try:
            if (not guided_workspace(self._workspace_id) or not guided_uuid(self._bundle_id)
                or not guided_uuid(self._request_id) or type(self._attempt_id) is not str
                or not self._attempt_id.strip() or len(self._attempt_id.encode()) > 128
                or type(sequence) is not int or not 1 <= sequence <= 2**53-1
                or phase not in ("preparing", "executing", "grading", "submitting")
                or type(completed) is not int or type(total) is not int
                or not 0 <= completed <= total <= 2000 or total < 1):
                return False
            report: EvaluationProgressRequest = {"attemptId": self._attempt_id, "sequence": sequence,
                "phase": phase, "completed": completed, "total": total}
            if case is not None:
                if (type(case) is not dict or type(case.get("caseId")) is not str
                    or not case["caseId"].strip() or len(case["caseId"].encode()) > 1024
                    or type(case.get("repetition")) is not int or not 0 <= case["repetition"] <= 2**32-1):
                    return False
                report["case"] = {"caseId": case["caseId"], "repetition": case["repetition"]}
            if len(json_bytes(report)) > 2048:
                return False
            self._client.report_evaluation_progress(self._workspace_id, self._bundle_id, self._request_id, report)
            return True
        except Exception:
            # Do not echo private failures, or alter external callback work.
            return False
