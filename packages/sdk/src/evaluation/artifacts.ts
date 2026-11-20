import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { AcclimateClient } from '../client.js';
import type {
  Comparison,
  ComparisonRequest,
  Evaluation,
  EvaluationHandoff,
  Outcome,
} from '../types.js';
import { validateEvaluationHandoff } from '../validation.js';
import { readEvaluatorConfig, readReaderConfig } from './config.js';
import { EvaluationError, toSafeDiagnostic, type SafeCode } from './errors.js';
import { journalDirectory, openJournal, type JournalScope } from './journal.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ArtifactRole = 'output' | 'grader-explanation';
type Side = 'parent' | 'candidate';
export interface ArtifactSelectionV1 {
  schemaVersion: 1;
  entries: Array<{
    caseId: string;
    repetition: number;
    side: Side;
    role: ArtifactRole;
    required: boolean;
  }>;
}
export interface ReviewMapperInput {
  identity: {
    requestId: string;
    attemptId: string;
    comparisonId: string;
    versionId: string;
    digest: string;
    caseId: string;
    repetition: number;
    side: Side;
    role: ArtifactRole;
  };
  value: Json;
}
export type ReviewMapper = (
  input: ReviewMapperInput,
) => Promise<
  null | { mediaType: 'application/json'; value: Json } | { mediaType: 'text/plain'; text: string }
>;
export interface ReviewManifestV1 {
  schemaVersion: 1;
  kind: 'acclimate-review-export';
  workspaceId: string;
  bundleId: string;
  requestId: string;
  attemptId: string;
  comparisonId: string;
  parent: { versionId: string; digest: string };
  candidate: { versionId: string; digest: string };
  localInspection: 'not_requested' | 'validated' | 'unavailable';
  projection: { file: 'comparison-review.json'; sha256: string; bytes: number };
  entries: Array<{
    caseId: string;
    repetition: number;
    side: Side;
    roles: Array<{
      role: ArtifactRole;
      selected: boolean;
      required: boolean;
      availability: 'exported' | 'not_shared' | 'missing' | 'unavailable';
      file?: {
        path: string;
        sha256: string;
        bytes: number;
        mediaType: 'application/json' | 'text/plain';
      };
    }>;
  }>;
  exporter: { name: 'acclimate-evidence'; version: string };
}
export interface ReviewExportResult {
  schemaVersion: 1;
  status: 'exported';
  manifestPath: string;
  localInspection: ReviewManifestV1['localInspection'];
  selection: { required: number; exportedRequired: number; optionalMissing: number };
}
export interface ReviewVerificationResult {
  schemaVersion: 1;
  status: 'verified';
  provenance: 'self_consistent' | 'online_scalar_binding';
  comparisonId: string;
  executionAttested: false;
}
const MAX_FILE = 1024 * 1024;
const MAX_PRIVATE_FILE = MAX_FILE + 16 * 1024;
const MAX_MANIFEST = 2 * MAX_FILE;
const MAX_EXPORT = 64 * MAX_FILE;
const SIDES = ['parent', 'candidate'] as const;
const ROLES = ['output', 'grader-explanation'] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function fail(code: SafeCode = 'artifact.integrity'): never {
  throw new EvaluationError(code, {
    phase: 'export',
    executionState: 'finished',
    nextAction: 'review_terminal_evidence',
  });
}
const obj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (
  x: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): x is Record<string, unknown> =>
  obj(x) &&
  required.every((k) => Object.hasOwn(x, k)) &&
  Object.keys(x).every((k) => required.includes(k) || optional.includes(k));
const utf8 = (x: unknown, limit: number): x is string =>
  typeof x === 'string' &&
  x.length > 0 &&
  encoder.encode(x).length <= limit &&
  !/[\ud800-\udfff]/u.test(x);
const integer = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const digest = (data: Uint8Array) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const validDigest = (x: unknown): x is string =>
  typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
const matchesDigest = (data: Uint8Array, expected: unknown) =>
  typeof expected === 'string' &&
  digest(data) === (expected.startsWith('sha256:') ? expected : `sha256:${expected}`);
const identityKey = (x: { caseId: string; repetition: number; side?: string; role?: string }) =>
  JSON.stringify([x.caseId, x.repetition, x.side, x.role]);
const pairKey = (x: { caseId: string; repetition: number }) =>
  JSON.stringify([x.caseId, x.repetition]);
const comparePair = (
  a: { caseId: string; repetition: number },
  b: { caseId: string; repetition: number },
) => Buffer.compare(Buffer.from(a.caseId), Buffer.from(b.caseId)) || a.repetition - b.repetition;
const canonical = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(canonical)
    : obj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const encode = (x: unknown) => encoder.encode(JSON.stringify(x) + '\n');

/** Strict parsing prevents duplicate keys from changing a reviewed selection/manifest. */
function parseJson(data: Uint8Array): unknown {
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    return fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '"') break;
    }
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): void => {
    ws();
    if (text[i] === '{') {
      i++;
      ws();
      const seen = new Set<string>();
      if (text[i] === '}') {
        i++;
        return;
      }
      while (i < text.length) {
        ws();
        const key = string();
        if (seen.has(key)) fail();
        seen.add(key);
        ws();
        i++;
        value();
        ws();
        if (text[i++] === '}') return;
      }
    } else if (text[i] === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      while (i < text.length) {
        value();
        ws();
        if (text[i++] === ']') return;
      }
    } else if (text[i] === '"') {
      string();
    } else {
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    }
  };
  value();
  return parsed;
}
function assertJson(x: unknown, seen = new Set<object>()): asserts x is Json {
  if (x === null || typeof x === 'boolean') return;
  if (typeof x === 'string') {
    if (/[\ud800-\udfff]/u.test(x)) fail('artifact.mapper_failed');
    return;
  }
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || (Number.isInteger(x) && !Number.isSafeInteger(x)))
      fail('artifact.mapper_failed');
    return;
  }
  if (
    !x ||
    typeof x !== 'object' ||
    seen.has(x) ||
    (!Array.isArray(x) &&
      Object.getPrototypeOf(x) !== Object.prototype &&
      Object.getPrototypeOf(x) !== null)
  )
    fail('artifact.mapper_failed');
  seen.add(x);
  if (Object.keys(x).some((key) => /[\ud800-\udfff]/u.test(key))) fail('artifact.mapper_failed');
  for (const v of Object.values(x)) assertJson(v, seen);
  seen.delete(x);
}

export function parseArtifactSelection(value: unknown): ArtifactSelectionV1 {
  if (
    !keys(value, ['schemaVersion', 'entries']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 4000
  )
    fail('artifact.selection_invalid');
  const seen = new Set<string>();
  const entries = value.entries.map((x) => {
    if (
      !keys(x, ['caseId', 'repetition', 'side', 'role', 'required']) ||
      !utf8(x.caseId, 1024) ||
      !integer(x.repetition) ||
      !SIDES.includes(x.side as Side) ||
      !ROLES.includes(x.role as ArtifactRole) ||
      typeof x.required !== 'boolean'
    )
      fail('artifact.selection_invalid');
    const row = x as unknown as ArtifactSelectionV1['entries'][number];
    if (seen.has(identityKey(row))) fail('artifact.selection_invalid');
    seen.add(identityKey(row));
    return { ...row };
  });
  return { schemaVersion: 1, entries };
}
export const validateArtifactSelection = parseArtifactSelection;

async function noSymlinks(filename: string): Promise<void> {
  const absolute = path.isAbsolute(filename) ? filename : path.resolve(filename);
  let at = path.parse(absolute).root;
  for (const segment of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
    // Preserve supplied segments until inspected: normalizing link/../ first
    // would erase the link from the ancestry promised to be rejected.
    at = at.endsWith(path.sep) ? at + segment : at + path.sep + segment;
    const stat = await lstat(at);
    if (stat.isSymbolicLink()) fail();
  }
}
async function readFile(filename: string, limit: number, privateFile = false): Promise<Uint8Array> {
  await noSymlinks(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > limit ||
      (privateFile &&
        (stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())))
    )
      fail();
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) fail();
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function writeFile(filename: string, data: Uint8Array): Promise<void> {
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
function outputOverlap(): never {
  throw new EvaluationError('artifact.integrity', {
    phase: 'export', executionState: 'finished', nextAction: 'fix_config', pathIssue: 'exportOverlap',
  });
}
async function safeOutputDirectory(output: string, roots: string[]): Promise<string> {
  if (!path.isAbsolute(output)) fail();
  await noSymlinks(path.dirname(output));
  const destination = path.resolve(output);
  if (roots.some((root) => overlaps(destination, path.resolve(root)))) outputOverlap();
  await noSymlinks(path.dirname(destination));
  const parent = await lstat(path.dirname(destination));
  if (
    !parent.isDirectory() ||
    (process.getuid && parent.uid !== process.getuid()) ||
    parent.mode & 0o022
  )
    fail();
  // Scalar-only exports intentionally do not open journals. The native recipe's
  // fixed ownership marker still reserves its whole workspace tree locally.
  let ancestor = path.dirname(destination);
  while (true) {
    const control = path.join(ancestor, '.acclimate');
    try {
      const stat = await lstat(control);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        try {
          await lstat(path.join(control, 'native-job-owner.json'));
          outputOverlap();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const above = path.dirname(ancestor);
    if (above === ancestor) break;
    ancestor = above;
  }
  return destination;
}
function inventory(value: unknown): Array<{ caseId: string; repetition: number }> {
  if (!Array.isArray(value) || !value.length || value.length > 1000) fail();
  const seen = new Set<string>();
  return value
    .map((x) => {
      if (
        !keys(x, ['caseId', 'repetition']) ||
        !utf8(x.caseId, 1024) ||
        !integer(x.repetition) ||
        x.repetition > 0xffffffff
      )
        fail();
      const row = { caseId: x.caseId, repetition: x.repetition };
      if (seen.has(pairKey(row))) fail();
      seen.add(pairKey(row));
      return row;
    })
    .sort(comparePair);
}
function outcome(
  value: unknown,
): Pick<Outcome, 'executionStatus' | 'gradingStatus' | 'reward' | 'usage'> {
  if (
    !obj(value) ||
    !['completed', 'task_failed', 'infrastructure_failed'].includes(
      value.executionStatus as string,
    ) ||
    !['scored', 'missing', 'failed'].includes(value.gradingStatus as string)
  )
    fail();
  if (
    value.gradingStatus === 'scored'
      ? typeof value.reward !== 'number' || !Number.isFinite(value.reward)
      : value.reward !== null
  )
    fail();
  let usage: Outcome['usage'] = null;
  if (value.usage !== null && value.usage !== undefined) {
    if (!keys(value.usage, [], ['inputTokens', 'outputTokens', 'costUsd'])) fail();
    usage = {};
    for (const k of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
      const n = value.usage[k];
      if (n !== undefined) {
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) fail();
        usage[k] = n;
      }
    }
  }
  return {
    executionStatus: value.executionStatus as Outcome['executionStatus'],
    gradingStatus: value.gradingStatus as Outcome['gradingStatus'],
    reward: value.reward as number | null,
    usage,
  };
}
function body(comparison: ComparisonRequest) {
  return {
    parentVersionId: comparison.parentVersionId,
    candidateVersionId: comparison.candidateVersionId,
    parentDigest: comparison.parentDigest,
    candidateDigest: comparison.candidateDigest,
    datasetRevision: comparison.datasetRevision,
    graderRevision: comparison.graderRevision,
    runtime: comparison.runtime,
    expectedCases: inventory(comparison.expectedCases),
    evaluation: comparison.evaluation,
    results: [...comparison.results].sort(comparePair),
  };
}
function projection(handoff: EvaluationHandoff, request: Evaluation, comparison: Comparison) {
  const expectedCases = inventory(comparison.expectedCases);
  const expected = new Set(expectedCases.map(pairKey));
  if (!Array.isArray(comparison.results) || comparison.results.length > expectedCases.length)
    fail();
  const seen = new Set<string>();
  const results = comparison.results
    .map((row) => {
      if (!obj(row) || !expected.has(pairKey(row)) || seen.has(pairKey(row))) fail();
      seen.add(pairKey(row));
      return {
        caseId: row.caseId,
        repetition: row.repetition,
        parent: outcome(row.parent),
        candidate: outcome(row.candidate),
      };
    })
    .sort(comparePair);
  const all = results.flatMap((row) => [row.parent, row.candidate]);
  const complete =
    seen.size === expected.size &&
    all.every((x) => x.executionStatus !== 'infrastructure_failed' && x.gradingStatus === 'scored');
  if (comparison.complete !== complete) fail();
  return {
    schemaVersion: 1,
    kind: 'acclimate-comparison-review',
    workspaceId: handoff.workspaceId,
    bundleId: handoff.bundleId,
    requestId: request.id,
    attemptId: request.attemptId!,
    comparisonId: comparison.id,
    parent: { versionId: comparison.parentVersionId, digest: comparison.parentDigest },
    candidate: { versionId: comparison.candidateVersionId, digest: comparison.candidateDigest },
    complete,
    expectedCases,
    results,
    missingness: {
      expectedPairs: expectedCases.length,
      presentPairs: results.length,
      missingPairs: expectedCases.length - results.length,
      ungradedOutcomes: all.filter((x) => x.gradingStatus !== 'scored').length,
      infrastructureFailures: all.filter((x) => x.executionStatus === 'infrastructure_failed')
        .length,
    },
  };
}
function descriptor(x: {
  datasetRevision: string;
  graderRevision: string;
  runtime: Record<string, string>;
  expectedCases: unknown;
}) {
  return {
    datasetRevision: x.datasetRevision,
    graderRevision: x.graderRevision,
    runtime: x.runtime,
    expectedCases: inventory(x.expectedCases),
  };
}
async function remoteRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    const diagnostic = toSafeDiagnostic(error, 'export', 'finished');
    throw new EvaluationError(diagnostic.code, diagnostic);
  }
}
async function authority(
  configPath: string | undefined,
  readConfigPath: string | undefined,
  supplied: EvaluationHandoff,
) {
  if (!!configPath === !!readConfigPath) fail('config.schema');
  const handoff = validateEvaluationHandoff(supplied);
  const config = configPath
    ? await readEvaluatorConfig(configPath)
    : await readReaderConfig(readConfigPath!);
  if (config.serviceUrl !== handoff.serviceUrl || config.workspaceId !== handoff.workspaceId)
    fail('evidence.identity_mismatch');
  const token = 'evaluatorToken' in config ? config.evaluatorToken : config.readToken;
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token,
    scope: 'evaluatorPrincipalId' in config ? config.evaluatorPrincipalId : 'review-reader',
  });
  const request = await remoteRead(() =>
    client.getEvaluation(handoff.workspaceId, handoff.bundleId, handoff.requestId),
  );
  if (
    request.id !== handoff.requestId ||
    !equal(descriptor(request), descriptor(handoff.descriptor))
  )
    fail('evidence.identity_mismatch');
  if (
    !['completed', 'failed'].includes(request.status) ||
    !request.comparisonId ||
    !request.attemptId ||
    !request.evaluatorPrincipal
  )
    fail('artifact.missing');
  const comparison = await remoteRead(() =>
    client.getComparison(handoff.workspaceId, handoff.bundleId, request.comparisonId!),
  );
  if (
    comparison.id !== request.comparisonId ||
    comparison.submitter !== request.evaluatorPrincipal ||
    comparison.evaluation?.requestId !== request.id ||
    comparison.evaluation?.attemptId !== request.attemptId ||
    !equal(descriptor(comparison), descriptor(request)) ||
    ['parentVersionId', 'candidateVersionId', 'parentDigest', 'candidateDigest'].some(
      (k) => comparison[k as keyof Comparison] !== request[k as keyof Evaluation],
    )
  )
    fail('evidence.identity_mismatch');
  if (
    !utf8(comparison.id, 128) ||
    !utf8(request.attemptId, 128) ||
    !utf8(comparison.parentVersionId, 128) ||
    !utf8(comparison.candidateVersionId, 128) ||
    !validDigest(comparison.parentDigest) ||
    !validDigest(comparison.candidateDigest)
  )
    fail();
  return {
    handoff,
    config,
    request,
    comparison,
    projection: projection(handoff, request, comparison),
  };
}
interface IndexEntry {
  caseId: string;
  repetition: number;
  side: Side;
  versionId: string;
  digest: string;
  role: ArtifactRole;
  file: string;
  sha256: string;
  bytes: number;
}
async function existingJournal(root: string, scope: JournalScope) {
  const directory = journalDirectory(root, scope);
  try {
    await noSymlinks(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return openJournal(root, scope);
}
function indexEntries(
  index: unknown,
  request: Evaluation,
  comparison: Comparison,
  reportBytes: Uint8Array,
): IndexEntry[] {
  if (
    !obj(index) ||
    index.schemaVersion !== 1 ||
    index.requestId !== request.id ||
    index.attemptId !== request.attemptId ||
    index.comparisonId !== comparison.id ||
    !matchesDigest(reportBytes, index.reportSha256) ||
    !Array.isArray(index.entries) ||
    index.entries.length > 4000
  )
    fail();
  const expected = new Set(inventory(comparison.expectedCases).map(pairKey));
  const seen = new Set<string>();
  const files = new Set<string>();
  return index.entries.map((value) => {
    if (
      !keys(value, [
        'caseId',
        'repetition',
        'side',
        'versionId',
        'digest',
        'role',
        'file',
        'sha256',
        'bytes',
      ]) ||
      !utf8(value.caseId, 1024) ||
      !integer(value.repetition) ||
      !SIDES.includes(value.side as Side) ||
      !ROLES.includes(value.role as ArtifactRole) ||
      !utf8(value.file, 128) ||
      !/^artifact-(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/.test(
        value.file,
      ) ||
      !integer(value.bytes) ||
      value.bytes > MAX_PRIVATE_FILE ||
      !validDigest(value.sha256) ||
      !expected.has(pairKey(value as unknown as IndexEntry))
    )
      fail();
    const row = value as unknown as IndexEntry;
    const versionId =
      row.side === 'parent' ? comparison.parentVersionId : comparison.candidateVersionId;
    const expectedDigest =
      row.side === 'parent' ? comparison.parentDigest : comparison.candidateDigest;
    if (
      row.versionId !== versionId ||
      row.digest !== expectedDigest ||
      seen.has(identityKey(row)) ||
      files.has(row.file)
    )
      fail();
    seen.add(identityKey(row));
    files.add(row.file);
    return row;
  });
}
async function preparedRoots(directory: string): Promise<string[]> {
  const jobs = path.join(directory, 'jobs');
  let entries;
  try {
    await noSymlinks(jobs);
    entries = await readdir(jobs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (entries.length > 2000) fail();
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) fail();
    try {
      const record = parseJson(
        await readFile(path.join(jobs, entry.name, 'job.json'), 65536, true),
      );
      if (!obj(record) || record.schemaVersion !== 1 || record.kind !== 'acclimate-native-job')
        fail();
      if (record.cwd !== null && record.cwd !== undefined) {
        if (typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd)) fail();
        roots.push(record.cwd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return roots;
}

export async function exportReviewEvidence(options: {
  configPath?: string;
  readConfigPath?: string;
  handoff: EvaluationHandoff;
  outputDirectory: string;
  selection?: ArtifactSelectionV1;
  toReviewArtifact?: ReviewMapper;
}): Promise<ReviewExportResult> {
  const selection = parseArtifactSelection(options.selection ?? { schemaVersion: 1, entries: [] });
  if (selection.entries.length && (!options.configPath || !options.toReviewArtifact))
    fail('artifact.selection_invalid');
  const remote = await authority(options.configPath, options.readConfigPath, options.handoff);
  const expectedPairs = inventory(remote.comparison.expectedCases);
  const expected = new Set(expectedPairs.map(pairKey));
  if (selection.entries.some((x) => !expected.has(pairKey(x)))) fail('artifact.selection_invalid');
  const selected = new Map(selection.entries.map((x) => [identityKey(x), x]));
  const configFile = options.configPath ?? options.readConfigPath!;
  const forbidden = [path.dirname(path.resolve(configFile))];
  if ('journalRoot' in remote.config) forbidden.push(remote.config.journalRoot);
  let journal: Awaited<ReturnType<typeof openJournal>> | undefined;
  let inspection: ReviewManifestV1['localInspection'] = selection.entries.length
    ? 'unavailable'
    : 'not_requested';
  let index: IndexEntry[] | undefined;
  try {
    if (selection.entries.length && 'journalRoot' in remote.config) {
      const scope: JournalScope = {
        serviceUrl: remote.config.serviceUrl,
        workspaceId: remote.handoff.workspaceId,
        bundleId: remote.handoff.bundleId,
        requestId: remote.request.id,
        evaluatorPrincipalId: remote.config.evaluatorPrincipalId,
      };
      journal = await existingJournal(remote.config.journalRoot, scope);
      if (journal) {
        const state = await journal.read();
        if (state) {
          if (
            state.attemptId !== remote.request.attemptId ||
            state.comparisonId !== remote.comparison.id ||
            remote.config.evaluatorPrincipalId !== remote.request.evaluatorPrincipal
          )
            fail();
          let reportAvailable = !!state.report || !!state.wireBodies?.submit;
          if (state.wireBodies?.submit?.file === 'submit-body.json') {
            try {
              await lstat(path.join(journal.directory, 'submit-body.json'));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') reportAvailable = false;
              else throw error;
            }
          }
          if (reportAvailable) {
            let reportText: string;
            try {
              reportText = await journal.readBody('submit', state);
            } catch {
              fail();
            }
            const reportBytes = encoder.encode(reportText);
            const report = parseJson(reportBytes);
            if (
              !obj(report) ||
              !equal(body(report as unknown as ComparisonRequest), body(remote.comparison))
            )
              fail();
            const localIndex = await journal.readArtifactIndex();
            if (localIndex) {
              index = indexEntries(localIndex, remote.request, remote.comparison, reportBytes);
              inspection = 'validated';
            }
          }
        }
        forbidden.push(...(await preparedRoots(journal.directory)));
      }
    }
    // Validate every selected original before releasing any payload to app code.
    // A later corrupt role must not permit an earlier mapper invocation.
    const registeredRoles = new Map(index?.map((entry) => [identityKey(entry), entry]));
    const readOriginal = async (registered: IndexEntry): Promise<{ value: Json } | undefined> => {
      let original: Uint8Array;
      try {
        original = await readFile(
          path.join(journal!.directory, registered.file),
          MAX_PRIVATE_FILE,
          true,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (original.length !== registered.bytes || !matchesDigest(original, registered.sha256))
        fail('artifact.hash_mismatch');
      const envelope = parseJson(original);
      const artifactIdentity = {
        requestId: remote.request.id,
        attemptId: remote.request.attemptId!,
        caseId: registered.caseId,
        repetition: registered.repetition,
        side: registered.side,
        versionId: registered.versionId,
        digest: registered.digest,
        role: registered.role,
      };
      if (
        !keys(envelope, ['schemaVersion', 'identity', 'value']) ||
        envelope.schemaVersion !== 1 ||
        !equal(envelope.identity, artifactIdentity)
      )
        fail();
      const value = envelope.value;
      assertJson(value);
      if (encoder.encode(JSON.stringify(value)).length > MAX_FILE) fail();
      return { value };
    };
    if (index) {
      for (const choice of selection.entries) {
        const registered = registeredRoles.get(identityKey(choice));
        if (registered) await readOriginal(registered);
      }
    }
    const destination = await safeOutputDirectory(options.outputDirectory, forbidden);
    const pending: Array<{ filename: string; bytes: Uint8Array }> = [];
    let total = 0;
    const counts = {
      required: selection.entries.filter((x) => x.required).length,
      exportedRequired: 0,
      optionalMissing: 0,
    };
    const manifest: ReviewManifestV1 = {
      schemaVersion: 1,
      kind: 'acclimate-review-export',
      workspaceId: remote.handoff.workspaceId,
      bundleId: remote.handoff.bundleId,
      requestId: remote.request.id,
      attemptId: remote.request.attemptId!,
      comparisonId: remote.comparison.id,
      parent: remote.projection.parent,
      candidate: remote.projection.candidate,
      localInspection: inspection,
      projection: { file: 'comparison-review.json', sha256: '', bytes: 0 },
      entries: [],
      exporter: { name: 'acclimate-evidence', version: '1' },
    };
    for (const pair of expectedPairs)
      for (const side of SIDES) {
        const roles: ReviewManifestV1['entries'][number]['roles'] = [];
        for (const role of ROLES) {
          const identity = { ...pair, side, role };
          const choice = selected.get(identityKey(identity));
          const row: ReviewManifestV1['entries'][number]['roles'][number] = {
            role,
            selected: !!choice,
            required: choice?.required ?? false,
            availability: 'not_shared',
          };
          if (choice) {
            const registered = registeredRoles.get(identityKey(identity));
            if (!index) row.availability = 'unavailable';
            else if (!registered) row.availability = 'missing';
            else {
              // Revalidate after the preflight without retaining up to 4000
              // private MiB-sized payloads in memory. The journal stays locked.
              const original = await readOriginal(registered);
              if (!original) row.availability = 'missing';
              else {
                const value = original.value;
                let mapped;
                try {
                  mapped = await options.toReviewArtifact!({
                    identity: {
                      requestId: remote.request.id,
                      attemptId: remote.request.attemptId!,
                      comparisonId: remote.comparison.id,
                      versionId: registered.versionId,
                      digest: registered.digest,
                      ...identity,
                    },
                    value: structuredClone(value),
                  });
                } catch {
                  fail('artifact.mapper_failed');
                }
                if (mapped !== null) {
                  let bytes: Uint8Array;
                  if (
                    keys(mapped, ['mediaType', 'value']) &&
                    mapped.mediaType === 'application/json'
                  ) {
                    assertJson(mapped.value);
                    bytes = encode(mapped.value);
                  } else if (
                    keys(mapped, ['mediaType', 'text']) &&
                    mapped.mediaType === 'text/plain' &&
                    typeof mapped.text === 'string' &&
                    !/[\ud800-\udfff]/u.test(mapped.text)
                  )
                    bytes = encoder.encode(mapped.text);
                  else fail('artifact.mapper_failed');
                  if (bytes.length > MAX_FILE) fail('artifact.mapper_failed');
                  const filename = `artifact-${createHash('sha256').update(identityKey(identity)).digest('hex')}${mapped.mediaType === 'application/json' ? '.json' : '.txt'}`;
                  row.availability = 'exported';
                  row.file = {
                    path: filename,
                    sha256: digest(bytes),
                    bytes: bytes.length,
                    mediaType: mapped.mediaType as 'application/json' | 'text/plain',
                  };
                  pending.push({ filename, bytes });
                  total += bytes.length;
                  if (total > MAX_EXPORT) fail();
                }
              }
            }
            if (row.availability === 'exported') {
              if (choice.required) counts.exportedRequired++;
            } else if (choice.required) fail('artifact.missing');
            else counts.optionalMissing++;
          }
          roles.push(row);
        }
        manifest.entries.push({ ...pair, side, roles });
      }
    const projectedBytes = encode(remote.projection);
    manifest.projection = {
      file: 'comparison-review.json',
      sha256: digest(projectedBytes),
      bytes: projectedBytes.length,
    };
    const manifestBytes = encode(manifest);
    if (
      projectedBytes.length > MAX_MANIFEST ||
      manifestBytes.length > MAX_MANIFEST ||
      total + projectedBytes.length + manifestBytes.length > MAX_EXPORT
    )
      fail();
    await mkdir(destination, { mode: 0o700 });
    try {
      for (const file of pending)
        await writeFile(path.join(destination, file.filename), file.bytes);
      await writeFile(path.join(destination, 'comparison-review.json'), projectedBytes);
      await writeFile(path.join(destination, 'manifest.json'), manifestBytes);
      const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return {
      schemaVersion: 1,
      status: 'exported',
      manifestPath: path.join(destination, 'manifest.json'),
      localInspection: inspection,
      selection: counts,
    };
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError('artifact.integrity', {
      phase: 'export',
      executionState: 'finished',
    });
  } finally {
    if (journal) await journal.close();
  }
}

export async function verifyReviewExport(options: {
  manifestPath: string;
  online?: { readConfigPath: string; expectedHandoff: EvaluationHandoff };
}): Promise<ReviewVerificationResult> {
  try {
    const manifestBytes = await readFile(options.manifestPath, MAX_MANIFEST);
    const m = parseJson(manifestBytes);
    if (
      !keys(m, [
        'schemaVersion',
        'kind',
        'workspaceId',
        'bundleId',
        'requestId',
        'attemptId',
        'comparisonId',
        'parent',
        'candidate',
        'localInspection',
        'projection',
        'entries',
        'exporter',
      ]) ||
      m.schemaVersion !== 1 ||
      m.kind !== 'acclimate-review-export' ||
      !['not_requested', 'validated', 'unavailable'].includes(m.localInspection as string) ||
      !Array.isArray(m.entries) ||
      m.entries.length > 2000 ||
      !keys(m.exporter, ['name', 'version']) ||
      m.exporter.name !== 'acclimate-evidence' ||
      !utf8(m.exporter.version, 128)
    )
      fail();
    for (const k of ['workspaceId', 'bundleId', 'requestId', 'attemptId', 'comparisonId'])
      if (!utf8(m[k], 1024)) fail();
    for (const side of SIDES) {
      const x = m[side];
      if (!keys(x, ['versionId', 'digest']) || !utf8(x.versionId, 128) || !validDigest(x.digest))
        fail();
    }
    if (
      !keys(m.projection, ['file', 'sha256', 'bytes']) ||
      m.projection.file !== 'comparison-review.json' ||
      !validDigest(m.projection.sha256) ||
      !integer(m.projection.bytes) ||
      m.projection.bytes > MAX_MANIFEST
    )
      fail();
    const directory = path.dirname(path.resolve(options.manifestPath));
    const projectedBytes = await readFile(
      path.join(directory, 'comparison-review.json'),
      MAX_MANIFEST,
    );
    if (
      projectedBytes.length !== m.projection.bytes ||
      !matchesDigest(projectedBytes, m.projection.sha256)
    )
      fail('artifact.hash_mismatch');
    const p = parseJson(projectedBytes);
    if (
      !keys(p, [
        'schemaVersion',
        'kind',
        'workspaceId',
        'bundleId',
        'requestId',
        'attemptId',
        'comparisonId',
        'parent',
        'candidate',
        'complete',
        'expectedCases',
        'results',
        'missingness',
      ]) ||
      p.schemaVersion !== 1 ||
      p.kind !== 'acclimate-comparison-review' ||
      typeof p.complete !== 'boolean' ||
      !Array.isArray(p.results) ||
      !obj(p.missingness)
    )
      fail();
    for (const k of [
      'workspaceId',
      'bundleId',
      'requestId',
      'attemptId',
      'comparisonId',
      'parent',
      'candidate',
    ])
      if (!equal(m[k], p[k])) fail();
    const expected = inventory(p.expectedCases);
    // Recreate the projection to validate its allowed scalar/status/coverage schema.
    const fakeRequest = { id: p.requestId, attemptId: p.attemptId } as Evaluation;
    const fakeComparison = {
      id: p.comparisonId,
      parentVersionId: (p.parent as any).versionId,
      parentDigest: (p.parent as any).digest,
      candidateVersionId: (p.candidate as any).versionId,
      candidateDigest: (p.candidate as any).digest,
      expectedCases: p.expectedCases,
      results: p.results,
      complete: p.complete,
    } as Comparison;
    const rebuilt = projection(
      { workspaceId: p.workspaceId, bundleId: p.bundleId } as EvaluationHandoff,
      fakeRequest,
      fakeComparison,
    );
    if (!equal(p, rebuilt)) fail();
    const expectedRows = new Set(
      expected.flatMap((x) => SIDES.map((side) => identityKey({ ...x, side }))),
    );
    const seen = new Set<string>();
    const filenames = new Set(['manifest.json', 'comparison-review.json']);
    let hasSelection = false;
    let total = manifestBytes.length + projectedBytes.length;
    for (const value of m.entries) {
      if (
        !keys(value, ['caseId', 'repetition', 'side', 'roles']) ||
        !Array.isArray(value.roles) ||
        value.roles.length !== 2
      )
        fail();
      const row = value as unknown as ReviewManifestV1['entries'][number];
      const id = identityKey(row);
      if (!expectedRows.has(id) || seen.has(id)) fail();
      seen.add(id);
      const seenRoles = new Set<string>();
      for (const role of row.roles) {
        if (
          !keys(role, ['role', 'selected', 'required', 'availability'], ['file']) ||
          !ROLES.includes(role.role) ||
          seenRoles.has(role.role) ||
          typeof role.selected !== 'boolean' ||
          typeof role.required !== 'boolean' ||
          (role.required && !role.selected) ||
          !['exported', 'not_shared', 'missing', 'unavailable'].includes(role.availability)
        )
          fail();
        seenRoles.add(role.role);
        if (role.selected) {
          hasSelection = true;
          if (
            m.localInspection === 'not_requested' ||
            (m.localInspection === 'unavailable') !== (role.availability === 'unavailable')
          )
            fail();
        }
        if (!role.selected && (role.required || role.availability !== 'not_shared')) fail();
        if (role.required && role.availability !== 'exported') fail();
        if (role.availability !== 'exported') {
          if (role.file !== undefined) fail();
          continue;
        }
        if (
          !role.selected ||
          !keys(role.file, ['path', 'sha256', 'bytes', 'mediaType']) ||
          !/^artifact-[a-f0-9]{64}\.(json|txt)$/.test(role.file.path) ||
          !validDigest(role.file.sha256) ||
          !integer(role.file.bytes) ||
          role.file.bytes > MAX_FILE ||
          !['application/json', 'text/plain'].includes(role.file.mediaType)
        )
          fail();
        const filename = `artifact-${createHash('sha256')
          .update(identityKey({ ...row, role: role.role }))
          .digest('hex')}${role.file.mediaType === 'application/json' ? '.json' : '.txt'}`;
        if (role.file.path !== filename || filenames.has(filename.toLowerCase())) fail();
        filenames.add(filename.toLowerCase());
        const bytes = await readFile(path.join(directory, filename), MAX_FILE);
        if (bytes.length !== role.file.bytes || !matchesDigest(bytes, role.file.sha256))
          fail('artifact.hash_mismatch');
        if (role.file.mediaType === 'application/json') assertJson(parseJson(bytes));
        else decoder.decode(bytes);
        total += bytes.length;
      }
    }
    if (
      seen.size !== expectedRows.size ||
      total > MAX_EXPORT ||
      (!hasSelection && m.localInspection !== 'not_requested')
    )
      fail();
    const actualFiles = await readdir(directory);
    if (
      actualFiles.length !== filenames.size ||
      actualFiles.some((x) => !filenames.has(x.toLowerCase()))
    )
      fail();
    let provenance: ReviewVerificationResult['provenance'] = 'self_consistent';
    if (options.online) {
      const remote = await authority(
        undefined,
        options.online.readConfigPath,
        options.online.expectedHandoff,
      );
      if (!equal(remote.projection, p)) fail('evidence.identity_mismatch');
      provenance = 'online_scalar_binding';
    }
    return {
      schemaVersion: 1,
      status: 'verified',
      provenance,
      comparisonId: m.comparisonId as string,
      executionAttested: false,
    };
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError('artifact.integrity', {
      phase: 'export',
      executionState: 'finished',
    });
  }
}
