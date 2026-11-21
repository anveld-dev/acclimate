import { AcclimateClient } from '../client.js';
import type { EvaluatorConfig } from '../evaluation/types.js';

export function createEvaluatorClient(config: EvaluatorConfig): AcclimateClient {
  return new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.evaluatorToken,
    scope: config.evaluatorPrincipalId,
  });
}
