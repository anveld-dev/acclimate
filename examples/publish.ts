import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AcclimateClient } from '../packages/sdk/src/index.js';
import type { BundlePayload } from '../packages/sdk/src/types.js';
const token = process.env.ACCLIMATE_TOKEN;
if (!token) throw new Error('Set ACCLIMATE_TOKEN to an operator-configured service token.');
const projectId = process.env.ACCLIMATE_PROJECT ?? 'demo';
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL ?? 'http://127.0.0.1:3000',
  token,
  scope: process.env.ACCLIMATE_SCOPE ?? 'demo-app',
});
const payload = JSON.parse(
  await readFile('contracts/fixtures/bundle-v1.json', 'utf8'),
) as BundlePayload;
const bundle = await client.createBundle(projectId, { name: 'Review assistant' }, randomUUID());
const version = await client.createVersion(
  projectId,
  bundle.id,
  { parentVersionId: null, payload },
  randomUUID(),
);
await client.promote(
  projectId,
  bundle.id,
  'stable',
  {
    versionId: version.id,
    expectedRevision: '0',
    unevaluatedReason: 'Initial example content; not an evaluated improvement.',
  },
  randomUUID(),
);
console.log(
  JSON.stringify(
    {
      projectId,
      bundleId: bundle.id,
      versionId: version.id,
      digest: version.digest,
      channel: 'stable',
    },
    null,
    2,
  ),
);
