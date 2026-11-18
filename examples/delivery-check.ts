/** Check the files delivered by the configured service. */
import { readFile } from 'node:fs/promises';
import { AcclimateClient } from '../packages/sdk/src/index.js';
import { optionalReceipts, settleOptional } from './optional-receipts.js';

for (const key of [
  'ACCLIMATE_URL',
  'ACCLIMATE_TOKEN',
  'ACCLIMATE_SCOPE',
  'ACCLIMATE_PROJECT',
  'ACCLIMATE_BUNDLE',
]) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!,
  scope: process.env.ACCLIMATE_SCOPE!,
});
const projectId = process.env.ACCLIMATE_PROJECT!;
const reporter = optionalReceipts(process.env, projectId);
try {
  const prepared = await client.prepare({
    projectId,
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
        versionId: prepared.version.id,
        digest: prepared.version.digest,
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
