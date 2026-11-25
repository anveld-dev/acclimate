import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AcclimateClient,
  resolveAndCache,
  type BundlePayload,
  type LearningDiagnosis,
  type LearningRound,
  type LearningSetting,
} from '@acclimate/sdk';
import { serveLearningLoop } from '@acclimate/sdk/learning';
import { optimizerAdapter, requestGuard } from './adapter.js';
import {
  conditions,
  IntegrityError,
  optimizerModel,
  optimizerReasoningEffort,
  setting,
  proxyKey,
  type ProxyIdentity,
  type Condition,
} from './conditions.js';
import { evaluator } from './evaluator.js';
import { heldOut, meanScore, type Case } from './heldout.js';

export interface RunSummary {
  project: string;
  bundleId: string;
  bundleName: string;
  firstNumber: number;
  lastNumber: number;
  memoryRevision: number;
  evolveRevision: number;
  evolveDigest: string;
  startDigest: string;
  finalDigest: string;
  finalVersion: Awaited<ReturnType<typeof resolveAndCache>>;
  roundZero: { id: string; score: number } | null;
}

export interface RunOptions {
  block: number;
  code: string;
  condition: Condition;
  directory: string;
  scratch: string;
  database: string;
  binary: string;
  project: string;
  seed: string;
  rounds: number;
  source?: RunSummary;
  baseline: BundlePayload;
  evolve: Case[];
  held: Case[];
  python: string;
  grader: string;
  proxy: ProxyIdentity;
  modelFree: boolean;
  targetZero?: boolean;
  finalEvolve?: boolean;
  serviceSettings: Record<string, string>;
  signal?: AbortSignal;
}

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const closed = once(server, 'close');
  server.close();
  await closed;
  return address.port;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new IntegrityError('K1: ' + message);
}

const terminal = (r: { state: string }) => ['completed', 'failed', 'stopped'].includes(r.state);
const save = (file: string, data: unknown) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });

export async function runCondition(options: RunOptions): Promise<RunSummary> {
  const { project, directory, scratch, evolve, held, source } = options;
  const plan = conditions[options.condition];
  check(
    options.serviceSettings.ACCLIMATE_MODEL === optimizerModel &&
      options.serviceSettings.ACCLIMATE_MODEL_REASONING_EFFORT === optimizerReasoningEffort,
    'optimizer settings differ from frozen protocol',
  );
  const apiKey = proxyKey();
  const modelToken = crypto.randomUUID();
  const operatorToken = crypto.randomUUID();
  const appToken = crypto.randomUUID();
  const principal = 'experiment-evaluator';
  const own = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, own.signal]) : own.signal;
  const abort = (error: unknown) => own.abort(error);
  const appStop = new AbortController();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const base = `http://127.0.0.1:${await port()}`;
  const client = new AcclimateClient({
    baseUrl: base,
    token: operatorToken,
    scope: 'experiment-operator',
    timeoutMs: 10_000,
  });
  const appClient = new AcclimateClient({
    baseUrl: base,
    token: appToken,
    scope: 'experiment-evaluator',
    timeoutMs: 10_000,
  });
  const forbidden = ['A', 'B', 'C', 'S'];
  if (source) forbidden.push(source.bundleName);
  const guard = requestGuard(evolve, held, forbidden);
  const details = new Map<number, LearningRound>();
  const adapterLog = path.join(directory, 'optimizer.jsonl');
  const heldCommit = heldOut(held);
  const evolveDigest = heldOut(evolve).digest;
  let bundleId = '';
  let bundleName = '';
  let evolveRevision = 0;
  let startDigest = '';
  let count = 0;
  let firstNumber = 1;
  let roundZero: RunSummary['roundZero'] = null;
  let app: Promise<void> | undefined;
  const proposalRecords = new Map<string, { diagnosis: LearningDiagnosis; returnedAt: string }>();
  const adapter = optimizerAdapter({
    model: optimizerModel,
    reasoningEffort: optimizerReasoningEffort,
    token: modelToken,
    ledger: adapterLog,
    guard,
    abort,
    async inspect(data, kind) {
      const loop = await client.getLearningLoop(project, bundleId);
      check(loop.activeRound, 'optimizer request without an active round');
      const current = await client.getLearningRound(project, bundleId, loop.activeRound.id);
      const pinnedSetting = data.setting as LearningSetting;
      check(
        pinnedSetting.policyModel === current.setting.policyModel &&
          pinnedSetting.domain === current.setting.domain &&
          pinnedSetting.benchmark === current.setting.benchmark,
        'optimizer setting differs from round',
      );
      const history = (
        await client.listLearningRounds(project, bundleId, { limit: 100 })
      ).items.filter((item) => item.number >= firstNumber && item.number < current.number);
      check(
        data.history.length === history.length,
        'optimizer history count differs from run history',
      );
      const attempts = data.improvementMemory.problems.flatMap((problem) => problem.attempts);
      check(
        attempts.length === current.memoryRevision,
        'optimizer memory differs from pinned revision',
      );
      check(
        heldOut(
          data.feedback.cases.map(({ caseId, input }) => ({
            caseId,
            input,
            expected: '',
          })),
        ).digest ===
          heldOut(evolve.map(({ caseId, input }) => ({ caseId, input, expected: '' }))).digest,
        'optimizer evolve input differs from frozen split',
      );
      return {
        round: current.number,
        sample:
          kind === 'propose'
            ? (current.candidates.find((item) => item.status === 'generating')?.sample ?? null)
            : null,
      };
    },
    proxy: options.proxy,
    apiKey,
    signal,
    recordReply(round, sample, content, returnedAt) {
      try {
        const { diagnosis } = JSON.parse(content) as { diagnosis: LearningDiagnosis };
        if ('new' in diagnosis.problem) {
          // The service stores a whitespace-normalized cause and byte-sorted case IDs.
          diagnosis.problem.new = diagnosis.problem.new
            .split(/\p{White_Space}+/u)
            .filter(Boolean)
            .join(' ');
        }
        diagnosis.predicted.sort();
        proposalRecords.set(`${round}:${sample}`, { diagnosis, returnedAt });
      } catch {
        // The service classifies malformed replies.
      }
    },
  });
  const env = JSON.parse(
    execFileSync(options.python, ['-m', 'scripts.testing.production'], {
      input: JSON.stringify({
        database_url: options.database,
        bind: new URL(base).host,
        project,
        tokens: {},
        login_token: crypto.randomUUID(),
        console_token: crypto.randomUUID(),
      }),
      encoding: 'utf8',
    }),
  ) as NodeJS.ProcessEnv;
  const endpoint = await adapter.start();
  const service = spawn(options.binary, [], {
    env: {
      ...env,
      ...options.serviceSettings,
      ACCLIMATE_MODEL_ENDPOINT: endpoint,
      ACCLIMATE_MODEL_TOKEN: modelToken,
      ACCLIMATE_AUTH: JSON.stringify([
        {
          token: operatorToken,
          principalId: 'operator',
          workspaceId: project,
          rights: ['read', 'write', 'promote'],
        },
        {
          token: appToken,
          principalId: principal,
          workspaceId: project,
          rights: ['read', 'evaluate'],
        },
      ]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.once('error', abort);
  for (const stream of [service.stdout, service.stderr]) {
    stream.on('data', (chunk: Buffer) =>
      appendFileSync(path.join(directory, 'service.log'), chunk),
    );
  }
  const alive = () => {
    signal.throwIfAborted();
    if (service.exitCode !== null || service.signalCode !== null)
      throw new Error('K5: service exited');
  };
  let activeEvaluation: string | undefined;
  const contexts = new Map<
    string,
    Promise<{ id: string; number: number; role: string; sample: number | null }>
  >();
  const runner = evaluator({
    model: plan.model,
    modelFree: options.modelFree,
    proxy: options.proxy,
    apiKey,
    grader: options.grader,
    python: options.python,
    ledger: path.join(directory, 'rollouts.jsonl'),
    seed: [options.seed, options.block, options.code],
    evolve,
    held,
    forbidden,
    abort,
    async context(version) {
      const work = await appClient.getLearningWork(project, bundleId);
      check(
        work.items.length === 1 &&
          work.items[0].versionId === version.version.id &&
          work.items[0].digest === version.version.digest,
        'callback does not match queued evaluation',
      );
      const item = work.items[0];
      activeEvaluation = item.evaluationId;
      if (!contexts.has(item.evaluationId)) {
        contexts.set(
          item.evaluationId,
          (async () => {
            const round = await client.getLearningRound(project, bundleId, item.roundId);
            check(
              round.setting.policyModel === plan.model &&
                round.evolveRevision === evolveRevision &&
                round.heldOut.digest === heldCommit.digest,
              'unfrozen round pins',
            );
            if (item.role === 'incumbent' && count >= options.rounds - 1) {
              await client.pauseLearningLoop(project, bundleId);
            }
            if (item.role === 'candidate') {
              const diagnosis = round.candidates.find((c) => c.sample === item.sample)?.diagnosis;
              const reply = proposalRecords.get(`${round.number}:${item.sample}`);
              const evaluation = round.evaluations.find((entry) => entry.id === item.evaluationId);
              check(
                diagnosis &&
                  reply &&
                  evaluation &&
                  Date.parse(evaluation.createdAt) >= Date.parse(reply.returnedAt),
                'candidate entered work before its diagnosis reply',
              );
              try {
                assert.deepEqual(diagnosis, reply.diagnosis);
              } catch {
                throw new IntegrityError('K1: candidate diagnosis differs from optimizer reply');
              }
            }
            return {
              id: item.evaluationId,
              number: round.number,
              role: item.role,
              sample: item.sample,
            };
          })(),
        );
      }
      return await contexts.get(item.evaluationId)!;
    },
  });
  const deliver = (id: string, versionId?: string) =>
    resolveAndCache(
      client,
      versionId
        ? { workspaceId: project, bundleId: id, versionId }
        : { workspaceId: project, bundleId: id, channel: 'learning' },
      { cacheDir: path.join(scratch, 'delivery') },
    );

  try {
    const startup = Date.now() + 30_000;
    while (true) {
      alive();
      if (
        await fetch(base + '/ready', { signal: AbortSignal.timeout(1000) }).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      if (Date.now() > startup) throw new Error('K5: service readiness deadline');
      await delay(100, undefined, { signal });
    }
    const sourceVersion = source ? await deliver(source.bundleId) : undefined;
    if (source) {
      check(
        sourceVersion?.version.digest === source.finalDigest,
        'checkpoint head differs from source',
      );
      check(source.evolveDigest === evolveDigest, 'checkpoint uses a different evolve split');
      const old = await client.getLearningLoop(project, source.bundleId);
      check(
        old.status === 'paused' && !old.activeRound && old.heldOut.digest === heldCommit.digest,
        'checkpoint does not contain a paused source loop',
      );
    }
    if (plan.continued) {
      check(source, 'Full SIM requires its source checkpoint');
      ({ bundleId, bundleName, evolveRevision } = source);
      firstNumber = source.lastNumber + 1;
      await client.stopLearningLoop(project, bundleId);
    } else {
      const bundle = await client.createBundle(
        project,
        { name: `fixture-${crypto.randomUUID()}` },
        crypto.randomUUID(),
      );
      bundleId = bundle.id;
      bundleName = bundle.name;
      forbidden.push(bundleName);
      const version = await client.createVersion(
        project,
        bundleId,
        {
          parentVersionId: null,
          payload: plan.start === 'source-final' ? sourceVersion!.payload : options.baseline,
        },
        crypto.randomUUID(),
      );
      await client.createRelease(
        project,
        bundleId,
        'learning',
        {
          versionId: version.id,
          expectedRevision: '0',
          unevaluatedReason: 'Initial fixture seed',
        },
        crypto.randomUUID(),
      );
    }
    const startVersion = await deliver(bundleId);
    check(
      startVersion.resolution?.channel === 'learning',
      'starting version lacks a learning channel resolution',
    );
    let expectedRevision = BigInt(startVersion.resolution.revision);
    let expectedParent = startVersion.version.id;
    startDigest = startVersion.version.digest;
    if (source && plan.start === 'source-final') {
      check(startDigest === source.finalDigest, 'Full SIM and HT start digests differ');
    }
    if (options.condition === 'source' || options.targetZero) {
      const zero = await runner.measure(startVersion, 'round-zero', plan.model, 0, signal);
      if (zero.infraFailures > held.length * 5 * 0.05)
        throw new Error('K5: round-zero measurement failed');
      roundZero = zero;
    }
    const enrollment = {
      channel: 'learning',
      appPrincipalId: principal,
      setting: setting(plan.model),
      heldOut: heldCommit,
    };
    await client.enrollLearningLoop(project, bundleId, enrollment);
    if (!plan.continued) {
      const added = await appClient.addLearningEvolveCases(
        project,
        bundleId,
        { cases: evolve, retire: [] },
        crypto.randomUUID(),
      );
      evolveRevision = added.evolveRevision;
      check(
        added.added === evolve.length &&
          added.liveCases === evolve.length &&
          (!source || source.evolveRevision === evolveRevision),
        'unexpected evolve receipt',
      );
    }
    const polls = options.modelFree ? 25 : 500;
    const configPath = path.join(scratch, 'evaluator.json');
    save(configPath, {
      schemaVersion: 1,
      serviceUrl: base,
      workspaceId: project,
      evaluatorPrincipalId: principal,
      evaluatorToken: appToken,
      journalRoot: path.join(scratch, 'journal'),
    });
    app = serveLearningLoop({
      configPath,
      bundleId,
      app: runner.app,
      allowLive: !options.modelFree,
      caseConcurrency: 8,
      pollIntervalMs: polls,
      signal: AbortSignal.any([signal, appStop.signal]),
      onDiagnostic: (diagnostic) =>
        appendFileSync(
          path.join(directory, 'diagnostics.jsonl'),
          JSON.stringify(diagnostic) + '\n',
        ),
    }).catch(abort);

    let lastProgress = Date.now();
    let lastActivity = '';
    let lastNumber = firstNumber - 1;
    while (count < options.rounds) {
      alive();
      const loop = await client.getLearningLoop(project, bundleId);
      if (loop.pauseReason === 'optimizer-context-too-large')
        throw new IntegrityError('K2: optimizer context overflow');
      if (loop.pauseReason === 'failed-rounds') throw new Error('K5: consecutive failed rounds');
      check(
        loop.evolveRevision === evolveRevision && loop.liveCases === evolve.length,
        'evolve split changed',
      );
      const items = (await client.listLearningRounds(project, bundleId, { limit: 100 })).items
        .reverse()
        .filter((item) => item.number >= firstNumber);
      const activity = JSON.stringify([items, activeEvaluation, runner.rows.length]);
      if (activity !== lastActivity) {
        lastActivity = activity;
        lastProgress = Date.now();
      }
      if (Date.now() - lastProgress > 7_200_000) throw new Error('K5: run stuck for two hours');
      const newRows = items.filter((item) => terminal(item) && !details.has(item.number));
      if (newRows.length || (count === options.rounds - 1 && loop.activeRound)) {
        if (
          loop.activeRound &&
          count + newRows.filter((r) => r.state === 'completed').length >= options.rounds - 1
        ) {
          await client.pauseLearningLoop(project, bundleId);
        }
      }
      for (const summary of newRows) {
        const round = await client.getLearningRound(project, bundleId, summary.id);
        check(
          round.evolveRevision === evolveRevision &&
            round.heldOut.digest === heldCommit.digest &&
            round.setting.policyModel === plan.model &&
            round.optimizerModel === optimizerModel &&
            'optimizerReasoningEffort' in round &&
            round.optimizerReasoningEffort === optimizerReasoningEffort,
          'round provenance differs from frozen protocol',
        );
        if (round.reason === 'optimizer-context-too-large')
          throw new IntegrityError('K2: optimizer context overflow');
        check(
          round.reason !== 'channel-moved' &&
            round.channel === 'learning' &&
            round.parentVersionId === expectedParent &&
            BigInt(round.channelRevision) === expectedRevision,
          'channel moved during run',
        );
        if (round.adoptedVersionId) {
          expectedParent = round.adoptedVersionId;
          expectedRevision++;
        }
        const pinned = await client.getLearningMemory(project, bundleId, {
          revision: round.memoryRevision,
        });
        check(
          round.memoryDigest === null || pinned.memoryDigest === round.memoryDigest,
          'round memory digest mismatch',
        );
        if (round.number === firstNumber) {
          check(
            round.parentVersionId === startVersion.version.id &&
              round.memoryRevision === (plan.continued ? source!.memoryRevision : 0),
            'wrong starting snapshot',
          );
        }
        if (round.state === 'completed') {
          check(round.candidates.length === 5, 'round does not have five samples');
          count++;
        }
        details.set(round.number, round);
        lastNumber = round.number;
        const retained = round.evaluations.find((entry) => entry.role === 'retained');
        const versionId = round.adoptedVersionId ?? round.parentVersionId;
        const retainedRows = runner.rows.filter((row) => row.id === retained?.id);
        let replacement;
        if (round.state === 'completed') {
          check(
            retained?.versionId === versionId && retained.split === 'heldOut',
            'retained evaluation did not bind retained version',
          );
          if (retained.status === 'scored') {
            check(
              retainedRows.length === held.length * 5 &&
                round.heldOutScore !== null &&
                Math.abs(meanScore(retainedRows) - round.heldOutScore) <= 1e-9,
              'held-out score mismatch',
            );
          }
          if (
            retained.status !== 'scored' ||
            retainedRows.filter((row) => row.infraFailure).length > held.length * 5 * 0.05
          ) {
            replacement = await runner.measure(
              await deliver(bundleId, versionId),
              'rescore',
              plan.model,
              round.number,
              signal,
            );
            if (replacement.infraFailures > held.length * 5 * 0.05)
              throw new Error('K5: held-out rescore failed');
          }
        }
        const rows = runner.rows.filter((row) => row.number === round.number);
        const requests = (existsSync(adapterLog) ? readFileSync(adapterLog, 'utf8') : '')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { round: number; event: string })
          .filter((row) => row.round === round.number);
        appendFileSync(
          path.join(directory, 'rounds.jsonl'),
          JSON.stringify({
            ...round,
            block: options.block,
            code: options.code,
            r: round.state === 'completed' ? count : null,
            parent: {
              versionId: round.parentVersionId,
              digest: round.evaluations.find((e) => e.role === 'incumbent')?.digest,
            },
            retained: retained
              ? {
                  versionId,
                  digest: retained.digest,
                  id: retained.id,
                  heldOutScore: round.heldOutScore,
                  heldOutError: round.heldOutError,
                  replacement,
                }
              : null,
            memory: pinned,
            optimizer: requests,
            turns: Object.fromEntries(
              ['incumbent', 'candidate', 'retained', 'rescore'].map((role) => [
                role,
                rows.filter((row) => row.role === role).reduce((sum, row) => sum + row.turns, 0),
              ]),
            ),
          }) + '\n',
        );
      }
      if (count === options.rounds) {
        const end = await client.getLearningLoop(project, bundleId);
        if (end.activeRound || end.nextRound !== lastNumber + 1 || end.status !== 'paused') {
          await client.stopLearningLoop(project, bundleId);
          throw new IntegrityError('K1: loop advanced beyond its counted round limit');
        }
        break;
      }
      if (!loop.activeRound && loop.status === 'paused')
        await client.resumeLearningLoop(project, bundleId);
      await delay(polls, undefined, { signal });
    }
    const finalVersion = await deliver(bundleId);
    const last = details.get(lastNumber)!;
    check(
      finalVersion.version.id === (last.adoptedVersionId ?? last.parentVersionId) &&
        finalVersion.resolution?.revision === expectedRevision.toString(),
      'final channel head differs from ledger',
    );
    const memory = await client.getLearningMemory(project, bundleId);
    if (options.finalEvolve) {
      const tail = await runner.measure(
        finalVersion,
        'final-evolve',
        plan.model,
        lastNumber + 1,
        signal,
        evolve,
      );
      if (tail.infraFailures > evolve.length * 5 * 0.05)
        throw new Error('K5: final evolve measurement failed');
    }
    if (runner.rows.filter((row) => row.infraFailure).length > runner.rows.length * 0.05) {
      throw new Error('K5: infrastructure failure rate exceeds five percent');
    }
    const summary = {
      project,
      bundleId,
      bundleName,
      firstNumber,
      lastNumber,
      startDigest,
      evolveRevision,
      evolveDigest,
      finalDigest: finalVersion.version.digest,
      finalVersion,
      memoryRevision: memory.currentRevision,
      memory,
      roundZero,
      turns: runner.rows.reduce((sum, row) => sum + row.turns, 0),
      rollouts: runner.rows.length,
      optimizerRequests: existsSync(adapterLog)
        ? readFileSync(adapterLog, 'utf8')
            .split('\n')
            .filter((line) => line && (JSON.parse(line) as { event: string }).event === 'request')
            .length
        : 0,
    };
    save(path.join(directory, 'summary.json'), summary);
    return summary;
  } finally {
    appStop.abort();
    own.abort();
    await app;
    if (service.exitCode === null && service.signalCode === null && service.pid !== undefined) {
      const closed = once(service, 'exit');
      service.kill('SIGTERM');
      const watchdog = setTimeout(() => service.kill('SIGKILL'), 45_000);
      try {
        await closed;
      } finally {
        clearTimeout(watchdog);
      }
    }
    await adapter.close();
  }
}
