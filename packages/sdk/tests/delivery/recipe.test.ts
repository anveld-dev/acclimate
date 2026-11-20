import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'read pinned content' }],
  }),
);
const version = {
  id: 'v',
  bundleId: 'b',
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  parentVersionId: null,
  createdAt: '2026-11-14',
};

for (const reporting of ['disabled', 'healthy', 'denied', 'stalled'] as const) {
  test(`TS delivery check reads staged files with ${reporting} optional reporting`, async () => {
    const events: any[] = [];
    const identities: string[] = [];
    const server = createServer((req, res) => {
      identities.push(req.headers.authorization!);
      if (req.url!.endsWith('/receipts')) {
        assert.equal(req.headers.authorization, 'Bearer receipt-only');
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          if (reporting === 'stalled') return;
          if (reporting === 'denied') {
            res.writeHead(403);
            res.end('{}');
            return;
          }
          events.push(JSON.parse(body));
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        });
      } else {
        assert.equal(req.headers.authorization, 'Bearer read-only');
        res.end(
          req.url!.endsWith('/payload')
            ? bytes
            : JSON.stringify({ channel: 'stable', revision: '1', version }),
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-recipe-'));
    try {
      const env = {
        ...process.env,
        ACCLIMATE_URL: `http://127.0.0.1:${port}`,
        ACCLIMATE_TOKEN: 'read-only',
        ACCLIMATE_SCOPE: 'test-app',
        ACCLIMATE_WORKSPACE: 'p',
        ACCLIMATE_BUNDLE: 'b',
        ACCLIMATE_CHANNEL: 'stable',
        ACCLIMATE_CACHE: join(dir, 'cache'),
        ACCLIMATE_JOB_DIR: join(dir, 'job'),
        ACCLIMATE_RECEIPT_TOKEN: '',
        ACCLIMATE_CONNECTION: '',
      };
      if (reporting !== 'disabled') {
        env.ACCLIMATE_RECEIPT_TOKEN = 'receipt-only';
        env.ACCLIMATE_CONNECTION = 'i';
      }
      const child = spawn(process.execPath, ['--import', 'tsx', 'examples/delivery-check.ts'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        errors = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (errors += chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        const deadline = (message: string, ms: number) =>
          setTimeout(() => {
            child.kill();
            reject(new Error(message));
          }, ms);
        let timer = deadline('Recipe did not finish preparing files', 30000);
        // Measure optional-reporting shutdown after delivery, independently of tsx startup.
        child.stdout.once('data', () => {
          clearTimeout(timer);
          timer = deadline('Recipe exceeded its optional reporting deadline', 5000);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(code, 0, errors);
      assert.equal(JSON.parse(output).checkedFiles, 1);
      assert.equal(JSON.parse(output).started, undefined);
      assert.equal(JSON.parse(output).digest, version.digest);
      assert.deepEqual(await readdir(join(dir, 'job')), []);
      if (reporting === 'healthy') {
        assert.deepEqual(
          events.map((e) => e.stage),
          ['resolved', 'downloaded', 'verified', 'prepared'],
        );
        assert(events.every((e) => e.versionId === 'v' && !('content' in e)));
      } else assert.deepEqual(events, []);
      if (reporting === 'disabled') assert(identities.every((auth) => auth === 'Bearer read-only'));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { force: true, recursive: true });
    }
  });
}
