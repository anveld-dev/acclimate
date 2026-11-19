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


if __name__ == "__main__":
    unittest.main()
