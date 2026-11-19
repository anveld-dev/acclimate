/** App-owned local Cursor session. This performs a paid provider call when run. */
import { Agent } from '@cursor/sdk';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { AcclimateClient, resolveAndCache } from '../packages/sdk/src/index.js';
import { prepare } from '../packages/cursor-plugin/src/index.js';
import { cursorLocalOptions } from '../packages/cursor-plugin/src/native.js';
import {
  optionalReceipts,
  observeOptional,
  observeStartOnce,
  settleOptional,
} from './optional-receipts.js';

if (!process.argv.includes('--live'))
  throw new Error(
    'Pass --live to request a paid Cursor session; Luna availability is not assumed.',
  );
const token = process.env.ACCLIMATE_TOKEN;
const bundleId = process.env.ACCLIMATE_BUNDLE;
const apiKey = process.env.CURSOR_API_KEY;
const model = process.env.CURSOR_MODEL;
if (!token || !bundleId || !apiKey || !model)
  throw new Error('Set ACCLIMATE_TOKEN, ACCLIMATE_BUNDLE, CURSOR_API_KEY and CURSOR_MODEL.');
if (!['gpt-6-luna', 'gpt-5.6-luna'].includes(model))
  throw new Error('This qualification permits only Luna models; Cursor support is not assumed.');
const projectId = process.env.ACCLIMATE_PROJECT ?? 'demo';
const reporter = optionalReceipts(process.env, projectId);
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL ?? 'http://127.0.0.1:3000',
  token,
  scope: process.env.ACCLIMATE_SCOPE ?? 'demo-app',
});
const bundle = await resolveAndCache(
  client,
  {
    projectId,
    bundleId,
    channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
  },
  {
    reporter,
    cacheDir: resolve(process.env.ACCLIMATE_CACHE ?? join(homedir(), '.cache', 'acclimate')),
  },
);
const selected = process.env.ACCLIMATE_APPROVED_MEMORY_PATH;
const prepared = await prepare(bundle, { approvedMemoryPaths: selected ? [selected] : [] });
observeOptional(() => reporter?.reportPrepared(bundle));
try {
  // The app chooses its model, tool policy and approved memory. Workspace settings can run hooks;
  // this fresh private workspace contains only the staged bundle resources.
  const agent = await Agent.create({
    apiKey,
    model: { id: model },
    ...cursorLocalOptions(prepared),
    local: { ...cursorLocalOptions(prepared).local, sandboxOptions: { enabled: true } },
  });
  try {
    const prompt =
      process.argv
        .slice(2)
        .filter((argument) => argument !== '--live')
        .join(' ') || 'Explain the available project guidance.';
    const memory = selected && prepared.memoryFiles.find((file) => file.path === selected);
    if (selected && !memory)
      throw new Error('The requested approved memory path is not in the bundle.');
    const run = await agent.send(
      memory ? `${prompt}\nApproved memory file: ${memory.absolutePath}` : prompt,
    );
    const observeStart = observeStartOnce(
      (event) => event.type === 'status' && event.status === 'RUNNING',
      () => reporter?.reportStarted(bundle),
    );
    for await (const event of run.stream()) {
      observeStart(event);
      console.log(event);
    }
    console.log({ versionId: prepared.versionId, digest: prepared.digest, mode: 'fresh-local' });
  } finally {
    await agent[Symbol.asyncDispose]();
  }
} finally {
  await prepared.cleanup();
  await settleOptional(reporter);
}
