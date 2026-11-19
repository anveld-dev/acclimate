"""Evaluation researcher: installed Python app, real isolated Rust/PostgreSQL.

Run with Python 3.11+: python -m scripts.acceptance.dx_personas.evaluation_researcher
Only disposable fixture mutations are performed; no model calls or source builds.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import subprocess

from scripts.acceptance.dx_personas.support import PersonaFixture


CRITERIA = {
    "installed_bound_execution": "Own installed app/executor/grader; exact parent/candidate binding on real service.",
    "equal_case_weight": "Unequal repetitions; independent per-case mean calculation must match installed policy.",
    "metric_direction": "Same observed finite values must orient improvement according to explicit higher/lower metadata.",
    "completion_is_not_quality": "A fully graded losing candidate completes its request but fails higher-is-better quality policy.",
    "missingness": "An actual failed grade leaves null reward, incomplete comparison and indeterminate policy; never zero imputation.",
    "unknown_cost": "Absent costs cannot pass a policy requiring known cost, even when its scalar quality checks pass.",
    "reproducibility": "Retained private manifest reconstructs exact descriptor; case/settings/grader changes alter app-derived identity.",
    "selected_evidence": "Only selected output/explanation roles are shared; independent reader verifies online scalar binding.",
    "generated_manifest": "Installed helper derives case/source/build/settings revisions, saves and restores executable definition without private plaintext in public descriptor.",
    "components": "Installed named metric analysis consumes actual service comparisons and retained independent grader components with exact trusted identities, units, directions and explicit missingness.",
    "conditional_uncertainty": "Separately executed app stochastic paired draws on fixed tasks support only explicitly declared conditional approximate bootstrap intervals, never promotion or gating.",
    "research_limits": "No component authenticity, real model quality, population inference, second-machine distribution or arbitrary process-loss recovery claimed.",
}


GRADER = '''from acclimate.evaluation import GradeResult

def grade(run):
    # The application grader sees output/expected, never a requested reward.
    if run.output.get("gradeUnavailable"):
        raise RuntimeError("deliberately unavailable independent rubric")
    expected = run.expected["labels"]
    predicted = run.output["labels"]
    matches = sum(a == b for a, b in zip(predicted, expected))
    score = matches / len(expected) if len(predicted) == len(expected) else 0.0
    return GradeResult(score, explanation={"rubric":"exact positional label match",
        "matches":matches, "total":len(expected), "reward":score, "positionalErrors":len(expected)-matches})
'''


APP = '''import hashlib
import json
import os
import random
from pathlib import Path
import sys
from acclimate.evaluation import Case, ExecutionResult, define_evaluation
from acclimate.evaluation_cli import evaluation_main
from acclimate.evaluation_manifest import create_evaluation_manifest, restore_evaluation_manifest
from grader import grade

manifest_path = Path(sys.argv.pop(1))
manifest = json.loads(manifest_path.read_text())
def digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True,
        separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
source = Path(__file__).with_name("grader.py").read_text()
captured = create_evaluation_manifest(config_id="researcher-label-router", execution="model-free",
    cases=[Case(c["id"],c["input"],c["expected"],c["repetitions"]) for c in manifest["cases"]],
    grader={"sourceUtf8":source}, runtime={"settings":manifest["settings"], "artifacts":{
        "executor":"sha256:"+hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "declared-build":"sha256:"+hashlib.sha256(Path(manifest["buildFile"]).read_bytes()).hexdigest(),
        "installed-wheel":manifest["wheelDigest"]}})
private_path = manifest_path.with_suffix(".captured.json")
fd = os.open(private_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as file:
    file.write(captured.private_manifest_json)
restored = restore_evaluation_manifest(private_path.read_text())

def execute(run):
    program = json.loads(run.bundle["payload"]["files"][0]["text"])
    if manifest["settings"].get("stochastic"):
        # Separate pseudorandom stream per fixed-task pair; both sides share
        # uniforms for pairing, with no adaptive stopping or reused outputs.
        identity = json.dumps([manifest["settings"]["collectionSeed"],run.case_id,run.repetition],separators=(",",":"))
        rng = random.Random(int(hashlib.sha256(identity.encode()).hexdigest(),16))
        labels = ["yes" if rng.random() < program["__probability"] else "no" for _ in run.input["records"]]
    else:
        labels = [program.get(item, "unknown") for item in run.input["records"]]
    unavailable = manifest["settings"].get("ungradedCandidateCritical", False) and run.context.side == "candidate" and run.case_id == "critical"
    return ExecutionResult({"labels":labels, "gradeUnavailable":unavailable}, usage=None)

app = define_evaluation(**restored.definition, execute=execute, grade=grade)
if sys.argv[1:] == ["manifest-proof"]:
    public_json = json.dumps(restored.descriptor,sort_keys=True)
    print(json.dumps({"descriptor":restored.descriptor,
        "descriptorRoundtrip":restored.descriptor == captured.descriptor == app.descriptor,
        "privateBytesRoundtrip":restored.private_manifest_json == captured.private_manifest_json,
        "definitionRoundtrip":restored.definition == captured.definition,
        "privateManifestSha256":"sha256:"+hashlib.sha256(private_path.read_bytes()).hexdigest(),
        "publicContainsPrivateSentinel":manifest["settings"]["privateSentinel"] in public_json,
        "publicContainsSource":source in public_json,
        "publicContainsBuildName":"declared-build" in public_json}))
    sys.exit(0)

def mapper(run):
    return {"mediaType":"application/json", "value":run["value"]}

sys.exit(evaluation_main(app, review={"to_review_artifact":mapper}))
'''


def digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def bundle(program):
    return {"schemaVersion": 1, "files": [{"path": "AGENTS.md", "kind": "instruction", "text": json.dumps(program, sort_keys=True)}]}


def policy(direction="higher", cost=False):
    value = {"schemaVersion": 1, "id": "researcher-label-quality", "revision": "1-" + direction,
             "metric": {"name": "positional-label-match" if direction == "higher" else "alternate-loss-interpretation", "unit": "fraction", "direction": direction},
             "aggregation": "equal-case-means", "minimumMeanImprovement": 0.1,
             "maximumCaseRegression": 1.0, "requiredCases": ["routine", "critical"],
             # A tiny fixture: name the point-estimate method explicitly instead of the paired-t default.
             "inference": {"method": "none"}}
    if cost:
        value["cost"] = {"maximumCandidateUsd": 1.0}
    return value


METRICS = [
    {"id": "correctness", "name": "Positional label correctness", "unit": "fraction correct", "direction": "higher", "source": "reward"},
    {"id": "errors", "name": "Positional label errors", "unit": "labels", "direction": "lower", "source": "component"},
]


def analyze_observed(f, app, python, command, label, manifest, completed, request, comparison, uncertainty=None):
    """Project only explicitly selected app grader components; trust service separately."""
    descriptor = command("describe", selected_manifest=manifest)
    trusted = {key: comparison[key] for key in ("parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest")}
    trusted.update(requestId=request["requestId"], attemptId=completed["attemptId"], comparisonId=completed["comparisonId"])
    assert comparison["evaluation"] == {"requestId": trusted["requestId"], "attemptId": trusted["attemptId"]}
    assert all(request[key] == trusted[key] for key in ("parentVersionId", "candidateVersionId"))
    selection = f.write_json(app / (label + "-analysis-selection.json"), {"schemaVersion": 1, "entries": [
        {"caseId": row["caseId"], "repetition": row["repetition"], "side": side, "role": "grader-explanation", "required": True}
        for row in comparison["results"] for side in ("parent", "candidate")]})
    evidence = f.root / (label + "-analysis-evidence")
    command("export", "--config", f.evaluator_config, "--handoff", app / (label + "-handoff.json"),
            "--out", evidence, "--selection", selection, selected_manifest=manifest)
    exported = json.loads((evidence / "manifest.json").read_text())
    observations = []
    for entry in exported["entries"]:
        for role in entry["roles"]:
            if role["role"] != "grader-explanation" or role["availability"] != "exported":
                continue
            explanation = json.loads((evidence / role["file"]["path"]).read_text())
            observations.append(dict(requestId=trusted["requestId"], attemptId=trusted["attemptId"], comparisonId=trusted["comparisonId"],
                graderRevision=descriptor["graderRevision"], caseId=entry["caseId"], repetition=entry["repetition"], side=entry["side"],
                versionId=trusted[entry["side"] + "VersionId"], bundleDigest=trusted[entry["side"] + "Digest"],
                values={"errors": explanation["positionalErrors"]}))
    files = [f.write_json(app / (label + "-" + name + ".json"), value) for name, value in (
        ("comparison", comparison), ("descriptor", descriptor), ("trusted", trusted))]
    config = dict(metrics=METRICS, observations=observations)
    if uncertainty is not None:
        config["uncertainty"] = uncertainty

    def installed(value, suffix="analysis"):
        config_path = f.write_json(app / (label + "-" + suffix + "-config.json"), value)
        return f.run([python, app / "analyze.py", *files, config_path], app)

    result = installed(config)
    assert result == installed(config, "repeat"), "Saved service analysis must reproduce exactly"
    return result, config, installed, trusted


def reference_bootstrap(observed, protocol):
    """Independent spec arithmetic over actual returned service scalar rows."""
    case_ids = sorted({row["caseId"] for row in observed}, key=lambda value: value.encode("utf-8"))
    groups = [[row for row in sorted(observed, key=lambda row: row["repetition"]) if row["caseId"] == case_id] for case_id in case_ids]
    mean = lambda values: sum(values) / len(values)
    result = {"summary": {side + "Mean": mean([mean([row[side] for row in group]) for group in groups]) for side in ("parent", "candidate")}}
    differences = [[row["candidate"] - row["parent"] for row in group] for group in groups]
    result["summary"]["orientedMeanImprovement"] = mean([mean(group) for group in differences])
    draws, state = [], protocol["seed"]
    for _ in range(protocol["resamples"]):
        case_draws = []
        for group in differences:
            sampled = []
            for _ in group:
                state = (1664525 * state + 1013904223) % (2 ** 32)
                sampled.append(group[int((state / (2 ** 32)) * len(group))])
            case_draws.append(mean(sampled))
        draws.append(mean(case_draws))
    draws.sort()
    alpha = (1 - protocol["confidenceLevel"]) / 2
    result["interval"] = {name: draws[max(0, math.ceil(quantile * len(draws)) - 1)] for name, quantile in (("lower", alpha), ("upper", 1 - alpha))}
    return result


def run(output):
    # Written before fixture execution so the acceptance bar is reviewable.
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "evaluation-researcher-criteria.json").write_text(json.dumps(CRITERIA, indent=2) + "\n")
    assertions = {}
    with PersonaFixture("evaluation-researcher", output) as f:
        app, python = f.install_python()
        assert not app.resolve().is_relative_to(Path(__file__).resolve().parents[3]), "Consumer must be external"
        (app / "research_eval.py").write_text(APP)
        (app / "grader.py").write_text(GRADER)
        records = ["r1", "r2", "r3", "r4", "r5"]
        manifest = {"schemaVersion": 1, "settings": {"ungradedCandidateCritical": False, "privateSentinel": "retained-private-input-do-not-publish"},
                    "cases": [{"id": "routine", "input": {"records": records}, "expected": {"labels": ["yes"] * 5}, "repetitions": 3},
                              {"id": "critical", "input": {"records": ["c1"]}, "expected": {"labels": ["safe"]}, "repetitions": 1}]}
        manifest["buildFile"] = str(f.write_json(app / "declared-build.json", {"python": "3.11+", "collectionAlgorithm": "paired-sha256-random-v1"}))
        manifest["wheelDigest"] = "sha256:" + f.installation_proofs["app"]["releaseArchiveSha256"]
        manifest_path = f.write_json(app / "private-manifest.json", manifest)
        baseline = bundle({"__probability": 0.35, "r1": "yes", "r2": "yes", "r3": "no", "r4": "no", "r5": "no", "c1": "safe"})
        candidate = bundle({"__probability": 0.7, "r1": "yes", "r2": "yes", "r3": "yes", "r4": "yes", "r5": "no", "c1": "unsafe"})
        setup = f.bootstrap(baseline, name="Evaluation researcher independent label rubric")
        bundle_id = setup["bundle"]["id"]
        candidate_path = f.write_json(app / "candidate-research.json", candidate)
        high_path = f.write_json(app / "higher-policy.json", policy())
        low_path = f.write_json(app / "lower-policy.json", policy("lower"))
        cost_path = f.write_json(app / "cost-policy.json", policy("lower", True))

        def command(*args, selected_manifest=manifest_path, expected=0):
            return f.run([python, "research_eval.py", selected_manifest, *args], app, expected=expected)

        descriptor = command("describe")
        assertions["descriptor_reconstructed_exactly"] = descriptor == command("describe")
        manifest_proof = command("manifest-proof")
        assertions["generated_manifest_saved_roundtrip"] = all(manifest_proof[k] for k in ("descriptorRoundtrip", "privateBytesRoundtrip", "definitionRoundtrip"))
        assertions["public_descriptor_excludes_declared_private_inputs"] = not any(manifest_proof[k] for k in ("publicContainsPrivateSentinel", "publicContainsSource", "publicContainsBuildName"))
        changed = {}
        for key in ("snapshot", "expected", "repetitions", "settings", "grader", "build"):
            variant = copy.deepcopy(manifest)
            if key == "snapshot":
                variant["cases"][0]["input"]["records"][0] = "changed-r1"
            elif key == "expected":
                variant["cases"][0]["expected"]["labels"][0] = "changed-expected"
            elif key == "repetitions":
                variant["cases"][0]["repetitions"] += 1
            elif key == "settings":
                variant["settings"]["experimentalSwitch"] = True
            elif key == "grader":
                (app / "grader.py").write_text(GRADER + "\n# independently retained changed grader source\n")
            else:
                variant["buildFile"] = str(f.write_json(app / "changed-build.json", {"python": "3.12", "collectionAlgorithm": "paired-sha256-random-v1"}))
            path = f.write_json(app / (key + "-manifest.json"), variant)
            changed[key] = command("describe", selected_manifest=path)
            (app / "grader.py").write_text(GRADER)
            assertions[key + "_changes_identity"] = changed[key] != descriptor and changed[key]["runtime"]["configRevision"] != descriptor["runtime"]["configRevision"]
        assertions["declared_provenance_domains_change"] = (
            all(changed[key]["datasetRevision"] != descriptor["datasetRevision"] for key in ("snapshot", "expected", "repetitions"))
            and changed["grader"]["graderRevision"] != descriptor["graderRevision"]
            and all(changed[key]["runtime"]["runtimeRevision"] != descriptor["runtime"]["runtimeRevision"] for key in ("settings", "build")))
        retained_manifest = json.loads(manifest_path.with_suffix(".captured.json").read_text())
        def declared_hash(domain, value):
            canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            return "sha256:" + hashlib.sha256((retained_manifest["schema"] + "\n" + domain + "\n" + canonical).encode()).hexdigest()
        declared_revisions = {
            "datasetRevision": declared_hash("dataset", retained_manifest["cases"]),
            "graderRevision": declared_hash("grader", retained_manifest["grader"]),
            "runtimeRevision": declared_hash("runtime", retained_manifest["runtime"])}
        declared_revisions["configRevision"] = declared_hash("configuration", {
            "configId": retained_manifest["configId"], "execution": retained_manifest["execution"], **declared_revisions})
        assertions["generated_hashes_match_independent_private_inventory"] = (
            all(descriptor[key] == declared_revisions[key] for key in ("datasetRevision", "graderRevision"))
            and all(descriptor["runtime"][key] == declared_revisions[key] for key in ("runtimeRevision", "configRevision")))

        def request_and_run(label, selected_manifest=manifest_path, failed=False):
            handoff_path = app / (label + "-handoff.json")
            request = command("request", "--config", f.evaluator_config, "--bundle", bundle_id, "--channel", "stable", "--payload", candidate_path,
                              "--intent", f.root / "private/intents" / (label + "-intent.json"), "--out", handoff_path, selected_manifest=selected_manifest)
            before = command("check", "--read-config", f.reader_config, "--handoff", handoff_path, "--policy", high_path, selected_manifest=selected_manifest, expected=3)
            assert before["code"] == "evidence.not_terminal"
            completed = command("run", "--config", f.evaluator_config, "--handoff", handoff_path, selected_manifest=selected_manifest, expected=2 if failed else 0)
            return handoff_path, request, completed

        handoff_path, request, completed = request_and_run("complete")
        higher = command("check", "--read-config", f.reader_config, "--handoff", handoff_path, "--policy", high_path, expected=2)
        lower = command("check", "--read-config", f.reader_config, "--handoff", handoff_path, "--policy", low_path)
        unknown_cost = command("check", "--read-config", f.reader_config, "--handoff", handoff_path, "--policy", cost_path, expected=3)
        base = "/v1/projects/" + f.project + "/bundles/" + bundle_id
        comparison = f.h.call("GET", base + "/comparisons/" + completed["comparisonId"], actor="viewer")
        observed = [{"caseId": pair["caseId"], "repetition": pair["repetition"], "parent": pair["parent"]["reward"], "candidate": pair["candidate"]["reward"]} for pair in comparison["results"]]
        # Independent derivation over returned service evidence, without SDK math.
        case_means = {}
        for case_id in {row["caseId"] for row in observed}:
            rows = [row for row in observed if row["caseId"] == case_id]
            case_means[case_id] = {side: sum(row[side] for row in rows) / len(rows) for side in ("parent", "candidate")}
        independent = {side: sum(means[side] for means in case_means.values()) / len(case_means) for side in ("parent", "candidate")}
        pooled = {side: sum(row[side] for row in observed) / len(observed) for side in ("parent", "candidate")}
        close = lambda a, b: abs(a - b) < 1e-12
        assertions["unequal_repetitions_expose_pooled_reversal"] = pooled["candidate"] > pooled["parent"] and independent["candidate"] < independent["parent"]
        assertions["equal_case_policy_matches_independent_calculation"] = all(close(higher["summary"][side + "Mean"], independent[side]) for side in independent)
        assertions["direction_changes_oriented_improvement"] = close(higher["summary"]["orientedMeanImprovement"], -0.3) and close(lower["summary"]["orientedMeanImprovement"], 0.3) and lower["verdict"] == "pass"
        assertions["loser_completed_but_quality_failed"] = completed["status"] == "completed" and comparison["complete"] and higher["verdict"] == "fail"
        assertions["unknown_cost_does_not_false_pass"] = unknown_cost["verdict"] == "indeterminate" and unknown_cost["code"] == "cost.unknown" and unknown_cost["summary"]["candidateCostUsd"] is None and unknown_cost["summary"]["candidateUnknownCosts"] == 4
        assertions["binding_matches_service"] = comparison["evaluation"] == {"requestId": completed["requestId"], "attemptId": completed["attemptId"]} and comparison["candidateVersionId"] == request["candidateVersionId"] and comparison["parentVersionId"] == request["parentVersionId"]
        assertions["service_retained_exact_descriptor"] = all(comparison[key] == descriptor[key] for key in descriptor)

        missing_manifest = copy.deepcopy(manifest)
        missing_manifest["settings"]["ungradedCandidateCritical"] = True
        missing_path = f.write_json(app / "missing-manifest.json", missing_manifest)
        incomplete_handoff, incomplete_request, incomplete = request_and_run("incomplete", missing_path, failed=True)
        missing_verdict = command("check", "--read-config", f.reader_config, "--handoff", incomplete_handoff, "--policy", low_path, selected_manifest=missing_path, expected=3)
        incomplete_comparison = f.h.call("GET", base + "/comparisons/" + incomplete["comparisonId"], actor="viewer")
        missing_row = next(pair for pair in incomplete_comparison["results"] if pair["caseId"] == "critical")
        assertions["ungraded_is_null_incomplete_and_indeterminate"] = incomplete["status"] == "failed" and not incomplete_comparison["complete"] and missing_row["candidate"]["reward"] is None and missing_row["candidate"]["gradingStatus"] == "failed" and missing_verdict["verdict"] == "indeterminate" and missing_verdict["summary"]["candidateMean"] is None and missing_verdict["counts"]["comparablePairs"] == 3

        selection = f.write_json(app / "selection-research.json", {"schemaVersion": 1, "entries": [{"caseId": "critical", "repetition": 0, "side": side, "role": role, "required": True} for side in ("parent", "candidate") for role in ("output", "grader-explanation")]})
        export_dir = f.root / "shared-review"
        exported = command("export", "--config", f.evaluator_config, "--handoff", handoff_path, "--out", export_dir, "--selection", selection)
        review_manifest_path = export_dir / "manifest.json"
        review_manifest = json.loads(review_manifest_path.read_text())
        roles = [role for entry in review_manifest["entries"] for role in entry["roles"]]
        selected_values = {entry["side"]: {role["role"]: json.loads((export_dir / role["file"]["path"]).read_text()) for role in entry["roles"] if role["availability"] == "exported"} for entry in review_manifest["entries"] if entry["caseId"] == "critical"}
        assertions["selected_responses_and_explanations_inspectable"] = selected_values["parent"]["output"]["labels"] == ["safe"] and selected_values["candidate"]["output"]["labels"] == ["unsafe"] and selected_values["parent"]["grader-explanation"]["matches"] == 1 and selected_values["candidate"]["grader-explanation"]["matches"] == 0
        # A reviewer directory receives only the export, handoff and separate
        # read credential. No application manifest, callbacks or journal lives here.
        reviewer = f.root / "reviewer"
        reviewer.mkdir(mode=0o700)
        shutil.copytree(export_dir, reviewer / "evidence")
        reviewer_config = f.write_json(reviewer / "reader.json", json.loads(f.reader_config.read_text()))
        reviewer_handoff = f.write_json(reviewer / "handoff.json", json.loads(handoff_path.read_text()))
        verify_program = "import json,sys;from acclimate.evaluation_artifacts import verify_review_export; options={} if len(sys.argv)==2 else {'online':{'readConfigPath':sys.argv[2],'expectedHandoff':json.load(open(sys.argv[3]))}}; print(json.dumps(verify_review_export(manifest_path=sys.argv[1],**options)))"
        offline = f.run([python, "-c", verify_program, reviewer / "evidence/manifest.json"], reviewer)
        online = f.run([python, "-c", verify_program, reviewer / "evidence/manifest.json", reviewer_config, reviewer_handoff], reviewer)
        assertions["selected_evidence_online_binding"] = online["provenance"] == "online_scalar_binding" and online["executionAttested"] is False and sum(role["availability"] == "exported" for role in roles) == 4 and sum(role["availability"] == "not_shared" for role in roles) == 12
        deterministic, analysis_config, installed_analysis, trusted = analyze_observed(
            f, app, python, command, "complete", manifest_path, completed, request, comparison)
        metrics = {row["metric"]["id"]: row for row in deterministic["metrics"]}
        assertions["named_metrics_match_actual_equal_case_rewards"] = (
            close(metrics["correctness"]["summary"]["parentMean"], .7)
            and close(metrics["correctness"]["summary"]["candidateMean"], .4)
            and metrics["errors"]["metric"]["unit"] == "labels"
            and metrics["errors"]["metric"]["direction"] == "lower"
            and close(metrics["errors"]["summary"]["orientedMeanImprovement"], .5))
        assertions["deterministic_descriptive_run_has_no_interval"] = all(
            row["uncertainty"]["status"] == "not_requested" and row["uncertainty"]["interval"] is None for row in deterministic["metrics"])
        missing_component = copy.deepcopy(analysis_config)
        missing_component["observations"][0]["values"]["errors"] = None
        missing_analysis = installed_analysis(missing_component, "missing-component")
        assertions["missing_component_indeterminate_never_zero"] = (
            missing_analysis["metrics"][1]["status"] == "indeterminate"
            and missing_analysis["metrics"][1]["summary"] is None
            and missing_analysis["metrics"][1]["counts"]["missingPairs"] == 1
            and missing_analysis["metrics"][0]["summary"] is not None)
        reject_script = app / "reject-analysis.py"
        reject_script.write_text("import json,sys\nfrom acclimate.evaluation_analysis import analyze_comparison\na=json.load(open(sys.argv[1]))\ntry:\n analyze_comparison(**a)\n print(json.dumps({'rejected':False}))\nexcept Exception as e:\n print(json.dumps({'rejected':True,'code':getattr(e,'code',None)}))\n")
        rejections = {}
        for field in ("requestId", "attemptId", "comparisonId", "versionId", "bundleDigest", "graderRevision"):
            stale = copy.deepcopy(analysis_config)
            stale["observations"][0][field] += "-stale"
            spec = f.write_json(app / ("stale-" + field + ".json"), dict(
                comparison=comparison, expected_descriptor=descriptor, expected_binding=trusted, **stale))
            rejections[field] = f.run([python, reject_script, spec], app)
        assertions["stale_sidecar_identity_rejected"] = all(
            value == {"rejected": True, "code": "analysis.identity_mismatch"} for value in rejections.values())

        stochastic_manifest = copy.deepcopy(manifest)
        stochastic_manifest["settings"].update(stochastic=True, collectionSeed=918273)
        stochastic_manifest["cases"] = [{"id": case_id, "input": {"records": [case_id + str(i) for i in range(5)]},
            "expected": {"labels": ["yes"] * 5}, "repetitions": 8} for case_id in ("routine", "critical")]
        stochastic_path = f.write_json(app / "stochastic-manifest.json", stochastic_manifest)
        stochastic_handoff, stochastic_request, stochastic_completed = request_and_run("stochastic", stochastic_path)
        stochastic_comparison = f.h.call("GET", base + "/comparisons/" + stochastic_completed["comparisonId"], actor="viewer")
        protocol = {"method": "paired-within-case-bootstrap", "estimand": "fixed-cases",
            "samplingProtocol": "researcher-paired-sha256-random-v1-seed918273-two-fixed-cases-eight-pairs-shared-uniforms-no-adaptation",
            "independentStochasticPairs": True, "confidenceLevel": .9, "resamples": 2000, "seed": 42}
        stochastic_analysis, stochastic_config, _, stochastic_binding = analyze_observed(
            f, app, python, command, "stochastic", stochastic_path, stochastic_completed, stochastic_request, stochastic_comparison, protocol)
        stochastic_rows = [{"caseId": row["caseId"], "repetition": row["repetition"], "parent": row["parent"]["reward"],
            "candidate": row["candidate"]["reward"]} for row in stochastic_comparison["results"]]
        assertions["actual_service_stochastic_paired_collection"] = (
            stochastic_completed["status"] == "completed" and len(stochastic_rows) == 16
            and len({row["caseId"] for row in stochastic_rows}) == 2
            and all(sum(row["caseId"] == case_id for row in stochastic_rows) == 8 for case_id in ("routine", "critical"))
            and any(len({round(row["candidate"] - row["parent"], 12) for row in stochastic_rows if row["caseId"] == case_id}) > 1 for case_id in ("routine", "critical")))
        assertions["explicit_fixed_task_intervals_only"] = (
            stochastic_analysis["uncertaintyProtocol"] == protocol and stochastic_analysis["executionAttested"] is False
            and all(row["uncertainty"]["status"] == "estimated" and row["uncertainty"]["interval"]["lower"] < row["uncertainty"]["interval"]["upper"] for row in stochastic_analysis["metrics"])
            and not any(key in stochastic_analysis for key in ("verdict", "promotion", "gate")))
        reference = reference_bootstrap(stochastic_rows, protocol)
        scalar_result = stochastic_analysis["metrics"][0]
        assertions["bootstrap_matches_independent_actual_row_calculation"] = (
            all(close(value, scalar_result["summary"][key]) for key, value in reference["summary"].items())
            and all(close(value, scalar_result["uncertainty"]["interval"][key]) for key, value in reference["interval"].items()))
        independent_collection = []
        for row in stochastic_rows:
            identity = json.dumps([918273, row["caseId"], row["repetition"]], separators=(",", ":"))
            uniforms = random.Random(int(hashlib.sha256(identity.encode()).hexdigest(), 16))
            values = [uniforms.random() for _ in range(5)]
            independent_collection.append(all(close(row[side], sum(value < threshold for value in values) / 5) for side, threshold in (("parent", .35), ("candidate", .7))))
        assertions["service_rows_match_declared_paired_collection_algorithm"] = all(independent_collection)
        assertions["installed_wheel_not_checkout_import"] = f.run([python, "-c", "import acclimate,json;print(json.dumps({'module':acclimate.__file__}))"], app)["module"].startswith(str(f.root))
        source_commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True, check=True).stdout.strip()
        result = {"schemaVersion": 1, "persona": "evaluation-researcher", "sourceCommit": source_commit, "sourceIncludesUncommittedGapClosure": True, "serviceBinarySha256": f.service_sha256,
                  "releaseSourceInventorySha256": f.manifest["source"]["sha256"], "binarySourceBuildAttested": False, "modelCalls": 0, "criteria": CRITERIA, "assertions": assertions,
                  "status": "accepted-bounded-followup" if all(assertions.values()) else "failed", "descriptor": descriptor,
                  "criterionResults": {"installed_bound_execution": "accepted-this-run", "equal_case_weight": "accepted-installed-policy-and-analysis-browser-separate", "metric_direction": "accepted", "completion_is_not_quality": "accepted", "missingness": "accepted", "unknown_cost": "accepted", "reproducibility": "accepted-declared-input-content-identities", "selected_evidence": "partial-isolated-directory-same-machine", "components": "accepted-app-asserted-exact-binding", "conditional_uncertainty": "accepted-fixed-task-synthetic-stochastic-protocol", "original_mid_run_recovery": "not-exercised", "console_equal_case_aggregation": "coordinator-browser-evidence-separate"},
                  "installation": f.installation_proofs["app"],
                  "generatedManifest": manifest_proof,
                  "analysis": {"deterministic": deterministic, "missingComponent": missing_analysis, "staleRejections": rejections, "stochastic": stochastic_analysis, "observedStochasticRewards": stochastic_rows, "trustedStochasticBinding": stochastic_binding, "independentBootstrap": reference},
                  "analysisArtifactSha256": {label: {name: hashlib.sha256((app / (label + "-" + name + ".json")).read_bytes()).hexdigest()
                      for name in ("comparison", "descriptor", "trusted", "analysis-config")} for label in ("complete", "stochastic")},
                  "ids": {"complete": completed, "incomplete": incomplete, "stochastic": stochastic_completed, "versions": {key: comparison[key] for key in ("parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest")}},
                  "observedRewards": observed, "independentCaseMeans": case_means, "independentEqualCaseMeans": independent, "pooledRowMeans": pooled,
                  "policies": {"higher": higher, "lowerAlternateInterpretation": lower, "unknownCost": unknown_cost, "ungraded": missing_verdict},
                  "reproduction": {"privateManifestSha256": manifest_proof["privateManifestSha256"], "graderCodeSha256": "sha256:" + hashlib.sha256(GRADER.encode()).hexdigest(), "appCodeSha256": "sha256:" + hashlib.sha256(APP.encode()).hexdigest(), "changedDescriptors": changed},
                  "export": {"offline": offline, "online": online, "manifestSha256": hashlib.sha256(review_manifest_path.read_bytes()).hexdigest(), "rolesExported": 4, "rolesNotShared": 12, "reviewerHasPrivateJournal": False},
                  "exitCodes": {"describe": 0, "request": 0, "runCompletedLoser": 0, "higherQualityFail": 2, "lowerAlternatePass": 0, "costUnknown": 3, "beforeExecution": 3, "runUngraded": 2, "checkUngraded": 3, "export": 0, "verifyOnline": 0},
                  "remainingNeeds": ["Console rendering is exercised separately by the coordinator's actual browser fixture.", "Manifest identities bind explicitly declared inputs/source/artifact digests; callback authenticity and hidden dependencies remain application responsibilities.", "Named components are app assertions projected from retained independent grader explanations, not authenticated component measurements or genuine safety evidence.", "Controlled model-free pseudorandom tasks establish conditional algorithm and service-wiring behavior only, not bootstrap coverage calibration, general model quality, causal effects, population inference or a release decision.", "The deterministic correctness loser remains rejected; changing metric direction demonstrates arithmetic only.", "Portable export checks consistency and authoritative scalar binding, not executor truth or actual second-machine distribution/access management.", "Lost lifecycle response and arbitrary mid-process termination/resume were not exercised in this researcher retest; coordinator/operator evidence must qualify recovery separately."]}
        f.write_json(f.root / "private/result.json", result)
    result["cleanup"] = json.loads((f.root / "private/cleanup.json").read_text())
    result["cleanup"].pop("servicePid", None)
    result["releaseManifestSha256"] = f.release_manifest_sha256
    result["releaseChecksumsSha256"] = f.release_checksums_sha256
    f.verify_release_unchanged()
    result_path = output / "evaluation-researcher.json"
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    assert all(assertions.values()), assertions
    return result_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("/private/tmp/acclimate-research-gap-retest-20261117"))
    args = parser.parse_args()
    print(json.dumps({"report": str(run(args.output))}))
