"""Validate replication fixtures without inference or Click command handlers."""
import json
from pathlib import Path
import shlex

from grade import grade, parse
from tasks import cases


def main():
    previous = [
        case for split in ("development", "audit", "field") for case in cases(split)
    ]
    inputs = {case["input"] for case in previous}
    ids = {case["caseId"] for case in previous}
    targets = [parse(shlex.split(case["expected"])) for case in previous]
    rows = json.loads(Path(__file__).with_name("replication-audit.json").read_text())
    assert len(rows) == 30
    for case in rows:
        expected = case["expected"]
        argv = shlex.split(expected)
        target = parse(argv)
        assert case["caseId"] not in ids, case
        assert case["input"] not in inputs, case
        assert target not in targets, case
        assert grade(argv, expected) == 1, case
        assert grade([*argv, "--invalid-control-option"], expected) == 0, case
        assert grade(["llm", "--help"], expected) == 0, case
        ids.add(case["caseId"])
        inputs.add(case["input"])
        targets.append(target)
    print("Verified 30 disjoint audit references and 60 negative controls")


if __name__ == "__main__":
    main()
