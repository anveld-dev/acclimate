/**
 * Teach a returns agent a shop's hidden policy as evidence arrives in batches, and measure each
 * release on a fixed test set the loop never sees.
 *
 *   npx tsx examples/gear-returns/run.ts
 *
 * The script publishes the starting instructions, imports stages/1.csv and starts learning. Each
 * time the loop has nothing left to try, it scores the released version on test.csv, then imports
 * the next batch, which wakes the loop again. It writes every measurement to results.json.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AcclimateClient, defaultCacheDir, resolveAndCache, systemPrompt } from '@acclimate/sdk';
import type { LearningLoop } from '@acclimate/sdk';

const here = fileURLToPath(new URL('.', import.meta.url));
const NAME = process.env.ACCLIMATE_BUNDLE_NAME ?? 'Gear returns';
const CHANNEL = 'stable';
const STAGES = 4;
// Each test task is answered this many times, as a rollout scores each task five times.
const SAMPLES = 3;

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const workspaceId = setting('ACCLIMATE_WORKSPACE');
const taskModel = setting('TASK_MODEL');
const judgeModel = setting('JUDGE_MODEL');
const providerUrl = setting('OPENAI_BASE_URL').replace(/\/$/, '');
const providerKey = setting('OPENAI_API_KEY');
const client = new AcclimateClient({
  baseUrl: setting('ACCLIMATE_URL'),
  token: setting('ACCLIMATE_TOKEN'),
  scope: 'gear-returns-example',
});

function parseCsv(text: string): { input: string; expected: string }[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  return rows.slice(1).map(([input, expected]) => ({ input, expected }));
}

async function answer(system: string, input: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${providerUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${providerKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: taskModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: input },
        ],
      }),
    });
    if (response.ok) {
      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      return body.choices[0].message.content.trim();
    }
    if (attempt === 4) throw new Error(`The model provider answered ${response.status}.`);
    await sleep(2000 * (attempt + 1));
  }
}

/** Pass rate of the released version on the fixed test set: the share of answers that match exactly. */
async function measure() {
  const released = await resolveAndCache(
    client,
    { workspaceId, bundleId, channel: CHANNEL },
    { cacheDir: process.env.ACCLIMATE_CACHE ?? (await defaultCacheDir()) },
  );
  const system = systemPrompt(released.payload);
  const jobs = test.flatMap((task) => Array.from({ length: SAMPLES }, () => task));
  let passed = 0;
  for (let i = 0; i < jobs.length; i += 8) {
    const replies = await Promise.all(jobs.slice(i, i + 8).map((task) => answer(system, task.input)));
    replies.forEach((reply, j) => (passed += Number(reply === jobs[i + j].expected)));
  }
  return { versionId: released.version.id, passRate: passed / jobs.length };
}

async function waitForIdle(): Promise<LearningLoop> {
  for (let stage = ''; ; await sleep(15_000)) {
    const loop = await client.getLearningLoop(workspaceId, bundleId);
    const active = loop.activeRound;
    if (active && `${active.number} ${active.state}` !== stage) {
      stage = `${active.number} ${active.state}`;
      console.log(`  round ${active.number}: ${active.state.replaceAll('_', ' ')}`);
    }
    if (!active && (loop.status !== 'running' || loop.waiting)) return loop;
  }
}

async function importStage(stage: number) {
  const bytes = await readFile(join(here, 'stages', `${stage}.csv`));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let imported = await client.importLearningTasks(workspaceId, bundleId, data, 'text/csv', `stage-${stage}.csv`);
  while (imported.pending > 0 && imported.status !== 'failed') {
    await sleep(2000);
    imported = await client.getLearningImport(workspaceId, bundleId, imported.importId);
  }
  if (imported.status === 'failed') throw new Error(`Import failed: ${imported.message}`);
  for (;;) {
    const pending = await client.listLearningTasks(workspaceId, bundleId, { admission: 'pending', limit: 100 });
    if (pending.items.length + pending.heldOutCount === 0) break;
    await sleep(5000);
  }
}

const test = parseCsv(await readFile(join(here, 'test.csv'), 'utf8'));

// Resume an earlier run of the same bundle from results.json, so stopping the script loses nothing.
let bundleId = '';
for (let cursor: string | undefined; ; ) {
  const page = await client.listBundles(workspaceId, { cursor, limit: 100 });
  bundleId = page.items.find((bundle) => bundle.name === NAME)?.id ?? '';
  cursor = page.nextCursor ?? undefined;
  if (bundleId || !cursor) break;
}
let results: ({ stage: number; rounds: number[] } & Record<string, unknown>)[] = [];
if (bundleId) {
  results = JSON.parse(await readFile(join(here, 'results.json'), 'utf8')).results;
  console.log(`Resuming "${NAME}" after batch ${results.length - 1}.`);
} else {
  const setup = await client.createBundleSetup(
    workspaceId,
    {
      name: NAME,
      origin: 'created',
      channel: CHANNEL,
      payload: {
        schemaVersion: 1,
        files: [
          {
            path: 'instructions.md',
            kind: 'instruction',
            text: await readFile(join(here, 'bundle/instructions.md'), 'utf8'),
          },
        ],
      },
      reason: 'Starting instructions for the gear returns example',
    },
    randomUUID(),
  );
  bundleId = setup.bundle.id;
  await client.enrollLearningLoop(workspaceId, bundleId, {
    channel: CHANNEL,
    setting: { domain: 'support', benchmark: 'gear-returns' },
    taskModel,
    judgeModel,
    maxRoundsPerDay: 24,
  });
  const start = await measure();
  console.log(`Start: ${Math.round(start.passRate * 100)}% on the ${test.length} test tasks.`);
  results.push({ stage: 0, rounds: [], ...start });
}

for (let stage = results.length; stage <= STAGES; stage++) {
  await importStage(stage);
  console.log(`Imported batch ${stage}.`);
  const before = new Set(results.flatMap((r) => r.rounds));
  if (stage === 1) await client.startLearningLoop(workspaceId, bundleId);
  // Wait for the new tasks to wake the loop before waiting for it to settle.
  for (let waited = 0; waited < 600_000; waited += 10_000) {
    const loop = await client.getLearningLoop(workspaceId, bundleId);
    if (loop.activeRound || loop.rounds.some((round) => !before.has(round.number))) break;
    await sleep(10_000);
  }
  const loop = await waitForIdle();
  const rounds = loop.rounds
    .filter((round) => round.endedAt && !before.has(round.number))
    .map((round) => ({
      number: round.number,
      decision: round.decision ?? round.state,
      reason: round.reason,
      incumbentScore: round.incumbentScore,
      evolveScore: round.evolveScore,
      heldOutScore: round.heldOutScore,
    }))
    .sort((a, b) => a.number - b.number);
  const measured = await measure();
  console.log(
    `Batch ${stage}: rounds ${rounds.map((r) => `${r.number} ${r.decision}`).join(', ')}. ` +
      `Test: ${Math.round(measured.passRate * 100)}%.`,
  );
  results.push({ stage, rounds: rounds.map((r) => r.number), roundDetails: rounds, ...measured });
  await writeFile(join(here, 'results.json'), JSON.stringify({ taskModel, samples: SAMPLES, results }, null, 2) + '\n');
}
