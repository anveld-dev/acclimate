"""Framework-agnostic bundle skill extraction, prompt rendering, and lookup."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import re
from typing import TypedDict

from .delivery import DeliveryError, validate_payload
from .types import BundleFile, BundlePayload

_KEY_LINE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$", re.DOTALL)
_BLOCK_SCALAR = re.compile(r"^[>|](?:[-+][1-9]?|[1-9][-+]?)?(?:[ \t]+#.*)?[ \t]*$", re.DOTALL)
_QUOTED = re.compile(r'^(["\']).*\1$', re.DOTALL)


class SkillSummary(TypedDict):
    name: str
    description: str
    files: list[str]


@dataclass(frozen=True)
class BundleSkillFile:
    path: str
    text: str


@dataclass(frozen=True)
class BundleSkill:
    name: str
    description: str
    path: str
    text: str
    body: str
    files: tuple[BundleSkillFile, ...]


def _unquote(value: str) -> str | None:
    trimmed = value.rstrip(" \t")
    if _QUOTED.match(trimmed):
        return trimmed[1:-1]
    return None


def _parse_frontmatter(text: str) -> tuple[str | None, str | None, str]:
    normalized = text.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        return None, None, normalized
    rest = normalized[4:].split("\n")
    try:
        end = rest.index("---")
    except ValueError:
        return None, None, normalized

    entries: list[tuple[str, str, list[str]]] = []
    for line in rest[:end]:
        if not line.strip():
            if entries and _BLOCK_SCALAR.match(entries[-1][1].lstrip(" \t")):
                entries[-1][2].append("")
            continue
        if line.startswith("#"):
            continue
        if line.startswith((" ", "\t")):
            if entries:
                entries[-1][2].append(line)
            continue
        match = _KEY_LINE.match(line)
        if not match:
            continue
        entries.append((match.group(1), match.group(2), []))

    def read_scalar(key: str) -> str | None:
        for entry_key, entry_val, continuation in reversed(entries):
            if entry_key != key:
                continue
            inline = entry_val.lstrip(" \t")
            if _BLOCK_SCALAR.match(inline):
                non_empty = [ln for ln in continuation if ln.strip()]
                if not non_empty:
                    return None
                min_indent = min(len(ln) - len(ln.lstrip(" \t")) for ln in non_empty)
                dedented = [ln[min_indent:] if ln.strip() else "" for ln in continuation]
                if inline.startswith("|"):
                    joined = "\n".join(dedented).strip()
                    return joined or None
                joined = " ".join(ln.strip() for ln in dedented if ln.strip()).strip()
                return joined or None
            unquoted = _unquote(inline)
            scalar = (unquoted if unquoted is not None else inline).strip()
            return scalar or None
        return None

    body = "\n".join(rest[end + 1 :]).lstrip("\n")
    return read_scalar("name"), read_scalar("description"), body


def extract_bundle_skills(payload: BundlePayload) -> list[BundleSkill]:
    """Extract structured skills from a validated bundle payload."""
    validate_payload(payload)
    skill_files = [file for file in payload["files"] if file["kind"] == "skill"]
    grouped: dict[str, list[BundleFile]] = {}
    standalone: list[BundleFile] = []

    for file in skill_files:
        parts = file["path"].split("/")
        if parts[0] == "skills" and len(parts) >= 3 and parts[1]:
            grouped.setdefault(parts[1], []).append(file)
        else:
            standalone.append(file)

    skills: list[BundleSkill] = []
    for folder_name, files in grouped.items():
        manifest = next(
            (file for file in files if file["path"] == f"skills/{folder_name}/SKILL.md"),
            None,
        )
        if manifest is None:
            manifest = next(
                (
                    file
                    for file in files
                    if file["path"].lower() == f"skills/{folder_name.lower()}/skill.md"
                ),
                files[0],
            )
        name, description, body = _parse_frontmatter(manifest["text"])
        prefix = f"skills/{folder_name}/"
        supporting = tuple(
            BundleSkillFile(
                path=file["path"][len(prefix) :] if file["path"].startswith(prefix) else file["path"],
                text=file["text"],
            )
            for file in files
            if file["path"] != manifest["path"]
        )
        skills.append(
            BundleSkill(
                name=name or folder_name,
                description=description or "",
                path=manifest["path"],
                text=manifest["text"],
                body=body,
                files=supporting,
            )
        )

    for file in standalone:
        name, description, body = _parse_frontmatter(file["text"])
        stem = file["path"].rsplit("/", 1)[-1]
        if stem.lower().endswith(".md"):
            stem = stem[:-3]
        skills.append(
            BundleSkill(
                name=name or stem or file["path"],
                description=description or "",
                path=file["path"],
                text=file["text"],
                body=body,
                files=(),
            )
        )

    return skills


def select_approved_memory(
    payload: BundlePayload,
    approved_memory_paths: Sequence[str] | None = None,
) -> list[dict[str, str]]:
    """Return memory files filtered by ``approved_memory_paths``.

    When ``approved_memory_paths`` is ``None``, all memory files are returned.
    Raises ``DeliveryError('invalid_payload', ...)`` if any requested path is missing.
    """
    validate_payload(payload)
    memory_files = [file for file in payload["files"] if file["kind"] == "memory"]
    if approved_memory_paths is None:
        return [{"path": file["path"], "text": file["text"]} for file in memory_files]
    approved = set(approved_memory_paths)
    existing = {file["path"] for file in memory_files}
    for selected in approved_memory_paths:
        if selected not in existing:
            raise DeliveryError("invalid_payload", f"Approved memory not found: {selected}")
    return [
        {"path": file["path"], "text": file["text"]}
        for file in memory_files
        if file["path"] in approved
    ]


def render_bundle_prompt(
    payload: BundlePayload,
    *,
    include_skills: bool = True,
    approved_memory_paths: Sequence[str] | None = None,
) -> str:
    """Render a bundle payload as a system prompt with optional skill/memory filtering."""
    validate_payload(payload)
    approved_memory = select_approved_memory(payload, approved_memory_paths)
    sections: list[tuple[str, str]] = [
        (file["path"], file["text"])
        for file in payload["files"]
        if file["kind"] == "instruction"
    ]
    if include_skills:
        sections.extend(
            (file["path"], file["text"])
            for file in payload["files"]
            if file["kind"] == "skill"
        )
    sections.extend((file["path"], file["text"]) for file in approved_memory)
    return "\n\n".join(f"# {path}\n{text}" for path, text in sections)


class SkillLookup:
    """Progressive-disclosure skill lookup for application agent frameworks."""

    def __init__(self, payload: BundlePayload):
        self.skills: tuple[BundleSkill, ...] = tuple(extract_bundle_skills(payload))
        self._by_name: dict[str, BundleSkill] = {}
        for skill in self.skills:
            if skill.name in self._by_name:
                raise DeliveryError(
                    "invalid_payload", f"Duplicate skill name in bundle: {skill.name}"
                )
            self._by_name[skill.name] = skill

    def list_skills(self) -> list[SkillSummary]:
        return [
            {
                "name": skill.name,
                "description": skill.description,
                "files": [file.path for file in skill.files],
            }
            for skill in self.skills
        ]

    def read_skill(self, name: str, file_path: str | None = None) -> str:
        skill = self._by_name.get(name)
        if skill is None:
            raise DeliveryError("invalid_payload", f"Unknown skill: {name}")
        if not file_path or file_path == "SKILL.md":
            return skill.text
        for supporting in skill.files:
            if supporting.path == file_path:
                return supporting.text
        raise DeliveryError(
            "invalid_payload", f'Unknown skill file "{file_path}" in skill "{name}"'
        )
