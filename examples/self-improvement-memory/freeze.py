#!/usr/bin/env python3
"""Verify W1 and write an immutable, machine-readable preregistration."""
import argparse
import hashlib
from importlib.metadata import distribution, version
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import unicodedata

from run import DEFAULTS, HERE, ROOT, node

FIXTURES = HERE / "fixtures/w1"
LLM_COMMIT = "46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f"
SPEC = ROOT / "docs/architecture/self-improvement-memory/experiment.md"
sys.path.insert(0, str(FIXTURES))
from grade import grade, parse
from tasks import cases


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(text):
    return " ".join(unicodedata.normalize("NFKC", text).lower().split())


def load(path):
    return json.loads(path.read_text())


def zero_call_checks(held=None):
    sources = load(FIXTURES / "SOURCES.json")
    for name, row in sources.items():
        if digest((FIXTURES / name).read_bytes()) != row["sha256"]:
            raise ValueError(f"Fixture digest mismatch: {name}")
    if version("llm") != "0.38" or version("click") != "8.5.1":
        raise ValueError("Install the pinned W1 grader dependencies")
    installation = distribution("llm")
    provenance = json.loads(installation.read_text("direct_url.json") or "{}")
    if provenance.get("vcs_info", {}).get("commit_id") != LLM_COMMIT:
        raise ValueError("Install LLM from the pinned Git commit in requirements.txt")
    extras = load(FIXTURES / "40-case-additions.json")
    evolve = [*cases("development"), *extras["development"]]
    previous = [
        *evolve, *cases("audit"), *cases("field"), *extras["audit"],
        *load(FIXTURES / "replication-audit.json"),
    ]
    held = load(FIXTURES / "held-out.json") if held is None else held
    if len(held) != 60 or len(evolve) != 40:
        raise ValueError("Expected 60 held-out and 40 evolve cases")
    ids = {row["caseId"] for row in previous}
    inputs = {fingerprint(row["input"]) for row in previous}
    targets = [parse(shlex.split(row["expected"])) for row in previous]
    controls = 0
    for row in held:
        name, text = row["caseId"], fingerprint(row["input"])
        argv = shlex.split(row["expected"])
        target = parse(argv)
        if (not re.fullmatch(r"h-[0-9a-f]{8}", name) or not text or
                name in ids or text in inputs or target in targets):
            raise ValueError(f"Held-out split is not disjoint: {name}")
        if grade(argv, row["expected"]) != 1:
            raise ValueError(f"Invalid canonical answer: {name}")
        negative = row["negativeControls"]
        if len(negative) != 2 or negative[0] == negative[1] or any(
            grade(control, row["expected"]) != 0 for control in negative
        ):
            raise ValueError(f"Invalid negative controls: {name}")
        controls += len(negative)
        ids.add(name)
        inputs.add(text)
        targets.append(target)
    return {"evolveCases": len(evolve), "heldOutCases": len(held),
            "priorCases": len(previous), "negativeControlsRejected": controls}


def cmd(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def build_record(source_tree, service_bin, pg_bin):
    source_tree = source_tree.resolve()
    if source_tree.is_relative_to(ROOT):
        raise ValueError("Use an LLM checkout outside the private experiment repository")
    if not Path("/usr/bin/sandbox-exec").is_file():
        raise ValueError("Paid stages require macOS sandbox-exec for fixture isolation")
    if cmd("git", "rev-parse", "HEAD", cwd=source_tree) != LLM_COMMIT or cmd(
        "git", "status", "--porcelain", "--untracked-files=all", cwd=source_tree
    ):
        raise ValueError("Use a clean W1 source tree at " + LLM_COMMIT)
    code = {
        str(path.relative_to(ROOT)): digest(path.read_bytes())
        for path in sorted(HERE.rglob("*"))
        if path.is_file() and path.suffix in {".json", ".py", ".ts", ".sql", ".md", ".txt", ".sh"}
        and not any(part.startswith(".") or part in {"__pycache__", "node_modules"} for part in path.relative_to(HERE).parts)
    }
    code[str(SPEC.relative_to(ROOT))] = digest(SPEC.read_bytes())
    rules = (ROOT / "src/learning/optimizer/instructions.rs").read_text()
    return {
        "serviceCommit": cmd("git", "rev-parse", "HEAD"),
        "serviceBinarySha256": digest(service_bin.read_bytes()),
        "eightRulesSha256": digest(rules.split('const EIGHT_RULES: &str = r#"', 1)[1].split('"#;', 1)[0].encode()),
        "toolVersions": {
            "rust": cmd("rustc", "--version"), "node": cmd("node", "--version"),
            "python": cmd(sys.executable, "--version"), "postgres": cmd(str(pg_bin / "postgres"), "--version"),
            "codexCli": cmd("codex", "--version"), "scipy": version("scipy"),
            "codexSdk": load(ROOT / "node_modules/@openai/codex-sdk/package.json")["version"],
            "acclimateSdk": load(ROOT / "packages/sdk/package.json")["version"],
            "llm": version("llm"), "click": version("click"),
        },
        "sha256": code, "llmCommit": LLM_COMMIT,
    }


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def freeze(source_tree, service_bin, pg_bin, pilot_path, optimizer_context):
    checks = zero_call_checks()
    commitments = node({"action": "freeze", "python": sys.executable, "seed": "", "block": 1}, capture=True)
    pilot = load(pilot_path) if pilot_path else None
    if pilot and (not pilot["passed"] or pilot["optimizerContext"] != optimizer_context):
        raise ValueError("Use a passing pilot report for the frozen optimizer context")
    document = {
        "schemaVersion": 1, **build_record(source_tree, service_bin, pg_bin),
        "serviceSettings": DEFAULTS,
        "runtimeSettings": {"ACCLIMATE_MODEL_ENDPOINT": "ephemeral loopback adapter",
                            "ACCLIMATE_MODEL_TOKEN": "ephemeral, redacted"},
        "models": {"source": "gpt-6-luna", "target": "gpt-6.2-sol",
                   "optimizer": "gpt-6-luna", "effort": "low"},
        "optimizerContext": optimizer_context,
        "setting": {"domain": "cli-support", "benchmark": "llm-0.38-argv"},
        "n": 10, "N": 10, "k": 5, "rolloutsPerCase": 5, "caseConcurrency": 8,
        "heldOut": commitments["heldOut"], "evolve": commitments["evolve"],
        "seedRules": "Sort by SHA-256 of the JSON array [seed, ...order components, originalIndex]. "
                     "Use start/block and codes/block for starts and labels. "
                     "Use block/code/number/role/sample/caseId for SDK rollout labels, "
                     "and block/code/number/role/sample for offline case/rollout pairs.",
        "trace": "JSON object with argv. Errors are stored separately. Held-out service reports contain score and passed.",
        "checks": checks, "pilot": pilot,
        "pilotSha256": digest(pilot_path.read_bytes()) if pilot_path else None,
    }
    return {**document, "seed": digest(canonical(document))}


def verify(path, source_tree, service_bin, pg_bin):
    document = load(path)
    seed = document.pop("seed")
    if digest(canonical(document)) != seed:
        raise ValueError("Preregistration digest mismatch")
    for key, value in build_record(source_tree, service_bin, pg_bin).items():
        if document.get(key) != value:
            raise ValueError(f"Preregistration no longer matches the environment: {key}")
    return {**document, "seed": seed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Run the zero-call fixture checks only")
    parser.add_argument("--source-tree", type=Path)
    parser.add_argument("--service-bin", type=Path, default=ROOT / "target/debug/acclimate-service")
    parser.add_argument("--pg-bin", type=Path, default=Path("/opt/homebrew/opt/postgresql@16/bin"))
    parser.add_argument("--optimizer-context", type=int, default=272_000)
    parser.add_argument("--pilot-report", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.check:
        print(json.dumps(zero_call_checks(), sort_keys=True))
        return
    if not args.output or not args.source_tree or args.optimizer_context < 1:
        parser.error("--output, --source-tree and a positive optimizer context are required")
    result = freeze(args.source_tree, args.service_bin, args.pg_bin, args.pilot_report, args.optimizer_context)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as out:
        json.dump(result, out, indent=2, sort_keys=True, ensure_ascii=False)
        out.write("\n")
    print(f"Frozen preregistration {result['seed']} at {args.output}")


if __name__ == "__main__":
    main()
