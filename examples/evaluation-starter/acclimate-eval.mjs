import { pathToFileURL } from 'node:url';
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import { evaluationMain } from '@acclimate/sdk/evaluation/cli';
import { runExistingAgent } from './agent.mjs';
import { cases, gradeResult } from './cases.mjs';

export const app = defineEvaluation({
  configId: 'installed-payment-starter', configRevision: '1',
  datasetRevision: 'payment-response-fixtures-1', graderRevision: 'single-charge-result-1',
  runtime: { app: 'payment-starter-1', model: 'none', writes: 'in-memory-only' },
  execution: 'model-free',
  cases,
  execute: async ({ bundle, input, signal }) => ({
    output: await runExistingAgent({ bundle, task: input, signal }),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  }),
  grade: async ({ output, expected }) => gradeResult(output, expected),
});

export const review = {
  toReviewArtifact: async ({ identity, value }) => ({
    mediaType: 'application/json',
    value: identity.role === 'output'
      ? { charges: value.charges, succeeded: value.succeeded }
      : { singleCharge: value.singleCharge, succeeded: value.succeeded },
  }),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await evaluationMain(app, process.argv.slice(2), { review });
