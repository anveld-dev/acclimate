#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EvaluationError, toSafeDiagnostic } from '../evaluation/errors.js';
import { serveConnectedLearning } from './connected.js';
import type { ConnectedLearningDriverOptions } from './connected.js';

const usage =
  'acclimate-learning --config /private/evaluator.json --integration UUID --installation ID --apps ./evaluators.mjs [--live]';
const startupHints: Partial<Record<ReturnType<typeof toSafeDiagnostic>['code'], string>> = {
  'learning.apps_module_missing':
    'Point --apps at the compiled evaluator module in this installation.',
  'learning.apps_module_load_failed':
    'Check that the --apps module and its imports load in this Node installation.',
  'learning.apps_invalid_export':
    'Default-export { development, audit: [...] } using evaluations created by defineEvaluation from the installed SDK. Optional replay hooks must be functions.',
};
function report(diagnostic: ReturnType<typeof toSafeDiagnostic>) {
  const hint = startupHints[diagnostic.code];
  console.error(JSON.stringify({ schemaVersion: 1, diagnostic, ...(hint ? { hint } : {}) }));
}

async function loadApps(path: string): Promise<ConnectedLearningDriverOptions['apps']> {
  const filename = resolve(path);
  try {
    if (!(await stat(filename)).isFile()) throw new EvaluationError('learning.apps_module_missing');
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new EvaluationError('learning.apps_module_missing');
    throw new EvaluationError('learning.apps_module_load_failed');
  }
  try {
    return (await import(pathToFileURL(filename).href)).default;
  } catch {
    throw new EvaluationError('learning.apps_module_load_failed');
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      integration: { type: 'string' },
      installation: { type: 'string' },
      apps: { type: 'string' },
      live: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.config || !values.integration || !values.installation || !values.apps) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  // Load only the local application module explicitly selected by the operator.
  const apps = await loadApps(values.apps);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await serveConnectedLearning({
      integrationId: values.integration,
      installationId: values.installation,
      configPath: values.config,
      apps,
      allowLive: values.live,
      signal: stop.signal,
      onDiagnostic: report,
    });
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

main().catch((error) => {
  report(toSafeDiagnostic(error));
  process.exitCode = 1;
});
