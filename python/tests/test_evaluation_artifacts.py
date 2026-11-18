import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from acclimate._evaluation_shared import EvaluationError, json_bytes, sha256
from acclimate._evaluation_journal import Journal
from acclimate.evaluation_artifacts import (
    export_review_evidence, parse_artifact_selection, verify_review_export,
)

IDS = dict(bundle="11111111-1111-4111-8111-111111111111", request="22222222-2222-4222-8222-222222222222",
           attempt="33333333-3333-4333-8333-333333333333", comparison="44444444-4444-4444-8444-444444444444",
           parent="55555555-5555-4555-8555-555555555555", candidate="66666666-6666-4666-8666-666666666666")
DESCRIPTOR = dict(datasetRevision="private-dataset-canary", graderRevision="private-grader-canary",
                  runtime={"configId": "test", "configRevision": "1", "secret": "runtime-secret-canary"},
                  expectedCases=[{"caseId": "case/../opaque", "repetition": 0}])
OUTCOME = dict(executionStatus="completed", gradingStatus="scored", reward=1, usage={"costUsd": 0},
               error="private-error-canary", outputRef="file:///private/secret-canary")
REPORT = {**DESCRIPTOR, "parentVersionId": IDS["parent"], "candidateVersionId": IDS["candidate"],
          "parentDigest": sha256(b"parent"), "candidateDigest": sha256(b"candidate"),
          "evaluation": {"requestId": IDS["request"], "attemptId": IDS["attempt"]},
          "results": [{"caseId": DESCRIPTOR["expectedCases"][0]["caseId"], "repetition": 0,
                       "parent": copy.deepcopy(OUTCOME), "candidate": copy.deepcopy(OUTCOME)}]}
COMPARISON = {**REPORT, "id": IDS["comparison"], "complete": True, "submitter": "evaluator", "createdAt": "2026-11-16T00:00:00Z"}
REQUEST = {**REPORT, "id": IDS["request"], "status": "completed", "evaluatorPrincipal": "evaluator",
           "attemptId": IDS["attempt"], "comparisonId": IDS["comparison"], "error": None,
           "createdAt": "2026-11-16T00:00:00Z", "updatedAt": "2026-11-16T00:00:00Z", "proposalId": None}


class FakeClient:
    def get_evaluation(self, *args):
        return copy.deepcopy(REQUEST)

    def get_comparison(self, *args):
        return copy.deepcopy(COMPARISON)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acclimate-python-artifacts-")).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        self.configs = self.root / "config"
        self.configs.mkdir(mode=0o700)
        self.journals = self.root / "journals"
        self.config_path = self.configs / "evaluator.json"
        self.read_config_path = self.configs / "reader.json"
        self.service = "http://127.0.0.1:43123"
        self.config = dict(schemaVersion=1, serviceUrl=self.service, projectId="project", evaluatorPrincipalId="evaluator",
                           evaluatorToken="config-token-canary", journalRoot=str(self.journals))
        self._write_private(self.config_path, json_bytes(self.config))
        self._write_private(self.read_config_path, json_bytes(dict(schemaVersion=1, serviceUrl=self.service, projectId="project", readToken="reader-token-canary")))
        self.handoff = dict(schemaVersion=1, serviceUrl=self.service, projectId="project", bundleId=IDS["bundle"], requestId=IDS["request"], configuration=copy.deepcopy(DESCRIPTOR))
        self.scope = {key: self.config[key] for key in ("serviceUrl", "projectId")}
        self.scope.update(bundleId=IDS["bundle"], requestId=IDS["request"], evaluatorPrincipalId="evaluator")
        self.mock = patch("acclimate.evaluation_artifacts.make_client", return_value=FakeClient())
        self.mock.start()
        self.addCleanup(self.mock.stop)

    @staticmethod
    def _write_private(path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def assert_code(self, code, callback):
        with self.assertRaises(EvaluationError) as raised:
            callback()
        self.assertEqual(raised.exception.code, code)

    @staticmethod
    def selection(role="output", required=True):
        return {"schemaVersion": 1, "entries": [{"caseId": DESCRIPTOR["expectedCases"][0]["caseId"], "repetition": 0,
                                                  "side": "candidate", "role": role, "required": required}]}

    def local_evidence(self):
        with Journal(self.journals, self.scope) as journal:
            body = json_bytes(REPORT)
            ref = journal.save_body("submit", body)
            journal.save({"scope": self.scope, "request": REPORT, "attemptId": IDS["attempt"],
                          "keys": dict(start="start", submit="submit", finish="finish"), "executionStarted": True})
            entry = journal.write_artifact({"caseId": DESCRIPTOR["expectedCases"][0]["caseId"], "repetition": 0,
                                            "side": "candidate", "versionId": IDS["candidate"], "digest": REPORT["candidateDigest"], "role": "output"},
                                           {"answer": "share-me", "secret": "output-secret-canary"})
            journal.save({"scope": self.scope, "request": REPORT, "attemptId": IDS["attempt"],
                          "keys": dict(start="start", submit="submit", finish="finish"), "executionStarted": True,
                          "report": REPORT, "comparisonId": IDS["comparison"], "completed": True, "wireBodies": {"submit": ref}})
            journal.save_artifact_index({"schemaVersion": 1, "requestId": IDS["request"], "attemptId": IDS["attempt"],
                                         "reportSha256": sha256(body), "comparisonId": IDS["comparison"], "entries": [entry]})
            return journal.directory, entry

    def test_scalar_export_without_journal_and_reader_online_binding(self):
        result = export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff, output_directory=self.root / "export")
        self.assertEqual(result["localInspection"], "not_requested")
        data = Path(result["manifestPath"]).read_text() + (self.root / "export" / "comparison-review.json").read_text()
        for secret in ("private-dataset-canary", "private-grader-canary", "runtime-secret-canary", "secret-canary", "config-token-canary"):
            self.assertNotIn(secret, data)
        self.assertEqual(verify_review_export(manifest_path=result["manifestPath"])["provenance"], "self_consistent")
        online = verify_review_export(manifest_path=result["manifestPath"], online={"readConfigPath": self.read_config_path, "expectedHandoff": self.handoff})
        self.assertEqual(online["provenance"], "online_scalar_binding")
        self.assertFalse(online["executionAttested"])
        wrong = {**self.handoff, "projectId": "wrong"}
        self.assert_code("evidence.identity_mismatch", lambda: verify_review_export(manifest_path=result["manifestPath"], online={"readConfigPath": self.read_config_path, "expectedHandoff": wrong}))

    def test_content_mapper_is_role_only_and_mixed_statuses_verify(self):
        self.local_evidence()
        calls = []

        def mapper(value):
            self.assertEqual(set(value), {"identity", "value"})
            self.assertEqual(value["identity"]["role"], "output")
            calls.append(value)
            return {"mediaType": "application/json", "value": {"answer": value["value"]["answer"]}}

        result = export_review_evidence(config_path=self.config_path, handoff=self.handoff, output_directory=self.root / "export",
                                        selection=self.selection(), to_review_artifact=mapper)
        self.assertEqual(len(calls), 1)
        manifest = json.loads(Path(result["manifestPath"]).read_text())
        candidate = next(x for x in manifest["entries"] if x["side"] == "candidate")
        self.assertEqual([x["availability"] for x in candidate["roles"]], ["exported", "not_shared"])
        self.assertNotIn("output-secret-canary", (self.root / "export" / candidate["roles"][0]["file"]["path"]).read_text())
        self.assertEqual(verify_review_export(manifest_path=result["manifestPath"])["status"], "verified")

    def test_required_missing_commits_nothing_and_optional_missing_is_explicit(self):
        self.local_evidence()
        self.assert_code("artifact.missing", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "required", selection=self.selection("grader-explanation"), to_review_artifact=lambda _: None))
        self.assertFalse((self.root / "required" / "manifest.json").exists())
        result = export_review_evidence(config_path=self.config_path, handoff=self.handoff, output_directory=self.root / "optional",
                                        selection=self.selection("grader-explanation", False), to_review_artifact=lambda _: None)
        manifest = json.loads(Path(result["manifestPath"]).read_text())
        candidate = next(x for x in manifest["entries"] if x["side"] == "candidate")
        self.assertEqual(candidate["roles"][1]["availability"], "missing")
        self.assertEqual(result["selection"]["optionalMissing"], 1)

    def test_corrupt_indexed_content_never_reaches_mapper(self):
        directory, entry = self.local_evidence()
        (directory / entry["file"]).write_bytes(b'{"tampered":true}')
        calls = []
        self.assert_code("artifact.hash_mismatch", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "export", selection=self.selection(), to_review_artifact=lambda x: calls.append(x)))
        self.assertEqual(calls, [])
        with Journal(self.journals, self.scope) as journal:
            state = journal.read()
            state["comparisonId"] = IDS["parent"]
            journal.save(state)
        self.assert_code("artifact.integrity", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "other", selection=self.selection(), to_review_artifact=lambda _: None))

    def test_every_selected_original_is_validated_before_first_mapper_call(self):
        self.local_evidence()
        with Journal(self.journals, self.scope) as journal:
            index = journal.read_artifact_index()
            explanation = journal.write_artifact({"caseId": DESCRIPTOR["expectedCases"][0]["caseId"], "repetition": 0,
                "side": "candidate", "versionId": IDS["candidate"], "digest": REPORT["candidateDigest"], "role": "grader-explanation"},
                {"reason": "valid before corruption"})
            index["entries"].append(explanation)
            journal.save_artifact_index(index)
            (journal.directory / explanation["file"]).write_bytes(b"corrupt later role")
        selection = self.selection()
        selection["entries"].extend(self.selection("grader-explanation")["entries"])
        calls = []
        def mapper(value):
            calls.append(value)
            return {"mediaType": "text/plain", "text": "redacted"}
        self.assert_code("artifact.hash_mismatch", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "export", selection=selection, to_review_artifact=mapper))
        self.assertEqual(calls, [])

    def test_duplicate_decoded_index_fields_never_reach_mapper(self):
        directory, _ = self.local_evidence()
        filename = directory / "artifact-index.json"
        original = filename.read_text()
        for key in ("comparisonId", "\\u0063omparisonId"):
            filename.write_text('{"' + key + '":"wrong",' + original[1:])
            calls = []
            self.assert_code("artifact.integrity", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
                output_directory=self.root / "export", selection=self.selection(),
                to_review_artifact=lambda value: calls.append(value)))
            self.assertEqual(calls, [])

    def test_verifier_rejects_inspection_claims_inconsistent_with_selection(self):
        scalar = export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff, output_directory=self.root / "scalar")
        manifest_path = Path(scalar["manifestPath"])
        manifest = json.loads(manifest_path.read_text())
        for inspection in ("validated", "unavailable"):
            manifest_path.write_bytes(json_bytes({**manifest, "localInspection": inspection}))
            self.assert_code("artifact.integrity", lambda: verify_review_export(manifest_path=manifest_path))
        self.local_evidence()
        content = export_review_evidence(config_path=self.config_path, handoff=self.handoff, output_directory=self.root / "content",
            selection=self.selection(), to_review_artifact=lambda _: {"mediaType": "text/plain", "text": "redacted"})
        manifest_path = Path(content["manifestPath"])
        manifest = json.loads(manifest_path.read_text())
        for inspection in ("not_requested", "unavailable"):
            manifest_path.write_bytes(json_bytes({**manifest, "localInspection": inspection}))
            self.assert_code("artifact.integrity", lambda: verify_review_export(manifest_path=manifest_path))

    def test_export_budget_stops_mapping_when_released_bytes_exceed_limit(self):
        self.local_evidence()
        with Journal(self.journals, self.scope) as journal:
            index = journal.read_artifact_index()
            index["entries"].append(journal.write_artifact({"caseId": DESCRIPTOR["expectedCases"][0]["caseId"], "repetition": 0,
                "side": "candidate", "versionId": IDS["candidate"], "digest": REPORT["candidateDigest"], "role": "grader-explanation"}, None))
            journal.save_artifact_index(index)
        selection = self.selection()
        selection["entries"].extend(self.selection("grader-explanation")["entries"])
        calls = []
        def mapper(value):
            calls.append(value)
            return {"mediaType": "text/plain", "text": "x" * 101}
        with patch("acclimate.evaluation_artifacts.MAX_EXPORT", 100):
            self.assert_code("artifact.integrity", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
                output_directory=self.root / "large", selection=selection, to_review_artifact=mapper))
        self.assertEqual(len(calls), 1)
        self.assertFalse((self.root / "large" / "manifest.json").exists())

    def test_path_symlink_duplicate_selection_and_hash_tampering(self):
        selection = self.selection()
        selection["entries"] *= 2
        self.assert_code("artifact.selection_invalid", lambda: parse_artifact_selection(selection))
        with self.assertRaises(EvaluationError) as caught:
            export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff,
                                   output_directory=self.configs / "bad")
        diagnostic = caught.exception.diagnostic
        self.assertEqual((diagnostic["code"], diagnostic["field"], diagnostic["nextAction"]),
                         ("artifact.integrity", "outputDirectory", "fix_config"))
        self.assertIn("private sibling", diagnostic["hint"])
        self.assertNotIn(str(self.root), json.dumps(diagnostic))
        self.assertFalse((self.configs / "bad").exists())
        result = export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff, output_directory=self.root / "export")
        manifest = json.loads(Path(result["manifestPath"]).read_text())
        manifest["projection"]["file"] = "../config/reader.json"
        Path(result["manifestPath"]).write_text(json.dumps(manifest))
        self.assert_code("artifact.integrity", lambda: verify_review_export(manifest_path=result["manifestPath"]))
        safe = export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff, output_directory=self.root / "safe")
        projection = self.root / "safe" / "comparison-review.json"
        projection.unlink()
        projection.symlink_to(self.read_config_path)
        self.assert_code("artifact.integrity", lambda: verify_review_export(manifest_path=safe["manifestPath"]))

    def test_cross_language_manifest_and_large_finite_reward_verify_in_node(self):
        fixture = copy.deepcopy(COMPARISON)
        fixture["results"][0]["parent"]["reward"] = 1e16
        fixture["results"][0]["candidate"]["reward"] = 1e16
        with patch.object(FakeClient, "get_comparison", return_value=fixture):
            result = export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff, output_directory=self.root / "export")
        self.assertEqual(verify_review_export(manifest_path=result["manifestPath"])["status"], "verified")
        repository = Path(__file__).resolve().parents[2]
        tsx = repository / "node_modules" / ".bin" / "tsx"
        if not tsx.exists():
            self.skipTest("TypeScript runner is unavailable for cross-language check")
        script = self.root / "verify.mts"
        module = repository / "packages/sdk/src/evaluation/artifacts.ts"
        arguments = json.dumps({"manifestPath": result["manifestPath"]})
        script.write_text(f'import {{verifyReviewExport}} from {json.dumps(str(module))};\n'
                          f'console.log(JSON.stringify(await verifyReviewExport({arguments})));\n')
        checked = subprocess.run([str(tsx), str(script)], cwd=repository, text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(checked.stdout)["provenance"], "self_consistent")

    def test_rewritten_projection_and_manifest_cannot_establish_online_truth(self):
        result = export_review_evidence(read_config_path=self.read_config_path, handoff=self.handoff, output_directory=self.root / "export")
        manifest_path = Path(result["manifestPath"])
        manifest = json.loads(manifest_path.read_text())
        projected = self.root / "export" / manifest["projection"]["file"]
        value = json.loads(projected.read_text())
        value["results"][0]["candidate"]["reward"] = 999
        data = json_bytes(value)
        projected.write_bytes(data)
        manifest["projection"].update(sha256=sha256(data), bytes=len(data))
        manifest_path.write_bytes(json_bytes(manifest))
        self.assertEqual(verify_review_export(manifest_path=manifest_path)["provenance"], "self_consistent")
        self.assert_code("evidence.identity_mismatch", lambda: verify_review_export(manifest_path=manifest_path,
            online={"readConfigPath": self.read_config_path, "expectedHandoff": self.handoff}))

    def test_missing_journal_and_oversize_mapper_keep_explicit_failure(self):
        result = export_review_evidence(config_path=self.config_path, handoff=self.handoff, output_directory=self.root / "optional",
                                        selection=self.selection(required=False), to_review_artifact=lambda _: None)
        self.assertEqual(result["localInspection"], "unavailable")
        self.assertEqual(result["selection"]["optionalMissing"], 1)
        self.local_evidence()
        self.assert_code("artifact.mapper_failed", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "large", selection=self.selection(),
            to_review_artifact=lambda _: {"mediaType": "text/plain", "text": "x" * (1024 * 1024 + 1)}))
        self.assertFalse((self.root / "large" / "manifest.json").exists())

    def test_dotdot_destination_cannot_bypass_private_root_overlap(self):
        outside = self.root / "outside"
        outside.mkdir(mode=0o700)
        self.journals.mkdir(mode=0o700)
        for alias in (outside / ".." / "config" / "new-export",
                      outside / ".." / "journals" / "new-export"):
            self.assert_code("artifact.integrity", lambda alias=alias: export_review_evidence(
                config_path=self.config_path, handoff=self.handoff, output_directory=alias))
            self.assertFalse(Path(os.path.abspath(alias)).exists())
        link = self.root / "alias"
        link.symlink_to(outside, target_is_directory=True)
        self.assert_code("artifact.integrity", lambda: export_review_evidence(
            config_path=self.config_path, handoff=self.handoff,
            output_directory=link / ".." / "new-export"))
        self.assertFalse((self.root / "new-export").exists())

    def test_swapped_registered_file_bindings_fail_before_mapper(self):
        self.local_evidence()
        with Journal(self.journals, self.scope) as journal:
            index = journal.read_artifact_index()
            explanation = journal.write_artifact({"caseId": DESCRIPTOR["expectedCases"][0]["caseId"], "repetition": 0,
                "side": "candidate", "versionId": IDS["candidate"], "digest": REPORT["candidateDigest"], "role": "grader-explanation"},
                {"graderOnly": "explanation-canary"})
            index["entries"].append(explanation)
            output = index["entries"][0]
            first = {key: output[key] for key in ("file", "sha256", "bytes")}
            output.update({key: explanation[key] for key in first})
            explanation.update(first)
            journal.save_artifact_index(index)
        calls = []
        self.assert_code("artifact.integrity", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "swapped", selection=self.selection(), to_review_artifact=lambda value: calls.append(value)))
        self.assertEqual(calls, [])

    def test_missing_report_or_index_is_unavailable_but_corruption_fails(self):
        calls = []
        for number, filename in enumerate(("submit-body.json", "artifact-index.json")):
            directory, _ = self.local_evidence()
            (directory / filename).unlink()
            result = export_review_evidence(config_path=self.config_path, handoff=self.handoff,
                output_directory=self.root / f"missing-{number}", selection=self.selection(required=False), to_review_artifact=lambda value: calls.append(value))
            self.assertEqual(result["localInspection"], "unavailable")
            self.assert_code("artifact.missing", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
                output_directory=self.root / f"required-{number}", selection=self.selection(), to_review_artifact=lambda value: calls.append(value)))
        directory, _ = self.local_evidence()
        (directory / "submit-body.json").write_bytes(b"{}")
        self.assert_code("artifact.integrity", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "corrupt", selection=self.selection(required=False), to_review_artifact=lambda value: calls.append(value)))
        self.assertEqual(calls, [])

    def test_mapper_cannot_commit_nonportable_json_that_its_verifier_rejects(self):
        self.local_evidence()
        self.assert_code("artifact.mapper_failed", lambda: export_review_evidence(config_path=self.config_path, handoff=self.handoff,
            output_directory=self.root / "nonportable", selection=self.selection(),
            to_review_artifact=lambda _: {"mediaType": "application/json", "value": 2**53}))
        self.assertFalse((self.root / "nonportable" / "manifest.json").exists())

    def test_scalar_reader_and_evaluator_reject_native_marker_without_journal(self):
        prepared = self.root / "prepared"
        (prepared / ".acclimate").mkdir(parents=True, mode=0o700)
        (prepared / ".acclimate" / "native-job-owner.json").write_text(json.dumps({"schemaVersion": 1, "jobId": "a" * 64}))
        for connection in ({"config_path": self.config_path}, {"read_config_path": self.read_config_path}):
            self.assert_code("artifact.integrity", lambda: export_review_evidence(**connection, handoff=self.handoff, output_directory=prepared / "shared"))
        self.assertFalse(self.journals.exists())


if __name__ == "__main__":
    unittest.main()
