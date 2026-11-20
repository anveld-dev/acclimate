/** Check the files delivered by the configured service. */
import { readFile } from 'node:fs/promises';
import { AcclimateClient } from '@acclimate/sdk';
import { optionalReceipts, settleOptional } from './optional-receipts.js';

for (const key of [
  'ACCLIMATE_URL',
  'ACCLIMATE_TOKEN',
  'ACCLIMATE_SCOPE',
  'ACCLIMATE_WORKSPACE',
  'ACCLIMATE_BUNDLE',
  'ACCLIMATE_CONNECTION',
]) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!,
  scope: process.env.ACCLIMATE_SCOPE!,
  connectionId: process.env.ACCLIMATE_CONNECTION!,
});
const workspaceId = process.env.ACCLIMATE_WORKSPACE!;
const reporter = optionalReceipts(process.env, workspaceId);
try {
  const prepared = await client.prepare({
    workspaceId,
    bundleId: process.env.ACCLIMATE_BUNDLE!,
    channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
    destination: process.env.ACCLIMATE_JOB_DIR,
    cacheDir: process.env.ACCLIMATE_CACHE,
    reporter,
  });
  try {
    for (const file of prepared.files) await readFile(file.absolutePath);
    console.log(
      JSON.stringify({
        versionId: prepared.version.version.id,
        digest: prepared.version.version.digest,
        files: prepared.files.map((file) => file.path),
        checkedFiles: prepared.files.length,
        reporting: reporter ? 'optional' : 'disabled',
      }),
    );
  } finally {
    await prepared.cleanup();
  }
} finally {
  await settleOptional(reporter);
}
