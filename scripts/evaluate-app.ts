import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcclimateClient } from '../packages/sdk/src/index.js';
import { EvaluatorConfigError, readEvaluatorConfig } from './evaluator-config.js';
import { runEvaluation } from '../examples/evaluation/runner.js';
import { paymentAdapter, presenceAdapter } from '../examples/evaluation/payment.js';
import { codexLunaAdapter } from '../examples/service-proposer/evaluation-adapter.js';

const usage = 'Usage: npm run evaluate:app -- --config /absolute/private/config.json --bundleID UUID --requestID UUID --adapter payment-retry|presence-contract|codex-luna-review [--live]';

export function parseEvaluatorArguments(args: string[]) {
  const values: Record<string, string> = {};
  let live = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--live' && !live) { live = true; continue; }
    if (!['--config', '--bundleID', '--requestID', '--adapter'].includes(name) || name in values ||
        !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid evaluator arguments. ' + usage);
    values[name] = args[++i];
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!path.isAbsolute(values['--config'] ?? '') || !uuid.test(values['--bundleID'] ?? '') || !uuid.test(values['--requestID'] ?? '') || !values['--adapter'])
    throw new Error(usage);
  const adapter = values['--adapter'];
  if (!['payment-retry', 'presence-contract', 'codex-luna-review'].includes(adapter))
    throw new Error('Adapter must be an installed allowlisted adapter name');
  if ((adapter === 'codex-luna-review') !== live)
    throw new Error('The installed codex-luna-review adapter requires explicit --live; model-free adapters do not accept --live');
  return { bundleId: values['--bundleID'], requestId: values['--requestID'], configPath: values['--config'], adapter };
}

export async function evaluateApp(args: string[]) {
  const parsed = parseEvaluatorArguments(args);
  const config = await readEvaluatorConfig(parsed.configPath);
  const adapter = parsed.adapter === 'payment-retry' ? paymentAdapter :
    parsed.adapter === 'presence-contract' ? presenceAdapter : await codexLunaAdapter();
  const api = new AcclimateClient({ baseUrl: config.serviceUrl, token: config.evaluatorToken, scope: 'app-evaluator' });
  return runEvaluation({ ...config, api, adapter, bundleId: parsed.bundleId, requestId: parsed.requestId });
}

export function evaluatorErrorMessage(error: unknown): string {
  if (error instanceof EvaluatorConfigError) return error.message;
  const message = error instanceof Error && !('status' in error) ? error.message : '';
  const allowed = new Set([usage, 'Invalid evaluator arguments. ' + usage,
    'Adapter must be an installed allowlisted adapter name',
    'The installed codex-luna-review adapter requires explicit --live; model-free adapters do not accept --live',
    'Another evaluator process owns this request; no execution was started here',
    'Execution started without a complete saved report; interrupt this request and create a new request',
    'Request does not match installed fixture/application configuration',
    'Running request has no local journal; interrupt it and create a new request',
    'Request was interrupted; create a new evaluation request',
    'Evaluator journal root changed; restore the original private journal root before recovery',
    'Request belongs to a different evaluator or attempt',
    'Evaluator did not confirm ownership of the running attempt']);
  return allowed.has(message) ? message : 'Evaluation was not confirmed. Inspect the request and private journal before retrying.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  evaluateApp(process.argv.slice(2)).then((request) => {
    console.log(JSON.stringify({ requestId: request.id, status: request.status, comparisonId: request.comparisonId }));
  }).catch((error: unknown) => {
    console.error(evaluatorErrorMessage(error));
    process.exitCode = 1;
  });
}
