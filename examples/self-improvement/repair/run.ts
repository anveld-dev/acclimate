/** Targeted content repair: model-authored reusable skill code, measured with raw native outputs. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveAndCache } from '@acclimate/sdk';
import type { VerifiedVersion } from '@acclimate/sdk';
import { Luna, model } from '../luna.js';
import { startService } from '../service.js';
import { dataset, grade, policy, prompt as flatPrompt, screen } from '../twenty/domain.js';
import { largeDataset, inventorySchema, prompt as longPrompt } from '../large/domain.js';
import { helperObserved, helperOutput } from './observed.js';

const args = process.argv.slice(2),
  get = (name: string) => args[args.indexOf(name) + 1];
assert(
  args.includes('--live') && args.includes('--source-run') && args.includes('--output'),
  'Use the isolated helper repair wrapper',
);
const source = path.resolve(get('--source-run')!),
  output = path.resolve(get('--output')!),
  database = process.env.EVALUATION_TEST_DATABASE_URL;
assert(database, 'Explicit disposable PostgreSQL required');
const original = JSON.parse(
  await readFile(path.join(source, 'parent.json'), 'utf8'),
) as VerifiedVersion;
const prototype = JSON.parse(
  await readFile(path.join(source, 'release-candidate.json'), 'utf8'),
) as VerifiedVersion;
const helperPath = 'skills/payment-triage/scripts/triage.py',
  nativeHelper = '.agents/skills/payment-triage/scripts/triage.py';
const flat = dataset(randomUUID()).development,
  long = largeDataset(randomUUID()).batches[0]!;
const save = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
await save('development-inputs.json', { flat, long });
await save('experiment.json', {
  model,
  maximumSdkTurns: 24,
  maximumProposals: 5,
  purpose:
    'Repair arithmetic/projection and ad-hoc loader failures with a reusable model-authored skill helper',
  originalParent: original.version,
  prototype: prototype.version,
  manuallyAddedScaffold: { path: helperPath, text: '', published: false },
  developmentGate:
    'all 56 exact decisions correct, zero unsafe, successful helper execution observed in all three native jobs',
  release: 'none here; a fresh separate large audit is required',
});
const luna = new Luna(output, 24),
  system = await startService(luna, database, output, {
    maximumProposals: 5,
    authorGuidance: `Implement ${helperPath} as a PURE Python 3.9 standard-library skill resource. The file already exists empty; empty oldText is allowed only for that empty file. Allowed imports: json, sys, pathlib, collections, math. No network, dynamic eval/exec, writes, absolute paths, or subprocesses. Use print for stdout. CLI: python3 ${nativeHelper} task.json. Accept either a flat incident array or a manifest array with id, requestFile, receiptFiles. Each JSONL receipt record has incidentId and receipt. Read every listed shard, join by incidentId, and normalize each request into an incident. Compare ONLY the five scope fields: original also has fence/requestId/ageSeconds and is not equal to a scope dict. Implement ALL approved policy rules through one deterministic calculation per incident. Print only {"decisions":[...]}, with id,action,fence,waitMs,receiptId,reason. Update SKILL.md to invoke this helper and return its computed objects unchanged. Never fabricate a fallback when the helper fails. Keep the facts in memory and preserve trust guidance. The helper is reusable skill content, not permission to execute payments.`,
  });
const { client, project } = system;
let failure: unknown;
try {
  const bundle = await client.createBundle(
    project,
    { name: 'Reusable skill-helper repair' },
    randomUUID(),
  );
  const root = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: null, payload: original.payload },
    randomUUID(),
  );
  const base = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: root.id, payload: prototype.payload },
    randomUUID(),
  );
  const scaffold = await client.createVersion(
    project,
    bundle.id,
    {
      parentVersionId: base.id,
      payload: {
        ...prototype.payload,
        files: [...prototype.payload.files, { path: helperPath, kind: 'skill', text: '' }],
      },
    },
    randomUUID(),
  );
  const cache = { cacheDir: path.join(output, 'cache') };
  const fetch = (versionId: string) =>
    resolveAndCache(client, { workspaceId: project, bundleId: bundle.id, versionId }, cache);
  await save('parent.json', await fetch(root.id));
  let draft = await fetch(scaffold.id),
    selected: VerifiedVersion | undefined;
  const feedback: string[] = [];
  const allCases = [...flat, long];
  for (let round = 1; round <= 5; round++) {
    console.log(`Helper repair ${round}: propose reusable procedure`);
    const proposal = await client.createProposal(
      project,
      bundle.id,
      {
        parentVersionId: draft.version.id,
        allowedPaths: draft.payload.files.map((f) => f.path),
        hypothesis:
          'Make evidence loading and numeric decisions reproducible through a reusable pure local skill helper. Avoid comparing an entire original request object to its five-field scope. Use the same computed decision fields in the final response instead of recreating them from prose.',
        evidence: [
          ...policy,
          'Canonical input contract: task.json is ALWAYS an array. Distinguish a manifest ENTRY by the presence of requestFile, not by whether task is a list. Flat incident fields: id,contractRevision,provider (exact lowercase meridian|harbor),status (legacy),original {account,operation,amount,currency,region,fence,requestId,ageSeconds},requested {account,operation,amount,currency,region},startedAtMs,snapshotAtMs,clockUncertaintyMs,ledgerAvailable,hold,cancelRequested,priorRetries,cooldownUntilMs,receipts. Each receipt has id,source,verified,scope {the five scope fields},sequence,recordedAtMs,state (ambiguous|accepted|committed|rejected_before_dispatch),retryAfterMs (integer|null),note. The input receipt identifier is id; the OUTPUT field receiptId carries that value. There is no input outcome, cancellation or receiptId field. Manifest entry fields: id,requestFile,receiptFiles. requestFile contains the incident metadata WITHOUT receipts. Each line in every receiptFiles JSONL file is {incidentId,receipt}. Read all listed files and join by incidentId. All relative input paths are relative to the working directory. Output is {decisions:[{id,action,fence,waitMs,receiptId,reason}]}.',
          'Approved execution finding: an ad-hoc loader compared receipt.scope to the entire original object, which also contains non-scope keys. It incorrectly reported no usable receipt. Compare only account, operation, amount, currency and region.',
          'Output-field mismatch finding: some responses described the correct expiry or poll bound while returning a different action or waitMs. Generate each full object from the same calculation; return computed fields unchanged.',
          ...feedback.slice(-8),
        ],
      },
      randomUUID(),
    );
    let completed = proposal;
    const deadline = Date.now() + 70000;
    while (['queued', 'running'].includes(completed.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      completed = await client.getProposal(project, bundle.id, proposal.id);
    }
    await save(`repair-${round}-proposal.json`, completed);
    if (completed.status !== 'succeeded' || !completed.candidate) {
      feedback.push('Previous proposal failed: ' + String(completed.error).slice(0, 1000));
      continue;
    }
    draft = await fetch(completed.candidate.id);
    await save(`repair-${round}-candidate.json`, draft);
    screen(draft.payload, allCases);
    const helper = draft.payload.files.find((f) => f.path === helperPath)!;
    const inspection = JSON.parse(
      execFileSync(
        process.env.ACCLIMATE_TEST_PYTHON || 'python3',
        ['examples/self-improvement/repair/inspect_helper.py'],
        { input: helper.text, encoding: 'utf8' },
      ),
    ) as { valid: boolean; errors: string[] };
    await save(`repair-${round}-inspection.json`, inspection);
    if (!inspection.valid || !helper.text.trim()) {
      feedback.push(
        JSON.stringify({ helperPreflightErrors: inspection.errors, empty: !helper.text.trim() }),
      );
      continue;
    }
    const results = [];
    for (const batch of flat) {
      const run = await luna.job(draft, batch, `repair-${round}-${batch.id}`, {
        prompt: flatPrompt,
        schema: inventorySchema(batch.incidents.map((i) => i.id)),
      });
      results.push({
        batchId: batch.id,
        grade: grade(batch, run.output),
        helperGrade: grade(
          batch,
          helperOutput(
            run.commands,
            batch.incidents.map((i) => i.id),
          ),
        ),
        helperObserved: helperObserved(
          run.commands,
          batch.incidents.map((i) => i.id),
        ),
      });
    }
    const run = await luna.job(
      draft,
      { id: long.id, incidents: long.manifest },
      `repair-${round}-long`,
      {
        prompt: longPrompt,
        schema: inventorySchema(long.manifest.map((i) => i.id)),
        files: long.files,
        timeoutMs: 360000,
      },
    );
    results.push({
      batchId: long.id,
      grade: grade(long, run.output),
      helperGrade: grade(
        long,
        helperOutput(
          run.commands,
          long.incidents.map((i) => i.id),
        ),
      ),
      helperObserved: helperObserved(
        run.commands,
        long.incidents.map((i) => i.id),
      ),
    });
    await save(`repair-${round}-development.json`, results);
    const correct = results.reduce((n, r) => n + r.grade.correct, 0),
      total = 56;
    console.log(
      `Helper repair ${round}: ${correct}/${total}; observed helper in ${results.filter((r) => r.helperObserved).length}/3 jobs`,
    );
    if (
      correct === total &&
      results.every(
        (r) =>
          r.grade.unsafe === 0 && r.helperObserved && r.helperGrade.correct === r.helperGrade.total,
      )
    ) {
      selected = draft;
      break;
    }
    for (const result of results) {
      if (!result.helperObserved)
        feedback.push(
          `The ${result.batchId} job did not successfully execute the reusable helper; SKILL.md must direct it to run the CLI and use complete stdout.`,
        );
      for (const o of [...result.helperGrade.outcomes, ...result.grade.outcomes]
        .filter((o) => !o.correct)
        .slice(0, 2)) {
        const i = allCases.flatMap((b) => b.incidents).find((i) => i.id === o.id)!;
        const usable = i.receipts.filter(
          (r) =>
            r.source === 'ledger' &&
            r.verified &&
            ['account', 'operation', 'amount', 'currency', 'region'].every(
              (key) =>
                r.scope[key as keyof typeof r.scope] === i.original[key as keyof typeof i.original],
            ),
        );
        feedback.push(
          JSON.stringify({
            developmentFailure: o,
            input: { ...i, receipts: usable.slice(0, 4) },
            receiptCount: i.receipts.length,
          }),
        );
      }
    }
  }
  assert(selected, 'No helper passed development within five repair proposals');
  const release = await client.createVersion(
    project,
    bundle.id,
    { parentVersionId: root.id, payload: selected.payload },
    randomUUID(),
  );
  const candidate = await fetch(release.id);
  assert.equal(candidate.version.digest, selected.version.digest);
  await save('release-candidate.json', {
    ...candidate,
    sourcePrototypeVersionId: prototype.version.id,
    sourceHelperDraftId: selected.version.id,
  });
  await save('summary.json', {
    developmentPassed: true,
    releaseQualified: false,
    lunaCalls: luna.calls,
    model,
    rootVersionId: root.id,
    candidateVersionId: candidate.version.id,
    digest: candidate.version.digest,
    helperPath,
    next: 'Independent frozen large audit required. No channel was promoted.',
  });
} catch (error) {
  failure = error;
  await save('failure.json', {
    passed: false,
    error: error instanceof Error ? error.message : String(error),
    lunaCalls: luna.calls,
  });
} finally {
  await system.close();
}
if (failure) throw failure;
