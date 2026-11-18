import copy
import json
from pathlib import Path
import unittest

from acclimate.evaluation_analysis import AnalysisError, analyze_comparison
from acclimate.evaluation_policy import PolicyError


FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "contracts/fixtures/evaluation-analysis/vectors.json").read_text())


def run(value):
    return analyze_comparison(comparison=value["comparison"], expected_descriptor=value["expectedDescriptor"],
        expected_binding=value["expectedBinding"], **{name: value[name] for name in ("metrics", "observations", "uncertainty") if name in value})


def vector_input(vector):
    value = copy.deepcopy(FIXTURES["input"])
    for patch in vector["patches"]:
        target = value
        for segment in patch["path"][:-1]:
            target = target[segment]
        if patch.get("remove"):
            del target[patch["path"][-1]]
        else:
            target[patch["path"][-1]] = copy.deepcopy(patch["value"])
    return value


class EvaluationAnalysisTests(unittest.TestCase):
    def test_shared_vectors(self):
        for vector in FIXTURES["vectors"]:
            with self.subTest(name=vector["name"]):
                value = vector_input(vector)
                before = copy.deepcopy(value)
                if "error" in vector["expected"]:
                    with self.assertRaises((AnalysisError, PolicyError)) as caught:
                        run(value)
                    self.assertEqual(caught.exception.code, vector["expected"]["error"])
                else:
                    self.assertEqual(run(value), vector["expected"]["result"])
                self.assertEqual(value, before)

    def test_equal_case_oracle_and_lower_direction(self):
        result = run(copy.deepcopy(FIXTURES["input"]))
        for metric in result["metrics"]:
            self.assertEqual(metric["summary"]["orientedMeanImprovement"], (2 - 3) / 2)
            self.assertEqual(metric["counts"], {"distinctCases": 2, "expectedPairs": 5, "comparablePairs": 5, "missingPairs": 0})
        self.assertEqual(result["metrics"][0]["summary"]["parentMean"], (2 + 8) / 2)
        self.assertEqual(result["metrics"][0]["summary"]["candidateMean"], (4 + 5) / 2)
        self.assertFalse(result["executionAttested"])

    def test_invalid_protocol_and_components(self):
        for patch in [{"seed": -1}, {"seed": 4294967296}, {"seed": 1.5}, {"seed": True}, {"resamples": 99},
                      {"resamples": 10001}, {"confidenceLevel": float("nan")}, {"independentStochasticPairs": False},
                      {"estimand": "population"}, {"unknown": 1}]:
            value = copy.deepcopy(FIXTURES["input"])
            value["uncertainty"].update(patch)
            with self.subTest(patch=patch), self.assertRaises(AnalysisError):
                run(value)
        for number in [float("nan"), float("inf"), -float("inf"), True, 10**400]:
            value = copy.deepcopy(FIXTURES["input"])
            value["observations"][0]["values"]["latency"] = number
            with self.assertRaises(AnalysisError):
                run(value)

    def test_order_independent_stream_detached_result_and_opt_in(self):
        value = copy.deepcopy(FIXTURES["input"])
        first = run(value)
        value["metrics"].reverse()
        self.assertEqual(run(value)["metrics"], list(reversed(first["metrics"])))
        first["expectedBinding"]["requestId"] = "changed"
        first["uncertaintyProtocol"]["samplingProtocol"] = "changed"
        self.assertNotEqual(value["expectedBinding"]["requestId"], "changed")
        self.assertNotEqual(value["uncertainty"]["samplingProtocol"], "changed")
        del value["uncertainty"]
        self.assertEqual(
            [(row["metric"]["id"], row["uncertainty"]["status"]) for row in run(value)["metrics"]],
            [(metric["id"], "not_requested") for metric in value["metrics"]],
        )

    def test_nonfinite_scalar_no_interval(self):
        value = copy.deepcopy(FIXTURES["input"])
        value["comparison"]["results"][0]["parent"]["reward"] = float("inf")
        metric = run(value)["metrics"][0]
        self.assertEqual(metric["code"], "analysis.nonfinite")
        self.assertIsNone(metric["summary"])
        self.assertIsNone(metric["uncertainty"]["interval"])
        component = run(value)["metrics"][1]
        self.assertEqual(component["code"], "analysis.nonfinite")
        self.assertIsNone(component["uncertainty"]["interval"])


if __name__ == "__main__":
    unittest.main()
