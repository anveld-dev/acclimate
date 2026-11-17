import unittest
from acclimate.evaluation_progress import EvaluationProgressReporter


class FakeClient:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def report_evaluation_progress(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return {"activity": "fresh"}


def reporter(client):
    return EvaluationProgressReporter(client, project_id="p",
        bundle_id="00000000-0000-0000-0000-000000000001",
        request_id="00000000-0000-0000-0000-000000000002", attempt_id="attempt")


class EvaluationProgressTests(unittest.TestCase):
    def test_only_public_fields_are_sent_and_no_work_starts_at_construction(self):
        client = FakeClient()
        progress = reporter(client)
        self.assertEqual(client.calls, [])
        self.assertTrue(progress.report(sequence=1, phase="executing", completed=0, total=2,
            case={"caseId": "a", "repetition": 0, "rawOutput": "private-canary"}))
        self.assertEqual(client.calls[0][-1], {"attemptId": "attempt", "sequence": 1,
            "phase": "executing", "completed": 0, "total": 2, "case": {"caseId": "a", "repetition": 0}})
        self.assertNotIn("private-canary", repr(client.calls))

    def test_reporting_failure_is_nonfatal_and_cannot_replay_external_work(self):
        client = FakeClient(RuntimeError("private-provider-error"))
        progress = reporter(client)
        executions = []
        def callback():
            self.assertFalse(progress.report(sequence=1, phase="executing", completed=0, total=2))
            executions.append("external call")
            return "private output"
        self.assertEqual(callback(), "private output")
        self.assertEqual(executions, ["external call"])
        self.assertEqual(len(client.calls), 1)
        self.assertFalse(progress.report(sequence=True, phase="executing", completed=0, total=2))
        self.assertFalse(progress.report(sequence=2, phase="grading", completed=3, total=2))
        self.assertEqual(len(client.calls), 1)
