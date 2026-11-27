// Exercise preparation from the installed SDK without provider credentials.
import { readFile } from 'node:fs/promises';
import { prepareFiles } from '@anveld/acclimate-sdk';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(await realpath(tmpdir()), 'native-delivery-'));
try {
  const text = 'Keep payment retries request-scoped.';
  const payload = {schemaVersion: 1, files: [{path: 'instructions.md', kind: 'instruction', text}]};
  const staged = await prepareFiles({payload, version: {id: 'fixture', bundleId: 'fixture'}}, path.join(root, 'job'));
  try {
    console.log(JSON.stringify({instructions: await readFile(staged.files[0].absolutePath, 'utf8')}));
  } finally {
    await staged.cleanup();
  }
} finally {
  await rm(root, {recursive: true, force: true});
}
