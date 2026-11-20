import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const shell = fileURLToPath(new URL('../../examples/ci/ci.sh', import.meta.url));
const candidate = '{"schemaVersion":1,"files":[{"path":"instructions.md","kind":"instruction","text":"PR content"}]}';
const requestId = '00000000-0000-4000-8000-000000000001';
const successorId = '00000000-0000-4000-8000-000000000009';
const candidateVersionId = '00000000-0000-4000-8000-000000000002';
const parentVersionId = '00000000-0000-4000-8000-000000000004';
const candidateDigest = 'sha256:' + '3'.repeat(64);
const comparisonId = '00000000-0000-4000-8000-000000000003';
let root, commit, previousCommit;

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const commitAll = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-ci-test-'));
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'bundle.json'), candidate);
  await mkdir(join(root, 'agent', 'skills', 'orders'), { recursive: true });
  await mkdir(join(root, 'agent', 'memory'));
  await writeFile(join(root, 'agent', 'instructions.md'), 'Old instructions\n');
  await writeFile(join(root, 'agent', 'skills', 'orders', 'SKILL.md'), 'An app skill\n');
  await writeFile(join(root, 'agent', 'memory', 'approved.md'), 'Approved fact\n');
  await writeFile(join(root, 'agent', 'memory', 'private.md'), 'Private note\n');
  await mkdir(join(root, 'bad-source'));
  await symlink('../bundle.json', join(root, 'bad-source', 'instructions.md'));
  git(root, 'add', 'bundle.json', 'agent', 'bad-source');
  git(root, '-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Original instructions');
  previousCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'agent', 'instructions.md'), 'New instructions in the PR\n');
  git(root, 'add', 'agent/instructions.md');
  git(root, '-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Candidate under review');
  commit = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'bundle.json'), 'Uncommitted working-tree edit');
  await writeFile(join(root, 'agent', 'instructions.md'), 'Unsaved change after checkout');
  await writeFile(join(root, 'agent', 'untracked.md'), 'Untracked scratch note');
  // A fake installed evaluator. CI_RESPONSES maps each command to one response, or to a list
  // consumed one invocation at a time. `hang` keeps the command running until a signal arrives.
  await writeFile(join(root, 'eval.mjs'), `#!${process.execPath}
    import { spawn } from 'node:child_process';
    import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    const [command, ...flags] = process.argv.slice(2);
    const flag = name => { const at = flags.indexOf('--' + name); return at < 0 ? undefined : flags[at + 1]; };
    const counter = process.env.CI_COMMAND_LOG + '.' + command + '.count';
    const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(count + 1));
    let phase = JSON.parse(process.env.CI_RESPONSES)[command] ?? {};
    if (Array.isArray(phase)) phase = phase[Math.min(count, phase.length - 1)] ?? {};
    let config = {};
    try { config = JSON.parse(readFileSync(flag('config'), 'utf8')); } catch {}
    const payload = command === 'request' ? readFileSync(flag('payload'), 'utf8') : null;
    const log = entry => appendFileSync(process.env.CI_COMMAND_LOG, JSON.stringify(entry) + '\\n');
    log({ command, flags, payload, cwd: process.cwd(), python: process.env.CI_TEST_PYTHON_EXE,
      configToken: config.evaluatorToken ?? null, configTokenFile: config.evaluatorTokenFile ?? null,
      envToken: process.env.ACCLIMATE_EVALUATOR_TOKEN ?? null, pid: process.pid });
    const body = phase.body ?? (command === 'request' ? {
      requestId: ${JSON.stringify(requestId)}, candidateVersionId: ${JSON.stringify(candidateVersionId)},
      candidateDigest: ${JSON.stringify(candidateDigest)}, parentVersionId: ${JSON.stringify(parentVersionId)},
    } : command === 'check' ? { verdict: 'pass' } : command === 'describe' ? { runtime: 'old evaluator' }
      : command === 'interrupt' ? { status: 'interrupted' } : { status: 'ok' });
    if (command === 'request' && !phase.exit) {
      const handoff = flag('out');
      mkdirSync(dirname(handoff), { recursive: true });
      if (!existsSync(handoff)) writeFileSync(handoff, JSON.stringify({ schemaVersion: 1,
        serviceUrl: config.serviceUrl ?? 'https://acclimate.invalid/', workspaceId: config.workspaceId ?? 'workspace',
        bundleId: flag('bundle'), requestId: body.requestId, descriptor: { runtime: 'old evaluator' } }));
    }
    if (command === 'export' && !phase.exit) {
      mkdirSync(flag('out'), { recursive: true });
      writeFileSync(join(flag('out'), 'manifest.json'), '{}');
    }
    if (phase.error) console.error(JSON.stringify({ schemaVersion: 1, command, error: phase.error }));
    if (phase.hang) {
      const helper = spawn('sleep', ['60'], { stdio: 'ignore' });
      log({ command, event: 'started', pid: process.pid, helper: helper.pid });
      const stop = signal => {
        log({ command, event: 'signal', signal });
        if (phase.hang !== 'graceful') return;
        helper.kill();
        console.log(JSON.stringify(body));
        process.exit(phase.exit ?? 2);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      setInterval(() => {}, 1000);
    } else {
      console.log(JSON.stringify(body));
      process.exit(phase.exit ?? 0);
    }
  `);
  await chmod(join(root, 'eval.mjs'), 0o755);
  await writeFile(join(root, 'eval.py'), `
import os, sys
os.environ['CI_TEST_PYTHON_EXE'] = sys.executable
os.execv(os.environ["CI_FIXTURE_NODE"], [os.environ["CI_FIXTURE_NODE"], os.environ["CI_FIXTURE_APP"], *sys.argv[1:]])
`);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function invocation(language, responses, extra, omit, env, dir) {
  const app = join(root, language === 'python' ? 'eval.py' : 'eval.mjs');
  const args = { language, app, config: join(root, 'config.json'), bundle: 'bundle-under-test',
    channel: 'canary', repo: root, commit, payload: 'bundle.json', policy: join(root, 'policy.json'),
    intent: join(dir, 'intent.json'), 'output-dir': dir };
  const flags = Object.entries(args).filter(([k]) => !omit.includes(k)).flatMap(([k, v]) => ['--' + k, v]);
  return {
    argv: [shell, ...flags, ...extra],
    options: { cwd: root, encoding: 'utf8', env: { ...process.env, CI_COMMAND_LOG: join(dir, 'log'),
      CI_FIXTURE_NODE: process.execPath, CI_FIXTURE_APP: join(root, 'eval.mjs'),
      CI_RESPONSES: JSON.stringify(responses), ...env } },
  };
}

async function commandLog(dir) {
  return (await readFile(join(dir, 'log'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function pipeline(language, responses, extra = [], omit = [], env = {}) {
  const dir = await mkdtemp(join(root, 'run-'));
  const { argv, options } = invocation(language, responses, extra, omit, env, dir);
  const result = spawnSync('sh', argv, options);
  const commands = (await commandLog(dir)).filter(entry => !entry.event);
  let summary;
  try {
    summary = JSON.parse(result.stdout);
  } catch {
    summary = null;
  }
  return { ...result, summary, commands, dir };
}

/** Start the wrapper in the background, wait for the named command to start, then signal it. */
async function interrupted(responses, extra, omit, signals, env = {}) {
  const dir = await mkdtemp(join(root, 'cancel-'));
  const { argv, options } = invocation('javascript', responses, extra, omit, env, dir);
  const child = spawn('sh', argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', code => resolve({ code, at: Date.now() })));
  for (let waited = 0; !(await commandLog(dir)).some(entry => entry.event === 'started'); waited += 50) {
    assert.ok(waited < 60000, 'the evaluator command did not start\n' + stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const signalledAt = Date.now();
  for (const [signal, delay] of signals) {
    await new Promise(resolve => setTimeout(resolve, delay));
    child.kill(signal);
  }
  const { code, at } = await exited;
  const entries = await commandLog(dir);
  return { status: code, stdout, stderr, summary: JSON.parse(stdout), entries, dir, elapsed: at - signalledAt };
}

async function alive(pid) {
  // Allow the process to be reaped after its group is killed.
  for (let waited = 0; waited < 3000; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return true;
}

async function writeConfig(dir, values) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify(values), { mode: 0o600 });
  return file;
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
      summary.candidateDigest, summary.qualityVerdict, summary.result, summary.exitCode],
      [commit, 'canary', requestId, candidateVersionId, candidateDigest, 'pass', 'pass', 0]);
    assert.match(summary.reviewDirectory, new RegExp('^reviews/' + requestId));
    assert.deepEqual(Object.values(summary.phaseExitCodes), [0, 0, 0, 0, 0, 0]);
  });
}

for (const [name, responses, expected, resultName, phaseCodes] of [
  ['policy regression', { check: { exit: 2, body: { verdict: 'fail' } } }, 2, 'quality_failed', [0, 0, 0, 2, 0, 0]],
  // Evaluator exit codes: 1 fix, 2 gate failed, 3 indeterminate, 4 run or service failed, 5 recovery.
  ['failed execution with an incomplete grade',
    { run: { exit: 4, body: { status: 'failed', comparisonId } }, check: { exit: 3, body: { verdict: 'indeterminate' } } },
    4, 'execution_failed', [0, 0, 4, 3, 0, 0]],
  ['an unreachable service during the run', { run: { exit: 4 } }, 4, 'execution_failed', [0, 0, 4, null, 0, 0]],
  ['a run stopped early with partial evidence',
    { run: { exit: 3, body: { status: 'completed', comparisonId } }, check: { exit: 3, body: { verdict: 'indeterminate' } } },
    3, 'execution_partial', [0, 0, 3, 3, 0, 0]],
  ['partial evidence that already fails the gate',
    { run: { exit: 3, body: { status: 'completed', comparisonId } }, check: { exit: 2, body: { verdict: 'fail' } } },
    2, 'quality_failed', [0, 0, 3, 2, 0, 0]],
  ['uncertain execution and unavailable export', { run: { exit: 5 }, export: { exit: 1 } },
    5, 'execution_unresolved', [0, 0, 5, null, 1, null]],
  ['missing required export', { export: { exit: 3 } }, 3, 'export_failed', [0, 0, 0, 0, 3, null]],
  ['unverifiable export', { 'verify-export': { exit: 1 } }, 1, 'export_failed', [0, 0, 0, 0, 0, 1]],
  ['failed request', { request: { exit: 5 } }, 5, 'request_failed', [0, 5, null, null, null, null]],
  ['missing candidate binding', { request: { body: {} } }, 1, 'request_failed', [0, 1, null, null, null, null]],
  ['failed preflight', { doctor: { exit: 1 } }, 1, 'preflight_failed', [1, null, null, null, null, null]],
]) {
  test(`CI distinguishes ${name}`, async () => {
    const run = await pipeline('javascript', responses);

    assert.equal(run.status, expected, run.stderr);
    assert.equal(run.summary.result, resultName);
    assert.equal(run.summary.exitCode, expected);
    assert.ok(run.summary.nextAction);
    assert.deepEqual(Object.values(run.summary.phaseExitCodes), phaseCodes);
    assert.ok(run.commands.every(c => !c.flags.includes('--live') && !c.flags.includes('--selection')));
    if (phaseCodes[5] !== 0) assert.equal(run.summary.reviewDirectory, null);
  });
}

test('CI reports the diagnostic, failed checks and hint for every phase', async () => {
  const doctor = await pipeline('javascript', { doctor: { exit: 4, body: { schemaVersion: 1, status: 'blocked',
    authorization: 'unverified', nextAction: 'retry_same_command', checks: [{ check: 'runtime', status: 'passed' },
      { check: 'serviceIdentity', status: 'failed', code: 'service.unavailable' }] } } });
  assert.equal(doctor.summary.result, 'preflight_failed');
  assert.equal(doctor.summary.failedPhase, 'doctor');
  assert.equal(doctor.summary.diagnosticCode, 'service.unavailable');
  assert.deepEqual(doctor.summary.failedChecks, [{ check: 'serviceIdentity', status: 'failed', code: 'service.unavailable' }]);
  assert.match(doctor.summary.hint, /could not reach the service/);
  assert.equal(doctor.summary.evaluatorNextAction, 'retry_same_command');

  const run = await pipeline('javascript', { run: { exit: 5, error: { code: 'journal.busy', phase: 'claim',
    nextAction: 'retry_same_command' } } });
  assert.equal(run.summary.result, 'execution_unresolved');
  assert.equal(run.summary.failedPhase, 'run');
  assert.equal(run.summary.diagnosticCode, 'journal.busy');
  assert.match(run.summary.hint, /orphaned evaluator/);

  const request = await pipeline('javascript', { request: { exit: 1, error: { code: 'request.channel_empty',
    hint: 'Publish a baseline release to channel canary first.' } } });
  assert.equal(request.summary.diagnosticCode, 'request.channel_empty');
  assert.equal(request.summary.hint, 'Publish a baseline release to channel canary first.');
});

test('without a structured diagnostic the summary keeps the evaluator\'s last output', async () => {
  const files = await mkdtemp(join(root, 'unstructured-'));
  const json = join(files, 'summary.json');
  const run = await pipeline('javascript', { doctor: { exit: 1, error: 'Node.js 22.22 is required' } },
    ['--format', 'markdown', '--summary-json', json]);
  assert.equal(run.status, 1);
  const summary = JSON.parse(await readFile(json, 'utf8'));
  assert.equal(summary.diagnosticCode, null);
  assert.match(summary.hint, /^Last evaluator output: .*Node\.js 22\.22 is required/);
  assert.match(run.stdout, /\*\*Diagnostic:\*\* phase `doctor`\n/);
  assert.doesNotMatch(run.stdout, /None|null/);
});

test('CI writes GitHub annotations, Markdown and step outputs that name failed criteria and cases', async () => {
  const verdict = { verdict: 'fail', code: 'policy.fail', comparisonId,
    policy: { id: 'shipping', revision: 'r1', sha256: candidateDigest },
    counts: { distinctCases: 2, expectedPairs: 3, comparablePairs: 2 },
    summary: { parentMean: 1, candidateMean: 0.5, orientedMeanImprovement: -0.5 },
    checks: [{ code: 'policy.minimum_mean_improvement', result: 'fail', caseIds: ['refund-flow'] }],
    cases: [{ caseId: 'refund-flow', parentMean: 1, candidateMean: 0, orientedMeanImprovement: -1 },
      { caseId: 'steady', parentMean: 1, candidateMean: 1, orientedMeanImprovement: 0 }],
    evidenceGaps: { total: 1, rows: [{ caseId: 'missing\nscore', repetition: 0, side: 'candidate',
      stage: 'grading', reason: 'grading_failed' }] } };
  const files = await mkdtemp(join(root, 'reports-'));
  const markdown = join(files, 'summary.md'), outputs = join(files, 'outputs'), json = join(files, 'summary.json');
  await writeFile(markdown, '# Existing step summary\n');
  const run = await pipeline('javascript', { check: { exit: 2, body: verdict },
    run: { body: { status: 'completed', comparisonId }, error: { code: 'note' } } },
  ['--format', 'github', '--summary-md', markdown, '--summary-json', json, '--github-output', outputs]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stdout, /^::error title=Acclimate quality gate failed::Failed criteria: policy.minimum_mean_improvement/m);
  assert.match(run.stdout, /^::error title=Failed criterion policy.minimum_mean_improvement::.*refund-flow/m);
  assert.match(run.stdout, /^::error title=Regressed case refund-flow::Case refund-flow changed by -1/m);
  assert.match(run.stdout, /^::warning title=Missing evidence for missing score::/m);
  assert.doesNotMatch(run.stdout, /steady/);
  // Evaluator output is fenced so that it cannot issue workflow commands.
  const token = /::stop-commands::([0-9a-f]{32})/.exec(run.stderr)[1];
  assert.ok(run.stderr.includes('::group::Acclimate run'));
  assert.ok(run.stderr.indexOf('"code":"note"') > run.stderr.indexOf('::stop-commands::' + token));
  assert.ok(run.stderr.includes('::' + token + '::'));
  // Each command's JSON result is printed before its fence closes.
  const runGroup = run.stderr.slice(run.stderr.indexOf('::group::Acclimate run'));
  assert.ok(runGroup.indexOf(comparisonId) < runGroup.indexOf('::endgroup::'));
  const written = JSON.parse(await readFile(json, 'utf8'));
  assert.equal(written.result, 'quality_failed');
  assert.deepEqual(written.quality.regressedCases.map(row => row.caseId), ['refund-flow']);
  const text = await readFile(markdown, 'utf8');
  assert.ok(text.startsWith('# Existing step summary\n### ❌ Acclimate quality gate failed'));
  assert.match(text, /\*\*Failed criteria:\*\* `policy.minimum_mean_improvement`/);
  assert.match(text, /\| `refund-flow` \| 1 \| 0 \| -1 \|/);
  assert.match(await readFile(outputs, 'utf8'),
    new RegExp(`^result=quality_failed\nexit-code=2\nverdict=fail\ncomparison-id=${comparisonId}\n`));

  const plain = await pipeline('javascript', {}, ['--format', 'markdown']);
  assert.match(plain.stdout, /^### ✅ Acclimate quality gate passed/);
});

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

test('CI explains a pull_request merge checkout and prints required flags in help', async () => {
  const run = await pipeline('javascript', {}, ['--commit', 'f'.repeat(40)], ['commit']);
  assert.match(run.summary.hint, /HEAD is [0-9a-f]{40} but --commit is f{40}.*github\.sha/);
  const help = spawnSync('sh', [shell, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const required = help.stdout.slice(help.stdout.indexOf('required arguments:'), help.stdout.indexOf('bundle source:'));
  for (const flag of ['--commit', '--app', '--config', '--bundle ID', '--channel', '--policy', '--output-dir', '--bundle-dir']) {
    assert.ok(required.includes(flag), flag);
  }
  assert.match(help.stdout, /--rerun-after HANDOFF/);
});

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
  assert.deepEqual(first.summary.reuse, { status: 'unavailable', reason: 'channel_release_unknown' });
  const repeat = await pipeline('javascript', {}, selected, omitted);
  assert.equal(repeat.status, 0, repeat.stderr);
  const resumed = repeat.commands.find(c => c.command === 'request');
  assert.equal(resumed.flags[resumed.flags.indexOf('--intent') + 1], intent);
  assert.equal(repeat.summary.handoff, first.summary.handoff);
  // The saved review export is verified and reused rather than exported again.
  assert.deepEqual(repeat.commands.map(c => c.command), ['doctor', 'status', 'request', 'run', 'check', 'verify-export']);
  assert.equal(repeat.summary.reviewDirectory, first.summary.reviewDirectory);
  assert.deepEqual((await readdir(join(output, 'reviews'))).filter(name => !name.startsWith('.')), [requestId]);
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

test('--base-commit lists the bundle files changed since the merge base', async () => {
  const run = await pipeline('javascript', {}, ['--bundle-dir', 'agent', '--no-memory', '--base-commit', previousCommit],
    ['payload']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.summary.changedFiles, [{ status: 'M', path: 'agent/instructions.md' }]);
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

test('a Python evaluator on an old interpreter fails with a version message, not an ImportError', async () => {
  const app = join(root, 'old-python-app');
  await mkdir(join(app, '.venv', 'bin'), { recursive: true });
  await writeFile(join(app, 'application.py'), '');
  await writeFile(join(app, '.venv', 'bin', 'python'), '#!/bin/sh\necho 3.9\n', { mode: 0o755 });
  const run = await pipeline('python', {}, ['--app', app], ['language', 'app'], { ACCLIMATE_CI_PYTHON: '' });
  assert.equal(run.status, 1);
  assert.equal(run.summary.result, 'configuration_error');
  assert.equal(run.commands.length, 0);
  assert.match(run.stderr, /Python evaluators need Python 3\.11 or later, but .*\.venv\/bin\/python is 3\.9/);
});

test('CI exposes policy measurements, incomplete pairs, reasons and receipt independently of execution', async () => {
  const policy = { id: 'shipping', revision: 'r1', sha256: candidateDigest };
  const counts = { distinctCases: 2, expectedPairs: 3, comparablePairs: 2 };
  const scores = { parentMean: 1, candidateMean: 0.5, orientedMeanImprovement: -0.5 };
  const gaps = { total: 1, rows: [{ caseId: 'missing-score', repetition: 0, side: 'candidate',
    stage: 'grading', reason: 'grading_failed' }] };
  const verdict = { verdict: 'fail', code: 'policy.fail', policy, comparisonId, counts,
    summary: scores, checks: [{ code: 'policy.minimum_mean_improvement', result: 'fail' },
      { code: 'policy.cost_unknown', result: 'unknown' }, { code: 'ignored.pass', result: 'pass' }],
    evidenceGaps: gaps, policyReceipt: { status: 'recorded', code: 'saved' } };
  const result = await pipeline('javascript', { run: { body: { status: 'completed', comparisonId } },
    check: { exit: 2, body: verdict } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.summary.executionStatus, 'completed');
  assert.equal(result.summary.comparisonId, comparisonId);
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
  const status = { status: 'failed', requestId, attemptId: candidateVersionId, comparisonId };
  const mismatch = await pipeline('javascript', {
    request: { exit: 1, error: { code: 'request.intent_mismatch' } },
    status: { body: status }, describe: { body: { runtime: 'repaired evaluator' } },
  }, common, omitted);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.summary.mismatch, 'evaluator_definition_changed');
  assert.equal(mismatch.summary.priorHandoff, previous);
  assert.equal(mismatch.summary.previousExecutionStatus, 'failed');
  assert.equal(mismatch.summary.diagnosticCode, 'request.intent_mismatch');
  assert.match(mismatch.summary.nextAction, /--rerun-after/);
  assert.ok(mismatch.commands.every(c => c.command !== 'run'));
  const next = [...common, '--rerun-after', previous];
  const successor = { request: { body: { requestId: successorId, candidateVersionId, candidateDigest } } };
  const retried = await pipeline('javascript', { status: { body: status }, ...successor }, next, omitted);
  const replay = await pipeline('javascript', { status: { body: { ...status, requestId: successorId } }, ...successor },
    next, omitted);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(replay.status, 0, replay.stderr);
  assert.ok(retried.summary.handoff.includes('/after-' + requestId + '/'));
  assert.equal(replay.summary.handoff, retried.summary.handoff);
  assert.notEqual(retried.summary.handoff, previous);
  assert.equal(retried.summary.previousRequestId, requestId);
  assert.equal(replay.summary.requestId, successorId);
  // A plain rerun follows the chain to the latest generation.
  const plain = await pipeline('javascript', { status: { body: { ...status, requestId: successorId } }, ...successor },
    common, omitted);
  assert.equal(plain.summary.handoff, retried.summary.handoff);

  const fresh = async () => {
    const dir = await mkdtemp(join(root, 'recovery-'));
    const seeded = await pipeline('javascript', {}, ['--output-dir', dir], omitted);
    return [dir, seeded.summary.handoff];
  };
  for (const body of [{ ...status, status: 'running' }, { ...status, comparisonId: null }]) {
    const [dir, handoff] = await fresh();
    const unsafe = await pipeline('javascript', { status: { body } }, ['--output-dir', dir, '--rerun-after', handoff], omitted);
    assert.equal(unsafe.status, 5);
    assert.equal(unsafe.summary.result, 'prior_execution_unresolved');
    assert.deepEqual(unsafe.commands.map(c => c.command), ['doctor', 'status']);
  }
  const [deniedDir, deniedHandoff] = await fresh();
  const denied = await pipeline('javascript', { status: { exit: 1 } },
    ['--output-dir', deniedDir, '--rerun-after', deniedHandoff], omitted);
  assert.equal(denied.summary.result, 'prior_status_unavailable');
  assert.deepEqual(denied.commands.map(c => c.command), ['doctor', 'status']);
  const unrelated = await pipeline('javascript', {}, [...next, '--channel', 'elsewhere'], [...omitted, 'channel']);
  assert.equal(unrelated.summary.result, 'configuration_error');
  assert.match(unrelated.summary.hint, /already starts a fresh request/);
  assert.deepEqual(unrelated.commands.map(c => c.command), ['doctor']);
  // A corrupt saved handoff does not hide the request failure.
  const [dir, handoff] = await fresh();
  await writeFile(join(dir, handoff), 'not json');
  const corrupt = await pipeline('javascript', { request: { exit: 1, error: { code: 'request.intent_mismatch' } },
    status: { body: status } }, ['--output-dir', dir], omitted);
  assert.equal(corrupt.summary.result, 'request_failed');
});

/** A fake service in its own process (spawnSync blocks this test's event loop). It refuses channel
 * reads with 503, so the wrapper falls back to per-commit request directories, and answers the
 * abandon route. */
async function abandonService() {
  const state = await mkdtemp(join(root, 'abandon-service-'));
  const seenFile = join(state, 'seen.log');
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ method: request.method, url: request.url,
          key: request.headers['idempotency-key'], authorization: request.headers.authorization, body }) + '\\n');
        const abandon = request.method === 'POST' && request.url.endsWith('/abandon');
        response.writeHead(abandon ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify(abandon ? { status: 'abandoned' } : { error: { code: 'unavailable' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise(resolve => server.stdout.once('data', data => resolve(Number(String(data).trim()))));
  const seen = async () => (await readFile(seenFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
  return { url: `http://127.0.0.1:${port}/`, seen, stop: () => server.kill() };
}

test('interrupted and abandoned predecessors are followed headlessly; unstarted ones are reconciled; uncertain ones need opt-in', async () => {
  const service = await abandonService();
  try {
  const omitted = ['intent', 'output-dir'];
  const journalRoot = await realpath(await mkdtemp(join(root, 'journal-')));
  const configValues = { schemaVersion: 1, serviceUrl: service.url, workspaceId: 'workspace',
    evaluatorPrincipalId: 'ci-evaluator', evaluatorToken: 'secret-token', journalRoot };
  const config = await writeConfig(await mkdtemp(join(root, 'config-')), configValues);
  const status = { requestId, attemptId: candidateVersionId, comparisonId: null };
  const successor = { request: { body: { requestId: successorId, candidateVersionId, candidateDigest } } };
  const setup = async () => {
    const dir = await mkdtemp(join(root, 'headless-'));
    const first = await pipeline('javascript', { run: { exit: 5 } }, ['--output-dir', dir, '--config', config],
      [...omitted, 'config']);
    assert.equal(first.summary.result, 'execution_unresolved');
    assert.equal(first.status, 5);
    return [dir, first.summary.handoff];
  };
  const journal = async (state) => {
    // The journal directory key the SDKs compute from the canonical scope.
    const scope = JSON.stringify({ serviceUrl: configValues.serviceUrl, workspaceId: 'workspace',
      bundleId: 'bundle-under-test', requestId, evaluatorPrincipalId: 'ci-evaluator' });
    const directory = join(journalRoot, createHash('sha256').update(scope).digest('hex'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'attempt.json'), JSON.stringify(state), { mode: 0o600 });
  };

  // An interrupted request, or one the service abandoned after inactivity, starts a successor automatically.
  let [dir, handoff] = await setup();
  for (const ended of ['interrupted', 'abandoned']) {
    if (ended === 'abandoned') [dir, handoff] = await setup();
    const expired = await pipeline('javascript', { status: { body: { ...status, status: ended,
      ...(ended === 'abandoned' && { abandonedBy: 'service:evaluation-expiry' }) } }, ...successor },
    ['--output-dir', dir, '--config', config], [...omitted, 'config']);
    assert.equal(expired.status, 0, expired.stderr);
    assert.equal(expired.summary.requestId, successorId);
    assert.equal(expired.summary.previousExecutionStatus, ended);
    assert.equal(expired.summary.handoff, handoff.replace(/[^/]+$/, 'after-' + requestId + '/handoff.json'));
  }
  // An explicitly named abandoned predecessor is settled too.
  [dir, handoff] = await setup();
  const named = await pipeline('javascript', { status: { body: { ...status, status: 'abandoned' } }, ...successor },
    ['--output-dir', dir, '--config', config, '--rerun-after', handoff], [...omitted, 'config']);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.summary.previousExecutionStatus, 'abandoned');

  // A running request whose journal has no execution marker is interrupted and replaced.
  [dir, handoff] = await setup();
  await journal({ attemptId: 'a' });
  const reconciled = await pipeline('javascript', { status: { body: { ...status, status: 'running' } }, ...successor },
    ['--output-dir', dir, '--config', config, '--rerun-after', handoff], [...omitted, 'config']);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.deepEqual(reconciled.summary.reconciled, { requestId, previousStatus: 'running', journal: 'not_started',
    action: 'interrupted' });
  const interrupt = reconciled.commands.find(c => c.command === 'interrupt');
  assert.match(interrupt.flags[interrupt.flags.indexOf('--reason') + 1], /before execution started/);

  // Execution may have started: stop unless the CI owner opts in.
  [dir, handoff] = await setup();
  await journal({ attemptId: 'a', executionStarted: true });
  const uncertain = await pipeline('javascript', { status: { body: { ...status, status: 'running' } } },
    ['--output-dir', dir, '--config', config, '--rerun-after', handoff], [...omitted, 'config']);
  assert.equal(uncertain.summary.result, 'prior_execution_unresolved');
  assert.equal(uncertain.status, 5);
  assert.equal(uncertain.summary.previousJournalState, 'may_have_started');
  assert.ok(!uncertain.commands.some(c => c.command === 'interrupt'));
  // --abandon-uncertain calls the service's abandon route instead of interrupting.
  const abandoned = await pipeline('javascript', { status: { body: { ...status, status: 'running' } }, ...successor },
    ['--output-dir', dir, '--config', config, '--abandon-uncertain'], [...omitted, 'config']);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.deepEqual(abandoned.summary.reconciled, { requestId, previousStatus: 'running', journal: 'may_have_started',
    action: 'abandoned' });
  assert.ok(!abandoned.commands.some(c => c.command === 'interrupt'));
  const call = (await service.seen()).find(entry => entry.method === 'POST');
  assert.equal(call.url, `/v1/workspaces/workspace/bundles/bundle-under-test/evaluation-requests/${requestId}/abandon`);
  assert.equal(call.key, 'ci-abandon-' + requestId);
  assert.equal(call.authorization, 'Bearer secret-token');
  assert.match(JSON.parse(call.body).reason, /--abandon-uncertain/);
  } finally {
    service.stop();
  }
});

test('SIGINT reaches the evaluator, the summary is printed, and a rerun starts a fresh request', async () => {
  const output = await mkdtemp(join(root, 'cancel-state-'));
  const omitted = ['intent', 'output-dir'];
  const responses = { run: { hang: 'graceful', exit: 4, body: { status: 'failed', comparisonId } } };
  const run = await interrupted(responses, ['--output-dir', output], omitted, [['SIGINT', 0]]);
  assert.equal(run.status, 130, run.stderr);
  assert.equal(run.summary.result, 'cancelled');
  assert.deepEqual(run.summary.cancellation, { signal: 'SIGINT', phase: 'run', forced: false });
  assert.equal(run.summary.executionStatus, 'failed');
  assert.equal(run.summary.phaseExitCodes.check, null);
  assert.doesNotMatch(run.stderr, /Traceback|KeyboardInterrupt/);
  assert.deepEqual(run.entries.filter(e => e.event === 'signal').map(e => e.signal), ['SIGINT']);
  const started = run.entries.find(e => e.event === 'started');
  assert.ok(!(await alive(started.pid)) && !(await alive(started.helper)));
  const marker = JSON.parse(await readFile(join(output, run.summary.handoff.replace(/[^/]+$/, 'cancelled.json')), 'utf8'));
  assert.equal(marker.requestId, requestId);

  const rerun = await pipeline('javascript', { status: { body: { status: 'failed', requestId, comparisonId } },
    request: { body: { requestId: successorId, candidateVersionId, candidateDigest } } }, ['--output-dir', output], omitted);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(rerun.summary.requestId, successorId);
  assert.ok(rerun.summary.handoff.includes('/after-' + requestId + '/'));
});

test('SIGTERM kills an evaluator that ignores it after the grace period, leaving no orphan', async () => {
  const run = await interrupted({ run: { hang: 'ignore' } }, ['--cancel-grace', '1'], [], [['SIGTERM', 0]]);
  assert.equal(run.status, 143, run.stderr);
  assert.equal(run.summary.result, 'cancelled');
  assert.deepEqual(run.summary.cancellation, { signal: 'SIGTERM', phase: 'run', forced: true });
  const started = run.entries.find(e => e.event === 'started');
  assert.ok(!(await alive(started.pid)) && !(await alive(started.helper)));

  // A second signal, like a CI runner's escalation, shortens the wait.
  const escalated = await interrupted({ run: { hang: 'ignore' } }, ['--cancel-grace', '60'], [],
    [['SIGINT', 0], ['SIGTERM', 200]]);
  assert.equal(escalated.status, 130);
  assert.ok(escalated.elapsed < 30000, 'a second signal should not wait for the 60 second grace period');
  assert.deepEqual(escalated.entries.filter(e => e.event === 'signal').map(e => e.signal), ['SIGINT', 'SIGTERM']);
});

test('a token from the environment or a private file reaches the evaluator only through its environment', async () => {
  const dir = await mkdtemp(join(root, 'token-config-'));
  const template = await writeConfig(dir, { schemaVersion: 1, serviceUrl: 'http://127.0.0.1:9/', workspaceId: 'p',
    evaluatorPrincipalId: 'ci', journalRoot: '/tmp/unused' });
  const omitted = ['config'];
  const run = await pipeline('javascript', {}, ['--config', template, '--token-env', 'CI_TEST_TOKEN'], omitted,
    { CI_TEST_TOKEN: 'from-environment' });
  assert.equal(run.status, 0, run.stderr);
  const configured = run.commands.filter(c => c.flags.includes('--config'));
  assert.equal(configured.length, 5);
  // The derived config is token-free; the evaluator reads ACCLIMATE_EVALUATOR_TOKEN.
  assert.ok(configured.every(c => c.configToken === null && c.configTokenFile === null));
  assert.ok(configured.every(c => c.envToken === 'from-environment'));
  const used = run.commands[0].flags[run.commands[0].flags.indexOf('--config') + 1];
  assert.ok(used.startsWith(run.dir + '/.credentials-'));
  await assert.rejects(stat(used));
  assert.doesNotMatch(run.stdout + run.stderr, /from-environment/);

  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'from-file\n', { mode: 0o600 });
  const fromFile = await pipeline('javascript', {}, ['--config', template, '--token-file', tokenFile], omitted);
  assert.ok(fromFile.commands.filter(c => c.flags.includes('--config'))
    .every(c => c.configToken === null && c.envToken === 'from-file'));
  await chmod(tokenFile, 0o644);
  const exposed = await pipeline('javascript', {}, ['--config', template, '--token-file', tokenFile], omitted);
  assert.equal(exposed.summary.result, 'configuration_error');
  assert.match(exposed.stderr, /mode 0600/);
  const missing = await pipeline('javascript', {}, ['--config', template, '--token-env', 'CI_TEST_UNSET'], omitted,
    { CI_TEST_UNSET: '' });
  assert.equal(missing.summary.result, 'configuration_error');
});

test('an unchanged candidate, release and evaluator reuse their result across commits', async () => {
  // The fake service runs in its own process: spawnSync blocks this test's event loop.
  const state = await mkdtemp(join(root, 'reuse-service-'));
  const releaseFile = join(state, 'release.json'), seenFile = join(state, 'seen.log');
  let release = { channel: 'canary', revision: '7', version: { id: parentVersionId, digest: candidateDigest } };
  const publish = value => writeFile(releaseFile, JSON.stringify(value));
  await publish(release);
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ url: request.url,
        authorization: request.headers.authorization }) + '\\n');
      const release = JSON.parse(readFileSync(${JSON.stringify(releaseFile)}, 'utf8'));
      response.writeHead(release ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(release ?? { error: { code: 'not_found', message: 'Channel not found' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise(resolve => server.stdout.once('data', data => resolve(Number(String(data).trim()))));
  try {
    const repo = await mkdtemp(join(root, 'reuse-repo-'));
    git(repo, 'init', '--quiet');
    await mkdir(join(repo, 'agent'));
    await writeFile(join(repo, 'agent', 'instructions.md'), 'Same instructions\n');
    await writeFile(join(repo, 'README.md'), 'First\n');
    const first = commitAll(repo, 'First');
    await writeFile(join(repo, 'README.md'), 'Docs only\n');
    const second = commitAll(repo, 'Docs only');
    const config = await writeConfig(await mkdtemp(join(root, 'reuse-config-')), { schemaVersion: 1,
      serviceUrl: `http://127.0.0.1:${port}/`, workspaceId: 'workspace',
      evaluatorPrincipalId: 'ci', evaluatorToken: 'reuse-token', journalRoot: '/tmp/unused' });
    const output = await mkdtemp(join(root, 'reuse-output-'));
    const omitted = ['payload', 'repo', 'commit', 'config', 'intent', 'output-dir'];
    const at = (sha, extra = []) => {
      git(repo, 'checkout', '--quiet', '--detach', sha);
      return pipeline('javascript', { status: { body: { status: 'completed', requestId, comparisonId } } },
        ['--repo', repo, '--commit', sha, '--bundle-dir', 'agent', '--config', config, '--output-dir', output, ...extra],
        omitted);
    };
    const original = await at(first);
    assert.equal(original.status, 0, original.stderr);
    assert.equal(original.summary.reuse.status, 'new');
    const seen = (await readFile(seenFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(seen[0], { url: '/v1/workspaces/workspace/bundles/bundle-under-test/channels/canary',
      authorization: 'Bearer reuse-token' });
    const reused = await at(second);
    assert.equal(reused.status, 0, reused.stderr);
    assert.deepEqual(reused.summary.reuse, { status: 'reused', key: original.summary.reuse.key, originCommit: first });
    assert.equal(reused.summary.commit, second);
    assert.equal(reused.summary.handoff, original.summary.handoff);

    // A new channel release, a changed evaluator or a different case subset needs a new request.
    release = { ...release, revision: '8', version: { id: successorId, digest: candidateDigest } };
    await publish(release);
    const moved = await at(second);
    assert.equal(moved.summary.reuse.status, 'new');
    assert.notEqual(moved.summary.handoff, original.summary.handoff);
    const subset = await at(second, ['--cases', 'refund-flow']);
    assert.notEqual(subset.summary.handoff, moved.summary.handoff);
    const runFlags = subset.commands.find(c => c.command === 'run').flags;
    assert.deepEqual(runFlags.slice(runFlags.indexOf('--cases')), ['--cases', 'refund-flow']);
    const disabled = await at(second, ['--no-reuse']);
    assert.ok(disabled.summary.handoff.startsWith('requests/' + second + '-'));

    // An empty channel stops before a request with a clear next step.
    await publish(null);
    const empty = await at(second);
    assert.equal(empty.status, 1);
    assert.equal(empty.summary.result, 'request_failed');
    assert.equal(empty.summary.diagnosticCode, 'request.channel_empty');
    assert.match(empty.summary.hint, /Publish a baseline release to this channel/);
    assert.deepEqual(empty.commands.map(c => c.command), ['doctor']);
  } finally {
    server.kill();
  }
});

test('cost and time limits pass through to the evaluator run command under its own flag names', async () => {
  const run = await pipeline('javascript', {}, ['--deadline', '30m', '--case-timeout', '2m', '--max-cost-usd', '2.50',
    '--shard', '1/3']);
  assert.equal(run.status, 0, run.stderr);
  const flags = run.commands.find(c => c.command === 'run').flags;
  assert.deepEqual(flags.slice(flags.indexOf('--deadline')),
    ['--deadline', '30m', '--case-timeout', '2m', '--max-cost-usd', '2.50', '--shard', '1/3']);
  for (const command of run.commands.filter(c => c.command !== 'run')) assert.ok(!command.flags.includes('--deadline'));
  // Concurrency is declared in the evaluator definition, not passed to run.
  const concurrency = await pipeline('javascript', {}, ['--concurrency', '4']);
  assert.equal(concurrency.summary.result, 'configuration_error');
  assert.match(concurrency.stderr, /evaluator definition/);
  for (const bad of [['--max-cost-usd', '0'], ['--max-cost-usd', 'lots'], ['--cancel-grace', '0'],
    ['--cases', 'a', '--shard', '1/2']]) {
    const rejected = await pipeline('javascript', {}, bad);
    assert.equal(rejected.summary.result, 'configuration_error', bad.join(' '));
  }
});
