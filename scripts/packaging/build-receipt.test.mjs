import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildInputFiles, cleanPackageEmissions, packageBuildInputs, verifyPackageBuildReceipt, writePackageBuildReceipt } from './build-receipt.mjs';
import { packageNames } from './release-metadata.mjs';

test('package receipts reject stale source and modified installed output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acclimate-build-receipt-'));
  async function put(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  try {
    for (const path of buildInputFiles) await put(path, '{}');
    for (const name of packageNames) {
      await put(`packages/${name}/src/index.ts`, 'export const value = 1;');
      await put(`packages/${name}/dist/index.js`, 'export const value = 1;');
    }
    await mkdir(join(root, 'dist'));
    await assert.rejects(verifyPackageBuildReceipt(root), /missing or invalid/);
    const inputs = await packageBuildInputs(root);
    await writePackageBuildReceipt(root, inputs);
    await verifyPackageBuildReceipt(root);
    await put('packages/sdk/src/index.ts', 'export const value = 2;');
    await assert.rejects(verifyPackageBuildReceipt(root), /stale or modified/);
    await assert.rejects(writePackageBuildReceipt(root, inputs), /changed during compilation/);
    await put('packages/sdk/src/index.ts', 'export const value = 1;');
    await put('packages/sdk/dist/index.js', 'export const value = 3;');
    await assert.rejects(verifyPackageBuildReceipt(root), /stale or modified/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('clean compilation removes obsolete emitted modules and preserves unrelated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acclimate-clean-emissions-'));
  try {
    for (const name of packageNames) {
      await mkdir(join(root, 'dist/packages', name, 'src'), { recursive: true });
      await writeFile(join(root, 'dist/packages', name, 'src/deleted.js'), 'stale private module');
      await writeFile(join(root, 'dist/packages', name, 'src/deleted.d.ts'), 'stale declaration');
    }
    await writeFile(join(root, 'dist/unrelated.js'), 'preserve this output');
    await cleanPackageEmissions(root);
    for (const name of packageNames)
      await assert.rejects(access(join(root, 'dist/packages', name, 'src/deleted.js')));
    assert.equal(await readFile(join(root, 'dist/unrelated.js'), 'utf8'), 'preserve this output');
  } finally { await rm(root, { recursive: true, force: true }); }
});
