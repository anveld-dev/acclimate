import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SOURCE_POLICY = 'repository-source-policy-v1';
export const LIMITS = Object.freeze({
  sourceFiles: 1000,
  sourceFileBytes: 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
  resultFiles: 100,
  resultFileBytes: 1024 * 1024,
  resultBytes: 8 * 1024 * 1024,
  patchBytes: 1024 * 1024,
  inlineOutputBytes: 64 * 1024,
  privateOutputBytes: 8 * 1024 * 1024,
  sourceManifestBytes: 1024 * 1024,
  jobBytes: 64 * 1024,
  workspaceEntries: 20_000,
  reportedPaths: 50,
  failureMessageBytes: 8 * 1024,
  testLogBytes: 256 * 1024,
});
const MARKER = '.acclimate/native-job-owner.json';
/** Prepared native resources and tool state that are never agent results. */
const CONTROL_ENTRIES = new Set(['.acclimate', '.agents', '.claude', '.cursor', '.codex', '.pi', '.git', 'agents.md', 'claude.md']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const uid = () => process.getuid?.();
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Every native failure carries a stable `code`. When a specific path or rule
 * caused it, the message names both, e.g. `native.control_path: ".gitignore" (…)`.
 */
export class NativeRepositoryError extends Error {
  constructor(code, detail = {}) {
    const { path: subject, rule, hint } = detail;
    super(
      code +
        (subject === undefined ? '' : `: ${JSON.stringify(subject)}`) +
        (rule ? ` (${rule})` : '') +
        (hint ? `. ${hint}` : ''),
    );
    this.name = 'NativeRepositoryError';
    this.code = code;
    if (subject !== undefined) this.path = subject;
    if (rule) this.rule = rule;
    if (hint) this.hint = hint;
  }
}
const fail = (code, detail) => {
  throw new NativeRepositoryError(code, detail);
};
const jsonBytes = (value) => Buffer.from(JSON.stringify(value) + '\n');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const overlap = (a, b) => inside(a, b) || inside(b, a);
function immutable(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
function text(bytes, subject) {
  try {
    const result = decoder.decode(bytes);
    if (result.includes('\0')) fail('native.nontext_file', { path: subject, rule: 'contains a NUL byte' });
    return result;
  } catch (error) {
    if (error instanceof NativeRepositoryError) throw error;
    fail('native.nontext_file', { path: subject, rule: 'not valid UTF-8 text' });
  }
}

const GLOB_SEGMENT = /^[-A-Za-z0-9._*]+$/;
const isPattern = (name) => name.includes('*');
function segmentExpression(segment) {
  return new RegExp(
    '^' + segment.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&')).join('[^/]*') + '$',
  );
}
/**
 * Match a portable relative path against a result pattern. `*` matches within one
 * segment and `**` matches zero or more whole segments. Wildcards never match
 * dot-prefixed segments, so `src/**` cannot select `src/.env`.
 */
export function matchesPattern(pattern, file) {
  const expected = pattern.split('/');
  const actual = file.split('/');
  const walk = (i, j) => {
    if (i === expected.length) return j === actual.length;
    if (expected[i] === '**') {
      for (let k = j; k <= actual.length; k++) {
        if (k > j && actual[k - 1].startsWith('.')) break;
        if (walk(i + 1, k)) return true;
      }
      return false;
    }
    if (j >= actual.length) return false;
    if (actual[j].startsWith('.') && !expected[i].startsWith('.')) return false;
    return segmentExpression(expected[i]).test(actual[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}
export const matchesAny = (patterns, file) => patterns.some((pattern) => pattern === file || (isPattern(pattern) && matchesPattern(pattern, file)));

/**
 * Validate a portable path inventory. `allowDotPaths` admits exact dot-prefixed
 * paths such as `.eslintrc` or `.npmrc`; `.git`, native control directories,
 * AGENTS.md and CLAUDE.md stay rejected. `patterns: true` admits `*` and `**`.
 */
export function validateInventory(paths, maximum = LIMITS.sourceFiles, options = {}) {
  const { allowDotPaths = [], patterns = false } = options;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > maximum)
    fail('native.inventory_limit', {
      rule: `list between 1 and ${maximum} paths; received ${Array.isArray(paths) ? paths.length : typeof paths}`,
    });
  const dotted = new Set(allowDotPaths);
  const seen = new Set();
  for (const name of paths) {
    if (typeof name !== 'string' || !name || name.length > 240 || !/^[-A-Za-z0-9._/*]+$/.test(name))
      fail('native.unsafe_path', {
        path: typeof name === 'string' ? name.slice(0, 240) : String(name),
        rule: 'use a relative path of letters, digits, ., _, - and / (at most 240 characters)',
      });
    if (isPattern(name) && !patterns)
      fail('native.unsafe_path', { path: name, rule: 'wildcards are accepted only in resultFiles' });
    for (const segment of name.split('/')) {
      if (!segment || segment === '.' || segment === '..')
        fail('native.unsafe_path', { path: name, rule: 'empty, . or .. path segment' });
      if (isPattern(segment) && (!GLOB_SEGMENT.test(segment) || (segment.includes('**') && segment !== '**')))
        fail('native.unsafe_path', { path: name, rule: '** must be a whole path segment' });
      if (CONTROL_ENTRIES.has(segment.toLowerCase()))
        fail('native.control_path', {
          path: name,
          rule: `${segment} is a native control path; the bundle supplies instructions and skills`,
        });
      if (segment.startsWith('.') && !dotted.has(name))
        fail('native.control_path', {
          path: name,
          rule: 'dot-prefixed segment',
          hint: 'Add the exact path to allowDotPaths in native.json if the agent or grader needs it',
        });
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))
        fail('native.control_path', { path: name, rule: 'reserved device name' });
    }
    const key = name.toLowerCase();
    if (seen.has(key)) fail('native.path_collision', { path: name, rule: 'listed twice or differs only by case' });
    seen.add(key);
  }
  for (const name of seen) {
    if (isPattern(name)) continue;
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (seen.has(prefix))
        fail('native.path_collision', { path: prefix, rule: `is both a file and the directory of ${name}` });
    }
  }
  return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * Generate a source inventory from `git ls-files` plus include/exclude globs.
 * Paths that the source policy rejects are skipped and reported, never copied.
 */
export async function discoverSourceFiles({ sourceRoot, include = ['**'], exclude = [], allowDotPaths = [] }) {
  validateInventory(include, LIMITS.sourceFiles, { patterns: true, allowDotPaths: include.filter((name) => name.startsWith('.')) });
  if (exclude.length) validateInventory(exclude, LIMITS.sourceFiles, { patterns: true, allowDotPaths: exclude.filter((name) => name.startsWith('.')) });
  const listed = await new Promise((resolve, reject) => {
    execFile('git', ['-C', sourceRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    }, (error, stdout) => {
      if (error) reject(new NativeRepositoryError('native.source_discovery', {
        path: sourceRoot, rule: 'git ls-files failed', hint: 'Set sourceFiles explicitly or run inside a Git checkout',
      }));
      else resolve(stdout.split('\0').filter(Boolean));
    });
  });
  const files = [];
  const skipped = [];
  // Wildcards never select dot paths; match a dot-free spelling so they can be reported.
  const undotted = (name) => name.split('/').map((segment) => segment.replace(/^\./, '_')).join('/');
  for (const name of listed.sort()) {
    const selected = allowDotPaths.includes(name) || (matchesAny(include, undotted(name)) && !matchesAny(exclude, name));
    if (!selected) continue;
    try {
      validateInventory([name], 1, { allowDotPaths });
      files.push(name);
    } catch (error) {
      if (!(error instanceof NativeRepositoryError)) throw error;
      skipped.push({ path: name, code: error.code, rule: error.rule });
    }
  }
  if (files.length > LIMITS.sourceFiles)
    fail('native.inventory_limit', {
      rule: `git ls-files selected ${files.length} files; the limit is ${LIMITS.sourceFiles}`,
      hint: 'Narrow sourceInventory.include or add sourceInventory.exclude globs',
    });
  return { files, skipped };
}

async function canonicalDirectory(input, { private: isPrivate = false, create = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.resolve(input) !== input)
    fail('native.unsafe_directory', { path: String(input), rule: 'not an absolute normalized path' });
  let cursor = path.parse(input).root;
  for (const part of input.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (!create || error.code !== 'ENOENT')
        fail('native.unsafe_directory', { path: cursor, rule: error.code === 'ENOENT' ? 'does not exist' : `cannot be read (${error.code})` });
      await mkdir(cursor, { mode: 0o700 });
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink())
      fail('native.unsafe_directory', {
        path: cursor,
        rule: 'symlink in path',
        hint: `Use the real path instead: ${await realpath(cursor).catch(() => '(unresolvable)')} (on macOS /tmp and /var are symlinks to /private)`,
      });
    if (!info.isDirectory()) fail('native.unsafe_directory', { path: cursor, rule: 'not a directory' });
  }
  const info = await lstat(input);
  if ((await realpath(input)) !== input)
    fail('native.unsafe_directory', { path: input, rule: 'not canonical', hint: `Use ${await realpath(input)}` });
  if (uid() !== undefined && info.uid !== uid())
    fail('native.unsafe_directory', { path: input, rule: 'owned by another user' });
  if (isPrivate ? (info.mode & 0o777) !== 0o700 : !!(info.mode & 0o022))
    fail('native.unsafe_directory', {
      path: input,
      rule: isPrivate ? `mode ${(info.mode & 0o777).toString(8)} is not 700` : 'group or world writable',
      hint: isPrivate ? `Run chmod 700 ${input}` : undefined,
    });
  return input;
}

async function safeRead(root, relative, maximum) {
  const segments = relative.split('/');
  let cursor = root;
  for (const part of segments.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail('native.unsafe_path', { path: relative, rule: 'a parent is a symlink or not a directory' });
  }
  const filename = path.join(root, ...segments);
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink())
    fail('native.unsafe_file', { path: relative, rule: before.isSymbolicLink() ? 'symlink' : 'not a regular file' });
  if (before.size > maximum)
    fail('native.unsafe_file', { path: relative, rule: `larger than ${maximum} bytes` });
  if (uid() !== undefined && before.uid !== uid())
    fail('native.unsafe_file', { path: relative, rule: 'owned by another user' });
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > maximum)
      fail('native.unsafe_file', { path: relative, rule: 'replaced while opening' });
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > maximum ||
      after.size !== length ||
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs
    )
      fail('native.file_changed_or_large', { path: relative, rule: 'changed while reading or too large' });
    return { bytes: buffer.subarray(0, length), mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exclusiveWrite(root, relative, bytes, mode = 0o600) {
  const parts = relative.split('/');
  let current = root;
  for (const segment of parts.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail('native.unsafe_directory', { path: relative, rule: 'a parent is a symlink or not a directory' });
  }
  const filename = path.join(root, ...parts);
  const handle = await open(
    filename,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filename));
}

async function atomicJob(directory, value) {
  const bytes = jsonBytes(value);
  if (bytes.length > LIMITS.jobBytes) fail('native.job_record_limit');
  const temporary = `job-${randomUUID()}.tmp`;
  await exclusiveWrite(directory, temporary, bytes);
  try {
    const info = await lstat(path.join(directory, 'job.json')).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      info &&
      (!info.isFile() ||
        info.isSymbolicLink() ||
        info.mode & 0o077 ||
        (uid() !== undefined && info.uid !== uid()))
    )
      fail('native.unsafe_job_record');
    await rename(path.join(directory, temporary), path.join(directory, 'job.json'));
    await syncDirectory(directory);
  } finally {
    await rm(path.join(directory, temporary), { force: true });
  }
}

export async function freezeSourceInventory({ sourceRoot, paths, revision, allowDotPaths = [] }) {
  await canonicalDirectory(sourceRoot);
  if (typeof revision !== 'string' || !revision.trim() || Buffer.byteLength(revision) > 1024)
    fail('native.source_revision', { rule: 'sourceRevision must be 1 to 1024 bytes of text' });
  const files = [];
  let total = 0;
  for (const relative of validateInventory(paths, LIMITS.sourceFiles, { allowDotPaths })) {
    let captured;
    try {
      captured = await safeRead(sourceRoot, relative, LIMITS.sourceFileBytes);
    } catch (error) {
      if (error instanceof NativeRepositoryError) throw error;
      fail('native.source_unavailable', {
        path: relative,
        rule: error.code === 'ENOENT' ? 'listed in sourceFiles but missing from sourceRoot' : `cannot be read (${error.code})`,
      });
    }
    text(captured.bytes, relative);
    total += captured.bytes.length;
    if (total > LIMITS.sourceBytes)
      fail('native.source_limit', { path: relative, rule: `source inventory exceeds ${LIMITS.sourceBytes} bytes` });
    files.push({
      path: relative,
      sha256: sha256(captured.bytes),
      bytes: captured.bytes.length,
      mode: captured.mode,
      dataBase64: captured.bytes.toString('base64'),
    });
  }
  const manifest = {
    schemaVersion: 1,
    policy: SOURCE_POLICY,
    revision,
    ...(allowDotPaths.length ? { allowDotPaths: [...allowDotPaths].sort() } : {}),
    files: files.map(({ dataBase64, ...entry }) => entry),
  };
  const encoded = jsonBytes(manifest);
  if (encoded.length > LIMITS.sourceManifestBytes) fail('native.source_manifest_limit');
  return immutable({ sourceRoot, manifest, sha256: sha256(encoded), files });
}

function validateFrozenSource(source) {
  if (!source || source.manifest?.policy !== SOURCE_POLICY || !Array.isArray(source.files))
    fail('native.source_snapshot_invalid');
  validateInventory(source.files.map((file) => file.path), LIMITS.sourceFiles, {
    allowDotPaths: source.manifest.allowDotPaths ?? [],
  });
  let total = 0;
  for (const file of source.files) {
    const bytes = Buffer.from(file.dataBase64, 'base64');
    if (
      bytes.length !== file.bytes ||
      bytes.length > LIMITS.sourceFileBytes ||
      sha256(bytes) !== file.sha256
    )
      fail('native.source_snapshot_invalid');
    total += bytes.length;
  }
  const manifest = {
    ...source.manifest,
    files: source.files.map(({ dataBase64, ...entry }) => entry),
  };
  if (
    total > LIMITS.sourceBytes ||
    sha256(jsonBytes(manifest)) !== source.sha256 ||
    JSON.stringify(manifest) !== JSON.stringify(source.manifest)
  )
    fail('native.source_snapshot_invalid');
}

function validateContext(context, bundle) {
  if (
    !context ||
    !/^[a-f0-9]{64}$/.test(context.jobId) ||
    !['parent', 'candidate'].includes(context.side) ||
    !context.requestId ||
    !context.attemptId ||
    !path.isAbsolute(context.privateJobDirectory) ||
    !bundle?.version?.id ||
    !bundle.version.digest
  )
    fail('native.execution_context');
}

async function prepareEffectiveContext(prepared, selected) {
  const original = prepared.memoryFiles ?? [];
  const available = new Set(original.map((file) => file.path));
  if (
    !Array.isArray(selected) ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => typeof name !== 'string' || !available.has(name))
  )
    fail('native.memory_selection', {
      path: Array.isArray(selected) ? selected.find((name) => !available.has(name)) : undefined,
      rule: 'approvedMemoryPaths must list distinct memory paths present in the bundle',
    });
  const approved = new Set(selected);
  for (const file of original) {
    if (!inside(prepared.cwd, file.absolutePath))
      fail('native.prepared_path', { path: file.path, rule: 'prepared memory file is outside the workspace' });
    if (!approved.has(file.path)) {
      const relative = path.relative(prepared.cwd, file.absolutePath).split(path.sep).join('/');
      await safeRead(prepared.cwd, relative, LIMITS.sourceFileBytes);
      await rm(file.absolutePath);
    }
  }
  const memoryFiles = original
    .filter((file) => approved.has(file.path))
    .map((file) => ({ ...file }));
  const resources = prepared.resources
    ?.filter((resource) => resource.kind !== 'memory' || approved.has(resource.path))
    .map((resource) => ({ ...resource }));
  return immutable({
    cwd: prepared.cwd,
    versionId: prepared.versionId,
    digest: prepared.digest,
    instructionPath: prepared.instructionPath,
    skillPaths: [...prepared.skillPaths],
    memoryFiles,
    ...(resources ? { resources } : {}),
    ...(prepared.settingSources ? { settingSources: [...prepared.settingSources] } : {}),
  });
}

function lines(value) {
  if (value === '') return [];
  const result = value.split('\n');
  if (value.endsWith('\n')) result.pop();
  return result;
}
function wholeFilePatch(relative, before, after) {
  if (before === after) return '';
  const oldLines = before === null ? [] : lines(before);
  const newLines = after === null ? [] : lines(after);
  let patch =
    `--- ${before === null ? '/dev/null' : 'a/' + relative}\n` +
    `+++ ${after === null ? '/dev/null' : 'b/' + relative}\n` +
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n`;
  for (const [prefix, values, original] of [
    ['-', oldLines, before],
    ['+', newLines, after],
  ]) {
    for (let index = 0; index < values.length; index++) {
      patch += prefix + values[index] + '\n';
      if (index === values.length - 1 && !original.endsWith('\n'))
        patch += '\\ No newline at end of file\n';
    }
  }
  return patch;
}

/** Walk the stopped workspace for files outside the frozen source and native controls. */
async function workspaceFiles(cwd) {
  const files = [];
  const special = [];
  let entries = 0;
  const visit = async (directory, relative) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && CONTROL_ENTRIES.has(entry.name.toLowerCase())) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (++entries > LIMITS.workspaceEntries) return false;
      if (entry.isDirectory()) {
        if ((await visit(path.join(directory, entry.name), name)) === false) return false;
      } else if (entry.isFile()) files.push(name);
      else special.push(name);
    }
    return true;
  };
  const complete = await visit(cwd, '');
  return { files: files.sort(), special: special.sort(), complete };
}

function boundedPaths(paths) {
  return {
    count: paths.length,
    paths: paths.slice(0, LIMITS.reportedPaths),
    truncated: paths.length > LIMITS.reportedPaths,
  };
}

/** Remove common credential shapes and known secret values from provider text. */
export function redactSecrets(value, secrets = []) {
  let result = String(value ?? '');
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 8) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b([A-Za-z_]*(?:api[_-]?key|key|token|secret|password)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}

function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(value);
  return bytes.length <= maximum ? value : bytes.subarray(0, maximum).toString('utf8').replace(/�$/, '') + '…';
}

async function writeFailure(artifactDirectory, { jobId, harness, reason, error, secrets }) {
  const record = {
    schemaVersion: 1,
    kind: 'acclimate-native-failure',
    jobId,
    harness,
    reason,
    code: typeof error?.code === 'string' ? error.code.slice(0, 128) : null,
    message: truncateUtf8(redactSecrets(error?.message ?? '', secrets), LIMITS.failureMessageBytes),
    ...(error?.stderr ? { stderrTail: truncateUtf8(redactSecrets(error.stderr, secrets), LIMITS.failureMessageBytes) } : {}),
    recordedAt: new Date().toISOString(),
  };
  const bytes = jsonBytes(record);
  await exclusiveWrite(artifactDirectory, 'failure.json', bytes);
  return {
    reason,
    code: record.code,
    file: path.join(artifactDirectory, 'failure.json'),
    sha256: sha256(bytes),
  };
}

async function retainResults({
  cwd,
  artifactDirectory,
  source,
  resultFiles,
  binding,
  contextPolicyRevision,
  selectedMemorySha256,
  runOutput,
  failure,
}) {
  let total = 0;
  let patch = '';
  const changes = [];
  const beforeMap = new Map(source.files.map((file) => [file.path, file]));
  const workspace = await workspaceFiles(cwd);
  const owned = (name) => matchesAny(resultFiles, name);
  const protectedChanges = [];
  for (const file of source.files) {
    if (owned(file.path)) continue;
    try {
      const captured = await safeRead(cwd, file.path, LIMITS.sourceFileBytes);
      const changedContent = sha256(captured.bytes) !== file.sha256;
      const changedExecutable = (captured.mode & 0o100) !== (file.mode & 0o100);
      if (changedContent || changedExecutable)
        protectedChanges.push({ path: file.path, status: 'modified' });
    } catch (error) {
      if (error.code === 'ENOENT') protectedChanges.push({ path: file.path, status: 'deleted' });
      else if (['native.unsafe_path', 'native.unsafe_file', 'ENOTDIR'].includes(error.code))
        protectedChanges.push({ path: file.path, status: 'replaced' });
      else throw error;
    }
  }
  // Literal entries are always reported; patterns add every matching source or new file.
  const declared = new Set(resultFiles.filter((name) => !isPattern(name)));
  for (const name of [...source.files.map((file) => file.path), ...workspace.files])
    if (owned(name)) declared.add(name);
  if (declared.size > LIMITS.resultFiles)
    fail('native.result_limit', {
      rule: `resultFiles matched ${declared.size} files; the limit is ${LIMITS.resultFiles}`,
      hint: 'Use narrower resultFiles patterns',
    });
  const undeclared = workspace.files.filter((name) => !beforeMap.has(name) && !owned(name));
  for (const relative of [...declared].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    let after;
    try {
      after = await safeRead(cwd, relative, LIMITS.resultFileBytes);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      after = null;
    }
    const oldFile = beforeMap.get(relative);
    const beforeText = oldFile ? text(Buffer.from(oldFile.dataBase64, 'base64'), relative) : null;
    const afterText = after ? text(after.bytes, relative) : null;
    total += after?.bytes.length ?? 0;
    if (total > LIMITS.resultBytes)
      fail('native.result_limit', { path: relative, rule: `retained results exceed ${LIMITS.resultBytes} bytes` });
    if (after) await exclusiveWrite(artifactDirectory, `files/${relative}`, after.bytes);
    const beforeSha256 = oldFile?.sha256 ?? null;
    const afterSha256 = after ? sha256(after.bytes) : null;
    changes.push({
      path: relative,
      beforeSha256,
      afterSha256,
      executable: !!(after?.mode & 0o100),
      status:
        beforeSha256 === afterSha256
          ? 'unchanged'
          : beforeSha256 === null
            ? 'added'
            : afterSha256 === null
              ? 'deleted'
              : 'modified',
      bytes: after?.bytes.length ?? 0,
    });
    patch += wholeFilePatch(relative, beforeText, afterText);
    if (Buffer.byteLength(patch) > LIMITS.patchBytes)
      fail('native.patch_limit', { path: relative, rule: `patch exceeds ${LIMITS.patchBytes} bytes` });
  }
  await exclusiveWrite(artifactDirectory, 'result.patch', Buffer.from(patch));
  const outputBytes = jsonBytes(runOutput);
  if (outputBytes.length > LIMITS.privateOutputBytes)
    fail('native.output_limit', { rule: `agent output exceeds ${LIMITS.privateOutputBytes} bytes` });
  await exclusiveWrite(artifactDirectory, 'output.json', outputBytes);
  const manifest = {
    schemaVersion: 1,
    kind: 'acclimate-native-results',
    binding,
    sourceManifestSha256: source.sha256,
    contextPolicyRevision,
    selectedMemorySha256,
    resultFiles: [...resultFiles],
    changes,
    protectedChanges,
    undeclaredChanges: {
      ...boundedPaths(undeclared),
      unsupportedEntries: workspace.special.slice(0, LIMITS.reportedPaths),
      complete: workspace.complete,
    },
    ...(failure ? { failure: { reason: failure.reason, code: failure.code, path: 'failure.json', sha256: failure.sha256 } } : {}),
    output: { sha256: sha256(outputBytes), bytes: outputBytes.length },
    patch: {
      path: 'result.patch',
      sha256: sha256(Buffer.from(patch)),
      bytes: Buffer.byteLength(patch),
    },
  };
  const bytes = jsonBytes(manifest);
  await exclusiveWrite(artifactDirectory, 'manifest.json', bytes);
  return { manifest, manifestSha256: sha256(bytes) };
}

function parseTapCounts(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (matches.length) counts[key] = Number(matches.at(-1)[1]);
  }
  if (counts.tests === undefined) return null;
  return {
    total: counts.tests,
    passed: counts.pass ?? 0,
    failed: counts.fail ?? 0,
    cancelled: counts.cancelled ?? 0,
    skipped: counts.skipped ?? 0,
    todo: counts.todo ?? 0,
  };
}

/**
 * The default grader: `node --test` with TAP output, run asynchronously in its own
 * process group so a timeout or abort kills the whole test tree. Output is kept
 * bounded and returned for private retention, never inlined into the explanation.
 */
export function nodeTestRunner({ testFiles, timeoutMs, env = {}, maxLogBytes = LIMITS.testLogBytes }) {
  return ({ cwd, signal }) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--', ...testFiles], {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      const collect = (chunk) => {
        if (bytes >= maxLogBytes) {
          truncated = true;
          return;
        }
        const part = chunk.subarray(0, maxLogBytes - bytes);
        truncated ||= part.length < chunk.length;
        chunks.push(part);
        bytes += part.length;
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      let stopped;
      const killGroup = (why) => {
        stopped ??= why;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exiting. */
        }
      };
      const timer = setTimeout(() => killGroup('timeout'), timeoutMs);
      const onAbort = () => killGroup('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new NativeRepositoryError('grader.test_runner_unavailable', { rule: error.code ?? 'spawn failed' }));
      });
      child.once('close', (status, killedBy) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Reap anything the tests left behind in their process group (best effort).
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* ESRCH: already gone. EPERM: macOS reports it for exiting groups. */
        }
        if (stopped === 'aborted') return reject(signal.reason ?? new Error('grader.aborted'));
        const log = Buffer.concat(chunks);
        const tests = parseTapCounts(log.toString('utf8'));
        if (stopped === 'timeout')
          return resolve({ passed: false, outcome: 'test_timeout', tests, log, truncated });
        if (killedBy || ![0, 1].includes(status))
          return reject(new NativeRepositoryError('grader.test_runner_unavailable', {
            rule: killedBy ? `node --test stopped by ${killedBy}` : `node --test exited ${status}`,
          }));
        resolve({ passed: status === 0, outcome: status === 0 ? 'passed' : 'failed', tests, log, truncated });
      });
    });
}

function normalizedTestResult(value) {
  if (typeof value === 'boolean') return { passed: value, outcome: value ? 'passed' : 'failed', tests: null };
  if (
    !value || typeof value !== 'object' || typeof value.passed !== 'boolean' ||
    (value.outcome !== undefined && !['passed', 'failed', 'test_timeout'].includes(value.outcome))
  )
    fail('native.grader_result', { rule: 'runTests must return a boolean or { passed, outcome?, tests?, log? }' });
  return { ...value, outcome: value.outcome ?? (value.passed ? 'passed' : 'failed'), tests: value.tests ?? null };
}

/**
 * Grade in a fresh tree containing frozen inputs and only the retained solution files.
 * `reward: 'binary'` scores 1 only when every test passes; `'fraction'` scores
 * passed/total. Any protected-file change scores 0 in both modes.
 */
export async function gradeRepositoryTests({
  repository, artifactRoot, source, resultFiles, runTests, signal, reward: rewardMode = 'binary',
}) {
  validateFrozenSource(source);
  const allowed = validateInventory(resultFiles, LIMITS.resultFiles, { patterns: true });
  if (typeof runTests !== 'function')
    fail('native.grading_configuration', { rule: 'runTests must be a function' });
  if (!['binary', 'fraction'].includes(rewardMode))
    fail('native.grading_configuration', { rule: "reward must be 'binary' or 'fraction'" });
  if (!/^[a-f0-9]{64}$/.test(repository?.jobId) || !/^[a-f0-9]{64}$/.test(repository.manifestSha256))
    fail('native.grading_configuration', { rule: 'output.repository needs the jobId and manifestSha256 from execute' });
  await canonicalDirectory(artifactRoot, { private: true });
  const artifactDirectory = path.join(artifactRoot, repository.jobId);
  await canonicalDirectory(artifactDirectory, { private: true });
  const { bytes } = await safeRead(artifactDirectory, 'manifest.json', LIMITS.sourceManifestBytes);
  if (sha256(bytes) !== repository.manifestSha256) fail('native.artifact_digest', { path: 'manifest.json' });
  const manifest = JSON.parse(text(bytes, 'manifest.json'));
  const changed = new Set(manifest.changes?.map((change) => change.path));
  const literals = allowed.filter((name) => !isPattern(name));
  if (
    manifest.kind !== 'acclimate-native-results' ||
    manifest.sourceManifestSha256 !== source.sha256 ||
    !Array.isArray(manifest.protectedChanges) ||
    !Array.isArray(manifest.changes) ||
    manifest.changes.some((change) => !matchesAny(allowed, change.path)) ||
    literals.some((name) => !changed.has(name)) ||
    source.files.some((file) => matchesAny(allowed, file.path) && !changed.has(file.path))
  )
    fail('native.grading_binding', { rule: 'retained results do not match this source snapshot and resultFiles' });

  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-grading-'));
  try {
    for (const file of source.files) {
      if (changed.has(file.path)) continue;
      const bytes = Buffer.from(file.dataBase64, 'base64');
      await exclusiveWrite(cwd, file.path, bytes, 0o600 | (file.mode & 0o100));
    }
    for (const change of manifest.changes) {
      if (change.afterSha256 === null) continue;
      const result = await safeRead(artifactDirectory, 'files/' + change.path, LIMITS.resultFileBytes);
      if (sha256(result.bytes) !== change.afterSha256) fail('native.artifact_digest', { path: 'files/' + change.path });
      await exclusiveWrite(cwd, change.path, result.bytes, change.executable ? 0o700 : 0o600);
    }
    const result = normalizedTestResult(await runTests({ cwd, signal }));
    let log;
    if (result.log !== undefined) {
      const logBytes = Buffer.from(result.log).subarray(0, LIMITS.testLogBytes);
      const name = `grading/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.tap`;
      await exclusiveWrite(artifactDirectory, name, logBytes);
      log = { path: name, bytes: logBytes.length, sha256: sha256(logBytes), truncated: !!result.truncated };
    }
    const intact = manifest.protectedChanges.length === 0;
    const fraction = result.tests?.total ? result.tests.passed / result.tests.total : result.passed ? 1 : 0;
    const reward = !intact ? 0 : rewardMode === 'fraction' ? fraction : result.passed ? 1 : 0;
    return {
      reward,
      explanation: {
        outcome: result.outcome,
        testsPassed: result.passed,
        tests: result.tests,
        rewardMode,
        protectedChanges: manifest.protectedChanges,
        ...(manifest.undeclaredChanges ? { undeclaredChanges: manifest.undeclaredChanges } : {}),
        ...(manifest.failure ? { executionFailure: { reason: manifest.failure.reason, code: manifest.failure.code } } : {}),
        ...(log ? { log } : {}),
      },
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function evaluationErrors() {
  return import('@acclimate/sdk/evaluation');
}
async function uncertain(cause) {
  const { ExecutionUncertainError } = await evaluationErrors();
  return new ExecutionUncertainError(cause === undefined ? undefined : { cause });
}

const HARNESS_NAME = /^[a-z][a-z0-9-]{0,63}$/;
function configurationProblem({ harness, prepare, runHarness, caseId, repetition, contextPolicyRevision }) {
  if (typeof harness !== 'string' || !HARNESS_NAME.test(harness))
    return 'harness must be a lowercase name such as codex or my-agent';
  if (typeof prepare !== 'function') return 'prepare must be a function';
  if (typeof runHarness !== 'function') return 'runHarness must be a function';
  if (typeof caseId !== 'string') return 'caseId must be a string';
  if (!Number.isSafeInteger(repetition) || repetition < 0) return 'repetition must be a non-negative integer';
  if (typeof contextPolicyRevision !== 'string' || !contextPolicyRevision || Buffer.byteLength(contextPolicyRevision) > 1024)
    return 'contextPolicyRevision must be 1 to 1024 bytes';
}

/**
 * Classify a harness result after the harness confirmed its work stopped.
 * `reason: 'timeout' | 'crash'` is a failed task with gradeable partial work.
 */
function classifyRun(run) {
  if (run.cancelled === true) return { kind: 'cancelled' };
  if (run.infrastructureFailure) return { kind: 'infrastructure', reason: run.reason ?? 'provider_error' };
  if (['timeout', 'crash'].includes(run.reason)) return { kind: 'task_failed', reason: run.reason };
  return { kind: run.executionStatus === 'task_failed' ? 'task_failed' : 'completed', reason: run.reason };
}

/**
 * Complete app-owned native lifetime. The harness must confirm actual quiescence.
 *
 * `runHarness(task)` resolves `{ stopped: true, output, usage?, executionStatus?, reason?, error? }`.
 * Return `reason: 'timeout' | 'crash'` when the harness confirmed it stopped after a
 * timeout or crash: the job retains the partial work and reports `task_failed`.
 * Return `infrastructureFailure: true` with `error.message` for a provider failure:
 * the job retains results, writes a private redacted failure.json and throws
 * `native.harness_failed`. Return `stopped: false` or reject only when termination
 * cannot be confirmed; the job is then quarantined as ExecutionUncertainError.
 */
export async function runRepositoryJob(options) {
  const {
    bundle,
    context,
    source,
    harness,
    prepare,
    runHarness,
    workspaceParent,
    artifactRoot,
    selectedMemoryPaths = [],
    contextPolicyRevision = SOURCE_POLICY + ':bundle-only-memory-v1',
    resultFiles,
    caseId,
    repetition,
    signal,
    secrets = [],
  } = options;
  validateContext(context, bundle);
  validateFrozenSource(source);
  validateInventory(resultFiles, LIMITS.resultFiles, { patterns: true });
  const problem = configurationProblem({ harness, prepare, runHarness, caseId, repetition, contextPolicyRevision });
  if (problem) fail('native.job_configuration', { rule: problem });
  await canonicalDirectory(workspaceParent, { private: true });
  if (os.tmpdir() !== workspaceParent)
    fail('native.persistent_tmpdir_required', {
      path: os.tmpdir(),
      rule: `TMPDIR must equal the workspace parent ${workspaceParent}`,
      hint: `export TMPDIR=${workspaceParent}`,
    });
  await canonicalDirectory(context.privateJobDirectory, { private: true });
  let runnerBinding;
  try {
    runnerBinding = JSON.parse(
      text((await safeRead(context.privateJobDirectory, 'binding.json', 16 * 1024)).bytes),
    );
  } catch {
    fail('native.execution_binding', { path: 'binding.json', rule: 'unreadable evaluator binding' });
  }
  const expectedBinding = {
    requestId: context.requestId,
    attemptId: context.attemptId,
    side: context.side,
    jobId: context.jobId,
    caseId,
    repetition,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
  };
  if (
    Object.keys(runnerBinding).length !== Object.keys(expectedBinding).length ||
    Object.entries(expectedBinding).some(([key, value]) => runnerBinding[key] !== value)
  )
    fail('native.execution_binding', { path: 'binding.json', rule: 'does not match this job' });
  if (
    typeof artifactRoot !== 'string' ||
    !path.isAbsolute(artifactRoot) ||
    path.resolve(artifactRoot) !== artifactRoot
  )
    fail('native.unsafe_directory', { path: String(artifactRoot), rule: 'artifactRoot must be absolute and normalized' });
  if (
    overlap(workspaceParent, context.privateJobDirectory) ||
    overlap(artifactRoot, workspaceParent) ||
    overlap(artifactRoot, context.privateJobDirectory) ||
    (source.sourceRoot &&
      (overlap(artifactRoot, source.sourceRoot) ||
        overlap(workspaceParent, source.sourceRoot) ||
        overlap(context.privateJobDirectory, source.sourceRoot)))
  )
    fail('native.overlapping_roots', {
      rule: 'sourceRoot, stateRoot workspaces/artifacts and the evaluator journal must not contain each other',
    });
  await canonicalDirectory(artifactRoot, { private: true, create: true });
  const artifactDirectory = path.join(artifactRoot, context.jobId);
  await mkdir(artifactDirectory, { mode: 0o700 });
  await syncDirectory(artifactRoot);
  // A private locator lets the `jobs` CLI find the evaluator's job record later.
  await exclusiveWrite(artifactDirectory, 'locator.json', jsonBytes({
    schemaVersion: 1, jobId: context.jobId, privateJobDirectory: context.privateJobDirectory,
    harness, caseId, repetition, side: context.side, createdAt: new Date().toISOString(),
  }));
  const binding = {
    requestId: context.requestId,
    attemptId: context.attemptId,
    side: context.side,
    caseId,
    repetition,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
  };
  const selectedMemorySha256 = sha256(jsonBytes([...selectedMemoryPaths].sort()));
  const record = {
    schemaVersion: 1,
    kind: 'acclimate-native-job',
    jobId: context.jobId,
    binding,
    harness,
    sourceManifestSha256: source.sha256,
    contextPolicyRevision,
    selectedMemorySha256,
    workspaceParent,
    cwd: null,
    facts: {
      prepared: false,
      launchIntent: false,
      confirmedStopped: false,
      resultsRetained: false,
      cleaned: false,
    },
    updatedAt: new Date().toISOString(),
  };
  const save = async () => {
    record.updatedAt = new Date().toISOString();
    await atomicJob(context.privateJobDirectory, record);
  };
  await save();
  let prepared;
  let launched = false;
  let retained = false;
  try {
    if (signal?.aborted) fail('native.cancelled_before_start');
    prepared = await prepare(bundle, { approvedMemoryPaths: selectedMemoryPaths });
    await canonicalDirectory(prepared.cwd, { private: true });
    if (path.dirname(prepared.cwd) !== workspaceParent)
      fail('native.prepared_parent', { path: prepared.cwd, rule: `prepare must create its workspace directly in ${workspaceParent}` });
    if (prepared.versionId !== bundle.version.id || prepared.digest !== bundle.version.digest)
      fail('native.prepared_binding', { rule: 'prepare returned a different version or digest' });
    record.cwd = prepared.cwd;
    await exclusiveWrite(
      prepared.cwd,
      MARKER,
      jsonBytes({ schemaVersion: 1, jobId: context.jobId }),
    );
    record.facts.prepared = true;
    await save();
    const effectiveContext = await prepareEffectiveContext(prepared, selectedMemoryPaths);
    for (const file of source.files)
      await exclusiveWrite(
        prepared.cwd,
        file.path,
        Buffer.from(file.dataBase64, 'base64'),
        0o600 | (file.mode & 0o100),
      );
    if (signal?.aborted) fail('native.cancelled_before_start');
    record.facts.launchIntent = true;
    await save();
    launched = true;
    const acknowledge = async (handle) => {
      if (
        !handle ||
        Object.keys(handle).sort().join(',') !== 'kind,value' ||
        typeof handle.kind !== 'string' ||
        typeof handle.value !== 'string' ||
        Buffer.byteLength(handle.kind) > 128 ||
        Buffer.byteLength(handle.value) > 4096
      )
        fail('native.job_handle', { rule: 'acknowledge({ kind, value }) takes two short strings' });
      record.externalHandle = { kind: handle.kind, value: handle.value };
      record.externalHandles = [...(record.externalHandles ?? []), record.externalHandle].slice(-8);
      await save();
    };
    let run;
    try {
      run = await runHarness({
        context: effectiveContext,
        sourceManifest: source.manifest,
        signal,
        acknowledge,
        binding: immutable({ ...binding }),
      });
    } catch (cause) {
      // A rejected harness promise never proves its process or provider job stopped.
      throw await uncertain(cause);
    }
    if (!run || run.stopped !== true)
      throw await uncertain(run?.error ? Object.assign(new Error(String(run.error.message ?? 'harness stop unconfirmed')), { code: run.error.code }) : undefined);
    record.facts.confirmedStopped = true;
    await save();
    const outcome = classifyRun(run);
    const failure =
      outcome.kind === 'infrastructure' || (outcome.kind === 'task_failed' && outcome.reason)
        ? await writeFailure(artifactDirectory, {
            jobId: context.jobId, harness, reason: outcome.reason, error: run.error, secrets,
          })
        : undefined;
    const results = await retainResults({
      cwd: prepared.cwd,
      artifactDirectory,
      source,
      resultFiles,
      binding,
      contextPolicyRevision,
      selectedMemorySha256,
      runOutput: run.output ?? null,
      failure,
    });
    record.artifactManifest = {
      path: path.join(artifactDirectory, 'manifest.json'),
      sha256: results.manifestSha256,
    };
    record.facts.resultsRetained = true;
    await save();
    retained = true;
    if (outcome.kind === 'infrastructure')
      fail('native.harness_failed', {
        path: failure.file,
        rule: failure.code ?? outcome.reason,
        hint: 'The private failure.json holds the redacted provider message',
      });
    if (outcome.kind === 'cancelled') {
      const { CallbackCancelled } = await evaluationErrors();
      throw new CallbackCancelled();
    }
    const executionStatus = outcome.kind === 'task_failed' ? 'task_failed' : run.executionStatus;
    return {
      output: {
        result: results.manifest.output.bytes <= LIMITS.inlineOutputBytes ? run.output ?? null : null,
        repository: {
          jobId: context.jobId,
          sourceManifestSha256: source.sha256,
          contextPolicyRevision,
          selectedMemorySha256,
          manifestSha256: results.manifestSha256,
          changes: results.manifest.changes,
          patch: results.manifest.patch,
          protectedChangeCount: results.manifest.protectedChanges.length,
          undeclaredChanges: results.manifest.undeclaredChanges,
          retainedOutput: results.manifest.output,
          ...(failure ? { failure: { reason: failure.reason, code: failure.code, file: failure.file } } : {}),
        },
      },
      outputRef: `native-job:${context.jobId}`,
      ...(executionStatus !== undefined ? { executionStatus } : {}),
      ...(run.usage !== undefined ? { usage: run.usage } : {}),
    };
  } finally {
    if (prepared && (!launched || retained)) {
      // Save deletion authorization before cleanup: process loss after the tree
      // disappears must not strand a permanently unfinishable recovery record.
      if (record.facts.prepared) {
        record.cleanupIntent = true;
        await save();
      }
      await prepared.cleanup();
      record.facts.cleaned = true;
      await save();
    }
  }
}

/** Local authorized inspection only: these records intentionally contain private locators. */
export async function inspectNativeJob(privateJobDirectory) {
  await canonicalDirectory(privateJobDirectory, { private: true });
  const captured = await safeRead(privateJobDirectory, 'job.json', LIMITS.jobBytes);
  let record;
  try {
    record = JSON.parse(text(captured.bytes));
  } catch {
    fail('native.job_record_invalid');
  }
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'acclimate-native-job' ||
    !/^[a-f0-9]{64}$/.test(record.jobId) ||
    !record.binding ||
    !record.facts
  )
    fail('native.job_record_invalid');
  return immutable(record);
}

/** An operator's explicit post-termination cleanup; no PID/age inference is made here. */
export async function cleanupQuarantinedJob({ privateJobDirectory, confirmStopped }) {
  const record = structuredClone(await inspectNativeJob(privateJobDirectory));
  if (record.facts.cleaned) return { cleaned: true, jobId: record.jobId };
  if (
    typeof confirmStopped !== 'function' ||
    (await confirmStopped(immutable(structuredClone(record)))) !== true
  )
    fail('native.termination_unconfirmed');
  if (!record.cwd || !record.facts.prepared) fail('native.job_record_invalid');
  await canonicalDirectory(record.workspaceParent, { private: true });
  if (path.dirname(record.cwd) !== record.workspaceParent) fail('native.prepared_parent');
  const exists = await lstat(record.cwd).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) {
    // Missing files alone never prove ownership or termination. A prior durable
    // cleanup intent proves this exact owned root was authorized for removal.
    if (
      record.cleanupIntent !== true ||
      (!record.facts.confirmedStopped && record.facts.launchIntent)
    )
      fail('native.ownership_mismatch');
    record.facts.confirmedStopped = true;
    record.facts.cleaned = true;
    record.updatedAt = new Date().toISOString();
    await atomicJob(privateJobDirectory, record);
    return { cleaned: true, jobId: record.jobId };
  }
  await canonicalDirectory(record.cwd, { private: true });
  const marker = JSON.parse(text((await safeRead(record.cwd, MARKER, 4096)).bytes));
  if (marker.schemaVersion !== 1 || marker.jobId !== record.jobId)
    fail('native.ownership_mismatch');
  record.facts.confirmedStopped = true;
  record.cleanupIntent = true;
  record.updatedAt = new Date().toISOString();
  await atomicJob(privateJobDirectory, record);
  await rm(record.cwd, { recursive: true });
  record.facts.cleaned = true;
  record.updatedAt = new Date().toISOString();
  await atomicJob(privateJobDirectory, record);
  return { cleaned: true, jobId: record.jobId };
}

/**
 * True while any non-zombie process in the group exists. macOS can answer EPERM
 * for a group of exiting processes, so EPERM is resolved with `ps`; if that is
 * unavailable the group is conservatively treated as alive.
 */
export function processGroupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') throw error;
  }
  try {
    const table = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin' } });
    return table.split('\n').some((line) => {
      const [group, state = ''] = line.trim().split(/\s+/);
      return Number(group) === pgid && !state.startsWith('Z');
    });
  } catch {
    return true;
  }
}

/** Summaries for the local `jobs` CLI. Records contain private locators; keep output local. */
export async function listNativeJobs(artifactRoot) {
  await canonicalDirectory(artifactRoot, { private: true });
  const jobs = [];
  for (const name of (await readdir(artifactRoot)).sort()) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const directory = path.join(artifactRoot, name);
    let locator = null;
    try {
      locator = JSON.parse(text((await safeRead(directory, 'locator.json', 16 * 1024)).bytes));
    } catch {
      /* Jobs from releases before locator.json have no recoverable journal pointer. */
    }
    const present = async (file) => !!(await lstat(path.join(directory, file)).catch(() => null));
    const summary = {
      jobId: name,
      artifactDirectory: directory,
      privateJobDirectory: locator?.privateJobDirectory ?? null,
      harness: locator?.harness ?? null,
      caseId: locator?.caseId ?? null,
      repetition: locator?.repetition ?? null,
      side: locator?.side ?? null,
      resultsRetained: await present('manifest.json'),
      failureFile: (await present('failure.json')) ? path.join(directory, 'failure.json') : null,
      state: 'unknown',
    };
    if (summary.privateJobDirectory) {
      try {
        const record = await inspectNativeJob(summary.privateJobDirectory);
        const group = record.externalHandles?.find((handle) => handle.kind === 'process-group');
        summary.state = record.facts.cleaned
          ? 'cleaned'
          : record.facts.launchIntent && !record.facts.confirmedStopped
            ? 'quarantined'
            : record.facts.resultsRetained
              ? 'retained'
              : 'interrupted';
        summary.workspace = record.cwd;
        summary.facts = record.facts;
        if (group) summary.processGroup = { pgid: Number(group.value), alive: processGroupAlive(Number(group.value)) };
      } catch (error) {
        summary.state = 'record_unreadable';
        summary.error = error.code ?? 'unknown';
      }
    }
    jobs.push(summary);
  }
  return jobs;
}
