/**
 * App-owned local Cursor session. This performs a paid provider call when run:
 *   tsx examples/cursor-agent.ts --live "Explain the project guidance"
 * client.prepare() -> prepare(delivery) -> Agent.create(local sandbox) -> reportStarted()
 * at RUNNING -> retain the result -> cleanup.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '@cursor/sdk';
import { AcclimateClient } from '@anveld/acclimate-sdk';
import { prepare } from '@anveld/acclimate-cursor-plugin';
import { cursorLocalOptions } from '@anveld/acclimate-cursor-plugin/native';
import { optionalReceipts, settleOptional } from './optional-receipts.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to request a paid Cursor session.');
const token = process.env.ACCLIMATE_TOKEN;
const connectionId = process.env.ACCLIMATE_CONNECTION;
const bundleId = process.env.ACCLIMATE_BUNDLE;
const apiKey = process.env.CURSOR_API_KEY;
const model = process.env.CURSOR_MODEL;
const jobDirectory = process.env.ACCLIMATE_JOB_DIR;
if (!token || !bundleId || !connectionId || !apiKey || !model || !jobDirectory)
  throw new Error('Set ACCLIMATE_TOKEN, ACCLIMATE_BUNDLE, ACCLIMATE_CONNECTION, CURSOR_API_KEY, CURSOR_MODEL and ACCLIMATE_JOB_DIR.');
const workspaceId = process.env.ACCLIMATE_WORKSPACE ?? 'demo';
const reporter = optionalReceipts(process.env, workspaceId);
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL ?? 'http://127.0.0.1:3000',
  token,
  connectionId,
  scope: process.env.ACCLIMATE_SCOPE ?? 'demo-app',
});
// cacheDir defaults to defaultCacheDir(): ~/.cache/acclimate/typescript.
const delivery = await client.prepare({
  workspaceId,
  bundleId,
  channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
  cacheDir: process.env.ACCLIMATE_CACHE,
  reporter,
});
const selected = process.env.ACCLIMATE_APPROVED_MEMORY_PATH;
const prepared = await prepare(delivery, { approvedMemoryPaths: selected ? [selected] : [] });
let finished = false;
try {
  // The app chooses its model, tool policy and approved memory. Workspace settings can run
  // hooks; this fresh private workspace contains only the staged bundle resources.
  const agent = await Agent.create({
    apiKey,
    model: { id: model },
    local: { ...cursorLocalOptions(prepared).local, sandboxOptions: { enabled: true } },
  });
  try {
    const prompt =
      process.argv.slice(2).filter((argument) => argument !== '--live').join(' ') ||
      'Explain the available project guidance.';
    const memory = selected && prepared.memoryFiles.find((file) => file.path === selected);
    if (selected && !memory) throw new Error('The requested approved memory path is not in the bundle.');
    const run = await agent.send(memory ? `${prompt}\nApproved memory file: ${memory.absolutePath}` : prompt);
    let started = false;
    for await (const event of run.stream()) {
      if (!started && event.type === 'status' && event.status === 'RUNNING') {
        started = true;
        prepared.reportStarted();
      }
    }
    const result = await run.wait();
    finished = true;
    // Retain the result outside the prepared workspace; never overwrite an earlier run.
    const retained = await open(join(jobDirectory, 'acclimate-agent-result.json'), 'wx', 0o600);
    try {
      await retained.writeFile(JSON.stringify({
        versionId: prepared.versionId, digest: prepared.digest, status: result.status,
        result: result.result ?? null, error: result.error?.message ?? null, usage: result.usage ?? null,
      }) + '\n');
      await retained.sync();
    } finally {
      await retained.close();
    }
    console.log({ versionId: prepared.versionId, digest: prepared.digest, status: result.status });
  } finally {
    await agent[Symbol.asyncDispose]();
  }
} finally {
  // Cleanup removes the workspace and the delivery directory; keep them if the run's end is unknown.
  if (finished) await prepared.cleanup();
  else console.error(`Cursor run end is unknown; inputs kept at ${prepared.cwd}`);
  await settleOptional(reporter);
}
