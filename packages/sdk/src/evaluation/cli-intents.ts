import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveAndCache } from '../cache.js';
import { ApiError } from '../client.js';
import type { Draft, Evaluation, EvaluationHandoff, BundlePayload } from '../types.js';
import {
  validatePayload,
  validateEvaluationHandoff,
  evaluationDescriptorDifferences,
} from '../validation.js';
import {
  createEvaluationTransport,
  evaluationOperationPath,
  evaluationFingerprint,
} from '../internal/evaluation-transport.js';
import { EvaluationError } from './errors.js';
import { acquireFileLock } from './journal.js';
import { atomicPrivateWrite, privateDirectory, readPrivateJson } from './private-state.js';
import type { EvaluatorConfig } from './config.js';
import type { EvaluationApp } from './types.js';

const json = (value: unknown) => JSON.stringify(value);
const stable = (value: unknown): string => JSON.stringify(normalize(value));
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  return value;
}
const fail = (
  code:
    | 'request.intent_mismatch'
    | 'request.base_conflict'
    | 'submission.unconfirmed' = 'request.intent_mismatch',
) =>
  new EvaluationError(code, {
    phase: 'claim',
    nextAction:
      code === 'request.base_conflict'
        ? 'review_terminal_evidence'
        : code === 'submission.unconfirmed'
          ? 'retry_same_command'
          : 'fix_config',
  });
const identity = (config: EvaluatorConfig) => ({
  serviceUrl: config.serviceUrl,
  projectId: config.projectId,
  evaluatorPrincipalId: config.evaluatorPrincipalId,
  journalRoot: config.journalRoot,
});
function commandFailure(error: unknown): EvaluationError {
  if (error instanceof EvaluationError) return error;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403)
      return new EvaluationError('auth.denied', { phase: 'claim', nextAction: 'ask_operator' });
    if (error.status === 409 && error.code === 'base_conflict')
      return fail('request.base_conflict');
    if (error.status < 500 && error.code !== 'response_too_large')
      return new EvaluationError('evidence.malformed', { phase: 'claim' });
  }
  return fail('submission.unconfirmed');
}

/** Explicit local command input; never reads a request-supplied filename. */
export async function readCommandText(filename: string, limit = 2 * 1024 * 1024): Promise<string> {
  const target = path.resolve(filename);
  if ((await realpath(path.dirname(target))) !== path.dirname(target))
    throw new EvaluationError('config.permissions');
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new EvaluationError('config.missing');
  });
  try {
    const before = await lstat(target);
    const info = await handle.stat();
    if (
      before.isSymbolicLink() ||
      !info.isFile() ||
      info.mode & 0o022 ||
      (process.getuid && info.uid !== process.getuid()) ||
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      info.size > limit
    )
      throw new EvaluationError('config.permissions');
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw new EvaluationError('config.schema');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
  } finally {
    await handle.close();
  }
}

export async function readCommandJson(filename: string, limit?: number): Promise<unknown> {
  try {
    return parseCommandJson(await readCommandText(filename, limit));
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError('config.schema');
  }
}

/** JSON.parse accepts duplicate object members; closed command inputs do not. */
export function parseCommandJson(text: string): unknown {
  let position = 0;
  const whitespace = () => {
    while (/\s/.test(text[position] ?? '') && position < text.length) position++;
  };
  const string = (): string => {
    whitespace();
    const begin = position;
    if (text[position++] !== '"') throw new Error();
    while (position < text.length) {
      const item = text[position++];
      if (item === '\\') {
        position++;
        continue;
      }
      if (item === '"') return JSON.parse(text.slice(begin, position));
    }
    throw new Error();
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error();
    whitespace();
    if (text[position] === '{') {
      position++;
      whitespace();
      const keys = new Set<string>();
      if (text[position] === '}') {
        position++;
        return;
      }
      while (true) {
        const key = string();
        if (keys.has(key)) throw new Error();
        keys.add(key);
        whitespace();
        if (text[position++] !== ':') throw new Error();
        value(depth + 1);
        whitespace();
        const delimiter = text[position++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw new Error();
      }
    }
    if (text[position] === '[') {
      position++;
      whitespace();
      if (text[position] === ']') {
        position++;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const delimiter = text[position++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw new Error();
      }
    }
    if (text[position] === '"') {
      string();
      return;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(position),
    );
    if (!match) throw new Error();
    position += match[0].length;
  };
  try {
    value(0);
    whitespace();
    if (position !== text.length) throw new Error();
    return JSON.parse(text);
  } catch {
    throw new EvaluationError('config.schema');
  }
}

interface RequestIntent {
  schemaVersion: 1;
  kind: 'acclimate-request-intent';
  identity: ReturnType<typeof identity>;
  bundleId: string;
  channel: string;
  output: string;
  payload: BundlePayload;
  descriptor: EvaluationApp<any, any, any>['descriptor'];
  retryAfterRequestId?: string;
  base: { versionId: string; digest: string; revision: string };
  keys: { draft: string; request: string };
  draftBody: string;
  requestBody?: string;
  draft?: Draft;
  request?: Evaluation;
}

async function existingIntent(filename: string): Promise<RequestIntent | undefined> {
  const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return undefined;
  return (await readPrivateJson(filename, 4 * 1024 * 1024)) as unknown as RequestIntent;
}

async function writeHandoff(filename: string, handoff: EvaluationHandoff) {
  const content = json(handoff) + '\n';
  const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if ((await readCommandText(filename)) !== content) throw fail();
    return;
  }
  const parent = path.dirname(filename),
    info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o022 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await realpath(parent)) !== parent
  )
    throw new EvaluationError('config.permissions');
  const temporary = path.join(parent, '.' + randomUUID() + '.tmp');
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await readCommandText(filename)) !== content) throw fail();
    }
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function recover<T>(
  transport: ReturnType<typeof createEvaluationTransport>,
  op: 'createDraft' | 'createRequest',
  scope: { projectId: string; bundleId: string; channel?: string },
  body: string,
  key: string,
): Promise<T | null> {
  const route = evaluationOperationPath(op, scope);
  const receipt = (await transport.client.getOperation(scope.projectId, key, route)) as unknown as {
    status: string;
    requestFingerprint?: string;
    result?: T;
  };
  if (receipt.status === 'closed') throw fail();
  if (receipt.status !== 'committed') return null;
  if (receipt.requestFingerprint !== evaluationFingerprint(op, scope, body) || !receipt.result)
    throw fail();
  return receipt.result;
}

function assertRequest(request: Evaluation, intent: RequestIntent) {
  if (!intent.requestBody) throw fail();
  const body = JSON.parse(intent.requestBody) as Record<string, unknown>;
  if (
    !request.id ||
    Object.entries(body).some(
      ([key, value]) =>
        stable((request as unknown as Record<string, unknown>)[key]) !== stable(value),
    )
  )
    throw fail();
}

/** A settled run has at most one retry, whatever name the retry was given. */
async function claimSuccessor(handoffFile: string, requestId: string, output: string) {
  const runs = path.dirname(path.dirname(handoffFile));
  // Retries made before --retry-after accepted --name always used after-<request ID>.
  const legacy = path.join(runs, 'after-' + requestId, 'request.json');
  if (legacy !== output && (await lstat(path.join(path.dirname(legacy), 'intent.json')).catch(() => null)))
    throw fail();
  const marker = path.join(path.dirname(handoffFile), 'successor.json');
  try {
    const handle = await open(
      marker,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(json({ schemaVersion: 1, output }) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readPrivateJson(marker)).output !== output) throw fail();
  }
}

/** Display labels for the console. Older services reject unknown request fields. */
async function runLabels(
  transport: ReturnType<typeof createEvaluationTransport>,
  projectId: string,
  runName: string | undefined,
  retryOf: string | undefined,
): Promise<{ runName?: string; retryOf?: string }> {
  if (!runName && !retryOf) return {};
  const supported = await transport.client
    .getEvaluationCapabilities(projectId)
    .then((capabilities) => capabilities.runLabels === true)
    .catch(() => false);
  return supported ? { ...(runName && { runName }), ...(retryOf && { retryOf }) } : {};
}

export async function createRequestFromIntent(options: {
  app: EvaluationApp<any, any, any>;
  config: EvaluatorConfig;
  bundleId: string;
  channel: string;
  payloadFile: string;
  intentPath: string;
  outputFile: string;
  predecessor?: { handoffFile: string; request: Evaluation };
  /** The run's journal name, shown in the console when the service supports it. */
  runName?: string;
}): Promise<{
  schemaVersion: 1;
  requestId: string;
  draftId: string;
  generation: number;
  parentVersionId: string;
  candidateVersionId: string;
  candidateDigest: string;
  status: string;
}> {
  const { app, config, bundleId, channel } = options;
  const filename = options.intentPath;
  if (!path.isAbsolute(filename)) throw new EvaluationError('config.permissions');
  const output = path.resolve(options.outputFile);
  const payload = await readCommandJson(options.payloadFile);
  validatePayload(payload);
  let prior: RequestIntent | undefined;
  if (options.predecessor) {
    const { handoffFile, request } = options.predecessor;
    prior = await existingIntent(path.join(path.dirname(handoffFile), 'intent.json'));
    if (!prior || prior.kind !== 'acclimate-request-intent' || prior.schemaVersion !== 1 ||
        stable(prior.identity) !== stable(identity(config)) || prior.output !== handoffFile ||
        prior.bundleId !== bundleId || prior.channel !== channel || stable(prior.payload) !== stable(payload) ||
        prior.request?.id !== request.id || prior.request.candidateVersionId !== request.candidateVersionId ||
        prior.request.candidateDigest !== request.candidateDigest || prior.base?.versionId !== request.parentVersionId ||
        prior.base.digest !== request.parentDigest)
      throw fail();
  }
  await privateDirectory(path.dirname(filename));
  const lock = await acquireFileLock(filename + '.lock');
  const transport = createEvaluationTransport(config);
  const scope = { projectId: config.projectId, bundleId, channel };
  const save = async (value: RequestIntent) => {
    lock.assertOwned();
    const content = json(value) + '\n';
    if (Buffer.byteLength(content) > 4 * 1024 * 1024)
      throw new EvaluationError('definition.report_budget_exceeded', { phase: 'claim' });
    await atomicPrivateWrite(filename, content);
    lock.assertOwned();
  };
  try {
    let state = await existingIntent(filename);
    const originFile = filename + '.origin.json';
    const origin = await lstat(originFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!state && origin)
      throw new EvaluationError('journal.missing', {
        phase: 'claim',
        nextAction: 'inspect_external_app',
      });
    if (
      state &&
      (state.schemaVersion !== 1 ||
        state.kind !== 'acclimate-request-intent' ||
        stable(state.identity) !== stable(identity(config)) ||
        (prior && state.retryAfterRequestId !== prior.request!.id) ||
        state.bundleId !== bundleId ||
        state.channel !== channel ||
        state.output !== output ||
        stable(state.payload) !== stable(payload) ||
        stable(state.descriptor) !== stable(app.descriptor))
    )
      throw fail();
    if (!state) {
      const current = await transport.client.resolveChannel(config.projectId, bundleId, channel);
      if (!current.resolution) throw fail('request.base_conflict');
      const base = current.resolution;
      if (prior && (base.version.id !== prior.base.versionId || base.version.digest !== prior.base.digest ||
          base.revision !== prior.base.revision))
        throw fail('request.base_conflict');
      if (prior) await claimSuccessor(prior.output, prior.request!.id, output);
      state = {
        schemaVersion: 1,
        kind: 'acclimate-request-intent',
        ...(prior && { retryAfterRequestId: prior.request!.id }),
        identity: identity(config),
        bundleId,
        channel,
        output,
        payload,
        descriptor: structuredClone(app.descriptor),
        base: { versionId: base.version.id, digest: base.version.digest, revision: base.revision },
        keys: { draft: randomUUID(), request: randomUUID() },
        draftBody: json({ baseVersionId: base.version.id, baseRevision: base.revision, payload }),
      };
      await atomicPrivateWrite(
        originFile,
        json({
          schemaVersion: 1,
          kind: 'acclimate-request-intent-origin',
          draftKey: state.keys.draft,
        }) + '\n',
      );
      await save(state);
    }
    const fixed = state;
    if (
      !fixed.base ||
      !fixed.keys?.draft ||
      !fixed.keys.request ||
      fixed.draftBody !==
        json({
          baseVersionId: fixed.base.versionId,
          baseRevision: fixed.base.revision,
          payload: fixed.payload,
        })
    )
      throw fail();
    // A committed request is recovered before checking a newer channel baseline.
    if (!fixed.request && fixed.requestBody) {
      fixed.request =
        (await recover<Evaluation>(
          transport,
          'createRequest',
          scope,
          fixed.requestBody,
          fixed.keys.request,
        )) ?? undefined;
      if (fixed.request) {
        assertRequest(fixed.request, fixed);
        await save(fixed);
      }
    }
    if (!fixed.draft) {
      fixed.draft =
        (await recover<Draft>(
          transport,
          'createDraft',
          scope,
          fixed.draftBody,
          fixed.keys.draft,
        )) ?? undefined;
      if (!fixed.draft) {
        const current = await transport.client.resolveChannel(config.projectId, bundleId, channel);
        if (
          current.resolution?.version.id !== fixed.base.versionId ||
          current.resolution.revision !== fixed.base.revision
        )
          throw fail('request.base_conflict');
        lock.assertOwned();
        fixed.draft = await transport.mutate<Draft>(
          'createDraft',
          scope,
          fixed.draftBody,
          fixed.keys.draft,
        );
      }
      await save(fixed);
    }
    const draft = fixed.draft;
    if (
      !draft.id ||
      draft.channel !== channel ||
      draft.baseVersionId !== fixed.base.versionId ||
      draft.baseRevision !== fixed.base.revision ||
      draft.snapshotVersion.parentVersionId !== fixed.base.versionId ||
      draft.snapshotVersion.bundleId !== bundleId ||
      draft.generation !== 1
    )
      throw fail();
    if (!fixed.request) {
      const current = await transport.client.resolveChannel(config.projectId, bundleId, channel);
      if (
        current.resolution?.version.id !== fixed.base.versionId ||
        current.resolution.revision !== fixed.base.revision
      )
        throw fail('request.base_conflict');
      const candidate = await resolveAndCache(
        transport.client,
        { projectId: config.projectId, bundleId, versionId: draft.snapshotVersion.id },
        { cacheDir: path.join(config.journalRoot, 'command-cache') },
      );
      if (
        candidate.version.digest !== draft.snapshotVersion.digest ||
        candidate.version.parentVersionId !== fixed.base.versionId ||
        stable(candidate.payload) !== stable(payload)
      )
        throw fail();
      // Labels chosen for a saved body stay fixed across recovery.
      const saved = fixed.requestBody
        ? (JSON.parse(fixed.requestBody) as { runName?: string; retryOf?: string })
        : undefined;
      const labels = saved
        ? {
            ...(saved.runName !== undefined && { runName: saved.runName }),
            ...(saved.retryOf !== undefined && { retryOf: saved.retryOf }),
          }
        : await runLabels(transport, config.projectId, options.runName, fixed.retryAfterRequestId);
      const requestBody = json({
        parentVersionId: fixed.base.versionId,
        parentDigest: fixed.base.digest,
        candidateVersionId: draft.snapshotVersion.id,
        candidateDigest: draft.snapshotVersion.digest,
        ...fixed.descriptor,
        requireBoundEvidence: true,
        ...labels,
      });
      if (fixed.requestBody && fixed.requestBody !== requestBody) throw fail();
      fixed.requestBody = requestBody;
      await save(fixed);
      lock.assertOwned();
      fixed.request = await transport.mutate<Evaluation>(
        'createRequest',
        scope,
        requestBody,
        fixed.keys.request,
      );
      assertRequest(fixed.request, fixed);
      await save(fixed);
    }
    assertRequest(fixed.request, fixed);
    const handoff = validateEvaluationHandoff({
      schemaVersion: 1,
      serviceUrl: config.serviceUrl,
      projectId: config.projectId,
      bundleId,
      requestId: fixed.request.id,
      configuration: fixed.descriptor,
    });
    await writeHandoff(output, handoff);
    return {
      schemaVersion: 1,
      requestId: fixed.request.id,
      draftId: draft.id,
      generation: draft.generation,
      parentVersionId: fixed.base.versionId,
      candidateVersionId: draft.snapshotVersion.id,
      candidateDigest: fixed.request.candidateDigest,
      status: fixed.request.status,
    };
  } catch (error) {
    throw commandFailure(error);
  } finally {
    await lock.close();
  }
}

function assertInterruptRequest(request: Evaluation, handoff: EvaluationHandoff) {
  if (request.id !== handoff.requestId || request.requireBoundEvidence !== true)
    throw new EvaluationError('evidence.identity_mismatch', { phase: 'inspect' });
  if (evaluationDescriptorDifferences(request, handoff.configuration).length)
    throw new EvaluationError('descriptor.mismatch', { phase: 'inspect' });
}

export async function interruptFromIntent(
  config: EvaluatorConfig,
  handoff: EvaluationHandoff,
  reason: string,
): Promise<Evaluation> {
  if (!reason.trim() || Buffer.byteLength(reason) > 4096)
    throw new EvaluationError('config.schema');
  const root = path.join(config.journalRoot, 'command-intents');
  await privateDirectory(root);
  const selection = {
    identity: identity(config),
    bundleId: handoff.bundleId,
    requestId: handoff.requestId,
    reason,
  };
  const filename = path.join(
    root,
    `interrupt-${createHash('sha256').update(stable(selection)).digest('hex')}.json`,
  );
  const lock = await acquireFileLock(filename + '.lock');
  try {
    let state = (await lstat(filename)
      .then(() => readPrivateJson(filename))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      })) as { selection: typeof selection; key: string; body: string } | null;
    if (!state) {
      state = { selection, key: randomUUID(), body: json({ reason }) };
      await atomicPrivateWrite(filename, json(state) + '\n');
    }
    if (
      stable(state.selection) !== stable(selection) ||
      state.body !== json({ reason }) ||
      !state.key
    )
      throw fail();
    const transport = createEvaluationTransport(config);
    const before = await transport.client.getEvaluation(
      config.projectId,
      handoff.bundleId,
      handoff.requestId,
    );
    assertInterruptRequest(before, handoff);
    lock.assertOwned();
    const result = await transport.mutate<Evaluation>(
      'interrupt',
      { projectId: config.projectId, bundleId: handoff.bundleId, requestId: handoff.requestId },
      state.body,
      state.key,
    );
    const current = await transport.client.getEvaluation(
      config.projectId,
      handoff.bundleId,
      handoff.requestId,
    );
    assertInterruptRequest(result, handoff);
    assertInterruptRequest(current, handoff);
    if (
      result.status !== 'interrupted' ||
      result.error !== reason ||
      current.status !== 'interrupted' ||
      current.error !== reason
    )
      throw fail('submission.unconfirmed');
    return current;
  } catch (error) {
    throw commandFailure(error);
  } finally {
    await lock.close();
  }
}
