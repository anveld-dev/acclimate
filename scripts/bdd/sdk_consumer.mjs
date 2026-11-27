import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  AcclimateClient,
  ApiError,
  AcclimateUsageError,
  DeliveryError,
  TransportError,
  resolveAndCache,
  prepareFiles,
  createReceiptReporter,
} from '@anveld/sdk';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const client = new AcclimateClient({
  baseUrl: input.baseUrl,
  token: input.token,
  scope: input.scope,
  ...(['delivery', 'editJob', 'collision', 'cleanup', 'native'].includes(input.action) && { connectionId: input.connectionId }),
  retries: 0,
  timeoutMs: 2000,
});
const base = { workspaceId: input.workspaceId, bundleId: input.bundleId };
const policy = {
  cacheDir: join(input.directory, 'cache'),
  ...(input.offline ? { offline: { pinnedVersionId: input.versionId ?? "legacy-channel" } } : {}),
};
const selection = input.versionId
  ? { ...base, versionId: input.versionId }
  : { ...base, channel: 'stable' };

async function delivery() {
  const reporter = input.reporting
    ? createReceiptReporter({
        client: new AcclimateClient({
          baseUrl: input.baseUrl,
          token: input.receiptToken,
          scope: 'receipt-fixture',
          retries: 0,
          timeoutMs: 1000,
        }),
        workspaceId: base.workspaceId,
        connectionId: input.connectionId,
      })
    : undefined;
  const destination = join(input.directory, 'prepared-' + crypto.randomUUID());
  const job = await client.prepare({ ...selection, ...policy, reporter, destination });
  const bundle = job.version;
  if (input.reporting) {
    if (input.started) {
      const { spawn } = await import('node:child_process');
      const app = spawn(process.execPath, ['-e', "console.log('app started')"], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let output = '',
        started = false;
      app.stdout.setEncoding('utf8');
      app.stdout.on('data', (chunk) => {
        output += chunk;
        if (!started && output.includes('app started\n')) {
          started = true;
          try {
            job.reportStarted();
          } catch {}
        }
      });
      await new Promise((resolve, reject) => {
        app.once('error', reject);
        app.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error('Application start failed')),
        );
      });
      assert(started);
    }
    await reporter.flush();
  }
  return {
    version: bundle.version,
    revision: bundle.resolution?.revision,
    stale: bundle.stale,
    instruction: await readFile(join(destination, 'AGENTS.md'), 'utf8'),
    destination,
    pending: reporter?.pendingCount,
  };
}
async function editJob() {
  const result = await delivery();
  await writeFile(join(result.destination, 'AGENTS.md'), 'Job-local edits.');
  return result;
}
async function collision() {
  const bundle = await resolveAndCache(client, selection, policy);
  const destination = join(input.directory, 'existing');
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, 'AGENTS.md'), 'Application instructions.', { mode: 0o600 });
  let rejected = false;
  try {
    await prepareFiles(bundle, destination);
  } catch (error) {
    if (!(error instanceof DeliveryError) && error.code !== 'EEXIST') throw error;
    rejected = true;
  }
  return { rejected, instruction: await readFile(join(destination, 'AGENTS.md'), 'utf8') };
}
async function cleanup() {
  const bundle = await resolveAndCache(client, selection, policy);
  const destination = join(input.directory, 'cleanup');
  const prepared = await prepareFiles(bundle, destination);
  await writeFile(join(destination, 'application-note.txt'), 'Keep this note.', { mode: 0o600 });
  await prepared.cleanup();
  let instructionExists = true;
  try {
    await access(join(destination, 'AGENTS.md'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    instructionExists = false;
  }
  return {
    instructionExists,
    note: await readFile(join(destination, 'application-note.txt'), 'utf8'),
  };
}
async function native() {
  const bundle = await resolveAndCache(client, selection, policy);
  const plugin = await import('@anveld/' + input.plugin + '-plugin');
  const prepared = await plugin.prepare(bundle, {
    approvedMemoryPaths: input.approveMemory ? ['memory/team.md'] : [],
  });
  try {
    return {
      instructionName: basename(prepared.instructionPath),
      instruction: await readFile(prepared.instructionPath, 'utf8'),
      skillPaths: prepared.skillPaths.map((path) => basename(path)),
      memoryCount: prepared.memoryFiles.length,
    };
  } finally {
    await prepared.cleanup();
  }
}
async function recoverReporting() {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const unavailable = createServer((request, response) => {
    request.resume();
    response.writeHead(503).end();
  });
  unavailable.listen(0, '127.0.0.1');
  await once(unavailable, 'listening');
  const outageUrl = 'http://127.0.0.1:' + unavailable.address().port;
  const originalEvents = new Map();
  const sentAfter = [];
  let recovered = false;
  let now = Date.now();
  const reportClient = new AcclimateClient({
    baseUrl: input.baseUrl,
    token: input.receiptToken,
    scope: 'receipt-fixture',
    retries: 0,
    fetch: (url, init) => {
      const raw = String(init.body);
      if (recovered) {
        sentAfter.push(raw);
        return fetch(url, init);
      }
      const { eventId } = JSON.parse(raw);
      if (originalEvents.has(eventId)) assert.equal(originalEvents.get(eventId), raw);
      originalEvents.set(eventId, raw);
      return fetch(outageUrl, init);
    },
  });
  const reporter = createReceiptReporter({
    client: reportClient,
    workspaceId: base.workspaceId,
    connectionId: input.connectionId,
    now: () => now,
  });
  try {
    const reader = new AcclimateClient({
      baseUrl: input.baseUrl,
      token: input.readerToken,
      scope: 'delivery-fixture',
    });
    const bundle = await resolveAndCache(reader, selection, { ...policy, reporter });
    const destination = join(input.directory, 'reporting-outage');
    await prepareFiles(bundle, destination);
    const instruction = await readFile(join(destination, 'AGENTS.md'), 'utf8');
    reporter.reportPrepared(bundle);
    await reporter.flush();
    const pendingBefore = reporter.pendingCount;
    const receivedBefore = (await client.listDeliveryReceipts(base.workspaceId, input.connectionId))
      .items;
    const originals = [...originalEvents.values()];
    const preparedEvent = originals
      .map((raw) => JSON.parse(raw))
      .find((event) => event.stage === 'prepared');
    now += input.expired ? 24 * 60 * 60 * 1000 + 1 : 1000;
    recovered = true;
    await reporter.flush();
    await reporter.flush();
    return {
      instruction,
      pendingBefore,
      receivedBefore,
      preparedEvent,
      originalEvents: originals.sort(),
      sentAfter: sentAfter.sort(),
      pendingAfter: reporter.pendingCount,
    };
  } finally {
    await new Promise((resolve) => unavailable.close(resolve));
  }
}
const actions = {
  delivery,
  editJob,
  collision,
  cleanup,
  native,
  recoverReporting,
};
if (!actions[input.action]) throw Error('Unknown SDK fixture action');
try {
  console.log(JSON.stringify(await actions[input.action]()));
} catch (error) {
  if (
    !(
      error instanceof AcclimateUsageError ||
      error instanceof ApiError ||
      error instanceof DeliveryError ||
      error instanceof TransportError
    )
  )
    throw error;
  console.log(
    JSON.stringify({ error: { name: error.name, code: error.code, status: error.status } }),
  );
}
