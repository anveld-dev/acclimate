import copy
import hashlib
import json
from pathlib import Path
import unittest

from acclimate.evaluation_policy import (
    PolicyError, check_comparison, parse_evaluation_policy, validate_evaluation_policy,
)


FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "contracts/fixtures/evaluation-policy/vectors.json").read_text())


def run(vector):
    return check_comparison(comparison=vector["comparison"], expected_descriptor=vector["descriptor"],
                            expected_binding=vector["binding"], policy=vector["policy"])


class EvaluationPolicyTests(unittest.TestCase):
    def test_shared_policy_vectors(self):
        for vector in FIXTURES["vectors"]:
            with self.subTest(vector=vector["name"]):
                expected = vector["expected"]
                if "error" in expected:
                    with self.assertRaises(PolicyError) as caught:
                        run(vector)
                    self.assertEqual(caught.exception.code, expected["error"])
                else:
                    result = run(vector)
                    self.assertEqual(result["verdict"], expected["verdict"])
                    self.assertEqual(result["code"], expected["code"])
                    if "improvement" in expected:
                        self.assertEqual(result["summary"]["orientedMeanImprovement"], expected["improvement"])
                    self.assertIsNone(result["policy"]["sha256"])
                    self.assertEqual(result["expectedBinding"], vector["binding"])

    def test_duplicate_keys_invalid_json_and_raw_error_redaction(self):
        for text in ['{"secret-canary":1,"secret-canary":2}', '{"id":1,"\\u0069d":2}',
                     '{"metric":{"name":1,"name":2}}', '{} trailing', '{"a":01}',
                     'NaN', '\ufeff{}', '{"a":"bad\nstring"}']:
            with self.subTest(text=text):
                with self.assertRaises(PolicyError) as caught:
                    parse_evaluation_policy(text)
                self.assertEqual(caught.exception.code, "policy.invalid")
                self.assertNotIn("secret-canary", str(caught.exception))

    def test_exact_utf8_file_hash(self):
        policy = copy.deepcopy(FIXTURES["vectors"][0]["policy"])
        policy["metric"]["name"] = "reward 🐿"
        texts = [json.dumps(policy, ensure_ascii=False, separators=(",", ":")),
                 json.dumps(policy, ensure_ascii=False, indent=2) + "\r\n"]
        hashes = []
        for text in texts:
            parsed = parse_evaluation_policy(text)
            self.assertEqual(parsed["policy"], policy)
            self.assertEqual(parsed["sha256"], "sha256:" + hashlib.sha256(text.encode()).hexdigest())
            hashes.append(parsed["sha256"])
        self.assertNotEqual(*hashes)

    def test_boolean_numeric_fields_nonfinite_unknown_and_empty_cost(self):
        for patch in [{"minimumMeanImprovement": True}, {"maximumCaseRegression": False},
                      {"minimumMeanImprovement": float("inf")}, {"candidateThreshold": float("nan")},
                      {"unknown": 1}, {"cost": {"maximumCandidateUsd": False}},
                      {"maximumCandidateTaskFailures": 0.5}, {"maximumCandidateTaskFailures": False},
                      {"cost": {}}, {"requiredCases": ["ordinary", "ordinary"]}]:
            with self.subTest(patch=patch), self.assertRaises(PolicyError):
                validate_evaluation_policy({**FIXTURES["vectors"][0]["policy"], **patch})

    def test_integral_float_count_has_same_numeric_contract_as_typescript(self):
        policy = validate_evaluation_policy({**FIXTURES["vectors"][0]["policy"], "maximumCandidateTaskFailures": 0.0})
        self.assertEqual(policy["maximumCandidateTaskFailures"], 0)

    def test_detached_validation_verdict_and_no_input_changes(self):
        source = copy.deepcopy(FIXTURES["vectors"][0])
        before = copy.deepcopy(source)
        validated = validate_evaluation_policy(source["policy"], source["descriptor"])
        validated["requiredCases"].append("new")
        validated["metric"]["name"] = "changed"
        result = run(source)
        result["expectedBinding"]["requestId"] = "changed"
        self.assertEqual(source, before)

    def test_recompute_infrastructure_and_nonfinite_missingness(self):
        for mutate in [
            lambda outcome: outcome.update(executionStatus="infrastructure_failed"),
            lambda outcome: outcome.update(reward=float("nan")),
            lambda outcome: outcome.update(reward=float("inf")),
            lambda outcome: outcome.update(reward=None),
        ]:
            source = copy.deepcopy(FIXTURES["vectors"][0])
            mutate(source["comparison"]["results"][0]["candidate"])
            result = run(source)
            self.assertEqual(result["verdict"], "indeterminate")
            self.assertEqual(result["counts"]["comparablePairs"], 0)
            self.assertIsNone(result["summary"]["candidateMean"])

    def test_equal_case_means_and_visible_known_failure(self):
        weighted = next(vector for vector in FIXTURES["vectors"] if vector["name"] == "unequal-repetitions")
        result = run(weighted)
        self.assertEqual(result["summary"]["parentMean"], 0.5)
        self.assertEqual(result["summary"]["candidateMean"], 0.5)
        self.assertEqual(result["summary"]["worstCaseRegression"], 1)
        uncertain = next(vector for vector in FIXTURES["vectors"] if vector["name"] == "known-failure-and-unknown-cost")
        result = run(uncertain)
        self.assertEqual(result["verdict"], "indeterminate")
        self.assertTrue(any(item["result"] == "fail" for item in result["checks"]))
        self.assertTrue(any(item["result"] == "unknown" for item in result["checks"]))

    def test_boolean_reward_and_cost_are_not_numeric(self):
        for mutate in [lambda outcome: outcome.update(reward=True),
                       lambda outcome: outcome.update(usage={"costUsd": False})]:
            source = copy.deepcopy(FIXTURES["vectors"][0])
            mutate(source["comparison"]["results"][0]["candidate"])
            with self.assertRaises(PolicyError) as caught:
                run(source)
            self.assertEqual(caught.exception.code, "evidence.malformed")

    def test_safe_result_does_not_copy_runtime_refs_or_raw_errors(self):
        source = copy.deepcopy(FIXTURES["vectors"][0])
        source["comparison"]["results"][0]["candidate"].update(error="secret-canary", outputRef="file:///private/secret-canary")
        source["comparison"]["runtime"]["privateName"] = "secret-canary"
        source["descriptor"]["runtime"]["privateName"] = "secret-canary"
        self.assertNotIn("secret-canary", json.dumps(run(source)))


if __name__ == "__main__":
    unittest.main()
