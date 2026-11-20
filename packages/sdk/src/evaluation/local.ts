import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TaskExecutionError } from '../compare.js';
import type { BundleFile, BundlePayload, Comparison, ComparisonRequest, EvaluationDescriptor, VerifiedVersion } from '../types.js';
import { DeliveryError, validatePayload } from '../validation.js';
import { analyzeComparison, policyAnalysisMetric, type MetricAnalysis } from './analysis.js';
import { parseCommandJson } from './cli-intents.js';
import type { CaseSelection, RunControls, RunSummary } from './controls.js';
import { runWarnings, selectedCaseIds } from './controls.js';
import { assertEvaluationOutput, captureDefinition, OutputValidationError } from './definition.js';
import { CallbackCancelled, EvaluationError } from './errors.js';
import { checkComparison, parseEvaluationPolicy, type PolicyVerdict } from './policy.js';
import { atomicPrivateWrite, privateDirectory } from './private-state.js';
import { reportedUsage, runTrials, type TrialArtifact } from './trials.js';
import type { EvaluationApp, ExecutionContext } from './types.js';

/**
 * A local input problem: an unreadable payload, a nonempty --out folder or a
 * missing --live. It is a usage error (exit 1) with a message for the terminal.
 */
export class LocalRunError extends EvaluationError {
  constructor(message: string, field?: string) {
    super('usage.invalid_flag', { message, reason: message, ...(field ? { field } : {}) });
    this.name = 'LocalRunError';
  }
}

const MAX_PAYLOAD_FILE = 2 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_TEXT = 256 * 1024;

export interface LocalPayload {
  payload: BundlePayload;
  /** The path the developer supplied, resolved. */
  source: string;
  form: 'file' | 'directory';
  digest: string;
}

/**
 * The digest the service would assign: SHA-256 of the canonical payload JSON
 * plus a newline. Field order matches the service encoder.
 */
export function localPayloadDigest(payload: BundlePayload): string {
  const canonical = {
    schemaVersion: payload.schemaVersion,
    files: payload.files.map((file) => ({ path: file.path, kind: file.kind, text: file.text })),
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical) + '\n').digest('hex');
}

/** Directory layout: `skills/**` → skill, `memory/**` → memory, everything else → instruction. */
export function localFileKind(relativePath: string): BundleFile['kind'] {
  const [first] = relativePath.split('/');
  return first === 'skills' ? 'skill' : first === 'memory' ? 'memory' : 'instruction';
}

function explainPayloadError(error: unknown, payload: BundlePayload): never {
  // Re-run the shared validator per file so the message can name the culprit.
  for (const file of payload.files) {
    try {
      validatePayload({ schemaVersion: 1, files: [file] });
    } catch {
      throw new LocalRunError(
        `${file.path}: not a valid bundle file. Paths use letters, digits, ".", "_", "-" and "/" (at most 240 characters, no "..", no reserved device names); each file holds at most 256 KiB of UTF-8 text.`,
      );
    }
  }
  const message = error instanceof DeliveryError ? error.message : 'Invalid bundle payload';
  throw new LocalRunError(
    `${message}. A payload holds 1–${MAX_FILES} files, at most 1 MiB of text in total, and no two paths that differ only by case or where one is a folder of the other.`,
  );
}

async function payloadFromDirectory(root: string): Promise<BundlePayload> {
  const files: BundleFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink())
        throw new LocalRunError(`${relative}: symbolic links are not read. Copy the file into the folder.`);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) throw new LocalRunError(`${relative}: only regular files can be bundle files.`);
      if (files.length === MAX_FILES)
        throw new LocalRunError(`The folder has more than ${MAX_FILES} files. A bundle holds at most ${MAX_FILES}.`);
      const info = await lstat(absolute);
      if (info.size > MAX_TEXT)
        throw new LocalRunError(`${relative}: ${info.size} bytes exceeds the 256 KiB bundle file limit.`);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute));
      } catch {
        throw new LocalRunError(`${relative}: bundle files must be UTF-8 text.`);
      }
      files.push({ path: relative, kind: localFileKind(relative), text });
    }
  };
  await walk(root);
  if (!files.length)
    throw new LocalRunError(
      `${root} has no files. Add an instruction file such as AGENTS.md, skills/<name>/SKILL.md or memory/<file>.`,
    );
  return { schemaVersion: 1, files };
}

/** Read a payload JSON file or map a folder of instruction, skill and memory files. */
export async function loadLocalPayload(target: string): Promise<LocalPayload> {
  const source = path.resolve(target);
  let info;
  try {
    info = await lstat(source);
  } catch {
    throw new LocalRunError(`Cannot read ${target}. Supply a payload JSON file or a folder of bundle files.`);
  }
  let payload: unknown;
  let form: LocalPayload['form'];
  if (info.isDirectory()) {
    form = 'directory';
    payload = await payloadFromDirectory(source);
  } else if (info.isFile()) {
    form = 'file';
    if (info.size > MAX_PAYLOAD_FILE)
      throw new LocalRunError(`${target} exceeds ${MAX_PAYLOAD_FILE} bytes.`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(source));
      payload = parseCommandJson(text);
    } catch {
      throw new LocalRunError(`${target} is not valid UTF-8 JSON (duplicate keys are rejected).`);
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      (payload as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((payload as { files?: unknown }).files)
    )
      throw new LocalRunError(
        `${target} must be {"schemaVersion":1,"files":[{"path","kind","text"}]}, where kind is instruction, skill or memory.`,
      );
    for (const [index, file] of ((payload as { files: unknown[] }).files).entries())
      if (
        !file ||
        typeof file !== 'object' ||
        Object.keys(file).some((key) => !['path', 'kind', 'text'].includes(key)) ||
        !['instruction', 'skill', 'memory'].includes((file as BundleFile).kind) ||
        typeof (file as BundleFile).text !== 'string' ||
        typeof (file as BundleFile).path !== 'string'
      )
        throw new LocalRunError(
          `${target}: files[${index}] needs exactly path, kind (instruction, skill or memory) and text strings.`,
        );
  } else {
    throw new LocalRunError(`${target} is not a regular file or folder.`);
  }
  try {
    validatePayload(payload);
  } catch (error) {
    explainPayloadError(error, payload as BundlePayload);
  }
  return { payload, source, form, digest: localPayloadDigest(payload) };
}

const uuidFrom = (seed: string) => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/** A stable placeholder bundle ID for local versions. It never names a service bundle. */
export const LOCAL_BUNDLE_ID = uuidFrom('acclimate-local-bundle');

/**
 * Build the same VerifiedVersion shape the service runner passes to execute.
 * IDs are derived from the digest so a repeated payload keeps its ID.
 */
export function localVersion(payload: BundlePayload, parent?: VerifiedVersion): VerifiedVersion {
  const digest = localPayloadDigest(payload);
  const id = uuidFrom('acclimate-local-version\n' + digest);
  return {
    version: {
      id,
      bundleId: LOCAL_BUNDLE_ID,
      parentVersionId: parent && parent.version.id !== id ? parent.version.id : null,
      digest,
      createdAt: new Date().toISOString(),
    },
    payload: structuredClone(payload),
    resolvedAt: Date.now(),
    stale: false,
  };
}

/** Resolve the deepest existing ancestor so private-directory checks see a real path. */
async function canonicalTarget(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function createLocalRunDirectory(out?: string, base = process.cwd()): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = await canonicalTarget(
    out ? path.resolve(base, out) : path.join(base, '.acclimate', 'local', `${stamp}-${randomUUID().slice(0, 8)}`),
  );
  try {
    const existing = await readdir(target);
    if (existing.length) throw new LocalRunError(`${target} is not empty. Choose a new --out folder.`, '--out');
  } catch (error) {
    if (error instanceof LocalRunError) throw error;
  }
  try {
    await privateDirectory(target);
  } catch {
    throw new LocalRunError(
      `Cannot create a private folder at ${target}. It must be owned by you with mode 0700; choose another --out folder.`,
      '--out',
    );
  }
  return target;
}

export interface LocalDiagnostic {
  caseId: string;
  repetition: number;
  side: 'parent' | 'candidate';
  phase: 'execute' | 'grade' | 'output';
  /** Developer-facing detail. Local only: the service never receives it. */
  detail: string;
}

export interface LocalComparisonOptions {
  app: EvaluationApp<any, any, any>;
  parent: BundlePayload;
  candidate: BundlePayload;
  /** Required exactly when the definition's execution is `live`. */
  allowLive?: boolean;
  controls?: RunControls;
  signal?: AbortSignal;
  /** A private, empty folder for job directories and artifacts. */
  directory: string;
}

export interface LocalComparisonResult {
  schemaVersion: 1;
  authoritative: false;
  descriptor: EvaluationDescriptor;
  versions: { parent: VerifiedVersion['version']; candidate: VerifiedVersion['version'] };
  comparison: Comparison;
  binding: {
    parentVersionId: string;
    candidateVersionId: string;
    parentDigest: string;
    candidateDigest: string;
    requestId: string;
    attemptId: string;
    comparisonId: string;
    submitter: string;
  };
  summary: RunSummary;
  callbacksStarted: number;
  diagnostics: LocalDiagnostic[];
  warnings: string[];
}

function describeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const frame = error.stack
        ?.split('\n')
        .slice(1)
        .find((line) => /\bat\b/.test(line) && !line.includes('node:internal'))
        ?.trim();
      return `${error.name}: ${error.message}`.slice(0, 500) + (frame ? ` (${frame.slice(0, 300)})` : '');
    }
    return `Thrown value: ${String(error)}`.slice(0, 500);
  } catch {
    return 'Unreadable thrown value';
  }
}

function assertLive(app: EvaluationApp<any, any, any>, allowLive: boolean | undefined) {
  const live = captureDefinition(app).execution === 'live';
  if (live !== (allowLive === true))
    throw new LocalRunError(
      live
        ? 'This evaluator calls live models or services. Add --live to confirm the run may spend money.'
        : 'This evaluator is model-free. Omit --live.',
      '--live',
    );
}

/**
 * Run the service comparison's trial schedule on two local payloads. Nothing
 * contacts the service, and the result is never release evidence.
 */
export async function runLocalComparison(options: LocalComparisonOptions): Promise<LocalComparisonResult> {
  assertLive(options.app, options.allowLive);
  const captured = captureDefinition(options.app);
  validatePayload(options.parent);
  validatePayload(options.candidate);
  const parent = localVersion(options.parent);
  const candidate = localVersion(options.candidate, parent);
  const requestId = randomUUID(),
    attemptId = randomUUID();
  const directory = options.directory;
  let callbacksStarted = 0;
  const diagnostics: LocalDiagnostic[] = [];
  const armOf = async (jobDirectory: string) =>
    JSON.parse(await readFile(path.join(jobDirectory, 'binding.json'), 'utf8')) as {
      caseId: string;
      repetition: number;
      side: 'parent' | 'candidate';
    };
  const { results, summary } = await runTrials({
    captured,
    requestId,
    attemptId,
    versions: [parent, candidate],
    jobsRoot: path.join(directory, 'jobs'),
    signal: options.signal ?? new AbortController().signal,
    controls: options.controls,
    captureCallbackErrors: true,
    hooks: {
      checkpoint: async () => undefined,
      assertOwned: () => undefined,
      writeArtifact: async (identity, value): Promise<TrialArtifact> => {
        const body = JSON.stringify({ schemaVersion: 1, identity, value });
        const sha256 = createHash('sha256').update(body).digest('hex');
        // Identical artifacts share one content-addressed file.
        await atomicPrivateWrite(path.join(directory, 'artifacts', `${sha256}.json`), body + '\n');
        return { sha256, bytes: Buffer.byteLength(body) };
      },
      discardArtifacts: async () => undefined,
      recordOutputError: async (jobDirectory, error) => {
        const file = path.join(jobDirectory, 'output-validation.json');
        await atomicPrivateWrite(file, JSON.stringify({ field: error.field, reason: error.reason }));
        diagnostics.push({ ...(await armOf(jobDirectory)), phase: 'output', detail: `${error.field}: ${error.reason}` });
        return file;
      },
      saveCallbackError: async (jobDirectory, phase, error) => {
        const detail = describeError(error);
        const file = path.join(jobDirectory, 'callback-error.json');
        await atomicPrivateWrite(file, JSON.stringify({ phase, detail }) + '\n');
        diagnostics.push({ ...(await armOf(jobDirectory)), phase, detail });
        return file;
      },
      isFatal: () => false,
      onCallbackStarted: () => {
        callbacksStarted++;
      },
    },
  });
  const descriptor = captured.descriptor;
  const request: ComparisonRequest = {
    parentVersionId: parent.version.id,
    candidateVersionId: candidate.version.id,
    parentDigest: parent.version.digest,
    candidateDigest: candidate.version.digest,
    datasetRevision: descriptor.datasetRevision,
    graderRevision: descriptor.graderRevision,
    runtime: { ...descriptor.runtime },
    evaluation: { requestId, attemptId },
    expectedCases: descriptor.expectedCases.map((key) => ({ ...key })),
    results,
  };
  const comparison: Comparison = {
    ...request,
    id: randomUUID(),
    complete: results.every((pair) =>
      [pair.parent, pair.candidate].every(
        (outcome) => outcome.gradingStatus === 'scored' && outcome.executionStatus !== 'infrastructure_failed',
      ),
    ),
    submitter: 'local',
    createdAt: new Date().toISOString(),
  };
  diagnostics.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : a.repetition - b.repetition));
  return {
    schemaVersion: 1,
    authoritative: false,
    descriptor: structuredClone(descriptor),
    versions: { parent: parent.version, candidate: candidate.version },
    comparison,
    binding: {
      parentVersionId: parent.version.id,
      candidateVersionId: candidate.version.id,
      parentDigest: parent.version.digest,
      candidateDigest: candidate.version.digest,
      requestId,
      attemptId,
      comparisonId: comparison.id,
      submitter: 'local',
    },
    summary,
    callbacksStarted,
    diagnostics,
    warnings: runWarnings(summary, { parent: parent.version.digest, candidate: candidate.version.digest }),
  };
}

export type LocalScores = Pick<MetricAnalysis, 'counts' | 'summary' | 'cases' | 'evidenceGaps'>;

/** Score a local comparison and, when supplied, apply a policy as advice only. */
export function scoreLocalComparison(
  result: LocalComparisonResult,
  policyText?: string,
): { scores: LocalScores; policy: (PolicyVerdict & { advisory: true }) | null } {
  const policy = policyText === undefined ? null : parseEvaluationPolicy(policyText, result.descriptor);
  const evidence = {
    comparison: result.comparison,
    expectedDescriptor: result.descriptor,
    expectedBinding: result.binding,
  };
  const metric = policy?.policy.metric;
  const [analysis] = analyzeComparison({
    ...evidence,
    metrics: metric ? [policyAnalysisMetric(metric)] : undefined,
  }).metrics;
  const scores: LocalScores = {
    counts: analysis.counts,
    summary: analysis.summary,
    cases: analysis.cases,
    ...(analysis.evidenceGaps ? { evidenceGaps: analysis.evidenceGaps } : {}),
  };
  if (!policy) return { scores, policy: null };
  const verdict = checkComparison({ ...evidence, policy: policy.policy, policyDigest: policy.sha256 });
  return { scores, policy: { ...verdict, advisory: true } };
}

export const LOCAL_NOTICE =
  'Local comparison: not a release receipt. The service did not verify these versions, this evidence or this policy result. Run compare against the service to gate a release.';

/** The report written beside local artifacts. It is never accepted as release evidence. */
export function localReport(
  result: LocalComparisonResult,
  scored: ReturnType<typeof scoreLocalComparison>,
  sources: { parent: LocalPayload; candidate: LocalPayload },
  directory: string,
) {
  return {
    schemaVersion: 1,
    kind: 'acclimate.local-comparison',
    authoritative: false,
    releaseReceipt: false,
    notice: LOCAL_NOTICE,
    createdAt: result.comparison.createdAt,
    descriptor: result.descriptor,
    parent: { ...result.versions.parent, source: sources.parent.source, form: sources.parent.form },
    candidate: { ...result.versions.candidate, source: sources.candidate.source, form: sources.candidate.form },
    run: result.summary,
    callbacksStarted: result.callbacksStarted,
    scores: scored.scores,
    policy: scored.policy,
    warnings: result.warnings,
    diagnostics: result.diagnostics,
    comparison: result.comparison,
    replay: {
      description:
        'Local evidence cannot be uploaded: the service only accepts results produced under an attempt it issued for versions it stores. Replay the same candidate against the service instead. The service compares it with the current parent on its channel; check that the digest of that parent matches parent.digest to reproduce this comparison.',
      candidatePayload: path.join(directory, 'candidate.payload.json'),
      command: `compare --config CONFIG --bundle BUNDLE_ID --channel CHANNEL --payload ${path.join(directory, 'candidate.payload.json')} --name RUN_NAME`,
      parentDigest: result.versions.parent.digest,
    },
  };
}

export async function writeLocalReport(
  directory: string,
  report: ReturnType<typeof localReport>,
  sources: { parent: LocalPayload; candidate: LocalPayload },
): Promise<string> {
  await atomicPrivateWrite(path.join(directory, 'parent.payload.json'), JSON.stringify(sources.parent.payload, null, 2) + '\n');
  await atomicPrivateWrite(
    path.join(directory, 'candidate.payload.json'),
    JSON.stringify(sources.candidate.payload, null, 2) + '\n',
  );
  const file = path.join(directory, 'local-report.json');
  await atomicPrivateWrite(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

/* ------------------------------------------------------------------ try --- */

export interface TryIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}
export interface TryCaseResult {
  caseId: string;
  execute: {
    status: 'ok' | 'failed';
    durationMs: number;
    output?: unknown;
    executionStatus?: string;
    usage?: unknown;
    error?: string;
    issues: TryIssue[];
  };
  grade: {
    status: 'ok' | 'failed' | 'skipped';
    durationMs: number;
    reward?: number;
    explanation?: unknown;
    error?: string;
    issues: TryIssue[];
  };
}
export interface TryResult {
  schemaVersion: 1;
  ok: boolean;
  payload: { digest: string; source: string | null };
  cases: TryCaseResult[];
}

/** A one-file placeholder used when `try` runs without --payload. */
export const PLACEHOLDER_PAYLOAD: BundlePayload = {
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: '# Placeholder instructions for acclimate-eval try\n' }],
};

const EXECUTION_KEYS = ['output', 'executionStatus', 'error', 'outputRef', 'usage'];
const GRADE_KEYS = ['reward', 'error', 'explanation'];

function inspectJson(value: unknown, field: string, issues: TryIssue[]) {
  try {
    assertEvaluationOutput(value);
  } catch (error) {
    if (error instanceof OutputValidationError)
      issues.push({ severity: 'error', field: error.field.replace(/^output/, field), message: error.reason });
    else issues.push({ severity: 'error', field, message: 'Return a JSON value.' });
  }
}

/** Check the shapes the runner accepts. Problems here become silent gaps in a real run. */
export function inspectExecution(value: unknown): TryIssue[] {
  const issues: TryIssue[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ severity: 'error', field: 'execute()', message: 'Return an object such as { output }.' });
    return issues;
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!EXECUTION_KEYS.includes(key))
      issues.push({ severity: 'warning', field: key, message: `Ignored. execute() returns ${EXECUTION_KEYS.join(', ')}.` });
  if (!Object.hasOwn(result, 'output'))
    issues.push({ severity: 'error', field: 'output', message: 'Missing. Return the agent output as output.' });
  else inspectJson(result.output, 'output', issues);
  if (result.executionStatus !== undefined && !['completed', 'task_failed'].includes(result.executionStatus as string))
    issues.push({
      severity: 'error',
      field: 'executionStatus',
      message: 'Use "completed" or "task_failed", or omit it.',
    });
  if (result.usage !== undefined && result.usage !== null) {
    try {
      reportedUsage(result.usage);
    } catch (error) {
      if (!(error instanceof OutputValidationError)) throw error;
      issues.push({
        severity: 'error',
        field: error.field,
        message: `${error.reason} The runner records this arm as output_invalid.`,
      });
    }
  }
  if (
    result.outputRef !== undefined &&
    result.outputRef !== null &&
    (typeof result.outputRef !== 'string' ||
      Buffer.byteLength(result.outputRef) > 1024 ||
      /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(result.outputRef))
  )
    issues.push({ severity: 'error', field: 'outputRef', message: 'Use a string of at most 1024 bytes without control characters.' });
  if (result.error !== undefined && result.error !== null && typeof result.error !== 'string')
    issues.push({ severity: 'warning', field: 'error', message: 'Use a string or null.' });
  return issues;
}

export function inspectGrade(value: unknown): TryIssue[] {
  const issues: TryIssue[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ severity: 'error', field: 'grade()', message: 'Return an object such as { reward }.' });
    return issues;
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!GRADE_KEYS.includes(key))
      issues.push({ severity: 'warning', field: key, message: `Ignored. grade() returns ${GRADE_KEYS.join(', ')}.` });
  if (typeof result.reward !== 'number' || !Number.isFinite(result.reward))
    issues.push({ severity: 'error', field: 'reward', message: 'Return a finite number. The runner records a grading failure otherwise.' });
  else if (result.reward < 0 || result.reward > 1)
    issues.push({
      severity: 'warning',
      field: 'reward',
      message: `${result.reward} is outside 0–1. Comparisons accept any finite reward, but thresholds and connected-learning policies expect 0–1.`,
    });
  if (result.explanation !== undefined) inspectJson(result.explanation, 'explanation', issues);
  return issues;
}

export interface TryOptions {
  app: EvaluationApp<any, any, any>;
  payload?: LocalPayload;
  /** Case IDs to run; defaults to the first case. Accepts the same selection as runs. */
  selection?: CaseSelection;
  allowLive?: boolean;
  caseTimeoutMs?: number;
  directory: string;
  signal?: AbortSignal;
}

/** Run execute and grade once per selected case and validate every returned shape. */
export async function tryEvaluation(options: TryOptions): Promise<TryResult> {
  assertLive(options.app, options.allowLive);
  const captured = captureDefinition(options.app);
  const caseIds = captured.cases.map((item) => item.caseId as string);
  const chosen = options.selection ? selectedCaseIds(options.selection, caseIds) : new Set(caseIds.slice(0, 1));
  const payload = options.payload?.payload ?? PLACEHOLDER_PAYLOAD;
  const verified = localVersion(payload);
  const requestId = randomUUID(),
    attemptId = randomUUID();
  const signal = options.signal ?? new AbortController().signal;
  const timed = async <T>(start: (signal: AbortSignal) => Promise<T>) => {
    const local = new AbortController();
    const begin = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => start(AbortSignal.any([signal, local.signal])));
    try {
      const value = await (options.caseTimeoutMs
        ? Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                local.abort();
                reject(new LocalRunError(`Timed out after ${options.caseTimeoutMs} ms; the signal was aborted.`));
              }, options.caseTimeoutMs);
            }),
          ])
        : work);
      return { value, durationMs: Date.now() - begin };
    } finally {
      if (timer) clearTimeout(timer);
      work.catch(() => undefined);
    }
  };
  const cases: TryCaseResult[] = [];
  for (const item of captured.cases) {
    if (!chosen.has(item.caseId)) continue;
    const jobId = createHash('sha256').update(JSON.stringify([requestId, attemptId, item.caseId])).digest('hex');
    const privateJobDirectory = path.join(options.directory, 'jobs', jobId);
    await privateDirectory(privateJobDirectory);
    const context: ExecutionContext = Object.freeze({
      requestId,
      attemptId,
      side: 'candidate',
      jobId,
      privateJobDirectory,
    });
    const row: TryCaseResult = {
      caseId: item.caseId,
      execute: { status: 'failed', durationMs: 0, issues: [] },
      grade: { status: 'skipped', durationMs: 0, issues: [] },
    };
    cases.push(row);
    let execution: Record<string, unknown>;
    try {
      const { value, durationMs } = await timed((callbackSignal) =>
        captured.execute({
          version: structuredClone(verified),
          caseId: item.caseId,
          repetition: 0,
          input: structuredClone(item.input),
          signal: callbackSignal,
          context,
        }),
      );
      row.execute.durationMs = durationMs;
      execution = value as unknown as Record<string, unknown>;
    } catch (error) {
      row.execute.error =
        error instanceof TaskExecutionError
          ? `TaskExecutionError (recorded as task_failed): ${describeError(error)}`
          : error instanceof CallbackCancelled
            ? 'CallbackCancelled: the runner treats this as a cancelled run.'
            : describeError(error);
      continue;
    }
    row.execute.issues = inspectExecution(execution);
    if (execution && typeof execution === 'object') {
      row.execute.output = execution.output;
      row.execute.executionStatus = (execution.executionStatus as string | undefined) ?? 'completed';
      if (execution.usage !== undefined) row.execute.usage = execution.usage;
    }
    if (row.execute.issues.some((issue) => issue.severity === 'error')) continue;
    row.execute.status = 'ok';
    try {
      const { value, durationMs } = await timed((callbackSignal) =>
        captured.grade({
          output: structuredClone(execution.output),
          expected: structuredClone(item.expected),
          caseId: item.caseId,
          repetition: 0,
          signal: callbackSignal,
        }),
      );
      row.grade.durationMs = durationMs;
      row.grade.issues = inspectGrade(value);
      const grade = value as unknown as Record<string, unknown>;
      if (grade && typeof grade === 'object') {
        if (typeof grade.reward === 'number') row.grade.reward = grade.reward;
        if (grade.explanation !== undefined) row.grade.explanation = grade.explanation;
      }
      row.grade.status = row.grade.issues.some((issue) => issue.severity === 'error') ? 'failed' : 'ok';
    } catch (error) {
      row.grade.status = 'failed';
      row.grade.error = describeError(error);
    }
  }
  return {
    schemaVersion: 1,
    ok: cases.length > 0 && cases.every((row) => row.execute.status === 'ok' && row.grade.status === 'ok'),
    payload: { digest: verified.version.digest, source: options.payload?.source ?? null },
    cases,
  };
}

/** Read a policy file for local advice. */
export async function readLocalText(target: string, limit = 2 * 1024 * 1024): Promise<string> {
  const handle = await open(path.resolve(target), 'r').catch(() => {
    throw new LocalRunError(`Cannot read ${target}.`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new LocalRunError(`${target} must be a file of at most ${limit} bytes.`);
    return new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
  } finally {
    await handle.close();
  }
}
