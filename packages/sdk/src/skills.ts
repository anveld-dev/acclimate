import type { BundleFile, BundlePayload } from './types.js';
import { DeliveryError, validatePayload } from './cache.js';

export interface BundleSkillFile {
  path: string;
  text: string;
}

export interface BundleSkill {
  name: string;
  description: string;
  path: string;
  text: string;
  body: string;
  files: BundleSkillFile[];
}

export interface RenderBundlePromptOptions {
  /** Include skill files in the rendered system prompt. Defaults to `true`. */
  includeSkills?: boolean;
  /**
   * Restrict included memory files to these bundle paths. When omitted, all
   * memory files are included (matching `systemPrompt`). Pass `[]` to omit all memory.
   */
  approvedMemoryPaths?: readonly string[];
}

export interface SkillSummary {
  name: string;
  description: string;
  files: string[];
}

export interface SkillLookup {
  readonly skills: readonly BundleSkill[];
  listSkills(): SkillSummary[];
  readSkill(name: string, filePath?: string): string;
}

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/s;
const BLOCK_SCALAR = /^[>|](?:[-+][1-9]?|[1-9][-+]?)?(?:[ \t]+#.*)?[ \t]*$/s;
const QUOTED = /^(["']).*\1$/s;

function unquote(value: string): string | undefined {
  const trimmed = value.replace(/[ \t]+$/, '');
  return QUOTED.test(trimmed) ? trimmed.slice(1, -1) : undefined;
}

function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    return { body: normalized };
  }
  const rest = normalized.slice(4).split('\n');
  const end = rest.indexOf('---');
  if (end < 0) {
    return { body: normalized };
  }
  const entries: Array<{ key: string; value: string; continuation: string[] }> = [];
  for (const line of rest.slice(0, end)) {
    if (/^\s*$/.test(line)) {
      const previous = entries.at(-1);
      if (previous && BLOCK_SCALAR.test(previous.value.replace(/^[ \t]+/, ''))) {
        previous.continuation.push('');
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const previous = entries.at(-1);
      if (previous) previous.continuation.push(line);
      continue;
    }
    const match = line.match(KEY_LINE);
    if (!match) continue;
    entries.push({ key: match[1]!, value: match[2]!, continuation: [] });
  }
  const readScalar = (key: string): string | undefined => {
    const entry = entries.filter((item) => item.key === key).at(-1);
    if (!entry) return undefined;
    const inline = entry.value.replace(/^[ \t]+/, '');
    if (BLOCK_SCALAR.test(inline)) {
      const nonEmpty = entry.continuation.filter((line) => /\S/.test(line));
      if (!nonEmpty.length) return undefined;
      const minIndent = Math.min(
        ...nonEmpty.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0),
      );
      const dedented = entry.continuation.map((line) =>
        /\S/.test(line) ? line.slice(minIndent) : '',
      );
      if (inline.startsWith('|')) {
        return dedented.join('\n').trim() || undefined;
      }
      return dedented
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .trim() || undefined;
    }
    return (unquote(inline) ?? inline).trim() || undefined;
  };
  const body = rest
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return {
    name: readScalar('name'),
    description: readScalar('description'),
    body,
  };
}

/**
 * Extract structured skills from a bundle payload.
 *
 * Skills under `skills/<name>/SKILL.md` are grouped with any supporting files
 * under `skills/<name>/...`. Standalone skill files without a `SKILL.md`
 * manifest are still represented using their path stem so generic bundles work
 * without failing.
 */
export function extractBundleSkills(payload: BundlePayload): BundleSkill[] {
  validatePayload(payload);
  const skillFiles = payload.files.filter((file) => file.kind === 'skill');
  const grouped = new Map<string, BundleFile[]>();
  const standalone: BundleFile[] = [];

  for (const file of skillFiles) {
    const parts = file.path.split('/');
    if (parts[0] === 'skills' && parts.length >= 3 && parts[1]) {
      const group = grouped.get(parts[1]) ?? [];
      group.push(file);
      grouped.set(parts[1], group);
    } else {
      standalone.push(file);
    }
  }

  const skills: BundleSkill[] = [];
  for (const [folderName, files] of grouped) {
    const manifest =
      files.find((file) => file.path === `skills/${folderName}/SKILL.md`) ??
      files.find((file) => file.path.toLowerCase() === `skills/${folderName.toLowerCase()}/skill.md`) ??
      files[0]!;
    const parsed = parseFrontmatter(manifest.text);
    const prefix = `skills/${folderName}/`;
    const supporting = files
      .filter((file) => file.path !== manifest.path)
      .map((file) => ({
        path: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
        text: file.text,
      }));
    skills.push({
      name: parsed.name ?? folderName,
      description: parsed.description ?? '',
      path: manifest.path,
      text: manifest.text,
      body: parsed.body,
      files: supporting,
    });
  }

  for (const file of standalone) {
    const parsed = parseFrontmatter(file.text);
    const fallbackName = file.path.split('/').at(-1)?.replace(/\.md$/i, '') || file.path;
    skills.push({
      name: parsed.name ?? fallbackName,
      description: parsed.description ?? '',
      path: file.path,
      text: file.text,
      body: parsed.body,
      files: [],
    });
  }

  return skills;
}

/**
 * Filter memory files from a bundle payload according to `approvedMemoryPaths`.
 * When `approvedMemoryPaths` is omitted, returns all memory files.
 * Throws `DeliveryError('invalid_payload', ...)` if any requested path is absent.
 */
export function selectApprovedMemory(
  payload: BundlePayload,
  approvedMemoryPaths?: readonly string[],
): Array<{ path: string; text: string }> {
  validatePayload(payload);
  const memoryFiles = payload.files.filter((file) => file.kind === 'memory');
  if (approvedMemoryPaths === undefined) {
    return memoryFiles.map((file) => ({ path: file.path, text: file.text }));
  }
  const approved = new Set(approvedMemoryPaths);
  for (const selected of approved) {
    if (!memoryFiles.some((file) => file.path === selected)) {
      throw new DeliveryError('invalid_payload', `Approved memory not found: ${selected}`);
    }
  }
  return memoryFiles
    .filter((file) => approved.has(file.path))
    .map((file) => ({ path: file.path, text: file.text }));
}

/**
 * Render a bundle payload as a system prompt with optional skill omission
 * (for progressive-disclosure skill tools) and explicit memory filtering.
 *
 * With default options (`includeSkills: true`, `approvedMemoryPaths: undefined`),
 * output is identical to `systemPrompt(payload)`.
 */
export function renderBundlePrompt(
  payload: BundlePayload,
  options: RenderBundlePromptOptions = {},
): string {
  validatePayload(payload);
  const includeSkills = options.includeSkills ?? true;
  const approvedMemory = selectApprovedMemory(payload, options.approvedMemoryPaths);
  const sections: BundleFile[] = [
    ...payload.files.filter((file) => file.kind === 'instruction'),
    ...(includeSkills ? payload.files.filter((file) => file.kind === 'skill') : []),
    ...approvedMemory.map((file): BundleFile => ({ path: file.path, kind: 'memory', text: file.text })),
  ];
  return sections.map((file) => `# ${file.path}\n${file.text}`).join('\n\n');
}

/**
 * Create a safe, framework-agnostic lookup over a bundle's skills so app-agent
 * frameworks can expose skills as progressive-disclosure tools (`list_skills` /
 * `read_skill`) without bloating the system prompt.
 */
export function createSkillLookup(payload: BundlePayload): SkillLookup {
  const skills = Object.freeze(extractBundleSkills(payload));
  const byName = new Map<string, BundleSkill>();
  for (const skill of skills) {
    if (byName.has(skill.name)) {
      throw new DeliveryError('invalid_payload', `Duplicate skill name in bundle: ${skill.name}`);
    }
    byName.set(skill.name, skill);
  }
  return {
    skills,
    listSkills() {
      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        files: skill.files.map((file) => file.path),
      }));
    },
    readSkill(name: string, filePath?: string): string {
      const skill = byName.get(name);
      if (!skill) {
        throw new DeliveryError('invalid_payload', `Unknown skill: ${name}`);
      }
      if (!filePath || filePath === 'SKILL.md') {
        return skill.text;
      }
      const supporting = skill.files.find((file) => file.path === filePath);
      if (!supporting) {
        throw new DeliveryError('invalid_payload', `Unknown skill file "${filePath}" in skill "${name}"`);
      }
      return supporting.text;
    },
  };
}
