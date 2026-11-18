import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcclimateClient } from '../packages/sdk/src/index.js';
import { EvaluatorConfigError, readEvaluatorConfig } from './evaluator-config.js';
import { runEvaluation } from '../examples/evaluation/runner.js';
import { nativeReviewDescriptor } from '../examples/evaluation/descriptor.js';
import { codexLunaAdapter } from '../examples/service-proposer/evaluation-adapter.js';
import { evaluationCheckMain } from '../packages/sdk/src/evaluation/cli.js';
import { EvaluationError } from '../packages/sdk/src/evaluation/errors.js';

const usage =
  'Usage: npm run evaluate:app -- --config /absolute/private/config.json --bundleID UUID --requestID UUID --adapter codex-luna-review --live';

export function parseEvaluatorArguments(args: string[]) {
  const values: Record<string, string> = {};
  let live = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--live' && !live) {
      live = true;
      continue;
    }
    if (
      !['--config', '--bundleID', '--requestID', '--adapter'].includes(name) ||
      name in values ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('Invalid evaluator arguments. ' + usage);
    values[name] = args[++i];
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !path.isAbsolute(values['--config'] ?? '') ||
    !uuid.test(values['--bundleID'] ?? '') ||
    !uuid.test(values['--requestID'] ?? '') ||
    !values['--adapter']
  )
    throw new Error(usage);
  const adapter = values['--adapter'];
  if (adapter !== 'codex-luna-review')
    throw new Error('Adapter must be an installed allowlisted adapter name');
  if (!live) throw new Error('The installed codex-luna-review adapter requires explicit --live');
  return {
    bundleId: values['--bundleID'],
    requestId: values['--requestID'],
    configPath: values['--config'],
    adapter,
  };
}

export async function evaluateApp(args: string[]) {
  const parsed = parseEvaluatorArguments(args);
  const config = await readEvaluatorConfig(parsed.configPath);
  const adapter = await codexLunaAdapter();
  const api = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.evaluatorToken,
    scope: 'app-evaluator',
  });
  return runEvaluation({
    ...config,
    api,
    adapter,
    bundleId: parsed.bundleId,
    requestId: parsed.requestId,
  });
}

export function evaluatorErrorMessage(error: unknown): string {
  if (error instanceof EvaluationError && !(error instanceof EvaluatorConfigError))
    return JSON.stringify({ schemaVersion: 1, error: error.diagnostic });
  if (error instanceof EvaluatorConfigError) return error.message;
  const message = error instanceof Error && !('status' in error) ? error.message : '';
  const allowed = new Set([
    usage,
    'Invalid evaluator arguments. ' + usage,
    'Adapter must be an installed allowlisted adapter name',
    'The installed codex-luna-review adapter requires explicit --live',
    'Another evaluator process owns this request; no execution was started here',
    'Execution started without a complete saved report; interrupt this request and create a new request',
    'Request does not match installed fixture/application configuration',
    'Running request has no local journal; interrupt it and create a new request',
    'Request was interrupted; create a new evaluation request',
    'Evaluator journal root changed; restore the original private journal root before recovery',
    'Request belongs to a different evaluator or attempt',
    'Evaluator did not confirm ownership of the running attempt',
  ]);
  return allowed.has(message)
    ? message
    : 'Evaluation was not confirmed. Inspect the request and private journal before retrying.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === 'describe') {
    console.log(JSON.stringify(nativeReviewDescriptor, null, 2));
  } else if (process.argv[2] === 'check') {
    process.exitCode = await evaluationCheckMain(nativeReviewDescriptor, process.argv.slice(2));
  } else {
    evaluateApp(process.argv.slice(2))
      .then((request) => {
        console.log(
          JSON.stringify({
            requestId: request.id,
            status: request.status,
            comparisonId: request.comparisonId,
          }),
        );
        process.exitCode = request.status === 'completed' ? 0 : request.status === 'failed' ? 2 : 3;
      })
      .catch((error: unknown) => {
        console.error(evaluatorErrorMessage(error));
        process.exitCode = 1;
      });
  }
}
