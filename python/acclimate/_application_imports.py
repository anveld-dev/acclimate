"""Resolve an installed adapter and bind ordinary local Python imports to source bytes."""
import ast
import hashlib
import importlib
import importlib.machinery
import importlib.metadata
import importlib.util
import os
from pathlib import Path
import sys
import sysconfig
import threading
from contextlib import contextmanager


from ._evaluation_shared import EvaluationError


class SetupError(EvaluationError):
    """The application module could not be imported, or its exports are invalid.

    ``code`` is ``application.invalid``, ``application.import_failed`` or
    ``definition.invalid``. The original exception is chained as ``__cause__``.
    """

    def __init__(self, message: str, *, code: str = "application.invalid", field: str | None = None,
                 reason: str | None = None, hint: str | None = None):
        super().__init__(code, message=message, field=field, reason=reason, hint=hint)  # type: ignore[arg-type]


class _BoundSource(importlib.machinery.SourceFileLoader):
    def __init__(self, name, path, data):
        super().__init__(name, str(path))
        self.source = data

    def get_code(self, fullname):
        return self.source_to_code(self.source, self.path)


class _SourceFinder:
    def __init__(self, files):
        self.files = files

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in self.files:
            return None
        path, data = self.files[fullname]
        return importlib.util.spec_from_file_location(fullname, path, loader=_BoundSource(fullname, path, data))


_import_lock = threading.RLock()


@contextmanager
def _bound_imports(files, root):
    # One module name can have only one identity in an interpreter, including
    # lazily imported modules belonging to concurrent runs of an installed app.
    finder = _SourceFinder(files)
    search_root = str(root)
    with _import_lock:
        for name, (path, data) in files.items():
            loaded = sys.modules.get(name)
            if loaded is not None:
                loader = getattr(loaded, "__loader__", None)
                if not isinstance(loader, _BoundSource) or loader.path != str(path) or loader.source != data:
                    raise SetupError("The worker already imported a different or unbound copy of an application module. Start a fresh evaluator process to bind the current files.")
        for active in sys.meta_path:
            if isinstance(active, _SourceFinder) and any(files[n] != active.files[n] for n in files.keys() & active.files.keys()):
                raise SetupError("Another evaluator in this process has a different build of the same module. Start the new build in a fresh evaluator process.")
        sys.meta_path.insert(0, finder)
        sys.path.insert(0, search_root)
    try:
        yield
    finally:
        with _import_lock:
            sys.meta_path.remove(finder)
            for index, value in enumerate(sys.path):
                if value is search_root:
                    del sys.path[index]
                    break


def _source_spec(name, search):
    """Locate normal dotted imports without running package initializers during discovery."""
    if not name or any(not part.isidentifier() for part in name.split(".")):
        return None
    spec = None
    parts = name.split(".")
    for i, part in enumerate(parts):
        # Each lookup is relative to its parent's search locations. An
        # unimported PEP 420 namespace has no sys.modules parent to consult.
        spec = importlib.machinery.PathFinder.find_spec(part, search)
        if spec is None and i == 0:
            # PEP 660 editable builds can register their own top-level finder.
            try:
                spec = importlib.util.find_spec(part)
            except (ImportError, ValueError):
                return None
        if spec is None:
            return None
        search = spec.submodule_search_locations
        if search is None and i + 1 < len(parts):
            return None
    return spec


def _import_names(source, package):
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        elif isinstance(node, ast.ImportFrom):
            try:
                base = importlib.util.resolve_name("." * node.level + (node.module or ""), package)
            except (ImportError, ValueError):
                continue
            yield base
            for alias in node.names:
                if alias.name != "*":
                    yield base + "." + alias.name


@contextmanager
def load_adapter(directory, selection):
    """Import exactly the fingerprinted sources, including package initializers."""
    if selection and "/" not in selection and not selection.endswith(".py"):
        try:
            spec = _source_spec(selection, sys.path) or importlib.util.find_spec(selection)
        except (ImportError, ValueError, AttributeError):
            spec = None
        if not spec or not spec.origin or not spec.origin.endswith(".py"):
            raise SetupError("Cannot locate the Python source for --app. Use an installed module or a .py file.")
        filename = Path(spec.origin).resolve()
        module = selection
    else:
        filename = Path(selection).resolve() if selection else (directory / "application.py").resolve()
        module = filename.stem
        if not filename.is_file() or filename.suffix != ".py":
            raise SetupError("Add application.py in this directory or select an installed adapter with --app MODULE or --app FILE.py.")
    root = filename.parent
    path_name = filename.stem if filename.name != "__init__.py" else ""
    while (root / "__init__.py").is_file():
        path_name = root.name + ("." + path_name if path_name else "")
        root = root.parent
    if not selection or "/" in selection or selection.endswith(".py"):
        module = path_name
        if root == filename.parent:
            # Avoid colliding with an unrelated top-level module already in the host.
            module = "_acclimate_app_" + hashlib.sha256(os.fsencode(filename)).hexdigest()
    search = [str(root), *sys.path]
    stdlib = Path(sysconfig.get_path("stdlib")).resolve()
    files = {}
    external_sources = {}
    external_packages = set()
    pending = [(module, filename)]
    # Hash reachable local source, keeping site-packages boundaries explicit. A packaged
    # adapter's own installed Python package is local to it, even inside a wheel.
    top_package = module.split(".")[0]
    while pending:
        name, path = pending.pop()
        if name in files:
            continue
        try:
            data = path.read_bytes()
            files[name] = (path, data)
            package = name if path.name == "__init__.py" else name.rpartition(".")[0]
            imported = set(_import_names(data, package))
        except (OSError, SyntaxError, ValueError) as error:
            location = f" ({path}:{error.lineno})" if isinstance(error, SyntaxError) and error.lineno else ""
            raise SetupError("Cannot read or parse the adapter's Python sources" + location +
                             f": {type(error).__name__}: {error}", code="application.import_failed",
                             field=str(path)) from error
        if package and package != name:
            imported.add(package)
        for target in imported:
            top = target.split(".")[0]
            if not top or top == "acclimate" or top in sys.stdlib_module_names:
                continue
            spec = _source_spec(target, search)
            if not spec or not spec.origin:
                continue
            origin = Path(spec.origin).resolve()
            installed = "site-packages" in origin.parts or "dist-packages" in origin.parts or origin.is_relative_to(stdlib)
            if installed and top != top_package:
                external_packages.add(top)
                if origin.suffix == ".py":
                    try:
                        with origin.open("rb") as source:
                            external_sources["external:" + target] = hashlib.file_digest(source, "sha256").hexdigest()
                    except OSError as error:
                        raise SetupError("Cannot fingerprint an imported dependency. Check the installed package files.") from error
            elif origin.suffix == ".py":
                pending.append((target, origin))
                if "." in target:
                    parent = target.rpartition(".")[0]
                    parent_spec = _source_spec(parent, search)
                    if parent_spec and parent_spec.origin and parent_spec.origin.endswith(".py"):
                        pending.append((parent, Path(parent_spec.origin).resolve()))

    with _bound_imports(files, root):
        try:
            adapter = importlib.import_module(module)
        except SetupError:
            raise
        except Exception as error:
            # Name the exception the application raised, including its own code, so an
            # ImportError or NameError in the user's module is visible without a debugger.
            code = getattr(error, "code", None)
            label = f" [{code}]" if type(code) is str and len(code) <= 64 else ""
            detail = str(error).split("\n")[0][:500]
            raise SetupError(f"Could not import the application module: {type(error).__name__}{label}: {detail}",
                             code="application.import_failed", field=str(filename),
                             hint="Fix the error your module raised while loading. Rerun with --verbose for the traceback.") from error
        digests = {name: hashlib.sha256(data).hexdigest() for name, (_, data) in files.items() if name != module}
        imported_files = sorted(os.path.relpath(path, filename.parent) for name, (path, _) in files.items() if name != module)
        digests.update(external_sources)
        if external_packages:
            # A wheel's RECORD binds its transitive package contents without
            # importing optional integrations or scanning unrelated packages.
            distributions = importlib.metadata.packages_distributions()
            for package in sorted(external_packages):
                for name in distributions.get(package, []):
                    dist = importlib.metadata.distribution(name)
                    digest = hashlib.sha256(dist.version.encode())
                    for file in sorted(dist.files or ()):
                        if file.parts[0] in (package, package + ".py") and file.hash:
                            digest.update(("\n" + str(file) + "=" + file.hash.mode + ":" + file.hash.value).encode())
                    digests["distribution:" + name + ":" + package] = digest.hexdigest()
        yield adapter, filename, files[module][1], digests, imported_files, sorted(external_packages)
