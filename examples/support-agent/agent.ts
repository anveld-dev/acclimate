/**
 * Answer one support request with the released bundle, and optionally record a correction.
 *
 *   npx tsx examples/support-agent/agent.ts "I was charged twice this month."
 *   npx tsx examples/support-agent/agent.ts "I was charged twice this month." --expected corrected.txt
 */
import { readFile } from 'node:fs/promises';
import { ApiError, createAcclimate } from '@acclimate/sdk';
import { systemPrompt } from './prompt.js';

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

async function complete(system: string, request: string): Promise<string> {
  const response = await fetch(`${setting('OPENAI_BASE_URL').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${setting('OPENAI_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: setting('AGENT_MODEL'),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: request },
      ],
    }),
  });
  if (!response.ok) throw new Error(`The model provider answered ${response.status}.`);
  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}

const [request, flag, expectedPath] = process.argv.slice(2);
if (!request || (flag !== undefined && (flag !== '--expected' || !expectedPath))) {
  throw new Error('Usage: agent.ts "REQUEST" [--expected FILE]');
}

// Reads ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.
const acclimate = createAcclimate();

// Pin the released version for this job. Every job re-reads the channel, so a release made by
// the learning loop reaches the next job without a deploy.
const job = await acclimate.job(process.env.ACCLIMATE_BUNDLE_NAME ?? 'Example agent', {
  channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
  input: request,
});
const reply = await complete(systemPrompt(job.version.payload), request);
console.log(reply);
// Keep the version with the result, so you can tell later which instructions produced it.
console.error(`\nAnswered with version ${job.version.version.id} (${job.version.version.digest}).`);

if (expectedPath) {
  // A person corrected the reply. Report what it should have been. The request becomes a learning
  // task, graded against criteria the judge model drafts from the corrected reply.
  const expected = (await readFile(expectedPath, 'utf8')).trim();
  let receipt;
  try {
    receipt = await job.expect(expected, { output: reply, grading: 'criteria' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new Error('Learning is not set up for this bundle. Save its settings on the Learning tab first.');
    }
    throw error;
  }
  // The service chooses the split. A held-out task waits for a person to confirm its criteria.
  const split = receipt.taskId ? 'an evolve task' : 'a held-out task, to confirm on the Learning tab';
  console.error(`Recorded the correction as outcome ${job.outcomeId}. It becomes ${split}.`);
}
