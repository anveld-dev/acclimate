import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPayloadBytes, type VersionMetadata } from '@acclimate/sdk';
import type { Decision, Incident } from './domain.js';
import {
  freshCases,
  freshExpected,
  freshQualificationCriteria,
  scoreFreshCandidate,
} from './fresh-cases.js';
import { liveExecution } from './live-domain.js';
import { liveModels, liveModelMaximumCalls } from './live-model.js';

const [mode, outputArg] = process.argv.slice(2);
assert(
  mode === 'freeze' || mode === 'run',
  'Usage: tsx examples/continuous-learning/generalization.ts freeze|run <artifact dir>',
);
assert(outputArg);
const evidence = path.resolve(outputArg);
const source = path.resolve('artifacts/continuous-learning/sol-author-luna-harness-verified');
const arms = ['pinned', 'lostResponseRelease', 'preChargeRelease'] as const;
type Arm = (typeof arms)[number];
const channels = ['qualification', 'alternate-correction'] as const;
const targets = {
  lostResponseRelease: 'response-lost',
  preChargeRelease: 'transient-before-charge',
} as const;
const parallelPairs = 6;
const rules = {
  casesPerClassification: 4,
  ...freshQualificationCriteria,
  maximumExecutionFailures: 0,
  description:
    'Score exact action and key. For each release, require every targeted case to match the shared policy, at least one repaired pinned miss, all clean cases correct and unchanged, and all other failed incident decisions exactly preserved from pinned. Shared-policy accuracy is reported separately.',
} as const;
const permutations: Arm[][] = [
  [arms[0], arms[1], arms[2]],
  [arms[1], arms[2], arms[0]],
  [arms[2], arms[0], arms[1]],
  [arms[0], arms[2], arms[1]],
  [arms[1], arms[0], arms[2]],
  [arms[2], arms[1], arms[0]],
];
type ScheduledCase = { caseId: string; order: Arm[] };
const hash = (data: string | Uint8Array) =>
  'sha256:' + createHash('sha256').update(data).digest('hex');
const json = (data: unknown) => JSON.stringify(data, null, 2) + '\n';
const write = (name: string, content: string | Uint8Array) =>
  writeFile(path.join(evidence, name), content, { flag: 'wx', mode: 0o600, flush: true });

function shuffled<T>(items: readonly T[], seed: string, namespace: string): T[] {
  return items
    .map((item, index) => ({ item, rank: hash(JSON.stringify([seed, namespace, index])) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .map(({ item }) => item);
}

function schedule(seed: string): ScheduledCase[] {
  const classes = ['clean', targets.lostResponseRelease, targets.preChargeRelease] as const;
  assert.equal(new Set(freshCases.map(({ id }) => id)).size, freshCases.length);
  assert.equal(freshCases.length, classes.length * rules.casesPerClassification);
  const classOrder = shuffled(classes, seed, 'classes');
  const threeCycle = shuffled(permutations.slice(0, 3), seed, 'cycle');
  const reverseCycle = shuffled(permutations.slice(3), seed, 'reverse cycle');
  const pairs = classOrder.flatMap((classification, i) => {
    const cases = shuffled(
      freshCases.filter((fixture) => fixture.classification === classification),
      seed,
      classification,
    );
    assert.equal(cases.length, rules.casesPerClassification);
    const schedule = shuffled(
      [threeCycle[(i + 1) % 3]!, threeCycle[(i + 2) % 3]!, reverseCycle[i]!, threeCycle[i]!],
      seed,
      classification + ' permutations',
    );
    return cases.map((fixture, position) => ({ caseId: fixture.id, order: schedule[position]! }));
  });
  // Each rotation appears three times and each reverse rotation once.
  // Across the twelve matched cases every arm occurs four times in each position.
  return shuffled(pairs, seed, 'pairs');
}

type BundleSource = {
  version: VersionMetadata;
  evidenceFile: string;
  sourceEntry: string;
  sourceEntryDigest: string;
  publishedChannel: string | null;
};
async function readPublished() {
  const summary = JSON.parse(await readFile(path.join(source, 'summary.json'), 'utf8')) as {
    baseline: VersionMetadata;
    models: { proposer: string; harness: string };
    outcomes: { channel: string; fresh: VersionMetadata; pinnedBaseline: VersionMetadata }[];
  };
  const interpretation = JSON.parse(
    await readFile(path.join(source, 'interpretation.json'), 'utf8'),
  ) as {
    baselineVersionId: string;
    baselineDigest: string;
    campaigns: { promotions: { channel: string; versionId: string; digest: string }[] }[];
  };
  assert.deepEqual(summary.models, liveModels);
  assert.equal(summary.baseline.id, interpretation.baselineVersionId);
  assert.equal(summary.baseline.digest, interpretation.baselineDigest);
  const cache = path.join(source, 'consumer-cache');
  const entries = await Promise.all(
    (await readdir(cache)).sort().map(async (name) => {
      const relativePath = path.join('consumer-cache', name, 'entry.json');
      const encoded = await readFile(path.join(source, relativePath));
      const parsed = JSON.parse(encoded.toString('utf8')) as {
        digest?: string;
        payloadBytes?: string;
      };
      return { relativePath, encoded, parsed };
    }),
  );
  return arms.map((arm, index) => {
    const publishedChannel = channels[index - 1] ?? null;
    const outcome = summary.outcomes.find(({ channel }) => channel === publishedChannel);
    const version = publishedChannel ? outcome!.fresh : summary.baseline;
    if (publishedChannel) {
      assert.deepEqual(outcome!.pinnedBaseline, summary.baseline);
      assert.equal(version.parentVersionId, summary.baseline.id);
      const promotion = interpretation.campaigns
        .flatMap(({ promotions }) => promotions)
        .find((item) => item.channel === publishedChannel);
      assert(promotion);
      assert.equal(promotion.versionId, version.id);
      assert.equal(promotion.digest, version.digest);
    }
    const entry = entries.find(
      ({ parsed }) => parsed.digest === version.digest && parsed.payloadBytes,
    );
    assert(
      entry?.parsed.payloadBytes,
      'Original consumer cache must retain the published payload bytes',
    );
    const bytes = Buffer.from(entry.parsed.payloadBytes, 'base64');
    verifyPayloadBytes(bytes, version.digest);
    const metadata: BundleSource = {
      version,
      evidenceFile: arm + '.bundle.json',
      sourceEntry: entry.relativePath,
      sourceEntryDigest: hash(entry.encoded),
      publishedChannel,
    };
    return { arm, metadata, bytes };
  });
}

const frozenSources = [
  'generalization.ts',
  'fresh-cases.ts',
  'live-domain.ts',
  'live-model.ts',
] as const;
const sources = await Promise.all(
  frozenSources.map(async (name) => {
    const file = await readFile(new URL('./' + name, import.meta.url));
    return { name, file, digest: hash(file) };
  }),
);

function dataset() {
  return freshCases.map((fixture) => ({
    ...fixture,
    sharedPolicyExpected: freshExpected(fixture),
  }));
}

type Precommit = {
  frozenAt: string;
  seed: string;
  schedule: ScheduledCase[];
  model: typeof liveModels.harness;
  maxCalls: number;
  plannedCalls: number;
  parallelPairs: number;
  retries: 0;
  paymentWrites: 0;
  publicationWrites: 0;
  sourceRun: string;
  bundles: Record<Arm, BundleSource>;
  sourceDigests: Record<string, string>;
  datasetDigest: string;
  criteriaDigest: string;
};

if (mode === 'freeze') {
  const pinned = await readPublished();
  const seed = randomBytes(16).toString('hex');
  const order = schedule(seed);
  const plannedCalls = order.length * arms.length;
  assert(plannedCalls <= liveModelMaximumCalls);
  await mkdir(evidence, { mode: 0o700 });
  await mkdir(path.join(evidence, 'source'), { mode: 0o700 });
  const fixtures = json(dataset());
  const criteria = json(rules);
  await Promise.all([
    write('dataset.json', fixtures),
    write('criteria.json', criteria),
    ...sources.map(({ name, file }) => write(path.join('source', name), file)),
    ...pinned.map(({ metadata, bytes }) => write(metadata.evidenceFile, bytes)),
  ]);
  const frozen: Precommit = {
    frozenAt: new Date().toISOString(),
    seed,
    schedule: order,
    model: liveModels.harness,
    maxCalls: liveModelMaximumCalls,
    plannedCalls,
    parallelPairs,
    retries: 0,
    paymentWrites: 0,
    publicationWrites: 0,
    sourceRun: path.relative(process.cwd(), source),
    bundles: Object.fromEntries(pinned.map(({ arm, metadata }) => [arm, metadata])) as Record<
      Arm,
      BundleSource
    >,
    sourceDigests: Object.fromEntries(sources.map(({ name, digest }) => [name, digest])),
    datasetDigest: hash(fixtures),
    criteriaDigest: hash(criteria),
  };
  const frozenJson = json(frozen);
  await write('precommit.json', frozenJson);
  await write('precommit.sha256', hash(frozenJson) + '\n');
  console.log('Frozen', plannedCalls, 'Luna turns', hash(frozenJson));
} else {
  const commitment = await readFile(path.join(evidence, 'precommit.json'), 'utf8');
  const commitmentDigest = hash(commitment);
  assert.equal(
    (await readFile(path.join(evidence, 'precommit.sha256'), 'utf8')).trim(),
    commitmentDigest,
  );
  const frozen = JSON.parse(commitment) as Precommit;
  const fixtures = dataset();
  assert.equal(frozen.datasetDigest, hash(json(fixtures)));
  assert.equal(frozen.criteriaDigest, hash(json(rules)));
  for (const [name, digest] of [
    ['dataset.json', frozen.datasetDigest],
    ['criteria.json', frozen.criteriaDigest],
  ] as const) {
    assert.equal(hash(await readFile(path.join(evidence, name))), digest);
  }
  for (const item of sources) {
    assert.equal(frozen.sourceDigests[item.name], item.digest);
    assert.equal(hash(await readFile(path.join(evidence, 'source', item.name))), item.digest);
  }
  assert.deepEqual(frozen.schedule, schedule(frozen.seed));
  assert.equal(frozen.model, liveModels.harness);
  assert.equal(frozen.maxCalls, liveModelMaximumCalls);
  assert.equal(frozen.parallelPairs, parallelPairs);
  assert.equal(frozen.plannedCalls, frozen.schedule.length * arms.length);
  assert(frozen.plannedCalls <= frozen.maxCalls);

  const original = await readPublished();
  const verified = await Promise.all(
    arms.map(async (arm, index) => {
      const entry = frozen.bundles[arm];
      assert.deepEqual(entry, original[index]!.metadata);
      const bytes = await readFile(path.join(evidence, entry.evidenceFile));
      assert.deepEqual(bytes, original[index]!.bytes);
      return [arm, verifyPayloadBytes(bytes, entry.version.digest)] as const;
    }),
  );
  const bundles = Object.fromEntries(verified) as Record<Arm, (typeof verified)[number][1]>;
  await write(
    'execution-start.json',
    json({ startedAt: new Date().toISOString(), commitmentDigest }),
  );

  const live = liveExecution(evidence);
  const results = await Promise.all(
    Array.from({ length: parallelPairs }, async (_, worker) => {
      const observations = [];
      for (const entry of frozen.schedule.filter((_, index) => index % parallelPairs === worker)) {
        const fixture = fixtures.find(({ id }) => id === entry.caseId)!;
        const outcomes = {} as Record<
          Arm,
          { label: string; output: Decision | null; error: string | null }
        >;
        // The unchanged harness serializes only the signal and request key. The wider
        // signal type extends the input wire data without changing the harness prompt.
        const input = fixture.input as unknown as Incident;
        for (const arm of entry.order) {
          const label = 'generalization/' + fixture.id + '/' + arm;
          try {
            const { output } = await live.execute(bundles[arm], input, label);
            outcomes[arm] = { label, output, error: null };
          } catch (error) {
            outcomes[arm] = {
              label,
              output: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        observations.push({
          caseId: fixture.id,
          classification: fixture.classification,
          expected: fixture.sharedPolicyExpected,
          outcomes,
        });
      }
      return observations;
    }),
  );
  const observations = results.flat().sort((a, b) => a.caseId.localeCompare(b.caseId));
  const exact = (a: Decision | null, b: Decision | null) =>
    a !== null && b !== null && a.action === b.action && a.key === b.key;
  const executionFailures = observations
    .flatMap(({ outcomes }) => Object.values(outcomes))
    .filter(({ error }) => error !== null).length;
  const sharedPolicyAccuracy = Object.fromEntries(
    arms.map((arm) => [
      arm,
      observations.filter((row) => exact(row.outcomes[arm].output, row.expected)).length,
    ]),
  );
  const resultsByRelease = Object.entries(targets).map(([name, target]) => {
    const arm = name as keyof typeof targets;
    const targetCases = observations.filter((row) => row.classification === target);
    const targetPinnedCorrect = targetCases.filter((row) =>
      exact(row.outcomes.pinned.output, row.expected),
    ).length;
    const validPairs = observations.flatMap(({ caseId, outcomes }) =>
      outcomes.pinned.output && outcomes[arm].output
        ? [{ id: caseId, pinned: outcomes.pinned.output, candidate: outcomes[arm].output }]
        : [],
    );
    const grade =
      validPairs.length === observations.length ? scoreFreshCandidate(target, validPairs) : null;
    return {
      arm,
      target,
      targetPinnedCorrect,
      targetedGain: grade === null ? null : grade.targetCorrect - targetPinnedCorrect,
      criteriaPassed: executionFailures <= rules.maximumExecutionFailures && grade?.passed === true,
      grade,
    };
  });
  const ledger = [...live.modelAttempts.entries()].sort(([a], [b]) => a.localeCompare(b));
  const summary = {
    commitmentDigest,
    model: frozen.model,
    plannedCalls: frozen.plannedCalls,
    reservedCalls: (await readdir(path.join(evidence, 'model-turns', 'model-calls', 'slots')))
      .length,
    completedCalls: ledger.length,
    executionFailures,
    cases: observations.length,
    sharedPolicyAccuracy,
    resultsByRelease,
    usage: {
      inputTokens: ledger.reduce((sum, [, turn]) => sum + turn.usage.inputTokens, 0),
      outputTokens: ledger.reduce((sum, [, turn]) => sum + turn.usage.outputTokens, 0),
      cachedInputTokens: ledger.reduce(
        (sum, [, turn]) => sum + (turn.usage.cachedInputTokens ?? 0),
        0,
      ),
      providerDollarCost: null,
    },
    limitations: [
      'The same original Luna prompt and output schema were used, including its older decoder list. Only the new task data and pinned bundle varied.',
      'One turn per arm and per case. The small, curated synthetic cohort supports a descriptive matched comparison.',
      'The two releases are separate scoped changes. Strict shared-policy accuracy and preservation of out-of-scope pinned behavior are different measures.',
    ],
  };
  await write('observations.json', json(observations));
  await write('summary.json', json(summary));
  console.log(json(summary));
}
