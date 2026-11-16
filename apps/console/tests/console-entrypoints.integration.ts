import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { consoleEnvironment } from './console-fixture';

const consoleRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));
const built = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Node fetch forbids overriding Host; use a real HTTP request to test the proxy hop. */
function wireRequest(port: number, path: string, method: string, headers: Record<string, string>) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
              responseHeaders.append(name, item);
          resolve(
            new Response(chunks.length ? Buffer.concat(chunks) : null, {
              status: incoming.statusCode!,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTP probe timed out')));
    request.end();
  });
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}
async function start(
  kind: 'built' | 'dev',
  override: Record<string, string | undefined>,
  cwd = consoleRoot,
) {
  const port = await freePort();
  // Avoid ambient credentials and dotenv files: exercise the actual executable directly.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...consoleEnvironment,
    CONSOLE_SESSION_TOKEN: undefined,
    HOST: '127.0.0.1',
    PORT: String(port),
    ...override,
  };
  const child = spawn(
    process.execPath,
    kind === 'built'
      ? [built]
      : [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    output += chunk;
  });
  return { child, port, output: () => output };
}

for (const kind of ['built', 'dev'] as const) {
  test(
    `${kind} executable rejects missing/legacy configuration before listening`,
    { timeout: 30000 },
    async () => {
      if (kind === 'built') await access(built); // Build is an explicit prerequisite for this integration check.
      for (const override of [
        { CONSOLE_LOGIN_TOKEN: undefined },
        { CONSOLE_MODE: 'hosted' },
        { ACCLIMATE_MODE: 'local' },
      ]) {
        const runtime = await start(kind, override);
        let listened = false;
        try {
          for (let elapsed = 0; elapsed < 8000 && runtime.child.exitCode === null; elapsed += 25) {
            try {
              await fetch(`http://127.0.0.1:${runtime.port}/health`, {
                signal: AbortSignal.timeout(100),
              });
              listened = true;
            } catch {
              /* Socket must stay closed. */
            }
            await delay(25);
          }
          assert.equal(
            listened,
            false,
            'invalid configuration must never bind its public listener',
          );
          assert.notEqual(runtime.child.exitCode, null, runtime.output());
          assert.notEqual(runtime.child.exitCode, 0, runtime.output());
          assert.doesNotMatch(runtime.output(), /Listening on|Local:\s+https?:/);
          assert.match(runtime.output(), /CONSOLE_LOGIN_TOKEN|CONSOLE_MODE|ACCLIMATE_MODE/);
          assert.doesNotMatch(runtime.output(), /unit-client|unit-login|unit-console-transport/);
        } finally {
          await stop(runtime.child);
        }
      }
    },
  );

  test(
    `${kind} executable starts with production identity config and exposes process probes`,
    { timeout: 30000 },
    async () => {
      // Use an unused upstream address instead of contacting an ambient local server.
      const upstreamPort = await freePort();
      const runtime = await start(kind, {
        CONSOLE_SERVICE_URL: `http://127.0.0.1:${upstreamPort}`,
      });
      try {
        let health: Response | undefined;
        for (let elapsed = 0; elapsed < 15000; elapsed += 50) {
          assert.equal(runtime.child.exitCode, null, runtime.output());
          try {
            health = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
              signal: AbortSignal.timeout(1000),
            });
            if (health.ok) break;
          } catch {
            /* Startup. */
          }
          await delay(50);
        }
        assert.equal(health?.status, 200, runtime.output());
        assert.deepEqual(await health!.json(), { status: 'ok' });
        const ready = await fetch(`http://127.0.0.1:${runtime.port}/ready`);
        assert.equal(ready.status, 503); // No actual Rust upstream in this entrypoint test.
        const rejected = await wireRequest(runtime.port, '/auth/login', 'GET', {
          host: 'untrusted.example',
          'x-forwarded-host': 'console.example',
          'x-forwarded-proto': 'https',
        });
        assert.ok([400, 403].includes(rejected.status));
      } finally {
        await stop(runtime.child);
      }
    },
  );
  test(
    `${kind} ignores implicit dotenv and accepts the exact configured public hostname`,
    { timeout: 30000 },
    async () => {
      const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'acclimate-console-env-')));
      const project = join(sandbox, 'apps', 'console');
      await mkdir(project, { recursive: true });
      try {
        // Copy config and public source links only; never inspect the operator's actual dotenv files.
        await symlink(
          fileURLToPath(new URL('../../../node_modules', import.meta.url)),
          join(sandbox, 'node_modules'),
          'dir',
        );
        await symlink(
          fileURLToPath(new URL('../../../packages', import.meta.url)),
          join(sandbox, 'packages'),
          'dir',
        );
        await symlink(join(consoleRoot, 'src'), join(project, 'src'), 'dir');
        await symlink(join(consoleRoot, 'public'), join(project, 'public'), 'dir');
        for (const file of ['tsconfig.json', 'package.json'])
          await copyFile(join(consoleRoot, file), join(project, file));
        const copiedConfig = (await readFile(join(consoleRoot, 'vite.config.ts'), 'utf8')).replace(
          'strictPort: true,',
          `strictPort: true, fs: { allow: ${JSON.stringify([fileURLToPath(new URL('../../..', import.meta.url)), sandbox])} },`,
        );
        await writeFile(join(project, 'vite.config.ts'), copiedConfig);
        await writeFile(
          join(project, '.env'),
          'CONSOLE_MODE=local\nVITE_IMPLICIT_ENV_SENTINEL=must-not-load\n',
        );
        await writeFile(
          join(project, '.env.local'),
          'ACCLIMATE_MODE=hosted\nVITE_IMPLICIT_ENV_SENTINEL=must-not-load-local\n',
        );
        await writeFile(join(project, 'dotenv-probe.js'), 'export default import.meta.env;');
        const runtime = await start(
          kind,
          { CONSOLE_ORIGIN: 'https://public-console.example' },
          project,
        );
        try {
          let health: Response | undefined;
          for (let elapsed = 0; elapsed < 15000; elapsed += 50) {
            assert.equal(runtime.child.exitCode, null, runtime.output());
            try {
              health = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
                signal: AbortSignal.timeout(1000),
              });
              if (health.ok) break;
            } catch {
              /* Startup. */
            }
            await delay(50);
          }
          assert.equal(health?.status, 200, runtime.output());
          const logout = await wireRequest(runtime.port, '/auth/logout', 'POST', {
            host: 'public-console.example',
            origin: 'https://public-console.example',
          });
          assert.equal(logout.status, 303, `${await logout.text()}\n${runtime.output()}`);
          if (kind === 'dev') {
            const transformed = await wireRequest(runtime.port, '/dotenv-probe.js', 'GET', {
              host: 'public-console.example',
            });
            const transformedSource = await transformed.text();
            assert.equal(transformed.status, 200, transformedSource);
            assert.doesNotMatch(transformedSource, /must-not-load|VITE_IMPLICIT_ENV_SENTINEL/);
          }
        } finally {
          await stop(runtime.child);
        }
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );
}
