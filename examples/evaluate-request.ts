/** Named contract check. The app CLI requires an explicit installed adapter. */
import type { AcclimateClient } from '../packages/sdk/src/index.js';
import { presenceDescriptor } from './evaluation/descriptor.js';
import { presenceAdapter } from './evaluation/payment.js';
import { runEvaluation } from './evaluation/runner.js';

export const fixtureIdentity = presenceDescriptor;

/** Callers own private state and evaluator identity; no ambient cache/config is read. */
export async function evaluateRequest(
  api: AcclimateClient, project: string, bundle: string, id: string,
  state: { journalRoot: string; serviceUrl: string; evaluatorPrincipalId: string },
) {
  return runEvaluation({
    ...state, api, projectId: project, bundleId: bundle, requestId: id, adapter: presenceAdapter,
  });
}
