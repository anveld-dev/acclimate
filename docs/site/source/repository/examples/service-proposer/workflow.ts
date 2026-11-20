import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepare } from '@acclimate/codex-plugin';
import path from 'node:path';
import { resolveAndCache } from '@acclimate/sdk';
import { compare, submitComparison } from '@acclimate/sdk';
import type { AcclimateClient } from '@acclimate/sdk';
import type { VerifiedVersion } from '@acclimate/sdk';
import { cases, datasetRevision } from './dataset.js';
import { gradeFinding, graderRevision } from './grader.js';

export interface Model {
  review(
    bundle: VerifiedVersion,
    snapshot: { diff: string },
  ): Promise<{ text: string; usage: { inputTokens?: number; outputTokens?: number } | null }>;
}
export interface Config {
  workspace: string;
  bundle: string;
  channel: string;
  skillPath: string;
  outputDir: string;
  model: string;
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
  const source = await client.inspectSource(config.workspace, config.bundle, config.channel);
  if (!source) throw new Error('Seed the bundle before comparing a candidate.');
  const parent = await resolveAndCache(
    client,
    { workspaceId: config.workspace, bundleId: config.bundle, versionId: source.version.id },
    { cacheDir },
  );
  const skill = parent.payload.files.find((f) => f.path === config.skillPath && f.kind === 'skill');
  if (!skill || !config.skillPath.endsWith('/SKILL.md'))
    throw new Error('Allowed path must be an existing skill manifest');
  const proposal = await client.createProposal(
    config.workspace,
    config.bundle,
    {
      parentVersionId: parent.version.id,
      allowedPaths: [config.skillPath],
      hypothesis: 'Identify unsafe retries of side-effecting operations.',
      evidence: ['Review saved checkout code for repeated side effects.'],
    },
    randomUUID(),
  );
  let final = proposal;
  const deadline = Date.now() + 65_000;
  while (final.status !== 'succeeded' && final.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    final = await client.getProposal(config.workspace, config.bundle, proposal.id);
  }
  if (final.status !== 'succeeded' || !final.candidate)
    throw new Error(`Service proposal did not succeed: ${final.status}: ${final.error ?? ''}`);
  const metadata = final.candidate;
  const candidate = await resolveAndCache(
    client,
    { workspaceId: config.workspace, bundleId: config.bundle, versionId: metadata.id },
    { cacheDir },
  );
  if (
    candidate.version.parentVersionId !== parent.version.id ||
    candidate.version.digest !== metadata.digest
  )
    throw new Error('Candidate metadata mismatch');
  const text = candidate.payload.files.find((f) => f.path === config.skillPath)?.text;
  if (!text || text === skill.text) throw new Error('Proposal did not change the skill');
  const staged = await prepare(candidate);
  await staged.cleanup();
  await writeFile(path.join(outputDir, 'proposal.json'), JSON.stringify(final, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
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
      app: 'service-proposer-review-v1',
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
    config.workspace,
    config.bundle,
    report,
    randomUUID(),
  );
  const summary = {
    workspace: config.workspace,
    bundle: config.bundle,
    channel: config.channel,
    channelRevision: source.revision,
    parent: parent.version,
    candidate: candidate.version,
    proposalId: final.id,
    comparisonId: comparison.id,
    artifacts,
    complete: comparison.complete,
    datasetRevision,
    graderRevision,
    model: config.model,
    sdkVersion: config.sdkVersion,
    sampleCount: report.expectedCases.length,
    costUsd: null,
    report,
    note: 'Service proposal and app-owned grading; tiny fixture sample is not evidence of statistical improvement. Review before promotion.',
  };
  const summaryPath = path.resolve(outputDir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return { summary, summaryPath };
}
