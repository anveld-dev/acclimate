import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  exportReviewEvidence,
  parseArtifactSelection,
  verifyReviewExport,
} from '../../src/evaluation/artifacts.js';
import { openJournal, type JournalScope } from '../../src/evaluation/journal.js';
import { EvaluationError } from '../../src/evaluation/errors.js';
import type { Comparison, Evaluation, EvaluationHandoff } from '../../src/types.js';

const ids = {
  bundle: '11111111-1111-4111-8111-111111111111',
  request: '22222222-2222-4222-8222-222222222222',
  attempt: '33333333-3333-4333-8333-333333333333',
  comparison: '44444444-4444-4444-8444-444444444444',
  parent: '55555555-5555-4555-8555-555555555555',
  candidate: '66666666-6666-4666-8666-666666666666',
};
const hash = (data: string | Uint8Array) =>
  'sha256:' + createHash('sha256').update(data).digest('hex');
const descriptor = {
  datasetRevision: 'private-dataset-canary',
  graderRevision: 'private-grader-canary',
  runtime: { configId: 'test', configRevision: '1', secret: 'runtime-secret-canary' },
  expectedCases: [{ caseId: 'case/../opaque', repetition: 0 }],
};
const outcome = {
  executionStatus: 'completed' as const,
  gradingStatus: 'scored' as const,
  reward: 1,
  usage: { costUsd: 0 },
  error: 'private-error-canary',
  outputRef: 'file:///private/secret-canary',
};
const report = {
  ...descriptor,
  parentVersionId: ids.parent,
  candidateVersionId: ids.candidate,
  parentDigest: hash('parent'),
  candidateDigest: hash('candidate'),
  evaluation: { requestId: ids.request, attemptId: ids.attempt },
  results: [
    {
      caseId: descriptor.expectedCases[0].caseId,
      repetition: 0,
      parent: { ...outcome },
      candidate: { ...outcome },
    },
  ],
};
const comparison: Comparison = {
  ...report,
  id: ids.comparison,
  complete: true,
  submitter: 'evaluator',
  createdAt: '2026-11-16T00:00:00Z',
};
const request: Evaluation = {
  ...descriptor,
  ...report,
  id: ids.request,
  requireBoundEvidence: true,
  status: 'completed',
  evaluatorPrincipal: 'evaluator',
  attemptId: ids.attempt,
  comparisonId: ids.comparison,
  error: null,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  proposalId: null,
};
let serviceUrl: string;
let server: ReturnType<typeof createServer>;
before(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url?.endsWith('/evaluation-requests/' + ids.request) ? request : comparison,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  serviceUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'acclimate-artifacts-test-')));
  const configs = path.join(root, 'config');
  const journals = path.join(root, 'journals');
  await mkdir(configs, { mode: 0o700 });
  const configPath = path.join(configs, 'evaluator.json');
  const readConfigPath = path.join(configs, 'reader.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl,
      workspaceId: 'project',
      evaluatorPrincipalId: 'evaluator',
      evaluatorToken: 'config-token-canary',
      journalRoot: journals,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    readConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl,
      workspaceId: 'project',
      readToken: 'read-token-canary',
    }),
    { mode: 0o600 },
  );
  const handoff: EvaluationHandoff = {
    schemaVersion: 1,
    serviceUrl,
    workspaceId: 'project',
    bundleId: ids.bundle,
    requestId: ids.request,
    descriptor: descriptor,
  };
  const scope: JournalScope = {
    serviceUrl,
    workspaceId: 'project',
    bundleId: ids.bundle,
    requestId: ids.request,
    evaluatorPrincipalId: 'evaluator',
  };
  return {
    root,
    configs,
    journals,
    configPath,
    readConfigPath,
    handoff,
    scope,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function localEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const journal = await openJournal(f.journals, f.scope);
  const body = JSON.stringify(report);
  const bodyRef = await journal.saveBody('submit', body);
  await journal.save({
    schemaVersion: 1,
    scope: f.scope,
    request: report,
    attemptId: ids.attempt,
    keys: { start: 'start', submit: 'submit', finish: 'finish' },
    executionStarted: true,
    retainedOperations: true,
    wireBodies: {},
  });
  const entry = await journal.writeArtifact(
    {
      caseId: descriptor.expectedCases[0].caseId,
      repetition: 0,
      side: 'candidate',
      versionId: ids.candidate,
      digest: report.candidateDigest,
      role: 'output',
    },
    { answer: 'share-me', secret: 'output-secret-canary' },
  );
  await journal.save({
    schemaVersion: 1,
    scope: f.scope,
    request: report,
    attemptId: ids.attempt,
    keys: { start: 'start', submit: 'submit', finish: 'finish' },
    executionStarted: true,
    retainedOperations: true,
    report,
    comparisonId: ids.comparison,
    completed: true,
    wireBodies: { submit: bodyRef },
  });
  await journal.saveArtifactIndex({
    schemaVersion: 1,
    requestId: ids.request,
    attemptId: ids.attempt,
    reportSha256: hash(body),
    comparisonId: ids.comparison,
    entries: [entry],
  });
  await journal.close();
  return { directory: journal.directory, entry };
}
const select = (role: 'output' | 'grader-explanation', required = true) => ({
  schemaVersion: 1 as const,
  entries: [
    {
      caseId: descriptor.expectedCases[0].caseId,
      repetition: 0,
      side: 'candidate' as const,
      role,
      required,
    },
  ],
});

test('every selected original is validated before the first mapper call', async () => {
  const f = await fixture();
  try {
    await localEvidence(f);
    const journal = await openJournal(f.journals, f.scope);
    const index = (await journal.readArtifactIndex())!;
    const explanation = await journal.writeArtifact(
      {
        caseId: descriptor.expectedCases[0].caseId,
        repetition: 0,
        side: 'candidate',
        versionId: ids.candidate,
        digest: report.candidateDigest,
        role: 'grader-explanation',
      },
      { reason: 'valid before corruption' },
    );
    index.entries.push(explanation);
    await journal.saveArtifactIndex(index);
    await writeFile(path.join(journal.directory, explanation.file), 'corrupt later role');
    await journal.close();
    let calls = 0;
    await assert.rejects(
      exportReviewEvidence({
        configPath: f.configPath,
        handoff: f.handoff,
        outputDirectory: path.join(f.root, 'export'),
        selection: {
          schemaVersion: 1,
          entries: [...select('output').entries, ...select('grader-explanation').entries],
        },
        toReviewArtifact: async () => {
          calls++;
          return { mediaType: 'text/plain', text: 'redacted' };
        },
      }),
      { code: 'artifact.hash_mismatch' },
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test('duplicate decoded index fields never reach a mapper', async () => {
  const f = await fixture();
  try {
    const { directory } = await localEvidence(f);
    const filename = path.join(directory, 'artifact-index.json');
    const original = await readFile(filename, 'utf8');
    for (const key of ['comparisonId', '\\u0063omparisonId']) {
      await writeFile(filename, `{"${key}":"wrong",${original.slice(1)}`);
      let calls = 0;
      await assert.rejects(
        exportReviewEvidence({
          configPath: f.configPath,
          handoff: f.handoff,
          outputDirectory: path.join(f.root, 'export'),
          selection: select('output'),
          toReviewArtifact: async () => {
            calls++;
            return { mediaType: 'text/plain', text: 'redacted' };
          },
        }),
        EvaluationError,
      );
      assert.equal(calls, 0);
    }
  } finally {
    await f.close();
  }
});

test('supplied symlink ancestry cannot disappear through dotdot normalization', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(f.root, 'alias'));
    await assert.rejects(
      exportReviewEvidence({
        readConfigPath: f.readConfigPath,
        handoff: f.handoff,
        outputDirectory: `${f.root}/alias/../export`,
      }),
      { code: 'artifact.integrity' },
    );
  } finally {
    await f.close();
  }
});

test('verifier rejects inspection claims inconsistent with role selection', async () => {
  const f = await fixture();
  try {
    const scalar = await exportReviewEvidence({
      readConfigPath: f.readConfigPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'scalar'),
    });
    const manifest = JSON.parse(await readFile(scalar.manifestPath, 'utf8'));
    for (const localInspection of ['validated', 'unavailable']) {
      await writeFile(scalar.manifestPath, JSON.stringify({ ...manifest, localInspection }));
      await assert.rejects(verifyReviewExport({ manifestPath: scalar.manifestPath }), {
        code: 'artifact.integrity',
      });
    }
    await localEvidence(f);
    const content = await exportReviewEvidence({
      configPath: f.configPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'content'),
      selection: select('output'),
      toReviewArtifact: async () => ({ mediaType: 'text/plain', text: 'redacted' }),
    });
    const shared = JSON.parse(await readFile(content.manifestPath, 'utf8'));
    for (const localInspection of ['not_requested', 'unavailable']) {
      await writeFile(content.manifestPath, JSON.stringify({ ...shared, localInspection }));
      await assert.rejects(verifyReviewExport({ manifestPath: content.manifestPath }), {
        code: 'artifact.integrity',
      });
    }
  } finally {
    await f.close();
  }
});

test('a 0.1 journal with scope.projectId keeps its directory and is recovered', async () => {
  const f = await fixture();
  try {
    const { directory } = await localEvidence(f);
    // The directory key keeps the 0.1 encoding, so a journal written before the rename is found.
    const legacyKey = JSON.stringify({
      serviceUrl,
      projectId: 'project',
      bundleId: ids.bundle,
      requestId: ids.request,
      evaluatorPrincipalId: 'evaluator',
    });
    assert.equal(path.basename(directory), createHash('sha256').update(legacyKey).digest('hex'));
    const file = path.join(directory, 'attempt.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const { workspaceId, ...rest } = saved.scope;
    await writeFile(file, JSON.stringify({ ...saved, scope: { ...rest, projectId: workspaceId } }) + '\n');
    const journal = await openJournal(f.journals, f.scope);
    try {
      const recovered = (await journal.read())!;
      assert.deepEqual(recovered.scope, f.scope);
      await journal.save(recovered);
    } finally {
      await journal.close();
    }
    const rewritten = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(rewritten.scope.workspaceId, 'project');
    assert.equal(Object.hasOwn(rewritten.scope, 'projectId'), false);
    // Export reads the same journal.
    const exported = await exportReviewEvidence({
      configPath: f.configPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'legacy-journal'),
      selection: select('output'),
      toReviewArtifact: async () => ({ mediaType: 'text/plain', text: 'redacted' }),
    });
    assert.equal(JSON.parse(await readFile(exported.manifestPath, 'utf8')).localInspection, 'validated');
    // A scope with both spellings is not a 0.1 journal.
    await writeFile(file, JSON.stringify({ ...saved, scope: { ...saved.scope, projectId: workspaceId } }) + '\n');
    const both = await openJournal(f.journals, f.scope);
    try {
      await assert.rejects(both.read(), { code: 'journal.invalid' });
    } finally {
      await both.close();
    }
  } finally {
    await f.close();
  }
});

test('verifying an export written by 0.1 names the projectId rename', async () => {
  const f = await fixture();
  try {
    const exported = await exportReviewEvidence({
      readConfigPath: f.readConfigPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'legacy-export'),
    });
    await verifyReviewExport({ manifestPath: exported.manifestPath });
    const manifest = JSON.parse(await readFile(exported.manifestPath, 'utf8'));
    const { workspaceId, ...rest } = manifest;
    await writeFile(exported.manifestPath, JSON.stringify({ ...rest, projectId: workspaceId }));
    await assert.rejects(verifyReviewExport({ manifestPath: exported.manifestPath }), (error: any) =>
      error instanceof EvaluationError &&
      error.code === 'artifact.integrity' &&
      error.diagnostic.field === 'projectId' &&
      error.diagnostic.reason === 'projectId was renamed to workspaceId in 0.2.0',
    );
  } finally {
    await f.close();
  }
});

test('export budget stops mapping as soon as released bytes exceed the limit', async () => {
  const originalCases = [...descriptor.expectedCases];
  const originalResults = [...report.results];
  const expectedCases = Array.from({ length: 17 }, (_, repetition) => ({
    caseId: 'budget',
    repetition,
  }));
  descriptor.expectedCases.splice(0, descriptor.expectedCases.length, ...expectedCases);
  report.results.splice(
    0,
    report.results.length,
    ...expectedCases.map((pair) => ({
      ...pair,
      parent: { ...outcome },
      candidate: { ...outcome },
    })),
  );
  const f = await fixture();
  try {
    await localEvidence(f);
    const journal = await openJournal(f.journals, f.scope);
    const index = (await journal.readArtifactIndex())!;
    index.entries = [];
    const entries = [];
    for (const pair of expectedCases)
      for (const side of ['parent', 'candidate'] as const)
        for (const role of ['output', 'grader-explanation'] as const) {
          entries.push({ ...pair, side, role, required: true });
          index.entries.push(
            await journal.writeArtifact(
              {
                ...pair,
                side,
                role,
                versionId: side === 'parent' ? ids.parent : ids.candidate,
                digest: side === 'parent' ? report.parentDigest : report.candidateDigest,
              },
              null,
            ),
          );
        }
    await journal.saveArtifactIndex(index);
    await journal.close();
    let calls = 0;
    await assert.rejects(
      exportReviewEvidence({
        configPath: f.configPath,
        handoff: f.handoff,
        outputDirectory: path.join(f.root, 'large'),
        selection: { schemaVersion: 1, entries },
        toReviewArtifact: async () => {
          calls++;
          return { mediaType: 'text/plain', text: 'x'.repeat(1024 * 1024) };
        },
      }),
      { code: 'artifact.integrity' },
    );
    assert.equal(calls, 65);
    await assert.rejects(readFile(path.join(f.root, 'large', 'manifest.json')), { code: 'ENOENT' });
  } finally {
    descriptor.expectedCases.splice(0, descriptor.expectedCases.length, ...originalCases);
    report.results.splice(0, report.results.length, ...originalResults);
    await f.close();
  }
});

test('scalar-only survives absent journals and a read-only teammate verifies independent online binding', async () => {
  const f = await fixture();
  try {
    const result = await exportReviewEvidence({
      readConfigPath: f.readConfigPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'export'),
    });
    assert.equal(result.localInspection, 'not_requested');
    const all =
      (await readFile(result.manifestPath, 'utf8')) +
      (await readFile(path.join(f.root, 'export', 'comparison-review.json'), 'utf8'));
    for (const secret of [
      'runtime-secret-canary',
      'private-dataset-canary',
      'private-grader-canary',
      'private-error-canary',
      'secret-canary',
      'config-token-canary',
    ])
      assert(!all.includes(secret));
    const local = await verifyReviewExport({ manifestPath: result.manifestPath });
    assert.equal(local.provenance, 'self_consistent');
    assert.equal(local.executionAttested, false);
    const online = await verifyReviewExport({
      manifestPath: result.manifestPath,
      online: { readConfigPath: f.readConfigPath, expectedHandoff: f.handoff },
    });
    assert.equal(online.provenance, 'online_scalar_binding');
    await assert.rejects(
      verifyReviewExport({
        manifestPath: result.manifestPath,
        online: {
          readConfigPath: f.readConfigPath,
          expectedHandoff: { ...f.handoff, workspaceId: 'different' },
        },
      }),
      { code: 'evidence.identity_mismatch' },
    );
  } finally {
    await f.close();
  }
});
test('role mapper receives only selected value and identity, output is shared while explanation stays withheld', async () => {
  const f = await fixture();
  try {
    await localEvidence(f);
    const result = await exportReviewEvidence({
      configPath: f.configPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'export'),
      selection: select('output'),
      toReviewArtifact: async (input) => {
        assert.deepEqual(Object.keys(input).sort(), ['identity', 'value']);
        assert.equal(input.identity.role, 'output');
        assert.deepEqual(input.value, { answer: 'share-me', secret: 'output-secret-canary' });
        return { mediaType: 'application/json', value: { answer: (input.value as any).answer } };
      },
    });
    assert.equal(result.selection.exportedRequired, 1);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const candidate = manifest.entries.find((x: any) => x.side === 'candidate');
    assert.equal(candidate.roles[0].availability, 'exported');
    assert.equal(candidate.roles[1].availability, 'not_shared');
    assert.equal(
      (await verifyReviewExport({ manifestPath: result.manifestPath })).status,
      'verified',
    );
    const output = await readFile(
      path.join(f.root, 'export', candidate.roles[0].file.path),
      'utf8',
    );
    assert(!output.includes('output-secret-canary'));
  } finally {
    await f.close();
  }
});
test('required missing explanation commits no manifest; optional missing remains visible', async () => {
  const f = await fixture();
  try {
    await localEvidence(f);
    const options = {
      configPath: f.configPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'required'),
      selection: select('grader-explanation'),
      toReviewArtifact: async () => null,
    };
    await assert.rejects(exportReviewEvidence(options), { code: 'artifact.missing' });
    await assert.rejects(readFile(path.join(f.root, 'required', 'manifest.json')), { code: 'ENOENT' });
    const result = await exportReviewEvidence({
      ...options,
      outputDirectory: path.join(f.root, 'optional'),
      selection: select('grader-explanation', false),
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(
      manifest.entries.find((x: any) => x.side === 'candidate').roles[1].availability,
      'missing',
    );
    assert.equal(result.selection.optionalMissing, 1);
  } finally {
    await f.close();
  }
});
test('changed indexed bytes fail before mapper, and same-attempt wrong confirmed comparison is rejected', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const { directory, entry } = await localEvidence(f);
    await writeFile(path.join(directory, entry.file), '{"changed":true}');
    await assert.rejects(
      exportReviewEvidence({
        configPath: f.configPath,
        handoff: f.handoff,
        outputDirectory: path.join(f.root, 'export'),
        selection: select('output'),
        toReviewArtifact: async () => {
          calls++;
          return null;
        },
      }),
      { code: 'artifact.hash_mismatch' },
    );
    assert.equal(calls, 0);
    const journal = await openJournal(f.journals, f.scope);
    const state = (await journal.read())!;
    state.comparisonId = ids.parent;
    await journal.save(state);
    await journal.close();
    await assert.rejects(
      exportReviewEvidence({
        configPath: f.configPath,
        handoff: f.handoff,
        outputDirectory: path.join(f.root, 'other'),
        selection: select('output'),
        toReviewArtifact: async () => null,
      }),
      { code: 'artifact.integrity' },
    );
  } finally {
    await f.close();
  }
});
test('tampering, traversal, symlinks, duplicate roles and output-root overlap cannot create verified evidence', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        parseArtifactSelection({
          ...select('output'),
          entries: [...select('output').entries, ...select('output').entries],
        }),
      { code: 'artifact.selection_invalid' },
    );
    await assert.rejects(
      exportReviewEvidence({
        readConfigPath: f.readConfigPath,
        handoff: f.handoff,
        outputDirectory: path.join(f.configs, 'bad'),
      }),
      (error: any) => {
        assert.equal(error.code, 'artifact.integrity');
        assert.equal(error.diagnostic.field, 'outputDirectory');
        assert.equal(error.diagnostic.nextAction, 'fix_config');
        assert.match(error.diagnostic.hint, /private sibling/);
        assert.ok(!JSON.stringify(error.diagnostic).includes(f.root));
        return true;
      },
    );
    const result = await exportReviewEvidence({
      readConfigPath: f.readConfigPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'export'),
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    manifest.projection.file = '../config/reader.json';
    await writeFile(result.manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyReviewExport({ manifestPath: result.manifestPath }), {
      code: 'artifact.integrity',
    });
    const safe = await exportReviewEvidence({
      readConfigPath: f.readConfigPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'safe'),
    });
    const projectionFile = path.join(f.root, 'safe', 'comparison-review.json');
    await rm(projectionFile);
    await symlink(f.readConfigPath, projectionFile);
    await assert.rejects(verifyReviewExport({ manifestPath: safe.manifestPath }), {
      code: 'artifact.integrity',
    });
  } finally {
    await f.close();
  }
});

test('rewriting both scalar file and manifest is self-consistency only and fails online binding', async () => {
  const f = await fixture();
  try {
    const result = await exportReviewEvidence({
      readConfigPath: f.readConfigPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'export'),
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const filename = path.join(f.root, 'export', manifest.projection.file);
    const projection = JSON.parse(await readFile(filename, 'utf8'));
    projection.results[0].candidate.reward = 999;
    const bytes = JSON.stringify(projection) + '\n';
    await writeFile(filename, bytes);
    manifest.projection.sha256 = hash(bytes);
    manifest.projection.bytes = Buffer.byteLength(bytes);
    await writeFile(result.manifestPath, JSON.stringify(manifest));
    assert.equal(
      (await verifyReviewExport({ manifestPath: result.manifestPath })).provenance,
      'self_consistent',
    );
    await assert.rejects(
      verifyReviewExport({
        manifestPath: result.manifestPath,
        online: { readConfigPath: f.readConfigPath, expectedHandoff: f.handoff },
      }),
      { code: 'evidence.identity_mismatch' },
    );
  } finally {
    await f.close();
  }
});

test('missing journal stays unavailable and mapper failures/oversize never commit a required export', async () => {
  const f = await fixture();
  try {
    const options = {
      configPath: f.configPath,
      handoff: f.handoff,
      outputDirectory: path.join(f.root, 'optional'),
      selection: select('output', false),
      toReviewArtifact: async () => null,
    };
    const result = await exportReviewEvidence(options);
    assert.equal(result.localInspection, 'unavailable');
    assert.equal(result.selection.optionalMissing, 1);
    await localEvidence(f);
    await assert.rejects(
      exportReviewEvidence({
        ...options,
        outputDirectory: path.join(f.root, 'failed'),
        selection: select('output'),
        toReviewArtifact: async () => {
          throw new Error('mapper-secret-canary');
        },
      }),
      { code: 'artifact.mapper_failed' },
    );
    await assert.rejects(
      exportReviewEvidence({
        ...options,
        outputDirectory: path.join(f.root, 'large'),
        selection: select('output'),
        toReviewArtifact: async () => ({
          mediaType: 'text/plain',
          text: 'x'.repeat(1024 * 1024 + 1),
        }),
      }),
      { code: 'artifact.mapper_failed' },
    );
    await assert.rejects(readFile(path.join(f.root, 'large', 'manifest.json')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('swapping two valid indexed files cannot relabel a grader explanation as output', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    await localEvidence(f);
    const journal = await openJournal(f.journals, f.scope);
    const index = (await journal.readArtifactIndex())!;
    const explanation = await journal.writeArtifact(
      {
        caseId: descriptor.expectedCases[0].caseId,
        repetition: 0,
        side: 'candidate',
        versionId: ids.candidate,
        digest: report.candidateDigest,
        role: 'grader-explanation',
      },
      { graderOnly: 'explanation-canary' },
    );
    index.entries.push(explanation);
    const first = index.entries[0];
    const a = { file: first.file, sha256: first.sha256, bytes: first.bytes };
    Object.assign(first, {
      file: explanation.file,
      sha256: explanation.sha256,
      bytes: explanation.bytes,
    });
    Object.assign(explanation, a);
    await journal.saveArtifactIndex(index);
    await journal.close();
    await assert.rejects(
      exportReviewEvidence({
        configPath: f.configPath,
        handoff: f.handoff,
        outputDirectory: path.join(f.root, 'swapped'),
        selection: select('output'),
        toReviewArtifact: async () => {
          calls++;
          return { mediaType: 'text/plain', text: 'wrong' };
        },
      }),
      { code: 'artifact.integrity' },
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test('missing sealed report/index is unavailable, while corrupted sealed bytes are an integrity failure', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    for (const [i, filename] of ['submit-body.json', 'artifact-index.json'].entries()) {
      const { directory } = await localEvidence(f);
      await rm(path.join(directory, filename));
      const options = {
        configPath: f.configPath,
        handoff: f.handoff,
        selection: select('output', false),
        outputDirectory: path.join(f.root, `missing-${i}`),
        toReviewArtifact: async () => {
          calls++;
          return null;
        },
      };
      const result = await exportReviewEvidence(options);
      assert.equal(result.localInspection, 'unavailable');
      await assert.rejects(
        exportReviewEvidence({
          ...options,
          selection: select('output'),
          outputDirectory: path.join(f.root, `required-${i}`),
        }),
        { code: 'artifact.missing' },
      );
    }
    const { directory } = await localEvidence(f);
    await writeFile(path.join(directory, 'submit-body.json'), '{}');
    await assert.rejects(
      exportReviewEvidence({
        configPath: f.configPath,
        handoff: f.handoff,
        selection: select('output', false),
        outputDirectory: path.join(f.root, 'corrupt'),
        toReviewArtifact: async () => {
          calls++;
          return null;
        },
      }),
      { code: 'artifact.integrity' },
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test('scalar-only reader/evaluator exports reject fixed native workspace ownership markers without opening journals', async () => {
  const f = await fixture();
  try {
    const prepared = path.join(f.root, 'prepared');
    await mkdir(path.join(prepared, '.acclimate'), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(prepared, '.acclimate', 'native-job-owner.json'),
      JSON.stringify({ schemaVersion: 1, jobId: 'a'.repeat(64) }),
      { mode: 0o600 },
    );
    for (const connection of [{ configPath: f.configPath }, { readConfigPath: f.readConfigPath }]) {
      await assert.rejects(
        exportReviewEvidence({
          ...connection,
          handoff: f.handoff,
          outputDirectory: path.join(prepared, 'shared'),
        }),
        { code: 'artifact.integrity' },
      );
    }
    await assert.rejects(readFile(path.join(f.journals, 'ownership.lock')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
