import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AcclimateClient } from '@acclimate/sdk';
import type { BundlePayload } from '@acclimate/sdk';

const [file, name, reason] = process.argv.slice(2);
if (!file || !name?.trim() || !reason?.trim()) {
  throw new Error('Usage: npm run example:publish -- PATH BUNDLE_NAME INITIAL_RELEASE_REASON');
}

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the target workspace.`);
  return value;
}

const projectId = setting('ACCLIMATE_PROJECT');
const channel = process.env.ACCLIMATE_CHANNEL ?? 'stable';
const client = new AcclimateClient({
  baseUrl: setting('ACCLIMATE_URL'),
  token: setting('ACCLIMATE_TOKEN'),
  scope: setting('ACCLIMATE_SCOPE'),
});
const payload: BundlePayload = JSON.parse(await readFile(file, 'utf8'));
const { bundle, version } = await client.createBundleSetup(
  projectId,
  { name, origin: 'imported', channel, payload, reason },
  process.env.ACCLIMATE_OPERATION_ID ?? randomUUID(),
);
console.log(
  JSON.stringify(
    { projectId, bundleId: bundle.id, versionId: version.id, digest: version.digest, channel },
    null,
    2,
  ),
);
