/**
 * Teach a ticket router from 64 labelled tickets, driving the learning loop over the API.
 *
 *   npx tsx examples/ticket-triage/loop.ts
 *
 * Learning runs on the service and its executor. This script sets the loop up, starts it and
 * prints what happens. Stopping the script does not stop learning.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AcclimateClient, ApiError, defaultCacheDir, resolveAndCache } from '@acclimate/sdk';
import type { BundlePayload, LearningLoop, LearningRoundSummary } from '@acclimate/sdk';

const here = fileURLToPath(new URL('.', import.meta.url));
const NAME = process.env.ACCLIMATE_BUNDLE_NAME ?? 'Ticket triage';
const CHANNEL = 'stable';

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

/** Files under skills/ are skills, files under memory/ are memory, and the rest are instructions. */
async function payloadFromDirectory(directory: string): Promise<BundlePayload> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
  const files = [];
  for (const path of paths) {
    const kind = path.startsWith('skills/') ? 'skill' : path.startsWith('memory/') ? 'memory' : 'instruction';
    files.push({ path, kind, text: await readFile(join(directory, path), 'utf8') } as const);
  }
  return { schemaVersion: 1, files };
}

const percent = (score: number | null) => (score === null ? 'not scored' : `${Math.round(score * 100)}%`);

function describe(round: LearningRoundSummary): string {
  const ended = round.state === 'completed' ? '' : ` The round ended as ${round.state} (${round.reason}).`;
  if (round.decision === 'adopted') {
    return (
      `Round ${round.number} adopted and released version ${round.adoptedVersionId}. Evolve tasks: ` +
      `${percent(round.incumbentScore)} before, ${percent(round.evolveScore)} for the adopted version. ` +
      `Held-out tasks: ${percent(round.heldOutScore)}.${ended}`
    );
  }
  if (round.decision === 'kept') {
    return (
      `Round ${round.number} kept the current version (${round.reason}). Evolve tasks: ` +
      `${percent(round.incumbentScore)}. Held-out tasks: ${percent(round.heldOutScore)}.${ended}`
    );
  }
  const cause = round.failureCause ? `: ${round.failureCause.code}` : '';
  return `Round ${round.number} ${round.state} (${round.reason}${cause}).`;
}

const workspaceId = setting('ACCLIMATE_WORKSPACE');
const taskModel = setting('TASK_MODEL');
const judgeModel = setting('JUDGE_MODEL');
const client = new AcclimateClient({
  baseUrl: setting('ACCLIMATE_URL'),
  token: setting('ACCLIMATE_TOKEN'),
  scope: process.env.ACCLIMATE_SCOPE ?? 'ticket-triage-example',
});

// 1. Publish the starting instructions, unless an earlier run already did.
let bundleId: string | undefined;
for (let cursor: string | undefined; ; ) {
  const page = await client.listBundles(workspaceId, { cursor, limit: 100 });
  bundleId = page.items.find((bundle) => bundle.name === NAME)?.id;
  cursor = page.nextCursor ?? undefined;
  if (bundleId || !cursor) break;
}
if (bundleId) {
  console.log(`Using the existing bundle "${NAME}".`);
} else {
  const setup = await client.createBundleSetup(
    workspaceId,
    {
      name: NAME,
      origin: 'created',
      channel: CHANNEL,
      payload: await payloadFromDirectory(join(here, 'bundle')),
      reason: 'Starting instructions for the ticket triage example',
    },
    randomUUID(),
  );
  bundleId = setup.bundle.id;
  console.log(`Published "${NAME}" and released version ${setup.version.id} on ${CHANNEL}.`);
}

// 2. Learning needs a verified model provider. A signed-in administrator saves it in the console.
const provider = await client.getModelProvider(workspaceId);
if (provider.verification?.status !== 'verified') {
  throw new Error('Save a model provider on the workspace Members page and wait until it is verified.');
}
for (const model of [taskModel, judgeModel]) {
  if (!provider.allowedModels.includes(model)) throw new Error(`Add ${model} to the provider's allowed models.`);
}

// 3. Turn learning on for the channel, unless it already is. Settings changed later in the
//    console are left alone.
let loop: LearningLoop;
try {
  loop = await client.getLearningLoop(workspaceId, bundleId);
} catch (error) {
  if (!(error instanceof ApiError) || error.status !== 404) throw error;
  loop = await client.enrollLearningLoop(workspaceId, bundleId, {
    channel: CHANNEL,
    setting: { domain: 'support', benchmark: 'ticket-triage' },
    taskModel,
    judgeModel,
    maxRoundsPerDay: 3,
  });
}

// 4. Import the tickets. Each row has `input` and a short `expected`, so it becomes an exact-match task.
//    Importing the same bytes again returns the first import, so a second run adds nothing.
const tickets = await readFile(join(here, 'tickets.csv'));
const data = tickets.buffer.slice(tickets.byteOffset, tickets.byteOffset + tickets.byteLength) as ArrayBuffer;
let imported = await client.importLearningTasks(workspaceId, bundleId, data, 'text/csv', 'tickets.csv');
while (imported.pending > 0 && imported.status !== 'failed') {
  await sleep(2000);
  imported = await client.getLearningImport(workspaceId, bundleId, imported.importId);
}
if (imported.status === 'failed') throw new Error(`Import failed: ${imported.message}`);
console.log(`Imported ${imported.converted} of ${imported.rows} rows as tasks.`);

// 5. The executor checks each task before it counts. A machine token lists evolve tasks only,
//    and gets a count of the held-out tasks that match the filter.
for (;;) {
  const pending = await client.listLearningTasks(workspaceId, bundleId, { admission: 'pending', limit: 100 });
  const waiting = pending.items.length + pending.heldOutCount;
  if (waiting === 0) break;
  console.log(`Checking tasks: ${waiting} still pending.`);
  await sleep(10_000);
}
loop = await client.getLearningLoop(workspaceId, bundleId);
console.log(`Admitted ${loop.admittedEvolve} evolve tasks and ${loop.admittedHeldOut} held-out tasks.`);

// 6. Start a loop that has never run. The service refuses when a split has fewer than 20 admitted
//    tasks or it has no optimizer. A loop someone paused or stopped stays that way.
if (loop.status !== 'running' && loop.nextRound === 1) {
  try {
    loop = await client.startLearningLoop(workspaceId, bundleId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new Error(`Start refused: ${error.message}`);
    throw error;
  }
}

// 7. Report each round as it ends, until the loop waits for something or stops.
if (loop.status === 'running') {
  console.log('Learning is running. Press Ctrl-C to stop watching. Learning continues on the service.');
}
const reported = new Set(loop.rounds.filter((round) => round.endedAt).map((round) => round.id));
let stage = '';
for (;;) {
  loop = await client.getLearningLoop(workspaceId, bundleId);
  for (const round of [...loop.rounds].reverse()) {
    if (!round.endedAt || reported.has(round.id)) continue;
    reported.add(round.id);
    console.log(describe(round));
  }
  const active = loop.activeRound;
  if (active && `${active.number} ${active.state}` !== stage) {
    stage = `${active.number} ${active.state}`;
    console.log(`Round ${active.number}: ${active.state.replaceAll('_', ' ')}`);
  }
  if (!active && (loop.status !== 'running' || loop.waiting)) break;
  await sleep(15_000);
}
console.log(
  loop.status === 'running'
    ? `Learning is waiting: ${loop.waiting}.` + (loop.nextRoundAt ? ` Next round at ${loop.nextRoundAt}.` : '')
    : `Learning is ${loop.status}` + (loop.pauseReason ? ` (${loop.pauseReason}).` : '.') +
        ' Start it again on the Learning tab.',
);
if (loop.alert) console.log(`The loop raised an alert on round ${loop.alert.roundId}. Open the Learning tab.`);

// 8. Show what the next job will run with.
const released = await resolveAndCache(
  client,
  { workspaceId, bundleId, channel: CHANNEL },
  { cacheDir: process.env.ACCLIMATE_CACHE ?? (await defaultCacheDir()) },
);
console.log(`\nReleased on ${CHANNEL}: version ${released.version.id}`);
for (const file of released.payload.files) console.log(`\n# ${file.path}\n${file.text}`);
