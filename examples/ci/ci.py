"""Run an installed Acclimate evaluator against a bundle payload at a Git commit."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from uuid import uuid4


UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def arguments(argv):
    parser = Arguments(description=__doc__, allow_abbrev=False)
    parser.add_argument("--language", choices=("javascript", "python"))
    parser.add_argument("--repo", default=".")
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--intent")
    operation.add_argument("--retry-after", metavar="HANDOFF",
                           help="Start or resume the one successor of a settled CI-managed request")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--bundle-dir")
    source.add_argument("--payload")
    memory = parser.add_mutually_exclusive_group()
    memory.add_argument("--memory", action="append", default=[], metavar="memory/PATH")
    memory.add_argument("--no-memory", action="store_true")
    for name in ("app", "config", "bundle", "channel", "commit", "policy", "output-dir"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--selection")
    parser.add_argument("--live", action="store_true", help="Authorize live evaluator execution")
    args = parser.parse_args(argv)
    if not Path(args.output_dir).is_absolute() or (args.intent and not Path(args.intent).is_absolute()):
        raise ValueError("--output-dir and --intent must be absolute")
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", args.commit):
        raise ValueError("--commit must be the full lowercase Git commit ID supplied by CI")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.channel):
        raise ValueError("--channel must be a guided channel name")
    source_path = args.payload if args.payload is not None else args.bundle_dir
    path = PurePosixPath(source_path)
    if not source_path or path.is_absolute() or ".." in path.parts or (args.payload and not path.parts):
        raise ValueError("Provide a committed path relative to the repository root")
    if args.payload is None:
        args.bundle_dir = path.as_posix()
    else:
        args.payload = path.as_posix()
    if args.payload and (args.memory or args.no_memory):
        raise ValueError("An explicit --payload already defines its memory inventory")
    return args


def committed_payload(args):
    def git(*argv):
        result = subprocess.run(["git", "-C", args.repo, *argv], capture_output=True)
        if result.returncode:
            raise ValueError("Could not read the commit or committed payload in --repo")
        return result.stdout

    if git("rev-parse", "--verify", "HEAD").decode().strip() != args.commit:
        raise ValueError("--repo HEAD differs from the commit requested by CI")
    if args.payload is not None:
        obj = args.commit + ":" + args.payload
        if git("cat-file", "-t", obj).strip() != b"blob" or int(git("cat-file", "-s", obj)) > 2 * 1024 * 1024:
            raise ValueError("--payload must identify a committed bundle JSON blob of at most 2 MiB")
        return git("cat-file", "blob", obj)

    tree = args.commit + (":" + args.bundle_dir if args.bundle_dir != "." else "^{tree}")
    if git("cat-file", "-t", tree).strip() != b"tree":
        raise ValueError("--bundle-dir must identify a committed directory")
    files = []
    memory = set(args.memory)
    found_memory = set()
    total_size = 0
    for entry in git("ls-tree", "--full-tree", "-rlz", tree).split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        mode, kind, oid, raw_size = metadata.split()
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError("Bundle sources must be regular files, without symlinks or submodules")
        try:
            name = raw_name.decode("ascii")
        except UnicodeDecodeError:
            raise ValueError("Bundle file paths must be ASCII") from None
        folder = name.split("/", 1)[0] if "/" in name else ""
        file_kind = {"skills": "skill", "memory": "memory"}.get(folder, "instruction")
        if file_kind == "memory":
            found_memory.add(name)
            if name not in memory:
                continue
        size = int(raw_size)
        total_size += size
        if size > 256 * 1024 or total_size > 1024 * 1024 or len(files) >= 128:
            raise ValueError("Committed source exceeds bundle file, text, or total size limits")
        try:
            content = git("cat-file", "blob", oid.decode("ascii")).decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("Bundle files must contain UTF-8 text") from None
        if "\0" in content:
            raise ValueError("Bundle sources must contain text")
        files.append({"path": name, "kind": file_kind, "text": content})
    if found_memory and not (memory or args.no_memory):
        raise ValueError("Choose each approved --memory memory/PATH or pass --no-memory")
    if memory - found_memory:
        raise ValueError("A selected --memory path is missing from the committed memory/ directory")
    if not files:
        raise ValueError("Bundle source has no selected files")
    # The installed request command applies the shared payload and path validation.
    return json.dumps({"schemaVersion": 1, "files": files}, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")


def evaluator_command(args):
    app = Path(args.app).resolve()
    language = args.language
    if app.is_dir():
        languages = set()
        if (app / "application.py").is_file():
            languages.add("python")
        if any((app / name).is_file() for name in ("application.mjs", "application.mts")):
            languages.add("javascript")
        if language is None:
            if len(languages) > 1:
                raise ValueError("Both Node and Python application modules exist; select --language")
            if not languages:
                raise ValueError("--app needs application.mjs, application.mts, or application.py")
            language = languages.pop()
        elif language not in languages:
            raise ValueError("The --app directory has no application module for the selected language")
        if language == "python":
            interpreter = sys.executable
            local_python = app / ".venv" / "bin" / "python"
            if not os.environ.get("ACCLIMATE_CI_PYTHON") and local_python.is_file():
                interpreter = str(local_python)
            return [interpreter, "-m", "acclimate"], app
        for parent in (app, *app.parents):
            binary = parent / "node_modules" / ".bin" / "acclimate-eval"
            if binary.is_file() and os.access(binary, os.X_OK):
                return [str(binary)], app
        raise ValueError("Install @acclimate/sdk in the evaluator application or its workspace")

    if not app.is_file():
        raise ValueError("--app must identify an installed evaluator directory or CLI file")
    if language is None:
        language = {".py": "python", ".js": "javascript", ".mjs": "javascript",
                    ".cjs": "javascript"}.get(app.suffix.lower())
        if language is None:
            raise ValueError("Use --language for an evaluator entrypoint without a recognized extension")
    return ["node" if language == "javascript" else sys.executable, str(app)], None


def policy_summary(verdict):
    def project(value, keys):
        return {key: value.get(key) for key in keys} if isinstance(value, dict) else {}

    counts = project(verdict.get("counts"), ("distinctCases", "expectedPairs", "comparablePairs"))
    if isinstance(counts.get("expectedPairs"), int) and isinstance(counts.get("comparablePairs"), int):
        counts["incompletePairs"] = counts["expectedPairs"] - counts["comparablePairs"]
    checks = [item for item in verdict.get("checks", [])
              if isinstance(item, dict) and isinstance(item.get("code"), str)]
    result = {
        "code": verdict.get("code"),
        "policy": project(verdict.get("policy"), ("id", "revision", "sha256")),
        "counts": counts,
        "scores": project(verdict.get("summary"), ("parentMean", "candidateMean", "orientedMeanImprovement")),
        "failedCriteria": [item["code"] for item in checks if item.get("result") == "fail"],
        "unknownCriteria": [item["code"] for item in checks if item.get("result") == "unknown"],
    }
    if isinstance(verdict.get("policyReceipt"), dict):
        result["policyReceipt"] = project(verdict["policyReceipt"], ("status", "code"))
    gaps = verdict.get("evidenceGaps")
    if isinstance(gaps, dict):
        result["evidenceGaps"] = {"total": gaps.get("total"), "rows": [
            project(row, ("caseId", "repetition", "side", "stage", "reason"))
            for row in gaps.get("rows", [])[:32]
        ]}
    return result


def prior_handoff(value, output, request_dir):
    handoff = output / value
    if not handoff.is_file() or handoff.resolve() != handoff:
        raise ValueError("--retry-after needs the original CI-managed handoff from this output directory")
    if handoff.name != "evaluation-request.json" or not (
        handoff.parent == request_dir
        or (handoff.parent.parent == request_dir and re.fullmatch("after-" + UUID, handoff.parent.name))
    ):
        raise ValueError("--retry-after must belong to this commit, payload, bundle and channel")
    return handoff


def pipeline(args, summary):
    output = Path(args.output_dir)
    output.mkdir(parents=True, mode=0o700, exist_ok=True)
    output = output.resolve()
    cli, app_directory = evaluator_command(args)
    # Explicit files belong to the caller; the installed CLI discovers its adapter in app_directory.
    args.config = os.path.abspath(args.config)
    args.policy = os.path.abspath(args.policy)
    if args.selection:
        args.selection = os.path.abspath(args.selection)
    phases = summary["phaseExitCodes"]

    request_error = None

    def step(name, *flags):
        nonlocal request_error
        try:
            result = subprocess.run([*cli, name, *flags], cwd=app_directory, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE if name == "request" else None)
        except OSError:
            phases[name] = 1
            print("Could not start evaluator for " + name, file=sys.stderr)
            return {}
        phases[name] = result.returncode if result.returncode >= 0 else 128 - result.returncode
        if result.stderr:
            sys.stderr.buffer.write(result.stderr)
            sys.stderr.buffer.flush()
            for line in reversed(result.stderr.splitlines()):
                try:
                    diagnostic = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(diagnostic, dict) and isinstance(diagnostic.get("error"), dict):
                    request_error = diagnostic["error"].get("code")
                    break
        if result.stdout:
            sys.stderr.buffer.write(result.stdout)
            sys.stderr.buffer.flush()
            try:
                value = json.loads(result.stdout)
                if isinstance(value, dict):
                    return value
            except (ValueError, UnicodeError):
                pass
        if not phases[name]:
            phases[name] = 1
            print("Evaluator returned no JSON object for " + name, file=sys.stderr)
        return {}

    revision = committed_payload(args)
    summary["commit"] = args.commit
    if args.intent:
        intent = Path(args.intent)
        handoff = output / "evaluation-request.json"
    else:
        # A second source or target in the same checkout has its own retained request.
        digest = hashlib.sha256()
        for field in (args.bundle.encode(), args.channel.encode(), revision):
            digest.update(len(field).to_bytes(8, "big"))
            digest.update(field)
        request_dir = output / "requests" / (args.commit + "-" + digest.hexdigest())
        if args.retry_after:
            prior = prior_handoff(args.retry_after, output, request_dir)
            record = step("status", "--config", args.config, "--handoff", str(prior))
            summary["priorHandoff"] = prior.relative_to(output).as_posix()
            if phases["status"]:
                return "prior_status_unavailable", phases["status"]
            prior_id = record.get("requestId")
            summary["previousRequestId"] = prior_id
            summary["previousExecutionStatus"] = record.get("status")
            if (record.get("status") not in ("completed", "failed")
                    or not all(re.fullmatch(UUID, str(record.get(field))) for field in
                               ("requestId", "attemptId", "comparisonId"))):
                summary["nextAction"] = "Inspect the prior worker and request. A fresh attempt requires a completed or failed run with a bound comparison."
                return "prior_execution_unresolved", 3
            request_dir = request_dir / ("after-" + prior_id)
        intent = request_dir / "request-intent.json"
        handoff = request_dir / "evaluation-request.json"
    target = ["--config", args.config, "--bundle", args.bundle]
    work = ["--config", args.config, "--handoff", str(handoff)]
    step("doctor", *target, "--policy", args.policy)
    if phases["doctor"]:
        return "preflight_failed", phases["doctor"]
    with tempfile.TemporaryDirectory(dir=output) as directory:
        payload = Path(directory) / "candidate.json"
        payload.write_bytes(revision)
        request = step("request", *target, "--channel", args.channel, "--payload", str(payload),
                       "--policy", args.policy, "--intent", str(intent), "--out", str(handoff))
    if phases["request"]:
        if request_error == "request.intent_mismatch":
            summary["diagnosticCode"] = request_error
            summary["nextAction"] = "Restore the original evaluator, candidate, target and worker identity to resume this intent."
            if handoff.is_file():
                summary["priorHandoff"] = handoff.relative_to(output).as_posix()
                prior = step("status", "--config", args.config, "--handoff", str(handoff))
                if phases["status"] == 0:
                    summary["previousRequestId"] = prior.get("requestId")
                    summary["previousExecutionStatus"] = prior.get("status")
                    saved = json.loads(handoff.read_bytes())
                    described = step("describe")
                    if phases["describe"] == 0 and described != saved.get("configuration"):
                        summary["mismatch"] = "evaluator_definition_changed"
                    if not args.intent and prior.get("status") in ("completed", "failed") and prior.get("comparisonId"):
                        summary["nextAction"] = "To evaluate the revised app, rerun this command with --retry-after and the priorHandoff value."
        return "request_failed", phases["request"]
    if not all(re.fullmatch(pattern, str(request.get(field))) for field, pattern in (
        ("requestId", UUID), ("candidateVersionId", UUID), ("candidateDigest", r"sha256:[0-9a-f]{64}"),
    )):
        print("Request did not identify its immutable candidate", file=sys.stderr)
        phases["request"] = 1
        return "request_failed", 1
    for field in ("requestId", "candidateVersionId", "candidateDigest"):
        summary[field] = request[field]
    summary["parentVersionId"] = request.get("parentVersionId")
    summary["handoff"] = handoff.relative_to(output).as_posix()

    run = step("run", *work, *(["--live"] if args.live else []))
    summary["executionStatus"] = run.get("status")
    summary["comparisonId"] = run.get("comparisonId")
    if phases["run"] in (0, 2):
        verdict = step("check", *work, "--policy", args.policy)
        if verdict.get("verdict") in ("pass", "fail", "indeterminate"):
            summary["qualityVerdict"] = verdict["verdict"]
            summary["quality"] = policy_summary(verdict)
            if verdict.get("comparisonId"):
                summary["comparisonId"] = verdict["comparisonId"]
        if phases["check"] == 0 and summary["qualityVerdict"] != "pass":
            phases["check"] = 1
    review = output / ("review-" + str(uuid4()))
    selection = ["--selection", args.selection] if args.selection else []
    step("export", *work, *selection, "--out", str(review))
    if not phases["export"]:
        step("verify-export", "--manifest", str(review / "manifest.json"))
        if not phases["verify-export"]:
            summary["reviewDirectory"] = review.name

    if phases["run"]:
        return ("execution_unresolved" if phases["run"] == 3 else "execution_failed"), phases["run"]
    if phases["check"]:
        outcome = {"fail": "quality_failed", "indeterminate": "quality_indeterminate"}
        return outcome.get(summary["qualityVerdict"], "check_failed"), phases["check"]
    if phases["export"] or phases["verify-export"]:
        return "export_failed", phases["export"] or phases["verify-export"]
    return "pass", 0


def main(argv):
    os.umask(0o077)
    summary = {
        "schemaVersion": 1, "commit": None, "channel": None,
        "requestId": None, "parentVersionId": None, "candidateVersionId": None, "candidateDigest": None,
        "executionStatus": None, "comparisonId": None, "qualityVerdict": None, "quality": None,
        "reviewDirectory": None, "handoff": None,
        "phaseExitCodes": dict.fromkeys(("doctor", "request", "run", "check", "export", "verify-export")),
    }
    try:
        args = arguments(argv)
        summary["channel"] = args.channel
        result, status = pipeline(args, summary)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        result, status = "configuration_error", 1
    except OSError:
        print("Could not access the CI workspace or launch a required command", file=sys.stderr)
        result, status = "configuration_error", 1
    summary["result"] = result
    print(json.dumps(summary, separators=(",", ":")))
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
