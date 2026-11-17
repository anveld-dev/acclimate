"""Offline deterministic application trial; it records no service/release evidence."""
import json
from pathlib import Path
from agent import run_existing_agent

root = Path(__file__).resolve().parent
means = {}
for side, name in (("parent", "baseline.json"), ("candidate", "candidate.json")):
    bundle = {"payload": json.loads((root / name).read_text())}
    grades = []
    for scenario in ("lost-response", "clean"):
        output = run_existing_agent(bundle=bundle, task={"scenario": scenario})
        grades.append(float(output["charges"] == 1 and output["succeeded"]))
    means[side] = sum(grades) / len(grades)
assert means == {"parent": 0.5, "candidate": 1.0}
print(json.dumps({"simulated": True, "claim": "deterministic application wiring only", "tasks": 2,
                  "parentMean": means["parent"], "candidateMean": means["candidate"],
                  "serviceMutation": False, "releaseEvidence": False}))
