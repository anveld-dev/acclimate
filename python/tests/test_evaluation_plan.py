import json
from pathlib import Path
import unittest

from acclimate.evaluation_plan import PlanError, plan_evaluation

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "contracts/fixtures/evaluation-policy/plan-vectors.json").read_text())


class EvaluationPlanTests(unittest.TestCase):
    def test_shared_plan_vectors_match_typescript(self):
        for vector in VECTORS["vectors"]:
            with self.subTest(vector=vector["name"]):
                self.assertEqual(plan_evaluation(**vector["options"]), vector["expected"])

    def test_invalid_options(self):
        options = VECTORS["vectors"][0]["options"]
        for patch in ({"simulations": -1}, {"simulations": 5001}, {"seed": 1.5}, {"effects": [2]}, {"effects": "0"}):
            with self.subTest(patch=patch), self.assertRaises(PlanError):
                plan_evaluation(**{**options, **patch})

    def test_per_case_warnings(self):
        options = VECTORS["vectors"][0]["options"]

        def warnings(**patch):
            return "\n".join(plan_evaluation(**{**options, "policy": {**options["policy"], **patch},
                                                 "simulations": 0})["warnings"])
        self.assertIn("one noisy case can fail the gate", warnings(perCaseChecks="all-cases", maximumCaseRegression=0))
        self.assertNotIn("noisy case", warnings(maximumCaseRegression=0))
        self.assertNotIn("noisy case", warnings(perCaseChecks="all-cases", maximumCaseRegression=0, maximumRegressedCases=1))
        self.assertIn("protects no case, so maximumCandidateTaskFailures never fails",
                      warnings(maximumCandidateTaskFailures=0))

    def test_one_repetition_needs_an_explicit_minimum(self):
        options = VECTORS["vectors"][2]["options"]
        plan = plan_evaluation(**{**options, "policy": {**options["policy"],
                                                        "inference": {"method": "paired-t", "minRepetitions": 1}}})
        self.assertEqual(plan["minRepetitions"], 1)
        self.assertTrue(any(warning.startswith("Cases run once") for warning in plan["warnings"]))


if __name__ == "__main__":
    unittest.main()
