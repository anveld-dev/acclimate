"""Shared app-manifest bytes/identities and private capture behavior."""
import copy
import hashlib
import json
import math
from pathlib import Path
import unittest

from acclimate.evaluation import Case, define_evaluation, ExecutionResult, GradeResult
from acclimate.evaluation_manifest import (
    canonical_evaluation_json, create_evaluation_manifest, restore_evaluation_manifest,
)
from acclimate._evaluation_shared import EvaluationError

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "tests/conformance/evaluation-manifest-v1.json").read_text())


def create(wire=None):
    x = copy.deepcopy(wire if wire is not None else FIXTURE["input"])
    return create_evaluation_manifest(config_id=x["configId"], execution=x["execution"],
        cases=[Case(c["caseId"], c["input"], c["expected"], c.get("repetitions", 1)) for c in x["cases"]],
        grader=x["grader"], runtime=x["runtime"])


class ManifestTests(unittest.TestCase):
    def invalid(self, action):
        with self.assertRaises(EvaluationError) as caught:
            action()
        self.assertEqual(caught.exception.code, "config.schema")
        self.assertNotIn("canary", str(caught.exception))

    def test_shared_vectors_descriptor_and_installed_definition(self):
        for vector in FIXTURE["canonicalVectors"]:
            canonical = canonical_evaluation_json(vector["value"])
            self.assertEqual(canonical, vector["canonical"], vector["name"])
            self.assertEqual("sha256:" + hashlib.sha256(canonical.encode()).hexdigest(), vector["sha256"])
        manifest = create()
        self.assertEqual(manifest.private_manifest_json, FIXTURE["privateManifestJson"])
        self.assertEqual(manifest.descriptor, FIXTURE["descriptor"])
        self.assertEqual(restore_evaluation_manifest(manifest.private_manifest_json).descriptor, manifest.descriptor)
        app = define_evaluation(**manifest.definition,
            execute=lambda item: ExecutionResult(item.input), grade=lambda item: GradeResult(1))
        self.assertEqual(app.descriptor, manifest.descriptor)
        self.assertNotIn("private-", json.dumps(manifest.descriptor))
        self.assertIn("private-expected-canary", manifest.private_manifest_json)

    def test_capture_and_getter_isolation(self):
        x = copy.deepcopy(FIXTURE["input"])
        cases = [Case(c["caseId"], c["input"], c["expected"], c.get("repetitions", 1)) for c in x["cases"]]
        manifest = create_evaluation_manifest(config_id=x["configId"], execution=x["execution"],
            cases=cases, grader=x["grader"], runtime=x["runtime"])
        cases[0].expected["answer"] = "changed"
        x["runtime"]["settings"]["temperature"] = .8
        manifest.definition["cases"][1].expected["answer"] = "changed"
        manifest.private_manifest["cases"][0]["input"] = "changed"
        manifest.descriptor["runtime"]["configRevision"] = "changed"
        self.assertEqual(manifest.private_manifest_json, FIXTURE["privateManifestJson"])
        self.assertEqual(manifest.descriptor, FIXTURE["descriptor"])
        reordered = copy.deepcopy(FIXTURE["input"])
        reordered["cases"].reverse()
        reordered["runtime"]["settings"] = dict(reversed(list(reordered["runtime"]["settings"].items())))
        self.assertEqual(create(reordered).descriptor, manifest.descriptor)

    def test_each_content_setting_or_artifact_changes_binding(self):
        original = create().descriptor
        paths = [("cases", 0, "input"), ("cases", 0, "expected"), ("cases", 0, "repetitions"),
            ("grader", "sourceUtf8"), ("runtime", "settings", "temperature"), ("runtime", "artifacts", "executor")]
        replacements = ["changed", "changed", 3, "# changed\n", .2, "sha256:" + "c" * 64]
        for path, value in zip(paths, replacements):
            changed = copy.deepcopy(FIXTURE["input"])
            parent = changed
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = value
            descriptor = create(changed).descriptor
            field = {"cases": "datasetRevision", "grader": "graderRevision", "runtime": "runtime"}[path[0]]
            self.assertNotEqual(descriptor[field], original[field])
            self.assertNotEqual(descriptor["runtime"]["configRevision"], original["runtime"]["configRevision"])
        artifact = copy.deepcopy(FIXTURE["input"])
        artifact["grader"] = {"artifactDigest": "sha256:" + "d" * 64}
        self.assertNotEqual(create(artifact).descriptor["graderRevision"], original["graderRevision"])
        self.assertEqual(canonical_evaluation_json([-0.0, 1.0]), "[0,1]")
        self.assertNotEqual(canonical_evaluation_json([1, 2]), canonical_evaluation_json([2, 1]))

    def test_reject_nonportable_and_bound_expansion(self):
        for value in (math.nan, math.inf, -math.inf, 2**53, 1e100, object(), (1,), "\ud800", {"\udfff": 1}, {1: 2}):
            self.invalid(lambda: canonical_evaluation_json(value))
        cycle = []; cycle.append(cycle)
        self.invalid(lambda: canonical_evaluation_json(cycle))
        deep = None
        for _ in range(66):
            deep = [deep]
        self.invalid(lambda: canonical_evaluation_json(deep))
        self.invalid(lambda: canonical_evaluation_json([None] * 100001))
        self.invalid(lambda: canonical_evaluation_json([5e-324] * 17000))

    def test_closed_restore_and_duplicate_keys(self):
        for text in (FIXTURE["privateManifestJson"].replace("{", '{"schema":"wrong",', 1),
                     '{"schema":"a","sch\\u0065ma":"b"}',
                     FIXTURE["privateManifestJson"].replace('"schema":', '"unknown":'),
                     FIXTURE["privateManifestJson"].replace("acclimate-evaluation-manifest-v1", "v2"),
                     FIXTURE["privateManifestJson"].replace("0.1000000000000000055511151231257827021181583404541015625", "1e999")):
            self.invalid(lambda: restore_evaluation_manifest(text))
        for location in ((), ("runtime",), ("grader",), ("cases", 0)):
            data = json.loads(FIXTURE["privateManifestJson"])
            current = data
            for key in location:
                current = current[key]
            current["unknown"] = "private-canary"
            self.invalid(lambda: restore_evaluation_manifest(json.dumps(data)))
        for change in (lambda d: d["cases"].append(d["cases"][0]),
                       lambda d: d["cases"][0].update(repetitions=1001),
                       lambda d: d["runtime"].update(artifacts={}),
                       lambda d: d["grader"].update(artifactDigest="sha256:" + "a" * 64)):
            data = json.loads(FIXTURE["privateManifestJson"])
            change(data)
            self.invalid(lambda: restore_evaluation_manifest(json.dumps(data)))


    def test_shared_restore_normalizes_integral_spellings_in_private_payloads(self):
        vector = FIXTURE["restoration"]
        for spelling in vector["integralSpellings"]:
            text = vector["privateManifestJson"].replace('"repetitions":1', '"repetitions":' + spelling, 1)
            text = text.replace('"nested":[1,0]', '"nested":[' + spelling + ',-0.0]')
            restored = restore_evaluation_manifest(text)
            self.assertEqual(restored.private_manifest_json, vector["privateManifestJson"])
            self.assertEqual(restored.descriptor, vector["descriptor"])
            for case in restored.definition["cases"]:
                self.assertIs(type(case.repetitions), int)
                if type(case.expected) is dict:
                    self.assertEqual(case.expected["nested"], [1, 0])
                    self.assertTrue(all(type(x) is int for x in case.expected["nested"]))
                    self.assertEqual(case.input["nested"], [1, 0])
                    self.assertTrue(all(type(x) is int for x in case.input["nested"]))
        for spelling in vector["invalidRepetitionSpellings"]:
            self.invalid(lambda: restore_evaluation_manifest(vector["privateManifestJson"].replace(
                '"repetitions":1', '"repetitions":' + spelling, 1)))
        self.invalid(lambda: restore_evaluation_manifest(vector["privateManifestJson"].replace(
            '"repetitions":1', '"repetitions":1.0,"repetitions":1', 1)))

    def test_shared_explicit_blank_identity_classification(self):
        blanks = [chr(code) for code in FIXTURE["restoration"]["blankIdentityCodepoints"]]
        for blank in blanks + ["".join(blanks)]:
            for field in ("configId", "caseId"):
                value = copy.deepcopy(FIXTURE["input"])
                if field == "configId":
                    value["configId"] = blank
                else:
                    value["cases"][0]["caseId"] = blank
                self.invalid(lambda: create(value))
                saved = json.loads(FIXTURE["privateManifestJson"])
                if field == "configId":
                    saved["configId"] = blank
                else:
                    saved["cases"][0]["caseId"] = blank
                self.invalid(lambda: restore_evaluation_manifest(json.dumps(saved)))
        for code in (133, 65279):
            value = copy.deepcopy(FIXTURE["input"])
            value["configId"] = "x" + chr(code)
            value["cases"][0]["caseId"] = chr(code) + "x"
            captured = create(value)
            self.assertEqual(restore_evaluation_manifest(captured.private_manifest_json).descriptor, captured.descriptor)
            self.assertEqual(captured.descriptor["runtime"]["configId"], "x" + chr(code))


if __name__ == "__main__":
    unittest.main()
