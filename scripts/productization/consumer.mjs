import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AcclimateClient, resolveAndCache, prepareFiles } from '@anveld/acclimate-sdk';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const client = new AcclimateClient({baseUrl:config.baseUrl,token:config.token,scope:'operator',retries:0});
const policy = {cacheDir:join(process.cwd(),'cache')};
const source = await client.inspectSource(config.project, config.bundleId, 'stable');
assert.deepEqual(source.version, config.version);
const prepared = await client.prepare({ workspaceId: config.project, bundleId: config.bundleId, channel: 'stable', ...policy });
try {
  assert.deepEqual(prepared.version.version, config.version);
} finally {
  await prepared.cleanup();
}
const pinned = await resolveAndCache(client, { workspaceId: config.project, bundleId: config.bundleId, versionId: config.version.id }, policy);
assert.deepEqual(pinned.version, config.version);
await prepareFiles(pinned,join(process.cwd(),'prepared'));
assert.equal(await readFile(join(process.cwd(),'prepared/AGENTS.md'),'utf8'),'Review duplicate retries.');
console.log('Packed SDK verified source history and prepared the released version.');
