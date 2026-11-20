"""Evaluate the agent bundle at a Git commit with an installed Acclimate evaluator.

The wrapper verifies the checkout, reads the committed bundle files and runs the
installed evaluator's doctor, request, run, check, export and verify-export
commands. The candidate is compared against the channel's current release. The
wrapper always prints one summary, including after a configuration error or a
cancellation.
"""

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4

if sys.version_info < (3, 8):
    sys.stderr.write("The Acclimate CI wrapper needs Python 3.8 or later. Set ACCLIMATE_CI_PYTHON.\n")
    sys.exit(1)


UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
PHASES = ("doctor", "request", "run", "check", "export", "verify-export")
HANDOFF = "handoff.json"
PYTHON_EVALUATOR_MINIMUM = (3, 11)
# Wait this long for a graceful stop after the first signal, and this long after a second one.
DEFAULT_CANCEL_GRACE = 20.0
ESCALATED_GRACE = 1.5
# Run controls passed through to the evaluator's run command, in this order. They match the
# evaluator's own flag names. Concurrency is not a run flag: it is declared in the evaluator
# definition (concurrency, gradeRetries) and fingerprinted in its descriptor.
RUN_PASSTHROUGH = (
    ("deadline", "--deadline"),
    ("case_timeout", "--case-timeout"),
    ("max_cost_usd", "--max-cost-usd"),
    ("shard", "--shard"),
    ("cases", "--cases"),
)
# The evaluator CLI's exit codes. The wrapper exits with the failing phase's code.
EXIT_OK, EXIT_USAGE, EXIT_GATE_FAILED, EXIT_INDETERMINATE, EXIT_FAILED, EXIT_RECOVERY = 0, 1, 2, 3, 4, 5
# The evaluator reads its token from this variable when the config names neither
# evaluatorToken nor evaluatorTokenFile.
TOKEN_ENV = "ACCLIMATE_EVALUATOR_TOKEN"

NEXT_ACTIONS = {
    "quality_failed": "Review the failed criteria and cases. Change the agent, or release the candidate later with a reviewed policy override.",
    "quality_indeterminate": "A criterion could not be measured. Inspect quality.evidenceGaps and the unknown criteria, repair the evaluator, then rerun with --rerun-after and the handoff.",
    "execution_failed": "Cases failed to run or grade. Inspect the evaluator output, repair the evaluator, then rerun with --rerun-after and the handoff.",
    "execution_unresolved": "Execution may still be running elsewhere. Wait for the service to mark the attempt abandoned and rerun, or rerun with --abandon-uncertain to abandon it now.",
    "execution_partial": "The run stopped early at its --deadline or --max-cost-usd, or covered only --cases or --shard, so the evidence is partial. Rerun with a larger budget or the full inventory.",
    "check_failed": "The policy check did not complete. Fix the diagnostic and rerun the same command; the saved result is reused.",
    "export_failed": "The review export failed. Fix the diagnostic and rerun the same command; the saved result is reused.",
    "preflight_failed": "Fix the failed preflight checks, then rerun the same command.",
    "request_failed": "Fix the request diagnostic, then rerun the same command.",
    "configuration_error": "Fix the wrapper arguments or CI workspace, then rerun.",
    "prior_status_unavailable": "The previous request could not be read. Check the evaluator credential and service, then rerun.",
    "prior_execution_unresolved": "Wait for the previous attempt to finish or for the service to mark it abandoned, then rerun. Pass --abandon-uncertain to abandon it now.",
    "cancelled": "Rerun the same command. A cancelled run is not a verdict: the wrapper resumes it or starts a fresh request for this commit.",
    "wrapper_error": "Report this wrapper failure to the evaluation owner with the stderr log.",
}

HINTS = {
    "service.unavailable": "The evaluator could not reach the service. Check serviceUrl, DNS, TLS trust and the network path from this runner.",
    "auth.denied": "The service rejected the evaluator credential. Check the token secret and that the principal can evaluate in this workspace.",
    "auth.principal_mismatch": "A different evaluator principal owns this request. Use the original evaluator config.",
    "config.missing": "The evaluator config file does not exist at the given path.",
    "config.permissions": "Keep the evaluator config at mode 0600 in a directory with mode 0700, owned by the runner user.",
    "config.schema": "The evaluator config or a command flag is invalid. Compare it with the configuration reference.",
    "config.url": "serviceUrl must be an https URL without a path, or http on localhost.",
    "bundle.missing": "The bundle ID does not exist in this workspace. Check --bundle.",
    "journal.busy": "Another evaluator process holds this request's journal. Wait for it to finish, or check that no orphaned evaluator is still running on this host.",
    "journal.missing": "This runner has no journal for a request that already started elsewhere. Use the original runner, wait for the service to mark it abandoned, or pass --abandon-uncertain.",
    "journal.relocated": "The journal moved. Restore journalRoot to its original path.",
    "execution.uncertain": "An earlier attempt may have started executing and did not finish. Wait for the service to mark it abandoned, or pass --abandon-uncertain.",
    "request.channel_empty": "The channel has no release yet. Publish a baseline release to the channel before running PR checks.",
    "request.base_conflict": "The channel release changed while the request was being created. Rerun the command to compare against the new release.",
    "request.intent_mismatch": "The saved request belongs to a different evaluator, candidate or target. Restore them, or rerun with --rerun-after and the priorHandoff.",
    "descriptor.mismatch": "The evaluator definition differs from the one the request was created with.",
    "policy.invalid": "The quality policy file is invalid. Start from quality-policy.example.json in the evaluator starter.",
    "runtime.unsupported": "The evaluator runtime is unsupported on this runner. Use Node.js 22.22+ or Python 3.11+ on Linux or macOS.",
    "evidence.not_terminal": "The previous request has not finished.",
}

# Request states a fresh request may follow. `abandoned` is the service's terminal state for an
# attempt it expired after inactivity or that a caller abandoned explicitly.
SETTLED = ("completed", "failed", "interrupted", "abandoned")
ENDED_WITHOUT_EVIDENCE = ("interrupted", "abandoned")


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


class Cancelled(Exception):
    def __init__(self, phase, value=None):
        super().__init__(phase)
        self.phase = phase
        self.value = value or {}


def arguments(argv):
    parser = Arguments(
        prog="ci.sh", description=__doc__, allow_abbrev=False,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Exit status follows the evaluator CLI: 0 pass, 1 fix the command, config or application, "
               "2 quality gate failed, 3 indeterminate (the policy could not decide, or the run stopped early "
               "with partial evidence), 4 run or service failed, 5 recovery required (earlier work is "
               "unresolved), 130/143 cancelled. Route on the summary's result field.")
    required = parser.add_argument_group("required arguments")
    required.add_argument("--commit", required=True, metavar="SHA",
                          help="Full commit ID the check represents. It must equal HEAD in --repo. On pull_request "
                               "events actions/checkout checks out the test merge commit, github.sha.")
    required.add_argument("--app", required=True, metavar="PATH",
                          help="Trusted evaluator directory with the SDK installed, or an evaluator CLI file")
    required.add_argument("--config", required=True, metavar="FILE",
                          help="Owner-only evaluator config. With --token-env or --token-file it may omit the token.")
    required.add_argument("--bundle", required=True, metavar="ID", help="Bundle ID in the workspace")
    required.add_argument("--channel", required=True, metavar="NAME",
                          help="Channel whose current release is the comparison parent, for example stable")
    required.add_argument("--policy", required=True, metavar="FILE", help="Quality policy that decides the check")
    required.add_argument("--output-dir", required=True, metavar="DIR",
                          help="Absolute private directory for request state and review exports")
    source = required.add_mutually_exclusive_group(required=True)
    source.add_argument("--bundle-dir", metavar="DIR",
                        help="Committed bundle directory relative to the repository root. Give this or --payload.")
    source.add_argument("--payload", metavar="FILE",
                        help="Committed bundle payload JSON relative to the repository root")

    bundle = parser.add_argument_group("bundle source")
    bundle.add_argument("--repo", default=".", metavar="DIR", help="Git checkout to read (default: current directory)")
    memory = bundle.add_mutually_exclusive_group()
    memory.add_argument("--memory", action="append", default=[], metavar="memory/PATH",
                        help="Approved memory file to include. Repeat for each file.")
    memory.add_argument("--no-memory", action="store_true", help="Include no files from memory/")
    bundle.add_argument("--base-commit", metavar="SHA",
                        help="Also list the bundle files changed since this commit, such as the merge base. "
                             "The comparison parent is still the channel release.")

    evaluation = parser.add_argument_group("evaluation")
    evaluation.add_argument("--language", choices=("javascript", "python"),
                            help="Adapter language when --app contains both")
    evaluation.add_argument("--live", action="store_true",
                            help="Authorize model-backed execution. Leave it off for untrusted changes.")
    evaluation.add_argument("--selection", metavar="FILE", help="Artifact selection for the review export")
    evaluation.add_argument("--deadline", metavar="DURATION",
                            help="Passed to the evaluator run command, such as 30m. A stopped run is partial (exit 3).")
    evaluation.add_argument("--case-timeout", metavar="DURATION",
                            help="Passed to the evaluator run command: abort each execute or grade call after this long")
    evaluation.add_argument("--max-cost-usd", metavar="USD",
                            help="Passed to the evaluator run command: stop starting pairs at this reported cost")
    evaluation.add_argument("--shard", metavar="I/N", help="Passed to the evaluator run command. Partial (exit 3).")
    evaluation.add_argument("--cases", metavar="IDS", help="Passed to the evaluator run command. Partial (exit 3).")
    # Concurrency belongs in the evaluator definition; reject it with an explanation.
    evaluation.add_argument("--concurrency", metavar="N", help=argparse.SUPPRESS)

    credentials = parser.add_argument_group("credentials")
    token = credentials.add_mutually_exclusive_group()
    token.add_argument("--token-env", metavar="NAME",
                       help="Read the evaluator token from this environment variable, such as a CI secret")
    token.add_argument("--token-file", metavar="FILE", help="Read the evaluator token from this owner-only file")

    recovery = parser.add_argument_group("reuse and recovery")
    recovery.add_argument("--no-reuse", action="store_true",
                          help="Create a request per commit instead of reusing an unchanged candidate's result")
    operation = recovery.add_mutually_exclusive_group()
    operation.add_argument("--intent", metavar="FILE", help="Absolute request intent path your pipeline manages")
    operation.add_argument("--rerun-after", metavar="HANDOFF",
                           help="Start one fresh request against the current channel release after this settled "
                                "handoff, relative to --output-dir")
    recovery.add_argument("--abandon-uncertain", action="store_true",
                          help="Abandon an earlier attempt that may have started executing (the service's abandon "
                               "route, which needs the evaluate right), then start a fresh request")
    recovery.add_argument("--cancel-grace", type=float, default=DEFAULT_CANCEL_GRACE, metavar="SECONDS",
                          help="On SIGINT or SIGTERM, wait this long for the evaluator to stop (default: 20)")

    reporting = parser.add_argument_group("reporting")
    reporting.add_argument("--format", choices=("json", "github", "markdown"), default="json",
                           help="Stdout format: one JSON object (default), GitHub log lines and annotations, or Markdown")
    reporting.add_argument("--summary-json", metavar="FILE", help="Also write the JSON summary to this file")
    reporting.add_argument("--summary-md", action="append", default=[], metavar="FILE",
                           help="Append a Markdown summary to this file, such as $GITHUB_STEP_SUMMARY. Repeatable.")
    reporting.add_argument("--github-output", metavar="FILE",
                           help="Append result, verdict and IDs to this file, such as $GITHUB_OUTPUT")
    args = parser.parse_args(argv)

    if not Path(args.output_dir).is_absolute() or (args.intent and not Path(args.intent).is_absolute()):
        raise ValueError("--output-dir and --intent must be absolute")
    for name in ("commit", "base_commit"):
        value = getattr(args, name)
        if value is not None and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value):
            raise ValueError("--" + name.replace("_", "-") + " must be a full lowercase Git commit ID")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.channel):
        raise ValueError("--channel must be a guided channel name")
    if not 0 < args.cancel_grace <= 600:
        raise ValueError("--cancel-grace must be between 0 and 600 seconds")
    if args.concurrency is not None:
        raise ValueError("--concurrency is not a run flag. Declare concurrency (1-64) in the evaluator definition "
                         "or application module; it is part of the evaluator's descriptor.")
    if args.max_cost_usd is not None:
        try:
            cost = float(args.max_cost_usd)
        except ValueError:
            cost = -1
        if not 0 < cost < float("inf"):
            raise ValueError("--max-cost-usd must be a positive number of US dollars")
    if args.shard is not None and args.cases is not None:
        raise ValueError("Use --cases or --shard, not both")
    for name, flag in RUN_PASSTHROUGH:
        value = getattr(args, name)
        if value is not None and (not value or value.startswith("-") or len(value) > 4096):
            raise ValueError(flag + " needs a value")
    if args.token_env is not None and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", args.token_env):
        raise ValueError("--token-env must name an environment variable")
    if args.intent and args.abandon_uncertain:
        raise ValueError("--abandon-uncertain applies to CI-managed requests; omit --intent")
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


def git_reader(args):
    def git(*argv):
        result = subprocess.run(["git", "-C", args.repo, *argv], capture_output=True)
        if result.returncode:
            raise ValueError("Could not read the commit or committed payload in --repo")
        return result.stdout
    return git


def committed_payload(args):
    git = git_reader(args)
    head = git("rev-parse", "--verify", "HEAD").decode().strip()
    if head != args.commit:
        raise ValueError(
            "--repo HEAD is " + head + " but --commit is " + args.commit + ". Pass the commit that is checked out. "
            "On pull_request events actions/checkout checks out the test merge commit (github.sha), not "
            "pull_request.head.sha. Pass github.sha, or check out the head commit before passing its SHA.")
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


def changed_files(args):
    """List bundle paths that differ between --base-commit and --commit. Informational only."""
    git = git_reader(args)
    scope = args.payload if args.payload is not None else args.bundle_dir
    try:
        raw = git("diff", "--no-renames", "--name-status", "-z", args.base_commit, args.commit, "--", scope)
    except ValueError:
        print("Could not diff --base-commit; fetch enough history to include it", file=sys.stderr)
        return None
    fields = [item.decode("utf-8", "replace") for item in raw.split(b"\0") if item]
    return [{"status": status, "path": name} for status, name in zip(fields[::2], fields[1::2])][:256]


def interpreter_version(interpreter):
    if os.path.realpath(interpreter) == os.path.realpath(sys.executable):
        return tuple(sys.version_info[:2])
    try:
        result = subprocess.run([interpreter, "-I", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                                capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.fullmatch(rb"(\d+)\.(\d+)\s*", result.stdout)
    return (int(match.group(1)), int(match.group(2))) if match and not result.returncode else None


def require_python(interpreter, app):
    version = interpreter_version(interpreter)
    if version is None or version < PYTHON_EVALUATOR_MINIMUM:
        found = "an unknown version" if version is None else "%d.%d" % version
        raise ValueError(
            "Python evaluators need Python 3.11 or later, but " + interpreter + " is " + found + ". "
            "Create " + str(app) + "/.venv with Python 3.11+ and install the SDK there, "
            "or set ACCLIMATE_CI_PYTHON to a Python 3.11+ interpreter that has the SDK.")


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
            require_python(interpreter, app)
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
    if language == "python":
        require_python(sys.executable, app.parent)
    return ["node" if language == "javascript" else sys.executable, str(app)], None


def read_json(path, limit=16 * 1024 * 1024):
    """Read a JSON object from wrapper-managed state, or None when absent or unreadable."""
    try:
        with open(path, "rb") as handle:
            data = handle.read(limit + 1)
        value = json.loads(data) if len(data) <= limit else None
    except (OSError, ValueError, UnicodeError):
        return None
    return value if isinstance(value, dict) else None


def write_json(path, value):
    temporary = path.with_name("." + path.name + "." + uuid4().hex + ".tmp")
    with open(temporary, "x") as handle:
        handle.write(json.dumps(value, separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def handoff_request_id(path):
    value = read_json(path, 1024 * 1024)
    request_id = value.get("requestId") if value else None
    return request_id if isinstance(request_id, str) and re.fullmatch(UUID, request_id) else None


def read_private_file(path, limit, what):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise ValueError(what + " is missing or is a symlink") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(what + " must be a regular file you own with mode 0600")
        data = b""
        while len(data) <= limit:
            chunk = os.read(descriptor, limit + 1 - len(data))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(descriptor)
    if len(data) > limit:
        raise ValueError(what + " is too large")
    return data


def valid_token(value, source):
    token = value.strip()
    if not token or len(token) > 4096 or re.search(r"[\s\x00-\x1f\x7f]", token):
        raise ValueError(source + " must hold one evaluator token")
    return token


def credentials(args, private):
    """Return (config path for the evaluator, parsed config or {}, token or None, child environment).

    A token from --token-env or --token-file never lands in a config file. The wrapper writes a
    token-free copy of the config and hands the token to each evaluator process in
    ACCLIMATE_EVALUATOR_TOKEN, which the evaluator reads when the config names no token.
    """
    environment = {key: value for key, value in os.environ.items() if key != TOKEN_ENV}
    config = read_json(args.config, 1024 * 1024) or {}
    token = None
    if args.token_env:
        token = valid_token(os.environ.get(args.token_env, ""), "Environment variable " + args.token_env)
    elif args.token_file:
        token = valid_token(read_private_file(args.token_file, 8192, "--token-file").decode("utf-8", "replace"),
                            "--token-file")
    if token is None:
        token = config.get("evaluatorToken") if isinstance(config.get("evaluatorToken"), str) else None
        token_file = config.get("evaluatorTokenFile")
        if token is None and isinstance(token_file, str):
            try:
                token = valid_token(read_private_file(token_file, 8192, "evaluatorTokenFile").decode(
                    "utf-8", "replace"), "evaluatorTokenFile")
            except ValueError:
                token = None
        if token is None and isinstance(os.environ.get(TOKEN_ENV), str):
            # The config names no token: the evaluator reads the inherited variable itself.
            environment[TOKEN_ENV] = os.environ[TOKEN_ENV]
            token = valid_token(os.environ[TOKEN_ENV], TOKEN_ENV)
        return args.config, config, token, environment
    if not config:
        raise ValueError("--config must be a readable JSON evaluator config when the token comes from "
                         "--token-env or --token-file")
    # The evaluator reads an owner-only config. Keep the derived, token-free copy in a private
    # directory for this run; the token travels only in the child processes' environment.
    derived = dict(config)
    derived.pop("evaluatorTokenFile", None)
    derived.pop("evaluatorToken", None)
    filename = Path(private) / "evaluator-config.json"
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(json.dumps(derived) + "\n")
    environment[TOKEN_ENV] = token
    return str(filename), config, token, environment


def abandon_request(config, token, handoff, reason):
    """Abandon a request through the service's abandon route. Returns the new status, or None.

    Abandonment is terminal and fences the attempt's later reports. It never claims the original
    worker stopped. It needs the `evaluate` right, which evaluator tokens hold.
    """
    base, workspace = config.get("serviceUrl"), config.get("workspaceId")
    bundle, request_id = (handoff or {}).get("bundleId"), (handoff or {}).get("requestId")
    if not (token and isinstance(base, str) and isinstance(workspace, str) and workspace
            and isinstance(bundle, str) and bundle
            and isinstance(request_id, str) and re.fullmatch(UUID, request_id)):
        return None
    url = urllib.parse.urlsplit(base)
    loopback = url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
    if (url.scheme != "https" and not loopback) or url.username or url.password or url.query or url.fragment:
        return None
    route = ("/v1/workspaces/" + urllib.parse.quote(workspace, safe="") + "/bundles/"
             + urllib.parse.quote(bundle, safe="") + "/evaluation-requests/" + request_id + "/abandon")
    request = urllib.request.Request(
        base.rstrip("/") + route, method="POST", data=json.dumps({"reason": reason}).encode(),
        headers={"Authorization": "Bearer " + token, "Accept": "application/json",
                 "Content-Type": "application/json",
                 # One key per request: a retried abandonment replays the same operation.
                 "Idempotency-Key": "ci-abandon-" + request_id})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            value = json.loads(response.read(1024 * 1024 + 1))
    except (OSError, ValueError):
        return None
    status = value.get("status") if isinstance(value, dict) else None
    return status if status in ("abandoned", "completed", "failed", "interrupted") else None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def channel_release(config, token, bundle, channel):
    """Read the channel's current release. Returns a dict, {"empty": True}, or None when unknown."""
    base, workspace = config.get("serviceUrl"), config.get("workspaceId")
    if not (token and isinstance(base, str) and isinstance(workspace, str) and workspace):
        return None
    url = urllib.parse.urlsplit(base)
    loopback = url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
    if (url.scheme != "https" and not loopback) or url.username or url.password or url.query or url.fragment:
        return None
    quote = lambda value: urllib.parse.quote(value, safe="")
    route = "/v1/workspaces/" + quote(workspace) + "/bundles/" + quote(bundle) + "/channels/" + quote(channel) + "/releases?limit=1"
    request = urllib.request.Request(base.rstrip("/") + route,
                                     headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            body = response.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            try:
                code = json.loads(error.read(65536)).get("error", {}).get("code")
            except (ValueError, AttributeError, OSError):
                code = None
            if code == "not_found":
                return {"empty": True}
        return None
    except (OSError, ValueError):
        return None
    try:
        value = json.loads(body)["items"][0]
        version = value["version"]
        release = {"versionId": version["id"], "digest": version["digest"], "revision": value["revision"]}
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    if not (isinstance(release["versionId"], str) and re.fullmatch(UUID, release["versionId"])
            and isinstance(release["digest"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", release["digest"])
            and isinstance(release["revision"], str)):
        return None
    return release


def journal_state(config, handoff):
    """Inspect the local evaluator journal for a request without modifying it."""
    try:
        import fcntl
    except ImportError:
        return "unknown"
    fields = ("serviceUrl", "workspaceId", "evaluatorPrincipalId", "journalRoot")
    if not handoff or not all(isinstance(config.get(field), str) for field in fields):
        return "unknown"
    # The journal directory name is the storage key the SDKs compute from the canonical scope.
    scope = json.dumps({"serviceUrl": config["serviceUrl"], "workspaceId": config["workspaceId"],
                        "bundleId": handoff.get("bundleId"), "requestId": handoff.get("requestId"),
                        "evaluatorPrincipalId": config["evaluatorPrincipalId"]},
                       ensure_ascii=False, separators=(",", ":"))
    directory = Path(config["journalRoot"]) / hashlib.sha256(scope.encode("utf-8")).hexdigest()
    if not directory.is_dir():
        return "absent"
    try:
        descriptor = os.open(directory / "ownership.lock", os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        descriptor = None
    except OSError:
        return "unknown"
    try:
        if descriptor is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return "busy"
            except OSError:
                return "unknown"
        for name in ("attempt.json", "attempt.python.json"):
            if (directory / name).exists():
                attempt = read_json(directory / name, 64 * 1024 * 1024)
                if attempt is None:
                    return "unknown"
                if attempt.get("report") is not None:
                    return "report_saved"
                return "may_have_started" if attempt.get("executionStarted") else "not_started"
        return "not_started"
    finally:
        if descriptor is not None:
            os.close(descriptor)


class Cancellation:
    """Forward SIGINT/SIGTERM to the evaluator's process group and bound the wait."""

    def __init__(self):
        self.signal = None
        self.phase = None
        self.deadline = None
        self.forced = False
        self.grace = DEFAULT_CANCEL_GRACE
        self.child = None

    def install(self):
        for name in ("SIGINT", "SIGTERM", "SIGHUP"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), self.handle)

    def handle(self, signum, _frame):
        now = time.monotonic()
        if self.signal is None:
            self.signal = signum
            self.deadline = now + self.grace
            self.forward(signum)
        else:
            # A second signal means the caller is about to kill us. Stop the evaluator quickly.
            self.deadline = min(self.deadline, now + ESCALATED_GRACE)
            self.forward(signal.SIGTERM)

    def forward(self, signum):
        child = self.child
        if child is not None:
            try:
                os.killpg(child.pid, signum)
            except (ProcessLookupError, PermissionError):
                pass

    def kill(self, child):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def exit_status(self):
        return 128 + int(self.signal)

    def describe(self):
        return {"signal": signal.Signals(self.signal).name, "phase": self.phase, "forced": self.forced}


class Runner:
    """Run installed evaluator commands in their own process group and keep their diagnostics."""

    def __init__(self, cli, cwd, summary, cancellation, github, environment=None):
        self.cli, self.cwd, self.summary, self.cancellation, self.github = cli, cwd, summary, cancellation, github
        self.environment = environment
        self.codes = {}
        self.diagnostics = {}

    def step(self, name, *flags):
        if self.cancellation.signal is not None:
            raise Cancelled(self.cancellation.phase or name)
        token = uuid4().hex
        if self.github:
            sys.stderr.write("::group::Acclimate " + name + "\n::stop-commands::" + token + "\n")
            sys.stderr.flush()
        try:
            child = subprocess.Popen([*self.cli, name, *flags], cwd=self.cwd, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                     env=self.environment)
        except OSError:
            self.record(name, 1)
            self.end_group(token)
            print("Could not start evaluator for " + name, file=sys.stderr)
            return {}
        self.cancellation.child = child
        self.cancellation.phase = name
        output = bytearray()
        recent = deque(maxlen=200)

        def read_stdout():
            for chunk in iter(lambda: child.stdout.read(65536), b""):
                if len(output) <= 8 * 1024 * 1024:
                    output.extend(chunk)

        def tee_stderr():
            for line in iter(child.stderr.readline, b""):
                sys.stderr.buffer.write(line)
                sys.stderr.buffer.flush()
                recent.append(line[:65536])

        readers = [threading.Thread(target=read_stdout, daemon=True), threading.Thread(target=tee_stderr, daemon=True)]
        for reader in readers:
            reader.start()
        while True:
            try:
                returncode = child.wait(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                deadline = self.cancellation.deadline
                if deadline is not None and time.monotonic() >= deadline and not self.cancellation.forced:
                    self.cancellation.forced = True
                    self.cancellation.kill(child)
        self.cancellation.child = None
        if self.cancellation.signal is not None:
            # Stop anything the evaluator left behind in its process group.
            self.cancellation.kill(child)
        for reader in readers:
            reader.join(timeout=5)
        self.record(name, returncode if returncode >= 0 else 128 - returncode)
        value = {}
        if output:
            # The command result stays inside the fenced group with the rest of the evaluator's output.
            sys.stderr.buffer.write(bytes(output))
            if not output.endswith(b"\n"):
                sys.stderr.buffer.write(b"\n")
            sys.stderr.buffer.flush()
            try:
                parsed = json.loads(bytes(output))
                value = parsed if isinstance(parsed, dict) else {}
            except (ValueError, UnicodeError):
                pass
        self.end_group(token)
        self.diagnose(name, value, recent)
        if self.cancellation.signal is not None:
            raise Cancelled(name, value)
        if not value and not self.codes[name]:
            self.record(name, 1)
            print("Evaluator returned no JSON object for " + name, file=sys.stderr)
        return value

    def end_group(self, token):
        if self.github:
            sys.stderr.write("::" + token + "::\n::endgroup::\n")
            sys.stderr.flush()

    def record(self, name, code):
        self.codes[name] = code
        if name in PHASES:
            self.summary["phaseExitCodes"][name] = code

    def code(self, name):
        return self.codes.get(name)

    def diagnose(self, name, value, recent):
        diagnostic = None
        for line in reversed(recent):
            try:
                parsed = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                error = parsed["error"]
                diagnostic = {key: error[key] for key in ("code", "phase", "nextAction", "hint", "executionState",
                                                          "field", "missingFields") if key in error}
                break
        checks = value.get("checks") if value.get("status") == "blocked" else None
        if isinstance(checks, list):
            failed = [{key: check[key] for key in ("check", "status", "code", "hint", "field") if key in check}
                      for check in checks if isinstance(check, dict) and check.get("status") in ("failed", "unverified")]
            if failed:
                diagnostic = dict(diagnostic or {})
                diagnostic.setdefault("code", failed[0].get("code"))
                diagnostic.setdefault("hint", next((item["hint"] for item in failed if item.get("hint")), None))
                diagnostic["failedChecks"] = failed
                if isinstance(value.get("nextAction"), str):
                    diagnostic.setdefault("nextAction", value["nextAction"])
        if diagnostic is None and self.codes.get(name):
            # Without a structured diagnostic, keep the evaluator's last words for the summary.
            last = next((line.strip() for line in reversed(recent) if line.strip()), b"")
            if last:
                diagnostic = {"output": text(last.decode("utf-8", "replace"), 300)}
        if diagnostic:
            self.diagnostics[name] = {key: item for key, item in diagnostic.items() if item is not None}


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
    # Criteria may name the cases they measured; keep them for annotations.
    failed_cases = {}
    for item in checks:
        cases = item.get("caseIds", item.get("cases"))
        if item.get("result") in ("fail", "unknown") and isinstance(cases, list):
            failed_cases[item["code"]] = [case for case in cases if isinstance(case, str)][:32]
    if failed_cases:
        result["criteriaCases"] = failed_cases
    rows = [row for row in verdict.get("cases", []) if isinstance(row, dict)
            and isinstance(row.get("caseId"), str) and isinstance(row.get("orientedMeanImprovement"), (int, float))
            and row["orientedMeanImprovement"] < 0]
    if rows:
        rows.sort(key=lambda row: row["orientedMeanImprovement"])
        result["regressedCases"] = [project(row, ("caseId", "parentMean", "candidateMean", "orientedMeanImprovement"))
                                    for row in rows[:32]]
    if isinstance(verdict.get("policyReceipt"), dict):
        result["policyReceipt"] = project(verdict["policyReceipt"], ("status", "code"))
    gaps = verdict.get("evidenceGaps")
    if isinstance(gaps, dict):
        result["evidenceGaps"] = {"total": gaps.get("total"), "rows": [
            project(row, ("caseId", "repetition", "side", "stage", "reason"))
            for row in gaps.get("rows", [])[:32]
        ]}
    return result


def within_chain(handoff, root):
    try:
        parts = handoff.parent.relative_to(root).parts
    except ValueError:
        return False
    return all(re.fullmatch("after-" + UUID, part) for part in parts)


def prior_handoff(value, output, request_dir):
    handoff = output / value
    if not handoff.is_file() or handoff.resolve() != handoff:
        raise ValueError("--rerun-after needs a CI-managed handoff path relative to --output-dir")
    if handoff.name != HANDOFF or not within_chain(handoff, request_dir):
        raise ValueError("--rerun-after must belong to this commit, payload, bundle, channel, evaluator and "
                         "channel release. If the release or evaluator changed, rerun without --rerun-after: "
                         "the wrapper already starts a fresh request.")
    return handoff


def latest_generation(root):
    current = root
    for _ in range(256):
        marker = read_json(current / "superseded.json", 65536)
        request_id = marker.get("requestId") if marker else None
        if not (isinstance(request_id, str) and re.fullmatch(UUID, request_id)):
            return current
        current = current / ("after-" + request_id)
    raise ValueError("Too many successor generations under " + str(root))


def supersede(directory, request_id, status, reason):
    write_json(directory / "superseded.json",
               {"schemaVersion": 1, "requestId": request_id, "status": status, "reason": reason})
    return directory / ("after-" + request_id)


class Pipeline:
    def __init__(self, args, summary, cancellation):
        self.args, self.summary, self.cancellation = args, summary, cancellation
        self.private = None
        self.generation = None

    def fail(self, result, code, phase=None):
        if phase:
            self.summary["failedPhase"] = phase
        return result, code

    def status_of(self, handoff):
        record = self.runner.step("status", "--config", self.config_path, "--handoff", str(handoff))
        return record if not self.runner.code("status") else None

    def interrupt(self, handoff, reason):
        record = self.runner.step("interrupt", "--config", self.config_path, "--handoff", str(handoff),
                                  "--reason", reason)
        return not self.runner.code("interrupt") and record.get("status") == "interrupted"

    def abandon(self, handoff, reason):
        status = abandon_request(self.config, self.token, read_json(handoff, 1024 * 1024), reason)
        if status != "abandoned":
            print("Could not abandon request " + str(handoff_request_id(handoff)) + " through the service",
                  file=sys.stderr)
        return status == "abandoned"

    def settle(self, handoff):
        """Make an explicitly named predecessor safe to follow. Returns None or a (result, code) failure."""
        summary = self.summary
        record = self.status_of(handoff)
        if record is None:
            return self.fail("prior_status_unavailable", self.runner.code("status") or EXIT_FAILED, "status")
        summary["previousRequestId"] = record.get("requestId")
        summary["previousExecutionStatus"] = status = record.get("status")
        if status in ("completed", "failed"):
            if all(re.fullmatch(UUID, str(record.get(field))) for field in ("requestId", "attemptId", "comparisonId")):
                return None
            summary["nextAction"] = "The previous request finished without a bound comparison. Ask the evaluation owner to inspect it."
            return self.fail("prior_execution_unresolved", EXIT_RECOVERY)
        if status in ENDED_WITHOUT_EVIDENCE:
            return None
        if status not in ("requested", "running"):
            return self.fail("prior_execution_unresolved", EXIT_RECOVERY)
        state = journal_state(self.config, read_json(handoff, 1024 * 1024))
        summary["previousJournalState"] = state
        if state == "busy":
            summary["nextAction"] = "Another evaluator process on this host is running the previous request. Wait for it, then rerun."
            return self.fail("prior_execution_unresolved", EXIT_RECOVERY)
        if state == "report_saved":
            summary["nextAction"] = "The previous attempt saved its report. Rerun without --rerun-after to submit it."
            return self.fail("prior_execution_unresolved", EXIT_RECOVERY)
        safe = state == "not_started" or (status == "requested" and state in ("absent", "unknown"))
        if not (safe or self.args.abandon_uncertain):
            summary["nextAction"] = NEXT_ACTIONS["prior_execution_unresolved"]
            return self.fail("prior_execution_unresolved", EXIT_RECOVERY)
        if safe:
            # Nothing started: an interruption records that without fencing any evidence.
            if not self.interrupt(handoff, "Superseded by the CI wrapper before execution started"):
                summary["nextAction"] = "Could not interrupt the previous request. Check the evaluator credential, then rerun."
                return self.fail("prior_execution_unresolved", self.runner.code("interrupt") or EXIT_RECOVERY,
                                 "interrupt")
            action = "interrupted"
        else:
            if not self.abandon(handoff, "Abandoned by the CI wrapper with --abandon-uncertain"):
                summary["nextAction"] = "Could not abandon the previous request. Check that the evaluator token holds the evaluate right, then rerun."
                return self.fail("prior_execution_unresolved", EXIT_RECOVERY, "abandon")
            action = "abandoned"
        summary["reconciled"] = {"requestId": record.get("requestId"), "previousStatus": status,
                                 "journal": state, "action": action}
        summary["previousExecutionStatus"] = action
        return None

    def advance(self, current):
        """Follow an interrupted or cancelled generation to its successor. Returns (directory, failure)."""
        for _ in range(256):
            handoff = current / HANDOFF
            request_id = handoff_request_id(handoff) if handoff.is_file() else None
            if request_id is None:
                return current, None
            record = self.status_of(handoff)
            if record is None:
                # Let the request and run phases report the service problem.
                return current, None
            status = record.get("status")
            cancelled = (current / "cancelled.json").is_file()
            if status in ENDED_WITHOUT_EVIDENCE or (cancelled and status == "failed"):
                # Interrupted by an operator or this wrapper, or abandoned explicitly or by the
                # service after inactivity: follow it with a fresh request.
                self.summary["previousRequestId"] = request_id
                self.summary["previousExecutionStatus"] = status
                reason = status if status in ENDED_WITHOUT_EVIDENCE else "cancelled"
                current = supersede(current, request_id, status, reason)
                continue
            if status in ("requested", "running") and self.args.abandon_uncertain:
                state = journal_state(self.config, read_json(handoff, 1024 * 1024))
                if state == "busy":
                    self.summary["nextAction"] = "Another evaluator process on this host is running this request."
                    return current, self.fail("execution_unresolved", EXIT_RECOVERY)
                if state == "may_have_started" or (status == "running" and state in ("absent", "unknown")):
                    if not self.abandon(handoff, "Abandoned by the CI wrapper with --abandon-uncertain"):
                        self.summary["nextAction"] = "Could not abandon the request. Check that the evaluator token holds the evaluate right, then rerun."
                        return current, self.fail("execution_unresolved", EXIT_RECOVERY, "abandon")
                    self.summary["reconciled"] = {"requestId": request_id, "previousStatus": status,
                                                  "journal": state, "action": "abandoned"}
                    self.summary["previousRequestId"] = request_id
                    self.summary["previousExecutionStatus"] = "abandoned"
                    current = supersede(current, request_id, "abandoned", "abandoned")
                    continue
            return current, None
        raise ValueError("Too many successor generations under " + str(current))

    def request_directory(self, output, revision):
        """Choose a request directory. An unchanged candidate, release and evaluator reuse their request."""
        args, summary = self.args, self.summary
        legacy = hashlib.sha256()
        for field in (args.bundle.encode(), args.channel.encode(), revision):
            legacy.update(len(field).to_bytes(8, "big"))
            legacy.update(field)
        fallback = output / "requests" / (args.commit + "-" + legacy.hexdigest())
        if args.no_reuse:
            summary["reuse"] = {"status": "disabled"}
            return fallback
        release = channel_release(self.config, self.token, args.bundle, args.channel)
        if release is None:
            summary["reuse"] = {"status": "unavailable", "reason": "channel_release_unknown"}
            return fallback
        if release.get("empty"):
            summary["diagnosticCode"] = "request.channel_empty"
            summary["hint"] = ("Channel " + args.channel + " has no release for bundle " + args.bundle + ". "
                               "Publish a baseline release to this channel before running PR checks.")
            summary["nextAction"] = summary["hint"]
            raise ChannelEmpty()
        descriptor = self.runner.step("describe")
        if self.runner.code("describe") or not descriptor:
            summary["reuse"] = {"status": "unavailable", "reason": "descriptor_unavailable"}
            return fallback
        identity = {field: self.config.get(field)
                    for field in ("serviceUrl", "workspaceId", "evaluatorPrincipalId", "journalRoot")}
        material = {"schemaVersion": 1, "identity": identity, "bundle": args.bundle, "channel": args.channel,
                    "parent": release, "descriptor": descriptor,
                    "payloadSha256": hashlib.sha256(revision).hexdigest(),
                    "subset": {"cases": args.cases, "shard": args.shard}}
        key = hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        directory = output / "requests" / key
        origin = read_json(directory / "origin.json", 65536)
        if origin and isinstance(origin.get("commit"), str):
            summary["reuse"] = {"status": "reused", "key": key, "originCommit": origin["commit"]}
        else:
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
            write_json(directory / "origin.json", {"schemaVersion": 1, "commit": args.commit,
                                                   "parentVersionId": release["versionId"]})
            summary["reuse"] = {"status": "new", "key": key}
        return directory

    def run(self):
        args, summary = self.args, self.summary
        output = Path(args.output_dir)
        output.mkdir(parents=True, mode=0o700, exist_ok=True)
        output = output.resolve()
        cli, app_directory = evaluator_command(args)
        # Explicit files belong to the caller; the installed CLI discovers its adapter in app_directory.
        args.config = os.path.abspath(args.config)
        args.policy = os.path.abspath(args.policy)
        if args.selection:
            args.selection = os.path.abspath(args.selection)
        revision = committed_payload(args)
        summary["commit"] = args.commit
        if args.base_commit:
            summary["baseCommit"] = args.base_commit
            summary["changedFiles"] = changed_files(args)
        self.private = tempfile.mkdtemp(prefix=".credentials-", dir=str(output))
        self.config_path, self.config, self.token, environment = credentials(args, self.private)
        self.runner = runner = Runner(cli, app_directory, summary, self.cancellation, args.format == "github",
                                      environment)
        phases = summary["phaseExitCodes"]
        target = ["--config", self.config_path, "--bundle", args.bundle]

        runner.step("doctor", *target, "--policy", args.policy)
        if phases["doctor"]:
            return self.fail("preflight_failed", phases["doctor"], "doctor")

        if args.intent:
            intent = Path(args.intent)
            handoff = output / HANDOFF
        else:
            try:
                request_root = self.request_directory(output, revision)
            except ChannelEmpty:
                return self.fail("request_failed", EXIT_USAGE, "request")
            summary["requestDirectory"] = request_root.relative_to(output).as_posix()
            if args.rerun_after:
                prior = prior_handoff(args.rerun_after, output, request_root)
                summary["priorHandoff"] = prior.relative_to(output).as_posix()
                request_id = handoff_request_id(prior)
                if request_id is None:
                    raise ValueError("--rerun-after names an unreadable handoff")
                if not (prior.parent / "superseded.json").is_file():
                    # One successor per predecessor: repeating the command resumes it.
                    failure = self.settle(prior)
                    if failure:
                        return failure
                    supersede(prior.parent, request_id, summary.get("previousExecutionStatus"), "rerun")
                current = latest_generation(prior.parent)
            else:
                current = latest_generation(request_root)
            current, failure = self.advance(current)
            if failure:
                return failure
            current.mkdir(parents=True, mode=0o700, exist_ok=True)
            self.generation = current
            intent = current / "request-intent.json"
            handoff = current / HANDOFF
        work = ["--config", self.config_path, "--handoff", str(handoff)]
        with tempfile.TemporaryDirectory(dir=str(output)) as directory:
            payload = Path(directory) / "candidate.json"
            payload.write_bytes(revision)
            request = runner.step("request", *target, "--channel", args.channel, "--payload", str(payload),
                                  "--policy", args.policy, "--intent", str(intent), "--out", str(handoff))
        if phases["request"]:
            if runner.diagnostics.get("request", {}).get("code") == "request.intent_mismatch":
                self.explain_mismatch(output, handoff)
            return self.fail("request_failed", phases["request"], "request")
        if not all(re.fullmatch(pattern, str(request.get(field))) for field, pattern in (
            ("requestId", UUID), ("candidateVersionId", UUID), ("candidateDigest", r"sha256:[0-9a-f]{64}"),
        )):
            print("Request did not identify its immutable candidate", file=sys.stderr)
            runner.record("request", EXIT_FAILED)
            return self.fail("request_failed", EXIT_FAILED, "request")
        for field in ("requestId", "candidateVersionId", "candidateDigest"):
            summary[field] = request[field]
        summary["parentVersionId"] = request.get("parentVersionId")
        summary["handoff"] = handoff.relative_to(output).as_posix()

        passthrough = []
        for name, flag in RUN_PASSTHROUGH:
            if getattr(args, name) is not None:
                passthrough += [flag, getattr(args, name)]
        try:
            run = runner.step("run", *work, *(["--live"] if args.live else []), *passthrough)
        except Cancelled as cancelled:
            summary["executionStatus"] = cancelled.value.get("status")
            summary["comparisonId"] = cancelled.value.get("comparisonId")
            if self.generation is not None:
                write_json(self.generation / "cancelled.json",
                           {"schemaVersion": 1, "requestId": summary["requestId"],
                            "executionStatus": summary["executionStatus"], "forced": self.cancellation.forced})
            raise
        summary["executionStatus"] = run.get("status")
        summary["comparisonId"] = run.get("comparisonId")
        if run.get("run"):
            summary["run"] = run["run"]
        # Check whenever the run produced a comparison: a completed run (0), one that stopped early
        # with partial evidence (3), or a request that finished as failed (4). Recovery (5) has none.
        if phases["run"] == EXIT_OK or (phases["run"] in (EXIT_INDETERMINATE, EXIT_FAILED) and run.get("comparisonId")):
            verdict = runner.step("check", *work, "--policy", args.policy)
            if verdict.get("verdict") in ("pass", "fail", "indeterminate"):
                summary["qualityVerdict"] = verdict["verdict"]
                summary["quality"] = policy_summary(verdict)
                if verdict.get("comparisonId"):
                    summary["comparisonId"] = verdict["comparisonId"]
            if phases["check"] == 0 and summary["qualityVerdict"] != "pass":
                runner.record("check", EXIT_INDETERMINATE)
        self.export(output, work)

        if phases["run"]:
            # 3: partial evidence (deadline, cost limit or case subset); 5: earlier work is unresolved;
            # 4: the request failed or the service was unreachable; 1: the command or config is wrong.
            result = {EXIT_INDETERMINATE: "execution_partial", EXIT_RECOVERY: "execution_unresolved"}.get(
                phases["run"], "execution_failed")
            if phases["check"] == EXIT_GATE_FAILED and result == "execution_partial":
                # Partial evidence that already fails the gate is a quality failure.
                return self.fail("quality_failed", EXIT_GATE_FAILED, "check")
            return self.fail(result, phases["run"], "run")
        if phases["check"]:
            outcome = {"fail": "quality_failed", "indeterminate": "quality_indeterminate"}
            return self.fail(outcome.get(summary["qualityVerdict"], "check_failed"), phases["check"], "check")
        if phases["export"] or phases["verify-export"]:
            phase = "export" if phases["export"] else "verify-export"
            return self.fail("export_failed", phases[phase], phase)
        return "pass", 0

    def export(self, output, work):
        """Export review evidence once per request and selection, at a deterministic path."""
        args, summary, runner = self.args, self.summary, self.runner
        reviews = output / "reviews"
        reviews.mkdir(mode=0o700, exist_ok=True)
        name = summary["requestId"]
        if args.selection:
            try:
                with open(args.selection, "rb") as handle:
                    name += "-" + hashlib.sha256(handle.read(4 * 1024 * 1024)).hexdigest()[:16]
            except OSError:
                pass
        final = reviews / name
        if final.is_dir():
            runner.step("verify-export", "--manifest", str(final / "manifest.json"))
            if not runner.code("verify-export"):
                summary["phaseExitCodes"]["export"] = 0
                summary["reviewDirectory"] = final.relative_to(output).as_posix()
                return
            shutil.rmtree(final, ignore_errors=True)
            summary["phaseExitCodes"]["verify-export"] = None
        staging = reviews / (".staging-" + name + "-" + uuid4().hex)
        selection = ["--selection", args.selection] if args.selection else []
        try:
            runner.step("export", *work, *selection, "--out", str(staging))
            if not runner.code("export"):
                runner.step("verify-export", "--manifest", str(staging / "manifest.json"))
                if not runner.code("verify-export"):
                    os.rename(staging, final)
                    summary["reviewDirectory"] = final.relative_to(output).as_posix()
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def explain_mismatch(self, output, handoff):
        summary, runner = self.summary, self.runner
        summary["nextAction"] = "Restore the original evaluator, candidate, target and worker identity to resume this intent."
        if not handoff.is_file():
            return
        summary["priorHandoff"] = handoff.relative_to(output).as_posix()
        prior = self.status_of(handoff)
        if prior is None:
            return
        summary["previousRequestId"] = prior.get("requestId")
        summary["previousExecutionStatus"] = prior.get("status")
        saved = read_json(handoff, 1024 * 1024)
        described = runner.step("describe")
        if saved is not None and not runner.code("describe") and described != saved.get("descriptor"):
            summary["mismatch"] = "evaluator_definition_changed"
        if not self.args.intent and prior.get("status") in SETTLED:
            summary["nextAction"] = "To evaluate the revised app, rerun this command with --rerun-after and the priorHandoff value."

    def cleanup(self):
        if self.private:
            shutil.rmtree(self.private, ignore_errors=True)


class ChannelEmpty(Exception):
    pass


def new_summary():
    return {
        "schemaVersion": 1, "result": None, "exitCode": None, "commit": None, "channel": None,
        "requestId": None, "parentVersionId": None, "candidateVersionId": None, "candidateDigest": None,
        "executionStatus": None, "comparisonId": None, "qualityVerdict": None, "quality": None,
        "reviewDirectory": None, "handoff": None, "failedPhase": None, "diagnosticCode": None,
        "failedChecks": None, "hint": None, "nextAction": None,
        "phaseExitCodes": dict.fromkeys(PHASES),
    }


def finish_summary(summary, runner, result, status):
    summary["result"] = result
    summary["exitCode"] = status
    diagnostics = runner.diagnostics if runner else {}
    phase = summary.get("failedPhase")
    diagnostic = diagnostics.get(phase) if phase else None
    if diagnostic is None and result not in ("pass", "quality_failed", "quality_indeterminate"):
        diagnostic = next(iter(reversed(list(diagnostics.values()))), None)
    if diagnostic:
        summary["diagnosticCode"] = summary.get("diagnosticCode") or diagnostic.get("code")
        summary["failedChecks"] = diagnostic.get("failedChecks")
        summary["hint"] = (summary.get("hint") or diagnostic.get("hint") or HINTS.get(diagnostic.get("code"))
                           or ("Last evaluator output: " + diagnostic["output"] if diagnostic.get("output") else None))
        if diagnostic.get("nextAction") and not summary.get("nextAction"):
            summary["evaluatorNextAction"] = diagnostic["nextAction"]
    elif summary.get("diagnosticCode") and not summary.get("hint"):
        summary["hint"] = HINTS.get(summary["diagnosticCode"])
    if result != "pass" and not summary.get("nextAction"):
        summary["nextAction"] = NEXT_ACTIONS.get(result)


def text(value, limit=200):
    """Render untrusted text on one line for logs and Markdown."""
    value = re.sub(r"[\x00-\x1f\x7f  ]", " ", str(value))
    return value if len(value) <= limit else value[:limit - 1] + "…"


def code_span(value):
    return "`" + text(value).replace("`", "'").replace("|", "\\|") + "`"


def number(value):
    return "unknown" if not isinstance(value, (int, float)) or isinstance(value, bool) else "%.4g" % value


def headline(summary):
    result = summary.get("result")
    if result == "pass":
        return "✅ Acclimate quality gate passed"
    if result == "cancelled":
        return "⏹️ Acclimate quality gate cancelled"
    if result in ("quality_failed", "quality_indeterminate"):
        return "❌ Acclimate quality gate failed (" + result + ")"
    return "⚠️ Acclimate quality gate could not decide (" + str(result) + ")"


def render_markdown(summary):
    quality = summary.get("quality") or {}
    scores = quality.get("scores") or {}
    counts = quality.get("counts") or {}
    rows = [("Result", code_span(summary.get("result")) + " (exit " + str(summary.get("exitCode")) + ")"),
            ("Commit", code_span(summary.get("commit"))), ("Channel", code_span(summary.get("channel")))]
    if summary.get("parentVersionId") or summary.get("candidateVersionId"):
        rows.append(("Parent → candidate", code_span(summary.get("parentVersionId")) + " → "
                     + code_span(summary.get("candidateVersionId"))))
    if scores:
        rows.append(("Mean score", number(scores.get("parentMean")) + " → " + number(scores.get("candidateMean"))
                     + " (change " + number(scores.get("orientedMeanImprovement")) + ")"))
    if counts:
        rows.append(("Comparable pairs", str(counts.get("comparablePairs")) + " of " + str(counts.get("expectedPairs"))))
    policy = quality.get("policy") or {}
    if policy.get("id"):
        rows.append(("Policy", code_span(str(policy.get("id")) + "@" + str(policy.get("revision")))))
    if summary.get("comparisonId"):
        rows.append(("Comparison", code_span(summary["comparisonId"])))
    reuse = summary.get("reuse") or {}
    if reuse.get("status") == "reused":
        rows.append(("Reused", "result from commit " + code_span(reuse.get("originCommit"))))
    lines = ["### " + headline(summary), "", "| | |", "| --- | --- |"]
    lines += ["| " + key + " | " + value + " |" for key, value in rows]
    if quality.get("failedCriteria"):
        lines += ["", "**Failed criteria:** " + ", ".join(code_span(item) for item in quality["failedCriteria"])]
    if quality.get("unknownCriteria"):
        lines += ["", "**Criteria without evidence:** " + ", ".join(code_span(item) for item in quality["unknownCriteria"])]
    for criterion, cases in (quality.get("criteriaCases") or {}).items():
        lines += ["", code_span(criterion) + " cases: " + ", ".join(code_span(case) for case in cases[:10])]
    if quality.get("regressedCases"):
        lines += ["", "**Regressed cases**", "", "| Case | Parent | Candidate | Change |", "| --- | --- | --- | --- |"]
        lines += ["| " + code_span(row.get("caseId")) + " | " + number(row.get("parentMean")) + " | "
                  + number(row.get("candidateMean")) + " | " + number(row.get("orientedMeanImprovement")) + " |"
                  for row in quality["regressedCases"][:10]]
    gaps = quality.get("evidenceGaps") or {}
    if gaps.get("rows"):
        lines += ["", "**Missing evidence** (" + str(gaps.get("total")) + " total)", "",
                  "| Case | Repetition | Side | Stage | Reason |", "| --- | --- | --- | --- | --- |"]
        lines += ["| " + " | ".join(code_span(row.get(key)) for key in ("caseId", "repetition", "side", "stage", "reason"))
                  + " |" for row in gaps["rows"][:10]]
    if summary.get("diagnosticCode") or summary.get("failedPhase"):
        lines += ["", "**Diagnostic:** " + ", ".join(
            label + " " + code_span(summary[key]) for label, key in (("phase", "failedPhase"), ("code", "diagnosticCode"))
            if summary.get(key))]
        for check in summary.get("failedChecks") or []:
            lines.append("- failed check " + code_span(check.get("check")) + " " + code_span(check.get("code")))
        if summary.get("hint"):
            lines.append("- " + text(summary["hint"], 500))
    if summary.get("cancellation"):
        cancellation = summary["cancellation"]
        lines += ["", "Cancelled by " + code_span(cancellation.get("signal")) + " during "
                  + code_span(cancellation.get("phase")) + (" (evaluator stopped forcibly)" if cancellation.get("forced") else "")]
    if summary.get("nextAction"):
        lines += ["", "**Next step:** " + text(summary["nextAction"], 500)]
    return "\n".join(lines) + "\n"


def escape_data(value):
    return text(value, 1000).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(value):
    return escape_data(value).replace(":", "%3A").replace(",", "%2C")


def annotation(kind, title, message):
    return "::" + kind + " title=" + escape_property(title) + "::" + escape_data(message)


def render_github(summary):
    result = summary.get("result")
    quality = summary.get("quality") or {}
    scores = quality.get("scores") or {}
    lines = [headline(summary)]
    for key in ("commit", "channel", "requestId", "parentVersionId", "candidateVersionId", "comparisonId",
                "qualityVerdict", "reviewDirectory"):
        if summary.get(key):
            lines.append("  " + key + ": " + text(summary[key]))
    if scores:
        lines.append("  mean score: " + number(scores.get("parentMean")) + " -> " + number(scores.get("candidateMean"))
                     + " (change " + number(scores.get("orientedMeanImprovement")) + ")")
    score_text = (" Mean score " + number(scores.get("parentMean")) + " -> " + number(scores.get("candidateMean"))
                  + ".") if scores else ""
    if result == "pass":
        lines.append(annotation("notice", "Acclimate quality gate passed",
                                "Candidate " + text(summary.get("candidateVersionId")) + " passed." + score_text))
    elif result in ("quality_failed", "quality_indeterminate"):
        failed = quality.get("failedCriteria") or []
        unknown = quality.get("unknownCriteria") or []
        lines.append(annotation("error", "Acclimate quality gate failed",
                                "Failed criteria: " + (", ".join(failed) or "none") + ". Criteria without evidence: "
                                + (", ".join(unknown) or "none") + "." + score_text))
        for criterion in failed + unknown:
            cases = (quality.get("criteriaCases") or {}).get(criterion)
            lines.append(annotation("error", "Failed criterion " + criterion,
                                    criterion + (" in cases " + ", ".join(cases[:10]) if cases else "")))
        for row in (quality.get("regressedCases") or [])[:10]:
            lines.append(annotation("error", "Regressed case " + text(row.get("caseId"), 80),
                                    "Case " + text(row.get("caseId")) + " changed by "
                                    + number(row.get("orientedMeanImprovement")) + " (" + number(row.get("parentMean"))
                                    + " -> " + number(row.get("candidateMean")) + ")"))
        for row in ((quality.get("evidenceGaps") or {}).get("rows") or [])[:10]:
            lines.append(annotation("warning", "Missing evidence for " + text(row.get("caseId"), 80),
                                    "Case " + text(row.get("caseId")) + " repetition " + text(row.get("repetition"))
                                    + " " + text(row.get("side")) + " " + text(row.get("stage")) + ": "
                                    + text(row.get("reason"))))
    elif result == "cancelled":
        lines.append(annotation("warning", "Acclimate quality gate cancelled", summary.get("nextAction") or ""))
    else:
        detail = " ".join(label + " " + text(summary[key]) + "." for label, key in
                          (("Phase", "failedPhase"), ("Code", "diagnosticCode")) if summary.get(key))
        for check in summary.get("failedChecks") or []:
            detail += " Failed check " + text(check.get("check")) + " (" + text(check.get("code")) + ")."
        if summary.get("hint"):
            detail += " " + text(summary["hint"], 500)
        lines.append(annotation("error", "Acclimate " + str(result), detail))
    if summary.get("nextAction"):
        lines.append("Next step: " + text(summary["nextAction"], 500))
    return "\n".join(lines)


def github_outputs(summary):
    values = {
        "result": summary.get("result"), "exit-code": summary.get("exitCode"),
        "verdict": summary.get("qualityVerdict"), "comparison-id": summary.get("comparisonId"),
        "request-id": summary.get("requestId"), "candidate-version-id": summary.get("candidateVersionId"),
        "candidate-digest": summary.get("candidateDigest"), "parent-version-id": summary.get("parentVersionId"),
    }
    return "".join(key + "=" + ("" if value is None else re.sub(r"[^A-Za-z0-9_.:-]", "", str(value))) + "\n"
                   for key, value in values.items())


def emit(summary, args):
    serialized = json.dumps(summary, separators=(",", ":"))
    markdown = render_markdown(summary)
    if args is not None:
        try:
            if args.summary_json:
                with open(args.summary_json, "w") as handle:
                    handle.write(serialized + "\n")
            for filename in args.summary_md:
                with open(filename, "a") as handle:
                    handle.write(markdown)
            if args.github_output:
                with open(args.github_output, "a") as handle:
                    handle.write(github_outputs(summary))
        except OSError:
            print("Could not write a summary or output file", file=sys.stderr)
    fmt = args.format if args is not None else "json"
    sys.stdout.write((serialized if fmt == "json" else markdown.rstrip("\n") if fmt == "markdown"
                      else render_github(summary)) + "\n")
    sys.stdout.flush()


def main(argv):
    os.umask(0o077)
    summary = new_summary()
    cancellation = Cancellation()
    cancellation.install()
    args = pipeline = None
    try:
        args = arguments(argv)
        cancellation.grace = args.cancel_grace
        summary["channel"] = args.channel
        pipeline = Pipeline(args, summary, cancellation)
        result, status = pipeline.run()
    except Cancelled as cancelled:
        summary["failedPhase"] = cancelled.phase
        summary["cancellation"] = cancellation.describe()
        result, status = "cancelled", cancellation.exit_status()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        summary["hint"] = text(error, 500)
        result, status = "configuration_error", 1
    except OSError:
        print("Could not access the CI workspace or launch a required command", file=sys.stderr)
        result, status = "configuration_error", 1
    except Exception as error:  # the summary must still be printed
        print("Unexpected CI wrapper failure: " + type(error).__name__, file=sys.stderr)
        result, status = "wrapper_error", EXIT_FAILED
    finally:
        if pipeline is not None:
            pipeline.cleanup()
    if cancellation.signal is not None and result in ("configuration_error", "wrapper_error"):
        # A signal also reaches helper commands such as git; report the cancellation, not their failure.
        summary["cancellation"] = cancellation.describe()
        result, status = "cancelled", cancellation.exit_status()
    finish_summary(summary, getattr(pipeline, "runner", None), result, status)
    emit(summary, args)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
