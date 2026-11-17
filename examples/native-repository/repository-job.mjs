import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
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
  sourceManifestBytes: 1024 * 1024,
  jobBytes: 64 * 1024,
});
const MARKER = '.acclimate/native-job-owner.json';
const decoder = new TextDecoder('utf-8', { fatal: true });
const uid = () => process.getuid?.();
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class NativeRepositoryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeRepositoryError';
    this.code = code;
  }
}
const fail = (code) => {
  throw new NativeRepositoryError(code);
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
function text(bytes) {
  try {
    const result = decoder.decode(bytes);
    if (result.includes('\0')) fail('native.nontext_file');
    return result;
  } catch {
    fail('native.nontext_file');
  }
}

export function validateInventory(paths, maximum = LIMITS.sourceFiles) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > maximum)
    fail('native.inventory_limit');
  const seen = new Set();
  for (const name of paths) {
    if (typeof name !== 'string' || !name || name.length > 240 || !/^[-A-Za-z0-9._/]+$/.test(name))
      fail('native.unsafe_path');
    for (const segment of name.split('/')) {
      if (
        !segment ||
        segment.startsWith('.') ||
        /^(?:AGENTS\.md|CLAUDE\.md)$/i.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
      )
        fail('native.control_path');
    }
    const key = name.toLowerCase();
    if (seen.has(key)) fail('native.path_collision');
    seen.add(key);
  }
  for (const name of seen) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++)
      if (seen.has(parts.slice(0, index).join('/'))) fail('native.path_collision');
  }
  return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

async function canonicalDirectory(input, { private: isPrivate = false, create = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.resolve(input) !== input)
    fail('native.unsafe_directory');
  let cursor = path.parse(input).root;
  for (const part of input.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (!create || error.code !== 'ENOENT') fail('native.unsafe_directory');
      await mkdir(cursor, { mode: 0o700 });
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('native.unsafe_directory');
  }
  const info = await lstat(input);
  if (
    (await realpath(input)) !== input ||
    (uid() !== undefined && info.uid !== uid()) ||
    (isPrivate ? (info.mode & 0o777) !== 0o700 : !!(info.mode & 0o022))
  )
    fail('native.unsafe_directory');
  return input;
}

async function safeRead(root, relative, maximum) {
  const segments = relative.split('/');
  let cursor = root;
  for (const part of segments.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('native.unsafe_path');
  }
  const filename = path.join(root, ...segments);
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximum ||
    (uid() !== undefined && before.uid !== uid())
  )
    fail('native.unsafe_file');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > maximum)
      fail('native.unsafe_file');
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
      fail('native.file_changed_or_large');
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
    if (!info.isDirectory() || info.isSymbolicLink()) fail('native.unsafe_directory');
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

export async function freezeSourceInventory({ sourceRoot, paths, revision }) {
  await canonicalDirectory(sourceRoot);
  if (typeof revision !== 'string' || !revision.trim() || Buffer.byteLength(revision) > 1024)
    fail('native.source_revision');
  const files = [];
  let total = 0;
  for (const relative of validateInventory(paths)) {
    let captured;
    try {
      captured = await safeRead(sourceRoot, relative, LIMITS.sourceFileBytes);
    } catch (error) {
      if (error instanceof NativeRepositoryError) throw error;
      fail('native.source_unavailable');
    }
    text(captured.bytes);
    total += captured.bytes.length;
    if (total > LIMITS.sourceBytes) fail('native.source_limit');
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
    files: files.map(({ dataBase64, ...entry }) => entry),
  };
  const encoded = jsonBytes(manifest);
  if (encoded.length > LIMITS.sourceManifestBytes) fail('native.source_manifest_limit');
  return immutable({ sourceRoot, manifest, sha256: sha256(encoded), files });
}

function validateFrozenSource(source) {
  if (!source || source.manifest?.policy !== SOURCE_POLICY || !Array.isArray(source.files))
    fail('native.source_snapshot_invalid');
  validateInventory(source.files.map((file) => file.path));
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
    fail('native.memory_selection');
  const approved = new Set(selected);
  for (const file of original) {
    if (!inside(prepared.cwd, file.absolutePath)) fail('native.prepared_path');
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

async function retainResults({
  cwd,
  artifactDirectory,
  source,
  resultFiles,
  binding,
  contextPolicyRevision,
  selectedMemorySha256,
}) {
  let total = 0;
  let patch = '';
  const changes = [];
  const beforeMap = new Map(source.files.map((file) => [file.path, file]));
  for (const relative of validateInventory(resultFiles, LIMITS.resultFiles)) {
    let after;
    try {
      after = await safeRead(cwd, relative, LIMITS.resultFileBytes);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      after = null;
    }
    const oldFile = beforeMap.get(relative);
    const beforeText = oldFile ? text(Buffer.from(oldFile.dataBase64, 'base64')) : null;
    const afterText = after ? text(after.bytes) : null;
    total += after?.bytes.length ?? 0;
    if (total > LIMITS.resultBytes) fail('native.result_limit');
    if (after) await exclusiveWrite(artifactDirectory, `files/${relative}`, after.bytes);
    const beforeSha256 = oldFile?.sha256 ?? null;
    const afterSha256 = after ? sha256(after.bytes) : null;
    changes.push({
      path: relative,
      beforeSha256,
      afterSha256,
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
    if (Buffer.byteLength(patch) > LIMITS.patchBytes) fail('native.patch_limit');
  }
  await exclusiveWrite(artifactDirectory, 'result.patch', Buffer.from(patch));
  const manifest = {
    schemaVersion: 1,
    kind: 'acclimate-native-results',
    binding,
    sourceManifestSha256: source.sha256,
    contextPolicyRevision,
    selectedMemorySha256,
    changes,
    patch: {
      path: 'result.patch',
      sha256: sha256(Buffer.from(patch)),
      bytes: Buffer.byteLength(patch),
    },
  };
  const bytes = jsonBytes(manifest);
  await exclusiveWrite(artifactDirectory, 'manifest.json', bytes);
  return { manifest, manifestSha256: sha256(bytes), patch };
}

async function uncertain() {
  const { ExecutionUncertainError } = await import('@acclimate/sdk/evaluation');
  return new ExecutionUncertainError();
}

/** Complete app-owned native lifetime. The harness must confirm actual quiescence. */
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
  } = options;
  validateContext(context, bundle);
  validateFrozenSource(source);
  validateInventory(resultFiles, LIMITS.resultFiles);
  if (
    !['codex', 'claude', 'pi', 'cursor'].includes(harness) ||
    typeof prepare !== 'function' ||
    typeof runHarness !== 'function' ||
    typeof caseId !== 'string' ||
    !Number.isSafeInteger(repetition) ||
    repetition < 0 ||
    typeof contextPolicyRevision !== 'string' ||
    !contextPolicyRevision ||
    Buffer.byteLength(contextPolicyRevision) > 1024
  )
    fail('native.job_configuration');
  await canonicalDirectory(workspaceParent, { private: true });
  if (os.tmpdir() !== workspaceParent) fail('native.persistent_tmpdir_required');
  await canonicalDirectory(context.privateJobDirectory, { private: true });
  let runnerBinding;
  try {
    runnerBinding = JSON.parse(
      text((await safeRead(context.privateJobDirectory, 'binding.json', 16 * 1024)).bytes),
    );
  } catch {
    fail('native.execution_binding');
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
    fail('native.execution_binding');
  if (
    typeof artifactRoot !== 'string' ||
    !path.isAbsolute(artifactRoot) ||
    path.resolve(artifactRoot) !== artifactRoot
  )
    fail('native.unsafe_directory');
  if (
    overlap(workspaceParent, context.privateJobDirectory) ||
    overlap(artifactRoot, workspaceParent) ||
    overlap(artifactRoot, context.privateJobDirectory) ||
    (source.sourceRoot &&
      (overlap(artifactRoot, source.sourceRoot) ||
        overlap(workspaceParent, source.sourceRoot) ||
        overlap(context.privateJobDirectory, source.sourceRoot)))
  )
    fail('native.overlapping_roots');
  await canonicalDirectory(artifactRoot, { private: true, create: true });
  const artifactDirectory = path.join(artifactRoot, context.jobId);
  await mkdir(artifactDirectory, { mode: 0o700 });
  await syncDirectory(artifactRoot);
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
    if (path.dirname(prepared.cwd) !== workspaceParent) fail('native.prepared_parent');
    if (prepared.versionId !== bundle.version.id || prepared.digest !== bundle.version.digest)
      fail('native.prepared_binding');
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
        fail('native.job_handle');
      record.externalHandle = { kind: handle.kind, value: handle.value };
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
    } catch {
      throw await uncertain();
    }
    if (!run || run.stopped !== true) throw await uncertain();
    record.facts.confirmedStopped = true;
    await save();
    const results = await retainResults({
      cwd: prepared.cwd,
      artifactDirectory,
      source,
      resultFiles,
      binding,
      contextPolicyRevision,
      selectedMemorySha256,
    });
    record.artifactManifest = {
      path: path.join(artifactDirectory, 'manifest.json'),
      sha256: results.manifestSha256,
    };
    record.facts.resultsRetained = true;
    await save();
    retained = true;
    return {
      output: {
        result: run.output ?? null,
        repository: {
          sourceManifestSha256: source.sha256,
          contextPolicyRevision,
          selectedMemorySha256,
          manifestSha256: results.manifestSha256,
          changes: results.manifest.changes,
          patch: results.patch,
        },
      },
      outputRef: `native-job:${context.jobId}`,
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
