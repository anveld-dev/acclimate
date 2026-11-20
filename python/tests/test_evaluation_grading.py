import json
from pathlib import Path
import unittest

from acclimate.evaluation_grading import grade_agreement, pass_at_k, repeat_grade

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "packages/sdk/tests/evaluation/fixtures/grading.json").read_text())


class GradingTests(unittest.TestCase):
    def test_pass_at_k_shared_vectors(self):
        for item in VECTORS["passAtK"]:
            self.assertAlmostEqual(pass_at_k(item["n"], item["successes"], item["k"]), item["value"], delta=1e-12)
        self.assertEqual(pass_at_k(5, 3, 3), 1)
        with self.assertRaises(ValueError):
            pass_at_k(3, 1, 4)

    def test_repeated_grading_matches_typescript(self):
        for item in VECTORS["repeatGrade"]:
            calls = iter(item["calls"])
            result = repeat_grade(lambda: next(calls), repetitions=len(item["calls"]), combine=item["combine"])
            self.assertEqual({"reward": result["reward"], "agreement": result["agreement"]}, item["expected"])
            if "components" in item:
                self.assertEqual(result["explanation"]["components"], item["components"])
        with self.assertRaises(ValueError):
            tie = iter([1, 0])
            repeat_grade(lambda: {"reward": next(tie)}, repetitions=2, combine="majority")
        with self.assertRaises(ValueError):
            grade_agreement([1], 1)


if __name__ == "__main__":
    unittest.main()
