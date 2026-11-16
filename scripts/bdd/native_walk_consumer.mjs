/** Copied into an outside-checkout app and resolved against installed tarballs. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AcclimateClient, createReceiptReporter, resolveAndCache } from '@acclimate/sdk';
import { prepare } from '@acclimate/codex-plugin';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const pinned of config.pinned || []) {
  for (const file of pinned.files)
    assert.equal(await readFile(file.absolutePath, 'utf8'), file.text);
}
const readClient = new AcclimateClient({
  baseUrl: config.baseUrl,
  token: config.readToken,
  scope: 'native-walk-read-' + config.integrationId,
  retries: 0,
  timeoutMs: 2000,
});
const receiptClient = new AcclimateClient({
  baseUrl: config.baseUrl,
  token: config.denyReceipt ? 'fixture-invalid-receipt-token' : config.receiptToken,
  scope: 'native-walk-receipts-' + config.integrationId,
  retries: 0,
  timeoutMs: 2000,
});
const receiptFailures = [];
const sendReceipt = receiptClient.reportDeliveryReceipt.bind(receiptClient);
receiptClient.reportDeliveryReceipt = async (...args) => {
  try {
    return await sendReceipt(...args);
  } catch (error) {
    receiptFailures.push({
      stage: args[2]?.stage,
      name: error.name,
      status: error.status,
      code: error.code,
    });
    throw error;
  }
};
const reporter = createReceiptReporter({
  client: receiptClient,
  projectId: config.projectId,
  integrationId: config.integrationId,
});
const bundle = await resolveAndCache(
  readClient,
  { projectId: config.projectId, bundleId: config.bundleId, channel: 'stable' },
  { cacheDir: join(process.cwd(), 'cache'), reporter },
);
assert.equal(bundle.version.id, config.expectedVersion.id);
assert.equal(bundle.version.digest, config.expectedVersion.digest);
assert.deepEqual(bundle.payload, config.expectedPayload);
const prepared = await prepare(bundle);
const files = [];
for (const source of bundle.payload.files) {
  const absolutePath =
    source.kind === 'instruction'
      ? prepared.instructionPath
      : source.kind === 'skill'
        ? prepared.skillPaths.find((path) => path.endsWith('/retry-review/SKILL.md'))
        : prepared.memoryFiles.find((file) => file.path === source.path)?.absolutePath;
  assert.ok(absolutePath);
  assert.equal(await readFile(absolutePath, 'utf8'), source.text);
  files.push({ absolutePath, text: source.text });
}
reporter.reportPrepared(bundle);
// The app explicitly approves this declarative data file, then observes a real
// model-free child reading it before reporting started. No model is launched.
const policy = prepared.memoryFiles.find((file) => file.path === 'payment-policy.json');
assert.ok(policy);
const child = spawnSync(
  process.execPath,
  [
    '-e',
    "const fs=require('node:fs');const policy=JSON.parse(fs.readFileSync(process.env.POLICY_FILE,'utf8'));process.stdout.write('started:'+policy.idempotency)",
  ],
  { cwd: prepared.cwd, env: { POLICY_FILE: policy.absolutePath }, encoding: 'utf8', timeout: 2000 },
);
assert.equal(child.status, 0);
assert.equal(child.stdout, 'started:' + JSON.parse(policy.text).idempotency);
reporter.reportStarted(bundle);
await reporter.flush();
if (config.denyReceipt) assert.ok(reporter.pendingCount > 0);
else assert.equal(reporter.pendingCount, 0, JSON.stringify({ receiptFailures }));
reporter.close();
console.log(
  JSON.stringify({
    version: bundle.version,
    resolution: bundle.resolution,
    files,
    pending: reporter.pendingCount,
    receiptFailures,
    appStarted: true,
    nativeCwd: prepared.cwd,
  }),
);
// This fixture deliberately retains prepared workspaces across refresh/rollback.
// TMPDIR points inside the owning test cluster directory; teardown removes them.
