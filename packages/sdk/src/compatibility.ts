import type { BundlePayload, CompatibilityTarget } from './types.js';

export interface CompatibilityIssue {
  code: string;
  path?: string;
  package?: string;
  message: string;
}

/** Native preparation rules only. Generic payload validation remains independent. */
export function compatibilityIssues(
  payload: BundlePayload,
  target: CompatibilityTarget,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (target === 'generic') return issues;
  if (!['codex', 'claude', 'pi', 'cursor'].includes(target))
    return [{ code: 'unknown_target', message: 'Unknown compatibility target' }];
  const add = (code: string, message: string, path?: string, packageName?: string) =>
    issues.push({
      code,
      ...(path === undefined ? {} : { path }),
      ...(packageName === undefined ? {} : { package: packageName }),
      message,
    });
  const instructions = payload.files.filter((file) => file.kind === 'instruction');
  if (instructions.length > 1)
    add('instruction_count', 'Native mapping supports at most one instruction file');
  const names = new Map<string, string>();
  const skills = payload.files.filter((file) => file.kind === 'skill');
  for (const file of skills) {
    const [root, name, child] = file.path.split('/');
    if (root !== 'skills' || !name || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || !child) {
      add('skill_path', 'Skill files require skills/<name>/<file>', file.path);
      continue;
    }
    if (target === 'cursor' && !/^[a-z0-9-]{1,64}$/.test(name))
      add(
        'skill_name',
        'Cursor skill names require lowercase letters, digits or hyphens',
        file.path,
        name,
      );
    const folded = name.toLowerCase();
    const existing = names.get(folded);
    if (existing && existing !== name)
      add('skill_case_collision', 'Skill names differ only by case', file.path, name);
    else names.set(folded, name);
  }
  for (const [folded, name] of names) {
    const manifest = skills.find((file) => file.path.toLowerCase() === `skills/${folded}/skill.md`);
    const manifestPath = `skills/${name}/SKILL.md`;
    if (!manifest || manifest.path !== manifestPath) {
      add(
        'skill_manifest',
        'Skill package requires an exact SKILL.md manifest',
        manifestPath,
        name,
      );
      continue;
    }
    const metadata = manifest.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const declaredName = metadata?.match(/^name:[ \t]*([A-Za-z0-9_-]{1,64})[ \t]*\r?$/m)?.[1];
    const description = metadata?.match(/^description:[ \t]*\S.+\r?$/m)?.[0];
    if (declaredName !== name || !description)
      add(
        'skill_metadata',
        'Skill metadata requires a matching name and description',
        manifest.path,
        name,
      );
  }
  return issues;
}

export function assertCompatible(payload: BundlePayload, target: CompatibilityTarget): void {
  const issues = compatibilityIssues(payload, target);
  if (issues.length) {
    const error = new Error(
      issues.map((issue) => `${issue.path ?? target}: ${issue.message}`).join('; '),
    );
    Object.assign(error, { code: 'invalid_payload', issues });
    throw error;
  }
}
