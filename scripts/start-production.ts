/** Explicit process startup. No database provisioning, private-state lookup or secret generation. */
import { spawn } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConsoleConfiguration } from '../apps/console/src/server/configuration.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function startupCommand(target: string, env: NodeJS.ProcessEnv = process.env) {
  if (target === 'service') {
    const binary = env.ACCLIMATE_SERVICE_BINARY ?? resolve(root, 'target/release/acclimate-service');
    if (!isAbsolute(binary)) throw new Error('ACCLIMATE_SERVICE_BINARY must be an absolute path.');
    // The Rust executable owns its single configuration validation and startup migration.
    return { command: binary, args: [], cwd: root, env };
  }
  if (!['console', 'dev', 'check'].includes(target))
    throw new Error('Usage: start-production.ts service|console|dev|check');
  assertConsoleConfiguration(env);
  const host = env.HOST ?? '127.0.0.1';
  const port = env.PORT ?? '3100';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('PORT must be an integer between 1 and 65535.');
  return {
    command: process.execPath,
    args: target === 'dev'
      ? [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', host, '--port', port, '--strictPort']
      : [resolve(root, 'apps/console/.output/server/index.mjs')],
    cwd: resolve(root, 'apps/console'),
    env: { ...env, HOST: host, PORT: port },
  };
}

class ProcessExitError extends Error {
  constructor(readonly exitCode: number) {
    super('Process exited unsuccessfully; inspect its startup diagnostic above.');
  }
}

export async function main(target = process.argv[2]) {
  const command = startupCommand(target);
  if (target === 'check') {
    console.log('Console configuration is valid. No process started.');
    return;
  }
  const child = spawn(command.command, command.args, {
    cwd: command.cwd, env: command.env, stdio: 'inherit',
  });
  const signal = (name: NodeJS.Signals) => child.kill(name);
  const interrupt = () => signal('SIGINT');
  const terminate = () => signal('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Process could not start. Build the required runtime artifact first.')));
      child.once('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') resolve();
        else reject(new ProcessExitError(code ?? 1));
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Authored validator diagnostics contain field names, never their values.
    console.error(error instanceof Error ? error.message : 'Startup failed.');
    process.exitCode = error instanceof ProcessExitError ? error.exitCode : 1;
  });
}
