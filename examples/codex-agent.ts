import { Codex } from '@openai/codex-sdk';
import { resolve, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AcclimateClient, resolveAndCache } from '../packages/sdk/src/index.js';
import { prepare } from '../packages/codex-plugin/src/index.js';
import { withNativeSessionInputs } from './native-session-lifetime.js';
import {
  optionalReceipts,
  observeOptional,
  observeStartOnce,
  settleOptional,
} from './optional-receipts.js';

if (!process.argv.includes('--live'))
  throw new Error('Pass --live to request a paid Luna session.');
const prompt = process.argv
  .slice(2)
  .filter((argument) => argument !== '--live')
  .join(' ')
  .trim();
if (!prompt) throw new Error('Supply the task for your Codex session.');
const {
  ACCLIMATE_PROJECT: projectId,
  ACCLIMATE_URL: baseUrl,
  ACCLIMATE_SCOPE: scope,
} = process.env;
if (!projectId || !baseUrl || !scope)
  throw new Error('Set ACCLIMATE_PROJECT, ACCLIMATE_URL and ACCLIMATE_SCOPE.');
const token = process.env.ACCLIMATE_TOKEN;
const bundleId = process.env.ACCLIMATE_BUNDLE;
if (!token || !bundleId) throw new Error('Set ACCLIMATE_TOKEN and ACCLIMATE_BUNDLE.');
const model = process.env.ACCLIMATE_CODEX_MODEL ?? 'gpt-6-luna';
if (!['gpt-6-luna', 'gpt-5.6-luna'].includes(model))
  throw new Error('Only Luna models are allowed.');
const reporter = optionalReceipts(process.env, projectId);
const client = new AcclimateClient({
  baseUrl,
  token,
  scope,
});
const verified = await resolveAndCache(
  client,
  {
    projectId,
    bundleId,
    channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
  },
  {
    reporter,
    cacheDir: resolve(
      process.env.ACCLIMATE_CACHE ?? join(await realpath(homedir()), '.cache', 'acclimate'),
    ),
  },
);
const prepared = await prepare(verified);
observeOptional(() => reporter?.reportPrepared(verified));
try {
  await withNativeSessionInputs(prepared, async () => {
    const thread = new Codex().startThread({
      model,
      workingDirectory: prepared.cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
    const memory = prepared.memoryFiles
      .map((f) => `Approved memory file: ${f.absolutePath}`)
      .join('\n');
    const turn = await thread.runStreamed(`${prompt}\n${memory}`, {
      signal: AbortSignal.timeout(110_000),
    });
    const observeStart = observeStartOnce(
      (event) => event.type === 'turn.started',
      () => reporter?.reportStarted(verified),
    );
    let response = '';
    for await (const event of turn.events) {
      // startThread and runStreamed construct lazy objects; only this event observes start.
      observeStart(event);
      if (event.type === 'item.completed' && event.item.type === 'agent_message')
        response = event.item.text;
      if (event.type === 'turn.failed') throw new Error(event.error.message);
      if (event.type === 'error') throw new Error(event.message);
    }
    console.log(
      JSON.stringify(
        {
          model,
          versionId: verified.version.id,
          digest: verified.version.digest,
          response,
        },
        null,
        2,
      ),
    );
  });
} finally {
  await settleOptional(reporter);
}
