import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const shell = fileURLToPath(new URL('../../examples/ci/ci.sh', import.meta.url));
const candidate = '{"schemaVersion":1,"files":[{"path":"instructions.md","kind":"instruction","text":"PR content"}]}';
const requestId = '00000000-0000-4000-8000-000000000001';
const candidateVersionId = '00000000-0000-4000-8000-000000000002';
const candidateDigest = 'sha256:' + '3'.repeat(64);
let root, commit, previousCommit;

before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-ci-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(root, 'bundle.json'), candidate);
  await mkdir(join(root, 'agent', 'skills', 'orders'), { recursive: true });
  await mkdir(join(root, 'agent', 'memory'));
  await writeFile(join(root, 'agent', 'instructions.md'), 'Old instructions\n');
  await writeFile(join(root, 'agent', 'skills', 'orders', 'SKILL.md'), 'An app skill\n');
  await writeFile(join(root, 'agent', 'memory', 'approved.md'), 'Approved fact\n');
  await writeFile(join(root, 'agent', 'memory', 'private.md'), 'Private note\n');
  await mkdir(join(root, 'bad-source'));
  await symlink('../bundle.json', join(root, 'bad-source', 'instructions.md'));
  git('add', 'bundle.json', 'agent', 'bad-source');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Original instructions');
  previousCommit = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'agent', 'instructions.md'), 'New instructions in the PR\n');
  git('add', 'agent/instructions.md');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Candidate under review');
  commit = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'bundle.json'), 'Uncommitted working-tree edit');
  await writeFile(join(root, 'agent', 'instructions.md'), 'Unsaved change after checkout');
  await writeFile(join(root, 'agent', 'untracked.md'), 'Untracked scratch note');
  await writeFile(join(root, 'eval.mjs'), `#!${process.execPath}
    import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    const [command, ...flags] = process.argv.slice(2);
    const phase = JSON.parse(process.env.CI_RESPONSES)[command] ?? {};
    const payload = command === 'request' ? readFileSync(flags[flags.indexOf('--payload') + 1], 'utf8') : null;
    appendFileSync(process.env.CI_COMMAND_LOG, JSON.stringify({ command, flags, payload, cwd: process.cwd(), python: process.env.CI_TEST_PYTHON_EXE }) + '\\n');
    if (command === 'request' && !phase.exit) {
      const handoff = flags[flags.indexOf('--out') + 1];
      mkdirSync(dirname(handoff), {recursive:true});
      writeFileSync(handoff, JSON.stringify({ configuration: { runtime: 'old evaluator' } }));
    }
    if (phase.error) console.error(JSON.stringify({error: {code: phase.error}}));
    console.log(JSON.stringify(phase.body ?? (command === 'request' ? {
      requestId: ${JSON.stringify(requestId)}, candidateVersionId: ${JSON.stringify(candidateVersionId)},
      candidateDigest: ${JSON.stringify(candidateDigest)},
    } : command === 'check' ? { verdict: 'pass' } : { status: 'ok' })));
    process.exit(phase.exit ?? 0);
  `);
  await chmod(join(root, 'eval.mjs'), 0o755);
  await writeFile(join(root, 'eval.py'), `
import os, sys
os.environ['CI_TEST_PYTHON_EXE'] = sys.executable
os.execv(os.environ["CI_FIXTURE_NODE"], [os.environ["CI_FIXTURE_NODE"], os.environ["CI_FIXTURE_APP"], *sys.argv[1:]])
`);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function pipeline(language, responses, extra = [], omit = [], env = {}) {
  const dir = await mkdtemp(join(root, 'run-'));
  const app = join(root, language === 'python' ? 'eval.py' : 'eval.mjs');
  const args = { language, app, config: join(root, 'config.json'), bundle: 'bundle-under-test',
    channel: 'canary', repo: root, commit, payload: 'bundle.json', policy: join(root, 'policy.json'),
    intent: join(dir, 'intent.json'), 'output-dir': dir };
  const flags = Object.entries(args).filter(([k]) => !omit.includes(k)).flatMap(([k, v]) => ['--' + k, v]);
  const result = spawnSync('sh', [shell, ...flags, ...extra], {
    cwd: root,
    env: { ...process.env, CI_COMMAND_LOG: join(dir, 'log'), CI_FIXTURE_NODE: process.execPath,
      CI_FIXTURE_APP: join(root, 'eval.mjs'), CI_RESPONSES: JSON.stringify(responses), ...env }, encoding: 'utf8',
  });
  const commands = (await readFile(join(dir, 'log'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, summary: JSON.parse(result.stdout), commands };
}

for (const language of ['javascript', 'python']) {
  test(`CI ${language} binds the requested commit, application and review inputs`, async () => {
    const selection = join(root, 'selection.json');
    const result = await pipeline(language, {}, ['--live', '--selection', selection]);
    assert.equal(result.status, 0, result.stderr);
    const { summary, commands } = result;
    assert.deepEqual(commands.map(c => c.command), ['doctor', 'request', 'run', 'check', 'export', 'verify-export']);
    assert.equal(commands[1].payload, candidate);
    assert.equal(commands[1].flags[commands[1].flags.indexOf('--channel') + 1], 'canary');
    assert.equal(commands[2].flags.includes('--live'), true);
    assert.equal(commands[4].flags[commands[4].flags.indexOf('--selection') + 1], selection);
    for (const phase of [commands[0], commands[1], commands[3]]) {
      assert.equal(phase.flags[phase.flags.indexOf('--policy') + 1], join(root, 'policy.json'));
    }
    assert.deepEqual([summary.commit, summary.channel, summary.requestId, summary.candidateVersionId,
      summary.candidateDigest, summary.qualityVerdict, summary.result],
      [commit, 'canary', requestId, candidateVersionId, candidateDigest, 'pass', 'pass']);
    assert.match(summary.reviewDirectory, /^review-/);
    assert.deepEqual(Object.values(summary.phaseExitCodes), [0, 0, 0, 0, 0, 0]);
  });
}

for (const [name, responses, expected, resultName, phaseCodes] of [
  ['policy regression', { check: { exit: 2, body: { verdict: 'fail' } } }, 2, 'quality_failed', [0, 0, 0, 2, 0, 0]],
  ['failed execution with an incomplete grade', { run: { exit: 2 }, check: { exit: 3, body: { verdict: 'indeterminate' } } },
    2, 'execution_failed', [0, 0, 2, 3, 0, 0]],
  ['uncertain execution and unavailable export', { run: { exit: 3 }, export: { exit: 1 } },
    3, 'execution_unresolved', [0, 0, 3, null, 1, null]],
  ['missing required export', { export: { exit: 3 } }, 3, 'export_failed', [0, 0, 0, 0, 3, null]],
  ['unverifiable export', { 'verify-export': { exit: 1 } }, 1, 'export_failed', [0, 0, 0, 0, 0, 1]],
  ['failed request', { request: { exit: 3 } }, 3, 'request_failed', [0, 3, null, null, null, null]],
  ['missing candidate binding', { request: { body: {} } }, 1, 'request_failed', [0, 1, null, null, null, null]],
  ['failed preflight', { doctor: { exit: 1 } }, 1, 'preflight_failed', [1, null, null, null, null, null]],
]) {
  test(`CI distinguishes ${name}`, async () => {
    const run = await pipeline('javascript', responses);
    assert.equal(run.status, expected, run.stderr);
    assert.equal(run.summary.result, resultName);
    assert.deepEqual(Object.values(run.summary.phaseExitCodes), phaseCodes);
    assert.ok(run.commands.every(c => !c.flags.includes('--live') && !c.flags.includes('--selection')));
    if (phaseCodes[5] !== 0) assert.equal(run.summary.reviewDirectory, null);
  });
}

for (const [name, extra, omit] of [
  ['missing payload', [], ['payload']],
  ['missing policy', [], ['policy']],
  ['wrong checkout', ['--commit', 'f'.repeat(40)], ['commit']],
  ['untracked path', ['--payload', 'not-in-commit.json'], ['payload']],
  ['unsafe relative path', ['--payload', '../bundle.json'], ['payload']],
]) {
  test(`CI rejects ${name} before making a request`, async () => {
    const run = await pipeline('javascript', {}, extra, omit);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.summary.result, 'configuration_error');
    assert.equal(run.commands.length, 0);
  });
}

test('directory input binds committed source edits, memory choices, and retries', async () => {
  const output = await mkdtemp(join(root, 'private-results-'));
  const omitted = ['payload', 'repo', 'intent', 'language', 'output-dir'];
  const source = ['--bundle-dir', './agent/', '--output-dir', output];
  const selected = [...source, '--memory', 'memory/approved.md'];
  const first = await pipeline('javascript', {}, selected, omitted);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.commands[1].payload).files, [
    { path: 'instructions.md', kind: 'instruction', text: 'New instructions in the PR\n' },
    { path: 'memory/approved.md', kind: 'memory', text: 'Approved fact\n' },
    { path: 'skills/orders/SKILL.md', kind: 'skill', text: 'An app skill\n' },
  ]);
  const flags = first.commands[1].flags;
  const intent = flags[flags.indexOf('--intent') + 1];
  assert.equal(join(output, first.summary.handoff), flags[flags.indexOf('--out') + 1]);
  assert.ok(intent.startsWith(join(output, 'requests', commit)));
  const repeat = await pipeline('javascript', {}, selected, omitted);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.commands[1].flags[repeat.commands[1].flags.indexOf('--intent') + 1], intent);
  assert.equal(repeat.summary.handoff, first.summary.handoff);
  const noMemory = await pipeline('python', {}, [...source, '--no-memory'], omitted);
  assert.equal(noMemory.status, 0, noMemory.stderr);
  assert.deepEqual(JSON.parse(noMemory.commands[1].payload).files.map(f => f.kind), ['instruction', 'skill']);
  assert.notEqual(noMemory.summary.handoff, first.summary.handoff);
});

test('directory input rejects stale commits, symlinks and unspecified memory before requests', async () => {
  const omitted = ['payload', 'repo', 'intent', 'language'];
  for (const extra of [
    ['--bundle-dir', 'agent', '--no-memory', '--commit', previousCommit],
    ['--bundle-dir', 'bad-source'],
    ['--bundle-dir', 'agent'],
    ['--bundle-dir', 'agent', '--memory', 'memory/missing.md'],
  ]) {
    const run = await pipeline('javascript', {}, extra, extra.includes('--commit') ? [...omitted, 'commit'] : omitted);
    assert.equal(run.status, 1);
    assert.equal(run.summary.result, 'configuration_error');
    assert.equal(run.commands.length, 0);
  }
});

test('installed SDK directory commands resolve the adapter, interpreter and caller paths', async () => {
  const workspace = join(root, 'node-workspace');
  const bin = join(workspace, 'node_modules', '.bin');
  const nodeApp = join(workspace, 'agent');
  await mkdir(bin, { recursive: true });
  await mkdir(nodeApp);
  await writeFile(join(nodeApp, 'application.mts'), '');
  await symlink(join(root, 'eval.mjs'), join(bin, 'acclimate-eval'));

  const extra = ['--app', 'node-workspace/agent', '--config', 'local-config.json',
    '--policy', 'local-policy.json', '--selection', 'local-selection.json'];
  const omitted = ['language', 'app', 'config', 'policy'];
  const js = await pipeline('javascript', {}, extra, omitted);
  assert.equal(js.status, 0, js.stderr);
  assert.ok(js.commands.every(c => c.cwd === nodeApp));
  for (const [flag, phase, file] of [
    ['--config', 'run', 'local-config.json'], ['--policy', 'check', 'local-policy.json'],
    ['--selection', 'export', 'local-selection.json'],
  ]) {
    const flags = js.commands.find(c => c.command === phase).flags;
    assert.equal(flags[flags.indexOf(flag) + 1], join(root, file));
  }

  const pythonApp = join(root, 'python-app');
  const venv = join(pythonApp, '.venv');
  await mkdir(pythonApp);
  await writeFile(join(pythonApp, 'application.py'), '');
  execFileSync(process.env.ACCLIMATE_CI_PYTHON || 'python3', ['-m', 'venv', '--without-pip', venv]);
  const interpreter = join(venv, 'bin', 'python');
  const purelib = execFileSync(interpreter, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
    { encoding: 'utf8' }).trim();
  await mkdir(join(purelib, 'acclimate'));
  await writeFile(join(purelib, 'acclimate', '__init__.py'), '');
  await writeFile(join(purelib, 'acclimate', '__main__.py'), await readFile(join(root, 'eval.py')));
  const py = await pipeline('python', {}, ['--app', pythonApp], ['language', 'app'],
    { ACCLIMATE_CI_PYTHON: '', PYTHONPATH: '' });
  assert.equal(py.status, 0, py.stderr);
  assert.ok(py.commands.every(c => c.cwd === pythonApp && c.python === interpreter));

  await writeFile(join(nodeApp, 'application.py'), '');
  const ambiguous = await pipeline('javascript', {}, extra, omitted);
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.commands.length, 0);
  assert.match(ambiguous.stderr, /select --language/);
  const chosen = await pipeline('python', {}, [...extra, '--language', 'python'], omitted,
    { ACCLIMATE_CI_PYTHON: interpreter, PYTHONPATH: '' });
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.ok(chosen.commands.every(c => c.cwd === nodeApp && c.python === interpreter));
});

test('CI exposes policy measurements, incomplete pairs, reasons and receipt independently of execution', async () => {
  const id = '00000000-0000-4000-8000-000000000003';
  const policy = { id: 'shipping', revision: 'r1', sha256: candidateDigest };
  const counts = { distinctCases: 2, expectedPairs: 3, comparablePairs: 2 };
  const scores = { parentMean: 1, candidateMean: 0.5, orientedMeanImprovement: -0.5 };
  const gaps = { total: 1, rows: [{ caseId: 'missing-score', repetition: 0, side: 'candidate',
    stage: 'grading', reason: 'grading_failed' }] };
  const verdict = { verdict: 'fail', code: 'policy.fail', policy, comparisonId: id, counts,
    summary: scores, checks: [{ code: 'policy.minimum_mean_improvement', result: 'fail' },
      { code: 'policy.cost_unknown', result: 'unknown' }, { code: 'ignored.pass', result: 'pass' }],
    evidenceGaps: gaps, policyReceipt: { status: 'recorded', code: 'saved' } };
  const result = await pipeline('javascript', { run: { body: { status: 'completed', comparisonId: id } },
    check: { exit: 2, body: verdict } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.summary.executionStatus, 'completed');
  assert.equal(result.summary.comparisonId, id);
  assert.equal(result.summary.qualityVerdict, 'fail');
  assert.deepEqual(result.summary.quality, { code: 'policy.fail', policy, scores,
    counts: { ...counts, incompletePairs: 1 }, failedCriteria: ['policy.minimum_mean_improvement'],
    unknownCriteria: ['policy.cost_unknown'], policyReceipt: verdict.policyReceipt, evidenceGaps: gaps });
  const pending = await pipeline('javascript', { check: { exit: 1, body: { ...verdict, verdict: 'pass',
    checks: [], policyReceipt: { status: 'unconfirmed', code: 'transport.unavailable' } } } });
  assert.equal(pending.status, 1);
  assert.equal(pending.summary.result, 'check_failed');
  assert.equal(pending.summary.quality.policyReceipt.status, 'unconfirmed');
});

test('one successor per settled request; uncertain, unrelated and unverified predecessors stop before execution', async () => {
  const output = await mkdtemp(join(root, 'recovery-'));
  const omitted = ['intent', 'output-dir'];
  const common = ['--output-dir', output];
  const first = await pipeline('javascript', {}, common, omitted);
  const previous = first.summary.handoff;
  const status = {status: 'failed', requestId, attemptId: candidateVersionId,
    comparisonId: '00000000-0000-4000-8000-000000000003'};
  const mismatch = await pipeline('javascript', {
    request: { exit: 1, error: 'request.intent_mismatch' },
    status: { body: status }, describe: { body: { runtime: 'repaired evaluator' } },
  }, common, omitted);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.summary.mismatch, 'evaluator_definition_changed');
  assert.equal(mismatch.summary.priorHandoff, previous);
  assert.equal(mismatch.summary.previousExecutionStatus, 'failed');
  assert.match(mismatch.summary.nextAction, /--retry-after/);
  assert.ok(mismatch.commands.every(c => c.command !== 'run'));
  const next = [...common, '--retry-after', previous];
  const retried = await pipeline('javascript', { status: { body: status } }, next, omitted);
  const replay = await pipeline('javascript', { status: { body: status } }, next, omitted);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(replay.status, 0);
  assert.ok(retried.summary.handoff.includes('/after-' + requestId + '/'));
  assert.equal(replay.summary.handoff, retried.summary.handoff);
  assert.notEqual(retried.summary.handoff, previous);
  assert.equal(retried.summary.previousRequestId, requestId);
  for (const body of ['requested', 'running', 'interrupted'].map(value => ({ ...status, status: value }))
    .concat([{ ...status, comparisonId: null }])) {
    const unsafe = await pipeline('javascript', { status: { body } }, next, omitted);
    assert.equal(unsafe.status, 3);
    assert.equal(unsafe.summary.result, 'prior_execution_unresolved');
    assert.deepEqual(unsafe.commands.map(c => c.command), ['status']);
  }
  const denied = await pipeline('javascript', { status: { exit: 1 } }, next, omitted);
  assert.equal(denied.summary.result, 'prior_status_unavailable');
  assert.deepEqual(denied.commands.map(c => c.command), ['status']);
  const unrelated = await pipeline('javascript', {}, [...next, '--channel', 'elsewhere'], [...omitted, 'channel']);
  assert.equal(unrelated.summary.result, 'configuration_error');
  assert.deepEqual(unrelated.commands, []);
});
