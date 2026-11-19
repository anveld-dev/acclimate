import type { BundlePayload, CompatibilityTarget } from './types.js';

export interface CompatibilityIssue {
  code: string;
  path?: string;
  package?: string;
  message: string;
}

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/s;
const BLOCK_SCALAR = /^[>|](?:[-+][1-9]?|[1-9][-+]?)?(?:[ \t]+#.*)?[ \t]*$/s;
const QUOTED = /^(["']).*\1$/s;

/** Returns the text inside one pair of matching quotes, ignoring trailing spaces or tabs. */
function unquote(value: string): string | undefined {
  const trimmed = value.replace(/[ \t]+$/, '');
  return QUOTED.test(trimmed) ? trimmed.slice(1, -1) : undefined;
}

/** Explains why a SKILL.md frontmatter block is unusable, without quoting file text. */
function metadataProblem(text: string, name: string): string | undefined {
  const missing = 'SKILL.md must start with a --- frontmatter block closed by ---';
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return missing;
  const rest = normalized.slice(4).split('\n');
  const end = rest.indexOf('---');
  if (end < 0) return missing;
  const entries: Array<{ key: string; value: string; continuation: string[] }> = [];
  for (const [index, line] of rest.slice(0, end).entries()) {
    if (/^\s*$/.test(line) || line.startsWith('#')) continue;
    const lineNumber = index + 2;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const previous = entries.at(-1);
      if (!previous)
        return `SKILL.md frontmatter line ${lineNumber} is indented but follows no key`;
      previous.continuation.push(line);
      continue;
    }
    const key = line.match(KEY_LINE);
    if (!key)
      return `SKILL.md frontmatter line ${lineNumber} is not a key, an indented continuation, a comment or blank`;
    entries.push({ key: key[1]!, value: key[2]!, continuation: [] });
  }
  const names = entries.filter((entry) => entry.key === 'name');
  if (names.length !== 1)
    return `SKILL.md frontmatter needs exactly one name: ${name} (found ${names.length} name keys)`;
  const declaredValue = names[0]!.value.replace(/^[ \t]+/, '');
  const declared = unquote(declaredValue) ?? declaredValue.replace(/[ \t]+$/, '');
  if (declared !== name)
    return SAFE_NAME.test(declared)
      ? `SKILL.md frontmatter needs exactly one name: ${name} (found "${declared}")`
      : `SKILL.md frontmatter needs exactly one name: ${name}`;
  const descriptions = entries.filter((entry) => entry.key === 'description');
  if (descriptions.length !== 1)
    return `SKILL.md frontmatter needs exactly one non-empty description (found ${descriptions.length})`;
  const description = descriptions[0]!;
  const inline = description.value.replace(/^[ \t]+/, '');
  if (BLOCK_SCALAR.test(inline)) {
    if (!description.continuation.some((line) => /\S/.test(line)))
      return 'SKILL.md frontmatter needs exactly one non-empty description; the block scalar has no indented text';
    return undefined;
  }
  const value = unquote(inline) ?? inline;
  if (!/^\S/.test(value) || value.length < 2)
    return 'SKILL.md frontmatter needs exactly one non-empty description of at least 2 characters';
  return undefined;
}

/** Native preparation rules only. Generic payload validation remains independent. */
export function compatibilityIssues(
  payload: BundlePayload,
  target: CompatibilityTarget,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (target === 'generic') return issues;
  if (!['codex', 'claude', 'pi', 'cursor'].includes(target))
    return [
      {
        code: 'unknown_target',
        message: 'Unknown compatibility target; use generic, codex, claude, pi or cursor',
      },
    ];
  const add = (code: string, message: string, path?: string, packageName?: string) =>
    issues.push({
      code,
      ...(path === undefined ? {} : { path }),
      ...(packageName === undefined ? {} : { package: packageName }),
      message,
    });
  const instructions = payload.files.filter((file) => file.kind === 'instruction');
  if (instructions.length > 1)
    add(
      'instruction_count',
      `Native mapping supports at most one instruction file; found ${instructions.length}: ${instructions.map((file) => file.path).join(', ')}`,
    );
  const names = new Map<string, string>();
  const skills = payload.files.filter((file) => file.kind === 'skill');
  for (const file of skills) {
    const [root, name, child] = file.path.split('/');
    if (root !== 'skills' || !name || !SAFE_NAME.test(name) || !child) {
      add(
        'skill_path',
        'Skill files must be under skills/<name>/<file>, where <name> uses letters, digits, _ or - (max 64)',
        file.path,
      );
      continue;
    }
    if (target === 'cursor' && !/^[a-z0-9-]{1,64}$/.test(name))
      add(
        'skill_name',
        `Cursor skill names require lowercase letters, digits or - (max 64); rename "${name}"`,
        file.path,
        name,
      );
    const folded = name.toLowerCase();
    const existing = names.get(folded);
    if (existing && existing !== name)
      add(
        'skill_case_collision',
        `Skill names differ only by case: "${name}" and "${existing}"; use one spelling`,
        file.path,
        name,
      );
    else names.set(folded, name);
  }
  for (const [folded, name] of names) {
    const manifest = skills.find((file) => file.path.toLowerCase() === `skills/${folded}/skill.md`);
    const manifestPath = `skills/${name}/SKILL.md`;
    if (!manifest || manifest.path !== manifestPath) {
      add(
        'skill_manifest',
        `Skill package requires an exact SKILL.md manifest at ${manifestPath}${manifest ? ` (found ${manifest.path})` : ''}`,
        manifestPath,
        name,
      );
      continue;
    }
    const problem = metadataProblem(manifest.text, name);
    if (problem) add('skill_metadata', problem, manifest.path, name);
  }
  return issues;
}

export function assertCompatible(payload: BundlePayload, target: CompatibilityTarget): void {
  const issues = compatibilityIssues(payload, target);
  if (issues.length) {
    const error = new Error(
      issues.map((issue) => `${issue.path ?? target}: [${issue.code}] ${issue.message}`).join('; '),
    );
    Object.assign(error, { code: 'invalid_payload', issues });
    throw error;
  }
}
