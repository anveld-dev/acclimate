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
    additions = json.loads(Path(__file__).with_name("40-case-additions.json").read_text())
    assert set(additions) == {"development", "audit"}
    assert all(len(split) == 10 for split in additions.values())
    rows.extend(additions["development"])
    rows.extend(additions["audit"])
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
    print("Verified 50 disjoint references and 100 negative controls across both replications")


if __name__ == "__main__":
    main()
