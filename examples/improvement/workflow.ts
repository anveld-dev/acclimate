import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepare } from '../../packages/codex-plugin/src/index.js';
import path from 'node:path';
import { resolveAndCache } from '../../packages/sdk/src/index.js';
import { compare, submitComparison } from '../../packages/sdk/src/compare.js';
import type { AcclimateClient } from '../../packages/sdk/src/client.js';
import type { VerifiedBundle } from '../../packages/sdk/src/types.js';
import { cases, datasetRevision } from './dataset.js';
import { gradeFinding, graderRevision } from './grader.js';

export interface Model {
  draft(parent: VerifiedBundle, skillPath: string): Promise<string>;
  review(
    bundle: VerifiedBundle,
    snapshot: { diff: string },
  ): Promise<{ text: string; usage: { inputTokens?: number; outputTokens?: number } | null }>;
}
export interface Config {
  project: string;
  bundle: string;
  channel: string;
  skillPath: string;
  outputDir: string;
  model: string;
  authorModel: string;
  sdkVersion: string;
}
export async function improve(client: AcclimateClient, config: Config, model: Model) {
  const outputDir = path.resolve(config.outputDir);
  const parentDir = path.dirname(outputDir);
  if ((await realpath(parentDir)) !== parentDir) throw new Error('Output path contains a symlink');
  try {
    await mkdir(outputDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const directory = await lstat(outputDir);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
    throw new Error('Output directory must be private (mode 0700)');
  if ((await realpath(outputDir)) !== outputDir) throw new Error('Output path contains a symlink');
  if ((await readdir(outputDir)).length) throw new Error('Output directory must be empty');
  const cacheDir = path.join(outputDir, 'cache');
  const parent = await resolveAndCache(
    client,
    { projectId: config.project, bundleId: config.bundle, channel: config.channel },
    { cacheDir },
  );
  if (!parent.resolution) throw new Error('Channel resolution missing');
  const skill = parent.payload.files.find((f) => f.path === config.skillPath && f.kind === 'skill');
  if (!skill || !config.skillPath.endsWith('/SKILL.md'))
    throw new Error('Allowed path must be an existing skill manifest');
  const text = await model.draft(parent, config.skillPath);
  if (
    typeof text !== 'string' ||
    !text.startsWith('---\n') ||
    !text.includes('\n---\n') ||
    text === skill.text ||
    Buffer.byteLength(text) > 256 * 1024
  )
    throw new Error('Draft must be a changed, nonempty skill text within 256 KiB');
  const payload = structuredClone(parent.payload);
  payload.files.find((f) => f.path === config.skillPath)!.text = text;
  // Validate the complete candidate through the real native mapping before publishing.
  const staged = await prepare({ ...parent, payload });
  await staged.cleanup();
  const metadata = await client.createVersion(
    config.project,
    config.bundle,
    { parentVersionId: parent.version.id, payload },
    randomUUID(),
  );
  const candidate = await resolveAndCache(
    client,
    { projectId: config.project, bundleId: config.bundle, versionId: metadata.id },
    { cacheDir },
  );
  if (
    candidate.version.parentVersionId !== parent.version.id ||
    candidate.version.digest !== metadata.digest
  )
    throw new Error('Candidate metadata mismatch');
  if (JSON.stringify(candidate.payload) !== JSON.stringify(payload))
    throw new Error('Published candidate payload differs from the bounded edit');
  const artifacts = {
    parentPayload: 'parent-payload.json',
    candidatePayload: 'candidate-payload.json',
    skillChange: 'skill-change.json',
  };
  for (const [name, value] of [
    [artifacts.parentPayload, parent.payload],
    [artifacts.candidatePayload, candidate.payload],
    [artifacts.skillChange, { path: config.skillPath, before: skill.text, after: text }],
  ] as const)
    await writeFile(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  const versions = new Map([
    [parent.version.id, parent],
    [candidate.version.id, candidate],
  ]);
  const report = await compare({
    parent: { version: parent.version },
    candidate: { version: candidate.version },
    cases,
    datasetRevision,
    graderRevision,
    runtime: {
      app: 'improve-review-v1',
      model: config.model,
      codexSdk: config.sdkVersion,
      cost: 'unknown',
    },
    concurrency: 1,
    execute: async ({ version, caseId, repetition, snapshot }) => {
      const result = await model.review(versions.get(version.version.id)!, snapshot);
      const filename = `${caseId}-${repetition}-${version.version.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      const outputPath = path.resolve(outputDir, filename);
      await writeFile(
        outputPath,
        JSON.stringify(
          {
            caseId,
            repetition,
            versionId: version.version.id,
            response: result.text,
            usage: result.usage,
            costUsd: null,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      return {
        output: result.text,
        outputRef: pathToFileURL(outputPath).href,
        usage: result.usage,
      };
    },
    grade: async ({ output, caseId }) => gradeFinding(caseId, output),
  });
  const comparison = await submitComparison(
    client,
    config.project,
    config.bundle,
    report,
    randomUUID(),
  );
  const summary = {
    project: config.project,
    bundle: config.bundle,
    channel: config.channel,
    channelRevision: parent.resolution.revision,
    parent: parent.version,
    candidate: candidate.version,
    comparisonId: comparison.id,
    artifacts,
    complete: comparison.complete,
    datasetRevision,
    graderRevision,
    model: config.model,
    authorModel: config.authorModel,
    sdkVersion: config.sdkVersion,
    sampleCount: report.expectedCases.length,
    costUsd: null,
    report,
    note: 'App-owned direct author flow; tiny fixture sample is not evidence of statistical improvement. Review before promotion.',
  };
  const summaryPath = path.resolve(outputDir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return { summary, summaryPath };
}
