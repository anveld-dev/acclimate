/** Model-free app delivery, with a separate optional receipt-write identity. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AcclimateClient, prepareFiles, resolveAndCache } from '../packages/sdk/src/index.js';
import { optionalReceipts, observeOptional, settleOptional } from './optional-receipts.js';

for (const key of [
  'ACCLIMATE_TOKEN',
  'ACCLIMATE_PROJECT',
  'ACCLIMATE_BUNDLE',
  'ACCLIMATE_CACHE',
  'ACCLIMATE_JOB_DIR',
]) {
  if (!process.env[key]) throw new Error(`Set ${key}`);
}
const projectId = process.env.ACCLIMATE_PROJECT!;
const reporter = optionalReceipts(process.env, projectId);
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL ?? 'http://127.0.0.1:3000',
  token: process.env.ACCLIMATE_TOKEN!,
  scope: process.env.ACCLIMATE_SCOPE ?? 'delivery-check',
});
const bundle = await resolveAndCache(
  client,
  {
    projectId,
    bundleId: process.env.ACCLIMATE_BUNDLE!,
    channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
  },
  { cacheDir: resolve(process.env.ACCLIMATE_CACHE!), reporter },
);
const prepared = await prepareFiles(bundle, resolve(process.env.ACCLIMATE_JOB_DIR!));
observeOptional(() => reporter?.reportPrepared(bundle));
try {
  // This tiny app actually starts and reads its pinned files. No model is called.
  const app = spawn(
    process.execPath,
    [
      '-e',
      `
    console.log('delivery-check started');
    for (const path of process.argv.slice(1)) require('node:fs').readFileSync(path, 'utf8');
  `,
      ...prepared.files.map((file) => file.absolutePath),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let observedStart = false,
    output = '';
  app.stdout.setEncoding('utf8');
  app.stdout.on('data', (chunk: string) => {
    output += chunk;
    if (!observedStart && output.includes('delivery-check started\n')) {
      observedStart = true;
      observeOptional(() => reporter?.reportStarted(bundle));
    }
  });
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`App exited ${code}`))));
  });
  if (!observedStart) throw new Error('Application start was not observed');
  console.log(
    JSON.stringify({
      versionId: bundle.version.id,
      digest: bundle.version.digest,
      files: prepared.files.map((file) => file.path),
      started: observedStart,
      reporting: reporter ? 'optional' : 'disabled',
    }),
  );
} finally {
  await prepared.cleanup();
  await settleOptional(reporter);
}
