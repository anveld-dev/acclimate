#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { toSafeDiagnostic } from '../evaluation/errors.js';
import { serveConnectedLearning } from './connected.js';
import type { ConnectedLearningDriverOptions } from './connected.js';

const usage =
  'acclimate-learning --config /private/evaluator.json --integration UUID --installation ID --apps ./evaluators.mjs [--live]';
const report = (diagnostic: ReturnType<typeof toSafeDiagnostic>) =>
  console.error(JSON.stringify({ schemaVersion: 1, diagnostic }));

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
  const loaded = (await import(pathToFileURL(resolve(values.apps)).href)) as {
    default: ConnectedLearningDriverOptions['apps'];
  };
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await serveConnectedLearning({
      integrationId: values.integration,
      installationId: values.installation,
      configPath: values.config,
      apps: loaded.default,
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
