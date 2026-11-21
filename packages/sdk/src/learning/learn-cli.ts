#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiError, AcclimateClient, TransportError } from '../index.js';
import { assertServiceUrl, readEvaluatorConfig } from '../evaluation/config.js';
import { EvaluationError, toSafeDiagnostic } from '../evaluation/errors.js';
import type { EvaluatorConfig } from '../evaluation/types.js';
import { createEvaluatorClient } from '../internal/evaluation-transport.js';
import { findBundle } from '../jobs.js';
import { loadLoop } from './define.js';
import { serveLearningLoop } from './loop.js';
import { streamRounds } from './progress.js';
import { reconcileLoop, resolveAppPrincipal, syncEvolveCases } from './setup.js';

const usage = 'Usage: acclimate learn [--config acclimate.loop.ts] [--evaluator-config evaluator.json] [--once]';

function fromEnv(directory: string): Omit<EvaluatorConfig, 'evaluatorPrincipalId'> {
  const {
    ACCLIMATE_URL: serviceUrl,
    ACCLIMATE_WORKSPACE: workspaceId,
    ACCLIMATE_TOKEN: evaluatorToken,
  } = process.env;
  if (!serviceUrl || !workspaceId || !evaluatorToken)
    throw new Error('Set ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN, or pass --evaluator-config.');
  assertServiceUrl(serviceUrl);
  return {
    schemaVersion: 1, serviceUrl, workspaceId, evaluatorToken,
    journalRoot: path.join(directory, '.acclimate'),
  };
}

async function main(argv: string[]) {
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'learn' && (argv.includes('--help') || argv.includes('-h'))) {
    console.log(usage);
    return;
  }
  if (argv[0] !== 'learn') throw new Error(usage);
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: 'string', default: 'acclimate.loop.ts' },
      'evaluator-config': { type: 'string' },
      once: { type: 'boolean' },
    },
  });
  const filename = await realpath(values.config!);
  const directory = path.dirname(filename);
  let definition;
  try {
    // Node 22.22+ strips erasable TypeScript natively, so a .ts config needs no loader dependency.
    definition = (await import(pathToFileURL(filename).href)).default;
  } catch {
    throw new Error(
      'Cannot load the loop config. Check its default export, module format and imports. ' +
        'A .ts config must use erasable TypeScript only (no enums or namespaces); otherwise use .mjs.',
    );
  }
  const loop = await loadLoop(definition ?? {}, directory);
  const evaluator = values['evaluator-config']
    ? await readEvaluatorConfig(path.resolve(values['evaluator-config']))
    : undefined;
  const connection = evaluator ?? fromEnv(directory);
  const { workspaceId } = connection;
  const enrollmentToken = process.env.ACCLIMATE_ENROLL_TOKEN;
  const identityClient = new AcclimateClient({
    baseUrl: connection.serviceUrl, token: connection.evaluatorToken, scope: workspaceId,
  });
  const evaluatorPrincipalId = await resolveAppPrincipal(identityClient, workspaceId, {
    explicit: process.env.ACCLIMATE_APP_PRINCIPAL || evaluator?.evaluatorPrincipalId,
    separateEnrollment: Boolean(enrollmentToken),
  });
  const config = { ...connection, evaluatorPrincipalId };
  const client = createEvaluatorClient(config);
  const { id: bundleId } = await findBundle(client, workspaceId, loop.bundle);
  const enrollment = enrollmentToken
    ? new AcclimateClient({ baseUrl: config.serviceUrl, token: enrollmentToken, scope: 'learn-enrollment' })
    : client;
  const current = await reconcileLoop(client, workspaceId, bundleId, {
    channel: loop.channel, setting: loop.setting, appPrincipalId: evaluatorPrincipalId, heldOut: loop.commitment,
  }, enrollment);
  // A running loop starts a round as soon as it has live cases. Pause it while a multi-request sync
  // writes, so no round pins a partial evolve revision; resume only a loop this command paused.
  let paused = false;
  try {
    await syncEvolveCases(client, workspaceId, bundleId, loop.evolve, async () => {
      if (current.status !== 'running') return;
      await enrollment.pauseLearningLoop(workspaceId, bundleId);
      paused = true;
    });
  } finally {
    if (paused) await enrollment.resumeLearningLoop(workspaceId, bundleId);
  }

  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  let activeRound = current.activeRound?.id;
  const running = [
    serveLearningLoop({
      config, bundleId, app: loop.app, allowLive: loop.live, caseConcurrency: loop.caseConcurrency,
      signal: stop.signal, shouldServeRound: values.once ? roundId => roundId === activeRound : undefined,
      onDiagnostic: diagnostic => console.error(JSON.stringify(diagnostic)),
    }),
    streamRounds(client, workspaceId, bundleId, (current.activeRound?.number ?? current.nextRound) - 1,
      Boolean(values.once), stop.signal, line => console.log(line), id => { activeRound = id; }),
  ];
  try {
    await Promise.race(running);
  } finally {
    abort();
    await Promise.allSettled(running);
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof ApiError ? `Service request failed (${error.status} ${error.code}).`
    : error instanceof EvaluationError || error instanceof TransportError
      ? JSON.stringify(toSafeDiagnostic(error, 'configure'))
      : error instanceof Error ? error.message : 'Learning setup failed.';
  console.error(message);
  process.exitCode = 1;
}
