import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { runExistingAgent } from './agent.mjs';

export const configId = 'installed-qualification-worker';
const agentBytes = await readFile(new URL('./agent.mjs', import.meta.url));
export const runtime = {
  settings: { app: 'payment-retry-qualification' },
  artifacts: { app: 'sha256:' + createHash('sha256').update(agentBytes).digest('hex') },
};
export async function execute({ version, input, signal }) {
  await appendFile(new URL('./executions.log', import.meta.url), 'executed\n', { mode: 0o600 });
  const output = await runExistingAgent({ version, task: input, signal });
  return { output, usage: { costUsd: 0 } };
}
export async function grade({ output, expected }) {
  const singleCharge = output.charges === expected.charges;
  const succeeded = output.succeeded === expected.succeeded;
  return { reward: Number(singleCharge && succeeded), explanation: { singleCharge, succeeded } };
}
export const grader = { sourceUtf8: grade.toString() };
export async function toReviewArtifact({ identity, value }) {
  return { mediaType: 'application/json', value: identity.role === 'output'
    ? { charges: value.charges, succeeded: value.succeeded }
    : { singleCharge: value.singleCharge, succeeded: value.succeeded } };
}
