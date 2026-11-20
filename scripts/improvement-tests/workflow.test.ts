import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { improve, type Model } from '../../examples/improvement/workflow.js';
import { gradeFinding } from '../../examples/improvement/grader.js';
import type { AcclimateClient } from '../../packages/sdk/src/client.js';
import type { BundlePayload, VersionMetadata } from '../../packages/sdk/src/types.js';

const bytes = (p: BundlePayload) => Buffer.from(JSON.stringify(p) + '\n');
const meta = (id: string, parentVersionId: string | null, p: BundlePayload): VersionMetadata => ({
  id,
  parentVersionId,
  bundleId: 'bundle',
  digest: `sha256:${createHash('sha256').update(bytes(p)).digest('hex')}`,
  createdAt: '2026-01-01T00:00:00Z',
});
const parentPayload: BundlePayload = {
  schemaVersion: 1,
  files: [
    {
      path: 'skills/review/SKILL.md',
      kind: 'skill',
      text: '---\nname: review\ndescription: review\n---\nReview.',
    },
    { path: 'context.md', kind: 'memory', text: 'unchanged' },
  ],
};
function fakeClient() {
  const parent = meta('parent', null, parentPayload);
  const payloads = new Map([['parent', parentPayload]]);
  const versions = new Map([['parent', parent]]);
  let uploaded: any;
  const client = {
    baseUrl: 'http://fixture',
    scope: 'fixture',
    inspectSource: async () => ({ channel: 'stable', revision: '1', version: parent }),
    getVersion: async (_p: string, _b: string, id: string) => versions.get(id),
    getPayload: async (_p: string, _b: string, id: string) => bytes(payloads.get(id)!),
    createVersion: async (
      _p: string,
      _b: string,
      request: { parentVersionId: string; payload: BundlePayload },
    ) => {
      assert.equal(request.parentVersionId, 'parent');
      assert.equal(request.payload.files[1]!.text, 'unchanged');
      payloads.set('candidate', request.payload);
      const v = meta('candidate', 'parent', request.payload);
      versions.set('candidate', v);
      return v;
    },
    createComparison: async (_p: string, _b: string, report: any) => {
      uploaded = report;
      return {
        ...report,
        id: 'comparison',
        complete: report.results.every((r: any) =>
          [r.parent, r.candidate].every(
            (o: any) =>
              o.gradingStatus === 'scored' && o.executionStatus !== 'infrastructure_failed',
          ),
        ),
      };
    },
  };
  return { client: client as unknown as AcclimateClient, uploaded: () => uploaded };
}
const config = (outputDir: string) => ({
  workspace: 'workspace',
  bundle: 'bundle',
  channel: 'stable',
  skillPath: 'skills/review/SKILL.md',
  outputDir,
  model: 'fake',
  authorModel: 'fake-author',
  sdkVersion: 'fixture',
});
test('pins, edits one file, compares both versions, and persists honest evidence', async () => {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'improve-test-'));
  try {
    const fake = fakeClient();
    let calls = 0;
    const model: Model = {
      draft: async () => parentPayload.files[0]!.text + '\nInspect retries.',
      review: async (_bundle, snapshot) => {
        calls++;
        return {
          text: JSON.stringify({ unsafeRetry: !snapshot.diff.includes('idempotencyKey') }),
          usage: null,
        };
      },
    };
    const { summary, summaryPath } = await improve(fake.client, config(dir), model);
    assert.equal(calls, 4);
    assert.equal(summary.complete, true);
    assert.equal(summary.sampleCount, 2);
    assert.equal(summary.authorModel, 'fake-author');
    assert.equal(summary.model, 'fake');
    assert.equal(summary.report.runtime.model, 'fake');
    assert.equal(summary.costUsd, null);
    assert.equal(summary.candidate.parentVersionId, 'parent');
    assert.equal(fake.uploaded().results.length, 2);
    for (const pair of summary.report.results)
      for (const outcome of [pair.parent, pair.candidate]) {
        assert.equal(outcome.reward, 1);
        assert(outcome.outputRef);
        assert.equal(JSON.parse(await readFile(new URL(outcome.outputRef), 'utf8')).costUsd, null);
      }
    assert.equal(JSON.parse(await readFile(summaryPath, 'utf8')).comparisonId, 'comparison');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('model failures and malformed output remain visible and incomplete', async () => {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'improve-test-'));
  try {
    const fake = fakeClient();
    let call = 0;
    const model: Model = {
      draft: async () => parentPayload.files[0]!.text + '\nchanged',
      review: async () => {
        if (++call === 1) throw new Error('model unavailable');
        return { text: 'not JSON', usage: null };
      },
    };
    const { summary } = await improve(fake.client, config(dir), model);
    assert.equal(summary.complete, false);
    assert.equal(summary.report.results[0]!.parent.executionStatus, 'infrastructure_failed');
    assert.equal(summary.report.results[0]!.candidate.gradingStatus, 'failed');
    assert.equal(summary.report.results[0]!.candidate.reward, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('grader is strict and independent of version', () => {
  assert.equal(gradeFinding('checkout-retry', '{"unsafeRetry":true}').reward, 1);
  assert.equal(gradeFinding('checkout-keyed', '{"unsafeRetry":true}').reward, 0);
  assert.throws(() => gradeFinding('checkout-keyed', '{"unsafeRetry":false,"extra":1}'));
  assert.throws(() => gradeFinding('unknown', '{"unsafeRetry":false}'));
});

test('rejects malformed or renamed draft before publishing', async () => {
  for (const draft of [
    '---\nname: review\n---\nMissing description.',
    '---\nname: other\ndescription: review\n---\nRenamed.',
  ]) {
    const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'improve-test-'));
    try {
      const fake = fakeClient();
      let published = false;
      fake.client.createVersion = async () => {
        published = true;
        throw new Error('unexpected publication');
      };
      const model: Model = {
        draft: async () => draft,
        review: async () => {
          throw new Error('unexpected review');
        },
      };
      await assert.rejects(improve(fake.client, config(dir), model), { code: 'invalid_payload' });
      assert.equal(published, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('refuses symlink output paths without touching their targets', async () => {
  const { symlink, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'improve-test-'));
  const targetDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'improve-target-'));
  try {
    const target = path.join(targetDir, 'target');
    await writeFile(target, 'untouched');
    const fake = fakeClient();
    let call = 0;
    const model: Model = {
      draft: async () => parentPayload.files[0]!.text + '\nChanged.',
      review: async () => {
        if (++call === 1) await symlink(target, path.join(dir, 'checkout-retry-0-parent.json'));
        return { text: '{"unsafeRetry":true}', usage: null };
      },
    };
    const { summary } = await improve(fake.client, config(dir), model);
    assert.equal(summary.report.results[0]!.parent.executionStatus, 'infrastructure_failed');
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    const link = path.join(targetDir, 'output-link');
    await symlink(dir, link);
    await assert.rejects(improve(fake.client, config(link), model), /private|symlink/);
    await assert.rejects(improve(fake.client, config(dir), model), /empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
