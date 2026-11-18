import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicPrivateWrite } from '../../scripts/private-state.js';
import { parseEvaluatorArguments } from '../../scripts/evaluate-app.js';
import { fixture, projectId, bundleId, requestId, evaluatorPrincipalId } from './fixture.js';
import { localEvaluationDescriptor } from './tests/descriptors.js';

const identifiers = ['--bundleID', bundleId, '--requestID', requestId];
const required = ['--config', '/absolute/private/evaluator.json', ...identifiers];
const args = [...required, '--adapter', 'codex-luna-review', '--live'];
test('command accepts identifiers and installed names, never a request-selected executable or URL', () => {
  assert.equal(parseEvaluatorArguments(args).adapter, 'codex-luna-review');
  for (const adapter of [
    'payment-retry',
    'presence-contract',
    'https://example.com/executor',
    '../evil.ts',
    'node:child_process',
  ])
    assert.throws(
      () => parseEvaluatorArguments([...required, '--adapter', adapter]),
      /installed allowlisted/,
    );
  assert.throws(
    () => parseEvaluatorArguments([...required, '--adapter', 'codex-luna-review']),
    /explicit --live/,
  );
  assert.equal(
    parseEvaluatorArguments([...required, '--adapter', 'codex-luna-review', '--live']).adapter,
    'codex-luna-review',
  );
  assert.throws(() => parseEvaluatorArguments([...args, '--module', './evil']), /Invalid/);
  assert.throws(() => parseEvaluatorArguments([...args, '--bundleID', bundleId]), /Invalid/);
  assert.throws(
    () => parseEvaluatorArguments(['--bundleID', '../escape', '--requestID', requestId]),
    /Usage/,
  );
});

test('live checkout command refuses a request for a different evaluator before starting work', async () => {
  const stateRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-command-'));
  const f = fixture(localEvaluationDescriptor);
  const token = randomUUID();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const route = req.url ?? '';
      requests.push(route);
      if (route === `/v1/projects/${projectId}/evaluation-capabilities`) {
        assert.equal(req.method, 'GET');
        res.setHeader('cache-control', 'private, no-store');
        return send(200, await f.api.getEvaluationCapabilities(projectId));
      }
      assert.ok(route.startsWith(`/v1/projects/${projectId}/bundles/${bundleId}/`));
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const key = String(req.headers['idempotency-key'] ?? '');
      const bundleRoute = `/v1/projects/${projectId}/bundles/${bundleId}`;
      if (req.method === 'POST') {
        assert.equal(req.headers['x-acclimate-durable-operation'], 'true');
        assert.match(key, /^[\x20-\x7e]{1,128}$/);
      }
      if (req.method === 'GET' && route === `${bundleRoute}/evaluation-requests/${requestId}`)
        return send(200, await f.api.getEvaluation(projectId, bundleId, requestId));
      if (
        req.method === 'POST' &&
        route === `${bundleRoute}/evaluation-requests/${requestId}/start`
      )
        return send(200, await f.api.startEvaluation(projectId, bundleId, requestId, body, key));
      if (req.method === 'POST' && route === `${bundleRoute}/comparisons`)
        return send(201, await f.api.createComparison(projectId, bundleId, body, key));
      if (
        req.method === 'POST' &&
        route === `${bundleRoute}/evaluation-requests/${requestId}/finish`
      )
        return send(200, await f.api.finishEvaluation(projectId, bundleId, requestId, body, key));
      if (
        req.method === 'GET' &&
        f.request.comparisonId &&
        route === `${bundleRoute}/comparisons/${f.request.comparisonId}`
      )
        return send(200, await f.api.getComparison(projectId, bundleId, f.request.comparisonId));
      const match = /\/versions\/([^/]+)(\/payload)?$/.exec(route);
      if (match) {
        if (match[2]) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(f.bytes.get(match[1]));
        }
        return send(200, f.version(match[1]));
      }
      send(404, {});
    } catch {
      send(500, { error: { code: 'fixture', message: 'fixture assertion', requestId: 'fixture' } });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try {
    await atomicPrivateWrite(
      path.join(stateRoot, 'evaluator.json'),
      JSON.stringify({
        schemaVersion: 1,
        serviceUrl: `http://127.0.0.1:${address.port}`,
        projectId,
        evaluatorToken: token,
        evaluatorPrincipalId,
        journalRoot: path.join(stateRoot, 'evaluations'),
      }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('ACCLIMATE_')) delete env[key];
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        path.resolve('scripts/evaluate-app.ts'),
        '--config',
        path.join(stateRoot, 'evaluator.json'),
        ...identifiers,
        '--adapter',
        'codex-luna-review',
        '--live',
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const code = await new Promise((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
    });
    assert.equal(code, 1);
    assert.match(stderr, /mismatch|does not match/);
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
    assert.ok(requests.some((route) => route.endsWith('/evaluation-requests/' + requestId)));
    assert.deepEqual(f.events, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateRoot, { recursive: true, force: true });
  }
});
