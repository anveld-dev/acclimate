"""Load the application's installed callbacks and private case inventory."""
import asyncio
import hashlib
import inspect
import json
import os
from contextlib import contextmanager
from pathlib import Path
import stat
import sys
import threading

from ._application_imports import SetupError, load_adapter

HELP = """Load cases, execute and grade from application.py.
Use --app PACKAGE.MODULE or --app FILE.py to select a different module.
Commands: try, describe, coverage, doctor, pull, learn.
Run python -m acclimate COMMAND --help for flags."""


def read_cases(filename):
    if not filename or not os.path.isabs(filename):
        raise SetupError("Set ACCLIMATE_EVALUATOR_CASES to the absolute path of your private case file.",
                         field="ACCLIMATE_EVALUATOR_CASES")
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, encoding="utf-8") as source:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise SetupError("The case file must be a regular file owned by this user, with mode 0400 or 0600.",
                                 field="ACCLIMATE_EVALUATOR_CASES")
            if info.st_size > 16 * 1024 * 1024:
                raise SetupError("The case file exceeds 16 MiB.", field="ACCLIMATE_EVALUATOR_CASES")
            rows = json.load(source)
    except (OSError, ValueError) as error:
        raise SetupError(f"Cannot read the private case file: {type(error).__name__}: {error}",
                         field="ACCLIMATE_EVALUATOR_CASES") from error
    return rows


def case_inventory(rows, root="cases"):
    """Convert exported cases to Case values. Dict rows may use caseId or case_id."""
    from acclimate.evaluation import Case

    if not isinstance(rows, (list, tuple)):
        raise SetupError("Export cases as a list of Case values or dicts.", code="definition.invalid", field=root)
    if not rows:
        raise SetupError("cases is empty. Add at least one case.", code="definition.invalid", field=root)
    cases = []
    for index, row in enumerate(rows):
        at = f"{root}[{index}]"
        if isinstance(row, Case):
            cases.append(row)
            continue
        if not isinstance(row, dict):
            raise SetupError("Each case must be a Case or a dict.", code="definition.invalid", field=at)
        if "caseId" in row and "case_id" in row:
            raise SetupError("Use caseId or case_id, not both.", code="definition.invalid", field=at + ".case_id")
        key = "case_id" if "case_id" in row else "caseId"
        for name in (key, "input", "expected"):
            if name not in row:
                raise SetupError(f"Add {name}. Use None when there is no value.", code="definition.invalid",
                                 field=f"{at}.{name}")
        unknown = sorted(set(row) - {key, "input", "expected", "repetitions"})
        if unknown:
            raise SetupError("Unknown case field. Use case_id (or caseId), input, expected and optional repetitions.",
                             code="definition.invalid", field=f"{at}.{unknown[0]}")
        cases.append(Case(row[key], row["input"], row["expected"], row.get("repetitions", 1)))
    return cases


class _RunnerPool:
    """One asyncio.Runner per calling thread.

    The owning thread keeps its original runner. Concurrent pairs and timed
    callbacks run on worker threads, and an asyncio.Runner is not thread-safe,
    so each worker thread gets its own runner, closed when the pool closes.
    """

    def __init__(self):
        self._owner = threading.get_ident()
        self._main = asyncio.Runner()
        self._local = threading.local()
        self._extra = []
        self._lock = threading.Lock()

    def run(self, coroutine):
        if threading.get_ident() == self._owner:
            return self._main.run(coroutine)
        runner = getattr(self._local, "runner", None)
        if runner is None:
            runner = self._local.runner = asyncio.Runner()
            with self._lock:
                self._extra.append(runner)
        return runner.run(coroutine)

    def close(self):
        self._main.close()
        with self._lock:
            extra, self._extra = self._extra, []
        for runner in extra:
            try:
                runner.close()
            except RuntimeError:
                pass  # An abandoned (timed-out) callback may still own this loop.

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def adapt_callback(callback, runner):
    from acclimate.evaluation import ExecutionUncertainError

    async def settle(awaitable):
        return await awaitable

    def invoke(run):
        try:
            value = callback(run)
            return runner.run(settle(value)) if inspect.isawaitable(value) else value
        except asyncio.CancelledError:
            # A cancelled coroutine cannot attest that an external job stopped.
            raise ExecutionUncertainError() from None

    return invoke


def hash_revision_files(directory, files):
    from .evaluation_manifest import canonical_evaluation_json

    if (not isinstance(files, (list, tuple))
            or any(not isinstance(name, str) or not name or os.path.isabs(name) for name in files)
            or len(set(files)) != len(files)):
        raise SetupError("revision_files must contain distinct file paths relative to your application module.",
                         field="revision_files")
    digests = {}
    try:
        for name in files:
            with (directory / name).open("rb") as source:
                digests[name] = hashlib.file_digest(source, "sha256").hexdigest()
    except OSError as error:
        raise SetupError("Cannot read a declared revision_files entry. Check the paths relative to your application module.",
                         field=f"revision_files: {name}") from error
    return "sha256:" + hashlib.sha256(canonical_evaluation_json(digests).encode()).hexdigest()


@contextmanager
def installed_application(directory=None, *, selection=None, coverage=None):
    directory = Path.cwd() if directory is None else Path(directory)
    with load_adapter(directory, selection) as (adapter, filename, source, imported, imported_files, external):
        with _configure(adapter, filename, source, imported, imported_files, external, coverage) as configured:
            yield configured


@contextmanager
def _configure(adapter, filename, source, imported, imported_files, external, coverage):
    from .evaluation import EvaluationError, capture_cases, define_evaluation
    from .evaluation_manifest import canonical_evaluation_json, create_evaluation_manifest

    directory = filename.parent
    missing = [name for name in ("execute", "grade") if not callable(getattr(adapter, name, None))]
    if missing:
        raise SetupError(f"Your application module does not define {' or '.join(missing)} as a function.",
                         field=missing[0], hint="Define execute(run) and grade(run) in the module. Either may be async.")
    execute, grade = adapter.execute, adapter.grade
    execution = getattr(adapter, "execution", "live")
    if execution not in ("live", "model-free"):
        raise SetupError('execution must be "live" or "model-free".', field="execution")
    case_file = os.environ.get("ACCLIMATE_EVALUATOR_CASES")
    rows = read_cases(case_file) if case_file else getattr(adapter, "cases", None)
    if rows is None:
        raise SetupError("Export your cases list or set ACCLIMATE_EVALUATOR_CASES to its private JSON file.", field="cases")
    root = "ACCLIMATE_EVALUATOR_CASES" if case_file else "cases"
    cases = case_inventory(rows, root)
    try:
        capture_cases(cases, root)
    except EvaluationError as error:
        raise SetupError(f"The application's evaluation definition is invalid. {error.field}: {error.reason}",
                         code="definition.invalid", field=error.field, reason=error.reason) from error
    for name, low, high in (("concurrency", 1, 64), ("grade_retries", 0, 5)):
        value = getattr(adapter, name, low)
        if type(value) is not int or not low <= value <= high:
            raise SetupError(f"{name} must be an integer from {low} to {high}.", code="definition.invalid", field=name)
    runtime = getattr(adapter, "runtime", {})
    if not isinstance(runtime, dict):
        raise SetupError("runtime must be a dict with optional settings and artifacts.", field="runtime")
    artifacts = runtime.get("artifacts", {})
    if not isinstance(artifacts, dict):
        raise SetupError("runtime['artifacts'] must map names to sha256 digests.", field="runtime.artifacts")
    if {"installedAdapter", "revisionFiles", "importedSources"}.intersection(artifacts):
        raise SetupError("The SDK supplies installedAdapter, importedSources and revisionFiles artifact identities.",
                         field="runtime.artifacts")
    digest = "sha256:" + hashlib.sha256(source).hexdigest()
    artifacts = {**artifacts, "installedAdapter": digest}
    grader_digest = digest
    if imported:
        import_digest = "sha256:" + hashlib.sha256(canonical_evaluation_json(imported).encode()).hexdigest()
        artifacts["importedSources"] = import_digest
        grader_digest = "sha256:" + hashlib.sha256((digest + "\n" + import_digest).encode()).hexdigest()
    if coverage is not None:
        coverage.update(adapter=str(filename), execution=execution, importedFiles=imported_files, externalImports=external,
                        revisionFiles=list(getattr(adapter, "revision_files", [])),
                        artifacts=sorted(runtime.get("artifacts", {})),
                        limits="Ordinary local Python source imports are followed recursively. Direct external imports bind available source and installed distribution records. Declare dynamic imports, external services, assets and deployment settings using revision_files or runtime artifacts/settings.")
    if hasattr(adapter, "revision_files"):
        revision = hash_revision_files(directory, adapter.revision_files)
        artifacts["revisionFiles"] = revision
        grader_digest = "sha256:" + hashlib.sha256((grader_digest + "\n" + revision).encode()).hexdigest()
    with _RunnerPool() as runner:
        try:
            manifest = create_evaluation_manifest(
                config_id=getattr(adapter, "config_id", "application"), execution=execution,
                cases=cases, grader=getattr(adapter, "grader", {"artifactDigest": grader_digest}),
                runtime={"settings": runtime.get("settings", {}), "artifacts": artifacts},
                **({"concurrency": adapter.concurrency} if hasattr(adapter, "concurrency") else {}),
                **({"grade_retries": adapter.grade_retries} if hasattr(adapter, "grade_retries") else {}),
            )
            app = define_evaluation(**manifest.definition, execute=adapt_callback(execute, runner),
                                    grade=adapt_callback(grade, runner))
        except EvaluationError as error:
            field = getattr(error, "field", None)
            if field:
                raise SetupError(f"The application's evaluation definition is invalid. {field}: {error.reason}",
                                 code="definition.invalid", field=field, reason=error.reason) from error
            # create_evaluation_manifest validates cases, grader, config_id and runtime together.
            raise SetupError("The application exports cannot form an evaluation manifest. Check that case_id values are "
                             "unique nonempty strings, inputs and expected values are plain JSON (no datetime), "
                             "config_id is a short string, grader is {'sourceUtf8': ...} or {'artifactDigest': 'sha256:...'} "
                             "and runtime settings are JSON.", code="definition.invalid",
                             field="cases, config_id, grader or runtime") from error
        yield app


_COMMAND_USAGE = {
    "describe": "describe [--app MODULE|FILE.py]",
    "try": "try [--case ID[,ID...]] [--payload PAYLOAD] [--live] [--case-timeout DURATION] [--json]",
    "coverage": "coverage [--app MODULE|FILE.py]",
    "doctor": "doctor --config CONFIG --bundle ID",
    "pull": "pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE",
}

def _coverage_text(coverage):
    def items(values):
        return ", ".join(values) if values else "none"
    return "\n".join([
        f'Adapter          {coverage["adapter"]}',
        f'Execution        {coverage.get("execution", "live")}',
        f'Imported files   {items(coverage["importedFiles"])}',
        f'External imports {items(coverage["externalImports"])}',
        f'Revision files   {items(coverage["revisionFiles"])}',
        f'Artifacts        {items(coverage["artifacts"])}',
        "",
        coverage["limits"],
    ])


def main(argv=None, directory=None):
    from .evaluation_cli import (
        ADAPTER_FREE_COMMANDS, evaluation_main, parse_evaluator_arguments, report_evaluator_error, sdk_version,
    )
    from ._evaluation_shared import EvaluationError, EXIT_CODES

    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == "learn":
        from ._learning_cli import learn_main

        return learn_main(args[1:], directory)
    wants_help = "--help" in args or "-h" in args
    if not wants_help and ("--version" in args or "-V" in args):
        print(sdk_version())
        return EXIT_CODES["ok"]
    if wants_help:
        print(_COMMAND_USAGE.get(args[0] if args else None, HELP))
        return EXIT_CODES["ok"]
    if not args:
        # An empty $CMD in CI must fail, not pass.
        print(HELP + "\n", file=sys.stderr)
        return report_evaluator_error(EvaluationError("usage.missing_command",
            hint="Choose a command, for example describe or try."), args)
    command = "invalid"
    try:
        selection = None
        if "--app" in args:
            offset = args.index("--app")
            if args.count("--app") > 1 or offset + 1 == len(args) or args[offset + 1].startswith("-"):
                raise SetupError("Pass --app once, followed by an installed Python module or a .py file.", field="--app")
            selection = args[offset + 1]
            del args[offset:offset + 2]
        # Validate the command line before importing application code.
        command = parse_evaluator_arguments(args)[0]
        if command in ADAPTER_FREE_COMMANDS:
            return evaluation_main(None, args)
        coverage = {} if command == "coverage" else None
        with installed_application(directory, selection=selection, coverage=coverage) as app:
            if coverage is not None:
                terminal = sys.stdout.isatty() and "--json" not in args
                print(_coverage_text(coverage) if terminal else json.dumps(coverage))
                return EXIT_CODES["ok"]
            return evaluation_main(app, args)
    except Exception as error:
        return report_evaluator_error(error, args, command)
