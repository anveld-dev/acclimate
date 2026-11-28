"""Acclimate integration for the Python Claude Agent SDK (`claude-agent-sdk`)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import errno
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from typing import Any

from ..delivery import DeliveryError, validate_payload
from ..skills import select_approved_memory
from ..types import DeliveryReceiptRequest, VerifiedVersion
from . import DeliveryInput, run_cleanup_async, unwrap_source

CLAUDE_PROJECT_OVERLAY: tuple[str, ...] = (
    ".claude/settings.json",
    ".claude/agents",
    ".claude/commands",
    ".claude/hooks",
    ".claude/output-styles",
    ".mcp.json",
)

_SAFE_SKILL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_KEY_LINE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$", re.DOTALL)
_BLOCK_SCALAR = re.compile(r"^[>|](?:[-+][1-9]?|[1-9][-+]?)?(?:[ \t]+#.*)?[ \t]*$", re.DOTALL)
_QUOTED = re.compile(r'^(["\']).*\1$', re.DOTALL)
_OVERLAY_MAX_FILES = 256
_OVERLAY_MAX_BYTES = 1024 * 1024
_OVERLAY_MAX_DEPTH = 16


def _unquote(value: str) -> str | None:
    trimmed = value.rstrip(" \t")
    if _QUOTED.match(trimmed):
        return trimmed[1:-1]
    return None


def _metadata_problem(text: str, name: str) -> str | None:
    """Validate SKILL.md frontmatter, matching `packages/sdk/src/compatibility.ts`."""
    missing = "SKILL.md must start with a --- frontmatter block closed by ---"
    normalized = text.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        return missing
    rest = normalized[4:].split("\n")
    try:
        end = rest.index("---")
    except ValueError:
        return missing
    entries: list[tuple[str, str, list[str]]] = []
    for index, line in enumerate(rest[:end]):
        if not line.strip() or line.startswith("#"):
            continue
        line_number = index + 2
        if line.startswith((" ", "\t")):
            if not entries:
                return f"SKILL.md frontmatter line {line_number} is indented but follows no key"
            entries[-1][2].append(line)
            continue
        match = _KEY_LINE.match(line)
        if not match:
            return (
                f"SKILL.md frontmatter line {line_number} is not a key, "
                "an indented continuation, a comment or blank"
            )
        entries.append((match.group(1), match.group(2), []))

    names = [entry for entry in entries if entry[0] == "name"]
    if len(names) != 1:
        return f"SKILL.md frontmatter needs exactly one name: {name} (found {len(names)} name keys)"
    declared_value = names[0][1].lstrip(" \t")
    unquoted_name = _unquote(declared_value)
    declared = unquoted_name if unquoted_name is not None else declared_value.rstrip(" \t")
    if declared != name:
        if _SAFE_SKILL_NAME.match(declared):
            return f'SKILL.md frontmatter needs exactly one name: {name} (found "{declared}")'
        return f"SKILL.md frontmatter needs exactly one name: {name}"

    descriptions = [entry for entry in entries if entry[0] == "description"]
    if len(descriptions) != 1:
        return f"SKILL.md frontmatter needs exactly one non-empty description (found {len(descriptions)})"
    inline = descriptions[0][1].lstrip(" \t")
    if _BLOCK_SCALAR.match(inline):
        if not any(line.strip() for line in descriptions[0][2]):
            return (
                "SKILL.md frontmatter needs exactly one non-empty description; "
                "the block scalar has no indented text"
            )
        return None
    unquoted_desc = _unquote(inline)
    value = unquoted_desc if unquoted_desc is not None else inline
    if not value or value[0].isspace() or len(value) < 2:
        return "SKILL.md frontmatter needs exactly one non-empty description of at least 2 characters"
    return None


def _validate_claude_compatibility(verified: VerifiedVersion) -> None:
    payload = verified["payload"]
    validate_payload(payload)
    instructions = [file for file in payload["files"] if file["kind"] == "instruction"]
    if len(instructions) > 1:
        paths = ", ".join(file["path"] for file in instructions)
        raise DeliveryError(
            "invalid_payload",
            f"Native mapping supports at most one instruction file; found {len(instructions)}: {paths}",
        )
    seen_names: dict[str, str] = {}
    skills = [file for file in payload["files"] if file["kind"] == "skill"]
    for file in skills:
        parts = file["path"].split("/")
        if len(parts) < 3 or parts[0] != "skills" or not _SAFE_SKILL_NAME.match(parts[1]):
            raise DeliveryError(
                "invalid_payload",
                f"{file['path']}: [skill_path] Skill files must be under skills/<name>/<file>",
            )
        name = parts[1]
        folded = name.lower()
        existing = seen_names.get(folded)
        if existing and existing != name:
            raise DeliveryError(
                "invalid_payload",
                f'{file["path"]}: [skill_case_collision] Skill names differ only by case: "{name}" and "{existing}"',
            )
        seen_names[folded] = name
    for folded, name in seen_names.items():
        manifest_path = f"skills/{name}/SKILL.md"
        manifest = next(
            (file for file in skills if file["path"].lower() == f"skills/{folded}/skill.md"),
            None,
        )
        if manifest is None or manifest["path"] != manifest_path:
            raise DeliveryError(
                "invalid_payload",
                f"{manifest_path}: [skill_manifest] Skill package requires an exact SKILL.md manifest at {manifest_path}",
            )
        problem = _metadata_problem(manifest["text"], name)
        if problem:
            raise DeliveryError("invalid_payload", f"{manifest['path']}: [skill_metadata] {problem}")


def _open_dir_nofollow(absolute_dir: str) -> int:
    """Open an absolute directory by traversing every component with O_NOFOLLOW."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for segment in Path(absolute_dir).parts[1:]:
            try:
                child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise DeliveryError(
                        "unsafe_path",
                        f"base_dir contains a symlink or non-directory: {absolute_dir}",
                    ) from exc
                raise
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _copy_overlay(root: str, base_dir: str, paths: Sequence[str]) -> list[dict[str, Any]]:
    """Copy allowlisted project files without following symlinks at any path component."""
    if not os.path.isabs(base_dir):
        raise DeliveryError("unsafe_destination", f"base_dir must be absolute: {base_dir}")
    copied: list[dict[str, Any]] = []
    base_fd = _open_dir_nofollow(base_dir)

    def copy_from_fd(dir_fd: int, name: str, relative: str, depth: int = 0) -> None:
        if depth > _OVERLAY_MAX_DEPTH:
            raise DeliveryError("invalid_payload", f"Overlay exceeds maximum nesting depth at {relative}")
        try:
            info = os.lstat(name, dir_fd=dir_fd)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)
        ):
            raise DeliveryError(
                "unsafe_path", f"Overlay path is a symlink or special file: {relative}"
            )
        if stat.S_ISDIR(info.st_mode):
            try:
                child_fd = os.open(
                    name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd
                )
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise DeliveryError(
                        "unsafe_path", f"Overlay path is a symlink or special file: {relative}"
                    ) from exc
                raise
            try:
                for entry in sorted(os.listdir(child_fd)):
                    copy_from_fd(child_fd, entry, f"{relative}/{entry}", depth + 1)
            finally:
                os.close(child_fd)
            return

        try:
            open_flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
            file_fd = os.open(name, open_flags, dir_fd=dir_fd)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise DeliveryError(
                    "unsafe_path", f"Overlay path is a symlink or special file: {relative}"
                ) from exc
            raise
        try:
            finfo = os.fstat(file_fd)
            if not stat.S_ISREG(finfo.st_mode):
                raise DeliveryError(
                    "unsafe_path", f"Overlay path is a symlink or special file: {relative}"
                )
            if finfo.st_size > _OVERLAY_MAX_BYTES or len(copied) >= _OVERLAY_MAX_FILES:
                raise DeliveryError(
                    "invalid_payload", f"Overlay exceeds its file or size limit at {relative}"
                )
            with os.fdopen(file_fd, "rb") as handle:
                file_fd = -1
                data = handle.read(_OVERLAY_MAX_BYTES + 1)
            if len(data) > _OVERLAY_MAX_BYTES:
                raise DeliveryError(
                    "invalid_payload", f"Overlay exceeds its file or size limit at {relative}"
                )
        finally:
            if file_fd >= 0:
                os.close(file_fd)

        target = os.path.join(root, *relative.split("/"))
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        mode = 0o600 | (finfo.st_mode & 0o100)
        out_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(out_fd, "wb") as out:
            out.write(data)
        copied.append(
            {
                "path": relative,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
        )

    try:
        for relative in paths:
            parts = relative.split("/")
            if (
                not relative
                or os.path.isabs(relative)
                or any(not part or part in (".", "..") for part in parts)
            ):
                raise DeliveryError("unsafe_path", f"Overlay paths must be relative: {relative}")
            current_fd = os.dup(base_fd)
            try:
                traversed: list[str] = []
                missing_ancestor = False
                for segment in parts[:-1]:
                    traversed.append(segment)
                    try:
                        next_fd = os.open(
                            segment,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=current_fd,
                        )
                    except FileNotFoundError:
                        missing_ancestor = True
                        break
                    except OSError as exc:
                        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                            raise DeliveryError(
                                "unsafe_path",
                                f"Overlay ancestor is a symlink or non-directory: {'/'.join(traversed)}",
                            ) from exc
                        raise
                    os.close(current_fd)
                    current_fd = next_fd
                if not missing_ancestor:
                    copy_from_fd(current_fd, parts[-1], relative)
            finally:
                os.close(current_fd)
    finally:
        os.close(base_fd)
    return copied


class PreparedClaudeVersion:
    """Staged private Claude Agent SDK workspace with `CLAUDE.md` and `.claude/skills/`."""

    def __init__(
        self,
        *,
        cwd: str,
        version_id: str,
        digest: str,
        instruction_path: str | None,
        skill_paths: list[str],
        memory_files: list[dict[str, str]],
        overlay_files: list[dict[str, Any]],
        report_started: Callable[[], DeliveryReceiptRequest | None],
        release: Callable[[], None],
    ):
        self._root = cwd
        self.cwd = cwd
        self.version_id = version_id
        self.digest = digest
        self.setting_sources: list[str] = ["project"]
        self.instruction_path = instruction_path
        self.skill_paths = skill_paths
        self.memory_files = memory_files
        self.overlay_files = overlay_files
        self._report_started = report_started
        self._release = release
        self._dir_removed = False
        self._released = False

    def report_started(self) -> DeliveryReceiptRequest | None:
        return self._report_started()

    def cleanup(self) -> None:
        if not self._dir_removed:
            try:
                shutil.rmtree(self._root)
            except FileNotFoundError:
                pass
            self._dir_removed = True
        if not self._released:
            self._release()
            self._released = True

    async def acleanup(self) -> None:
        await run_cleanup_async(self.cleanup)

    def __enter__(self) -> PreparedClaudeVersion:
        return self

    def __exit__(self, *args: Any) -> None:
        self.cleanup()

    async def __aenter__(self) -> PreparedClaudeVersion:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.acleanup()


def prepare(
    source: DeliveryInput,
    *,
    base_dir: str | Path | None = None,
    approved_memory_paths: Sequence[str] | None = None,
) -> PreparedClaudeVersion:
    """Stage verified bundle instructions and skills for a fresh Python Claude Agent SDK session.

    When ``approved_memory_paths`` is provided, only those memory files are staged
    and returned (raising ``DeliveryError`` for unknown paths).
    """
    if os.name != "posix":
        raise DeliveryError("unsupported_platform", "Private filesystem helpers require POSIX")
    verified, report_started, release = unwrap_source(source)
    _validate_claude_compatibility(verified)
    approved_memory = (
        {item["path"] for item in select_approved_memory(verified["payload"], approved_memory_paths)}
        if approved_memory_paths is not None
        else None
    )

    root = tempfile.mkdtemp(prefix="acclimate-claude-", dir=os.path.realpath(tempfile.gettempdir()))
    os.chmod(root, 0o700)
    overlay_files: list[dict[str, Any]] = []
    instruction_path: str | None = None
    skill_paths: list[str] = []
    memory_files: list[dict[str, str]] = []

    try:
        if base_dir is not None:
            overlay_files = _copy_overlay(root, str(base_dir), CLAUDE_PROJECT_OVERLAY)
        for file in verified["payload"]["files"]:
            if file["kind"] == "memory" and approved_memory is not None and file["path"] not in approved_memory:
                continue
            if file["kind"] == "instruction":
                mapped = "CLAUDE.md"
            elif file["kind"] == "skill":
                mapped = "/".join([".claude/skills", *file["path"].split("/")[1:]])
            else:
                mapped = "/".join([".acclimate/memory", *file["path"].split("/")])
            absolute = os.path.join(root, *mapped.split("/"))
            os.makedirs(os.path.dirname(absolute), mode=0o700, exist_ok=True)
            try:
                fd = os.open(absolute, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError as exc:
                raise DeliveryError(
                    "invalid_payload",
                    f"Bundle file {file['path']} collides with overlay file {mapped}",
                ) from exc
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as out:
                out.write(file["text"])
            if file["kind"] == "instruction":
                instruction_path = absolute
            elif file["kind"] == "skill" and mapped.endswith("/SKILL.md"):
                skill_paths.append(absolute)
            elif file["kind"] == "memory":
                memory_files.append(
                    {"path": file["path"], "text": file["text"], "absolutePath": absolute}
                )
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise

    return PreparedClaudeVersion(
        cwd=root,
        version_id=verified["version"]["id"],
        digest=verified["version"]["digest"],
        instruction_path=instruction_path,
        skill_paths=skill_paths,
        memory_files=memory_files,
        overlay_files=overlay_files,
        report_started=report_started,
        release=release,
    )


def claude_session_options(prepared: PreparedClaudeVersion) -> dict[str, Any]:
    """Return kwargs suitable for `ClaudeAgentOptions(**claude_session_options(prepared))`.

    `skills` is omitted when the bundle has none because an empty list disables
    every skill in the Claude Agent SDK.
    """
    skills = [Path(file).parent.name for file in prepared.skill_paths]
    options: dict[str, Any] = {
        "cwd": prepared.cwd,
        "setting_sources": list(prepared.setting_sources),
    }
    if skills:
        options["skills"] = skills
    return options


__all__ = [
    "CLAUDE_PROJECT_OVERLAY",
    "PreparedClaudeVersion",
    "prepare",
    "claude_session_options",
]
