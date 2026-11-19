import copy
import hashlib
import json
from pathlib import Path
import unittest

from acclimate._student_t import CONFIDENCE_LEVELS, NORMAL_QUANTILES, QUANTILES, student_t_quantile
from acclimate.evaluation_policy import (
    CONNECTED_POLICY_DEFAULTS, RESERVED_POLICY_IDS, PolicyError, check_comparison, parse_evaluation_policy,
    validate_evaluation_policy,
)


CONTRACTS = Path(__file__).resolve().parents[2] / "contracts/fixtures"
FIXTURES = json.loads((CONTRACTS / "evaluation-policy/vectors.json").read_text())
INFERENCE = json.loads((CONTRACTS / "evaluation-policy/inference-vectors.json").read_text())
CONFIDENCE = json.loads((CONTRACTS / "connected-confidence-decisions.json").read_text())
STUDENT_T = json.loads((CONTRACTS / "evaluation-analysis/student-t.json").read_text())
SUMMARY_FIELDS = ("parentMean", "candidateMean", "orientedMeanImprovement", "worstCaseRegression",
                  "candidateTaskFailures", "protectedCandidateTaskFailures", "parentTaskFailures")


def _outcome(value):
    if value is None:
        return {"executionStatus": "infrastructure_failed", "gradingStatus": "missing", "reward": None,
                "outputRef": None, "error": "execution_failed", "usage": None}
    if isinstance(value, dict):
        return {"executionStatus": "task_failed", "gradingStatus": "scored", "reward": value["taskFailed"],
                "outputRef": None, "error": None, "usage": None}
    return {"executionStatus": "completed", "gradingStatus": "scored", "reward": value,
            "outputRef": None, "error": None, "usage": None}


def expand_inference_vector(vector):
    """Expand a compact shared inference vector into check_comparison keyword arguments."""
    base = copy.deepcopy(FIXTURES["vectors"][0])
    base["policy"].pop("inference")
    results = [{"caseId": case["id"], "repetition": repetition, "parent": _outcome(parent),
                "candidate": _outcome(case["candidate"][repetition])}
               for case in vector["cases"] for repetition, parent in enumerate(case["parent"])]
    keys = [{"caseId": row["caseId"], "repetition": row["repetition"]} for row in results]
    base["comparison"].update(results=results, expectedCases=keys)
    base["descriptor"]["expectedCases"] = keys
    options = {"stage": "stage", "replayPassed": "replay_passed",
               "calibratedStandardDeviation": "calibrated_standard_deviation",
               "calibrationEffectiveRepetitions": "calibration_effective_repetitions"}
    return {"comparison": base["comparison"], "expected_descriptor": base["descriptor"],
            "expected_binding": base["binding"], "policy": {**base["policy"], **vector["policy"]},
            **{options[name]: value for name, value in vector.get("options", {}).items()}}


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

    def test_missing_pairs_report_bounded_public_arm_diagnostics(self):
        source = copy.deepcopy(FIXTURES["vectors"][0])
        keys = [{"caseId":"ordinary", "repetition": i} for i in range(20)]
        source["descriptor"]["expectedCases"] = source["comparison"]["expectedCases"] = keys
        source["comparison"]["results"] = []
        gaps = run(source)["evidenceGaps"]
        self.assertEqual((gaps["total"], len(gaps["rows"])), (40, 32))
        self.assertEqual(gaps["rows"][0], {"caseId":"ordinary", "repetition":0,
            "side":"parent", "stage":"collection", "reason":"missing_pair"})

    def test_equal_case_means_and_visible_known_failure(self):
        weighted = next(vector for vector in FIXTURES["vectors"] if vector["name"] == "unequal-repetitions")
        result = run(weighted)
        self.assertEqual(result["summary"]["parentMean"], 0.5)
        self.assertEqual(result["summary"]["candidateMean"], 0.5)
        self.assertEqual(result["summary"]["worstCaseRegression"], 1)
        uncertain = next(vector for vector in FIXTURES["vectors"] if vector["name"] == "known-failure-and-unknown-cost")
        result = run(uncertain)
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["evidenceGaps"]["rows"][0]["reason"], "missing_cost")
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


    def test_shared_inference_vectors_match_typescript_exactly(self):
        for vector in INFERENCE["vectors"]:
            with self.subTest(vector=vector["name"]):
                expected = vector["expected"]
                if "error" in expected:
                    with self.assertRaises(PolicyError) as caught:
                        check_comparison(**expand_inference_vector(vector))
                    self.assertEqual(caught.exception.code, expected["error"])
                    continue
                result = check_comparison(**expand_inference_vector(vector))
                self.assertEqual({
                    "verdict": result["verdict"], "code": result["code"], "checks": result["checks"],
                    "summary": {name: result["summary"][name] for name in SUMMARY_FIELDS},
                    "perCaseChecks": result["perCaseChecks"], "interpretation": result["interpretation"],
                    "inference": result["inference"],
                }, expected)
                # Exact float identity, not just numeric equality within a tolerance.
                for name in ("lowerBound", "sd", "standardError", "criticalValue", "meanDifference"):
                    actual, wanted = result["inference"][name], expected["inference"][name]
                    self.assertEqual(None if actual is None else float(actual).hex(),
                                     None if wanted is None else float(wanted).hex(), name)

    def test_shared_connected_confidence_decisions(self):
        for decision in CONFIDENCE:
            with self.subTest(decision=decision["name"]):
                connected = CONNECTED_POLICY_DEFAULTS["audit" if decision["stage"] == "audit" else "development"]
                base = copy.deepcopy(FIXTURES["vectors"][0])
                template = base["comparison"]["results"][0]
                offset = decision.get("rewardOffset", 0)
                rows = []
                for index, gain in enumerate(decision["gains"]):
                    for repetition in range(decision.get("evaluationRepetitions", 1)):
                        missing_parent = index in decision.get("missingParent", [])
                        missing_candidate = index in decision.get("missingCandidate", [])
                        parent = {**template["parent"], "reward": None if missing_parent else offset + max(0, -gain)}
                        candidate = {**template["candidate"], "reward": 1 if missing_parent else (
                            None if missing_candidate else offset + max(0, gain))}
                        if missing_parent:
                            parent["gradingStatus"] = "missing"
                        if missing_candidate:
                            candidate["gradingStatus"] = "missing"
                        rows.append({"caseId": str(index), "repetition": repetition, "parent": parent, "candidate": candidate})
                keys = [{"caseId": row["caseId"], "repetition": row["repetition"]} for row in rows]
                base["comparison"].update(results=rows, expectedCases=keys)
                base["descriptor"]["expectedCases"] = keys
                policy = {**base["policy"], "id": "connected-audit" if decision["stage"] == "audit" else "connected-development",
                          "metric": {**base["policy"]["metric"], "scale": connected["scale"]},
                          "schemaVersion": decision.get("schemaVersion", 2),
                          "minimumMeanImprovement": decision.get("minimumMeanImprovement", 0),
                          "inference": connected["inference"], "perCaseChecks": connected["perCaseChecks"]}
                for name in ("auditMode", "nonInferiorityMargin"):
                    if name in decision:
                        policy[name] = decision[name]
                result = check_comparison(
                    comparison=base["comparison"], expected_descriptor=base["descriptor"],
                    expected_binding=base["binding"], policy=policy, stage=decision["stage"],
                    replay_passed=decision.get("replayPassed"),
                    calibrated_standard_deviation=decision["calibratedStandardDeviation"],
                    calibration_effective_repetitions=decision.get("calibrationEffectiveRepetitions"))
                self.assertEqual(result["verdict"] == "pass", decision["pass"])

    def test_student_t_table_matches_shared_fixture(self):
        self.assertEqual(list(CONFIDENCE_LEVELS), STUDENT_T["confidenceLevels"])
        self.assertEqual(list(NORMAL_QUANTILES), STUDENT_T["normalQuantiles"])
        self.assertEqual([list(row) for row in QUANTILES], STUDENT_T["quantiles"])
        for item in STUDENT_T["checks"]:
            self.assertAlmostEqual(student_t_quantile(item["confidence"], item["df"]), item["value"], delta=5e-7)

    def test_reserved_ids_need_the_connected_flag(self):
        for policy_id in RESERVED_POLICY_IDS:
            policy = {**FIXTURES["vectors"][0]["policy"], "id": policy_id}
            with self.assertRaises(PolicyError):
                validate_evaluation_policy(policy)
            self.assertEqual(validate_evaluation_policy(policy, connected=True)["id"], policy_id)

    def test_inference_block_validation(self):
        base = {key: value for key, value in FIXTURES["vectors"][0]["policy"].items() if key != "inference"}
        for inference in [{"method": "bootstrap"}, {"confidence": 0.95}, {"method": "paired-t", "minCases": 1},
                          {"method": "paired-t", "minCases": 2.5}, {"method": "paired-t", "minRepetitions": 0},
                          {"method": "paired-t", "sdFloor": -0.1}, {"method": "paired-t", "maximumMissingPercent": 51},
                          {"method": "none", "sdFloor": 0.1}, {"method": "paired-t", "extra": True},
                          {"method": "paired-t", "confidence": True}]:
            with self.subTest(inference=inference), self.assertRaises(PolicyError):
                validate_evaluation_policy({**base, "inference": inference})
        for scale in [{"minimum": 1, "maximum": 1}, {"minimum": 0}, {"minimum": 0, "maximum": "x"}]:
            with self.subTest(scale=scale), self.assertRaises(PolicyError):
                validate_evaluation_policy({**base, "metric": {**base["metric"], "scale": scale}})
        parsed = validate_evaluation_policy({**base, "perCaseChecks": "protected-cases",
                                             "inference": {"method": "paired-t", "confidence": 0.975, "minCases": 20, "sdFloor": 0}})
        self.assertEqual(parsed["inference"], {"method": "paired-t", "confidence": 0.975, "minCases": 20, "sdFloor": 0})
        self.assertEqual(parsed["perCaseChecks"], "protected-cases")


if __name__ == "__main__":
    unittest.main()
