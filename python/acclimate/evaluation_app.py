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

from ._application_imports import SetupError, load_adapter

HELP = """Compare your agent using its installed application.py.
Export cases, execute and grade from that module. Run in the module's directory or add --app PACKAGE.MODULE or --app FILE.py.
Run coverage to inspect the fingerprinted files and build identities.

  python -m acclimate compare --config CONFIG --handoff HANDOFF --live [--policy POLICY] [--json]
  python -m acclimate compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME [--name RUN_NAME]) --live [--policy POLICY] [--json]

Reuse RUN_NAME to recover the same change. Use describe for your public descriptor,
doctor to check setup, or request, run, check, status, interrupt, export and verify-export.
Use pull to save a published bundle as a payload file to edit."""


def read_cases(filename):
    if not filename or not os.path.isabs(filename):
        raise SetupError("Set ACCLIMATE_EVALUATOR_CASES to the absolute path of your private case file.")
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, encoding="utf-8") as source:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise SetupError("The case file must be a regular file owned by this user, with mode 0400 or 0600.")
            if info.st_size > 16 * 1024 * 1024:
                raise SetupError("The case file exceeds 16 MiB.")
            rows = json.load(source)
    except (OSError, ValueError) as error:
        raise SetupError("Cannot read the private case file. Check its path, access and JSON syntax.") from error
    return rows


def case_inventory(rows):
    from acclimate.evaluation import Case

    if not isinstance(rows, (list, tuple)):
        raise SetupError("Supply a sequence of application cases or a private JSON array.")
    cases = []
    fields = {"caseId", "input", "expected"}
    for row in rows:
        if isinstance(row, Case):
            cases.append(row)
            continue
        if (not isinstance(row, dict) or not fields.issubset(row)
                or set(row) - fields - {"repetitions"}):
            raise SetupError("Each case requires caseId, input and expected, with optional repetitions.")
        cases.append(Case(row["caseId"], row["input"], row["expected"], row.get("repetitions", 1)))
    return cases


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
        raise SetupError("revision_files must contain distinct file paths relative to your application module.")
    digests = {}
    try:
        for name in files:
            with (directory / name).open("rb") as source:
                digests[name] = hashlib.file_digest(source, "sha256").hexdigest()
    except OSError as error:
        raise SetupError("Cannot read a declared revision_files entry. Check the paths relative to your application module.") from error
    return "sha256:" + hashlib.sha256(canonical_evaluation_json(digests).encode()).hexdigest()


@contextmanager
def installed_application(directory=None, *, selection=None, coverage=None):
    directory = Path.cwd() if directory is None else Path(directory)
    with load_adapter(directory, selection) as (adapter, filename, source, imported, imported_files, external):
        with _configure(adapter, filename, source, imported, imported_files, external, coverage) as configured:
            yield configured


@contextmanager
def _configure(adapter, filename, source, imported, imported_files, external, coverage):
    from .evaluation import EvaluationError, define_evaluation
    from .evaluation_manifest import canonical_evaluation_json, create_evaluation_manifest

    directory = filename.parent
    try:
        execute, grade = adapter.execute, adapter.grade
        if not callable(execute) or not callable(grade):
            raise SetupError("Your application module must export execute and grade functions.")
        case_file = os.environ.get("ACCLIMATE_EVALUATOR_CASES")
        rows = read_cases(case_file) if case_file else getattr(adapter, "cases", None)
        if not rows:
            raise SetupError("Export your cases list or set ACCLIMATE_EVALUATOR_CASES to its private JSON file.")
        runtime = getattr(adapter, "runtime", {})
        artifacts = runtime.get("artifacts", {})
        if {"installedAdapter", "revisionFiles", "importedSources"}.intersection(artifacts):
            raise SetupError("The SDK supplies installedAdapter, importedSources and revisionFiles artifact identities.")
        digest = "sha256:" + hashlib.sha256(source).hexdigest()
        artifacts = {**artifacts, "installedAdapter": digest}
        grader_digest = digest
        if imported:
            import_digest = "sha256:" + hashlib.sha256(canonical_evaluation_json(imported).encode()).hexdigest()
            artifacts["importedSources"] = import_digest
            grader_digest = "sha256:" + hashlib.sha256((digest + "\n" + import_digest).encode()).hexdigest()
        if coverage is not None:
            coverage.update(adapter=str(filename), importedFiles=imported_files, externalImports=external,
                            revisionFiles=list(getattr(adapter, "revision_files", [])),
                            artifacts=sorted(runtime.get("artifacts", {})),
                            limits="Ordinary local Python source imports are followed recursively. Direct external imports bind available source and installed distribution records. Declare dynamic imports, external services, assets and deployment settings using revision_files or runtime artifacts/settings.")
        if hasattr(adapter, "revision_files"):
            revision = hash_revision_files(directory, adapter.revision_files)
            artifacts["revisionFiles"] = revision
            grader_digest = "sha256:" + hashlib.sha256((grader_digest + "\n" + revision).encode()).hexdigest()
        manifest = create_evaluation_manifest(
            config_id=getattr(adapter, "config_id", "application"), execution="live",
            cases=case_inventory(rows), grader=getattr(adapter, "grader", {"artifactDigest": grader_digest}),
            runtime={"settings": runtime.get("settings", {}), "artifacts": artifacts},
        )
        mapper = getattr(adapter, "to_review_artifact", None)
        if mapper is not None and not callable(mapper):
            raise ValueError
    except SetupError:
        raise
    except Exception as error:
        raise SetupError("Check your case inventory, callbacks and any declared build or grader identities.") from error

    with asyncio.Runner() as runner:
        try:
            app = define_evaluation(**manifest.definition, execute=adapt_callback(execute, runner),
                                    grade=adapt_callback(grade, runner))
        except EvaluationError as error:
            if error.code == "definition.report_budget_exceeded":
                raise SetupError("The case inventory exceeds the report size limit. Split it into smaller evaluations.") from error
            raise SetupError("Check the installed evaluation definition and callbacks.") from error
        review = {"to_review_artifact": adapt_callback(mapper, runner)} if mapper else None
        yield app, review


_COMMAND_USAGE = {
    "compare": HELP,
    "describe": "describe [--app MODULE|FILE.py]  Print the public descriptor for these callbacks and cases.",
    "coverage": "coverage [--app MODULE|FILE.py]  Inspect the local sources, declared files and build artifacts bound by the adapter.",
    "status": "status (--config CONFIG | --read-config READER) --handoff FILE\nstatus --config CONFIG --name RUN_NAME",
    "verify-export": "verify-export --manifest FILE [--read-config READER --handoff FILE]",
    "doctor": "doctor --config CONFIG (--bundle ID | --handoff FILE | --name RUN_NAME) [--policy POLICY]",
    "check": "check (--config CONFIG | --read-config READER) --handoff FILE --policy POLICY\ncheck --config CONFIG --name RUN_NAME --policy POLICY",
    "export": "export (--config CONFIG | --read-config READER) --handoff FILE --out DIRECTORY [--selection FILE]\nexport --config CONFIG --name RUN_NAME --out DIRECTORY [--selection FILE]",
    "request": "request --config CONFIG --bundle ID --channel CHANNEL --payload FILE --intent FILE --out HANDOFF [--policy POLICY]",
    "run": "run --config CONFIG (--handoff FILE | --name RUN_NAME) --live",
    "interrupt": "interrupt --config CONFIG (--handoff FILE | --name RUN_NAME) --reason REASON",
    "pull": "pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit.",
}


def main(argv=None, directory=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        selection = None
        if "--app" in args:
            offset = args.index("--app")
            if args.count("--app") > 1 or offset + 1 == len(args) or args[offset + 1].startswith("-"):
                raise SetupError("Pass --app once, followed by an installed Python module or a .py file.")
            selection = args[offset + 1]
            del args[offset:offset + 2]
        command = args[0] if args else None
        if not args or "--help" in args or "-h" in args:
            print(_COMMAND_USAGE.get(command, HELP))
            return 0
        if command == "pull":
            from ._evaluation_pull import pull_main
            return pull_main(args)
        from .evaluation_cli import evaluation_main
        if command in ("status", "verify-export"):
            return evaluation_main(None, args)
        if command not in _COMMAND_USAGE:
            raise SetupError("Unknown evaluator command. Run python -m acclimate --help.")
        coverage = {} if command == "coverage" else None
        with installed_application(directory, selection=selection, coverage=coverage) as (app, review):
            if coverage is not None:
                if len(args) != 1:
                    raise SetupError(_COMMAND_USAGE["coverage"])
                print(json.dumps(coverage))
                return 0
            return evaluation_main(app, args, review=review)
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1
