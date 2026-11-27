/**
 * Answer one support request with the released bundle.
 *
 *   npx tsx examples/support-agent/agent.ts "I was charged twice this month."
 */
import { createAcclimate, systemPrompt } from '@anveld/acclimate-sdk';

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

const [request, extra] = process.argv.slice(2);
if (!request || extra !== undefined) {
  throw new Error('Usage: agent.ts "REQUEST"');
}

// Reads ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.
const acclimate = createAcclimate();

// Pin the released version for this job. Every job re-reads the channel, so a release made by
// the learning loop reaches the next job without a deploy.
const job = await acclimate.job(process.env.ACCLIMATE_BUNDLE_NAME ?? 'Example agent', {
  channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
});
// Send the bundle as the learning loop does, so the loop scores the prompt this job runs with.
const reply = await complete(systemPrompt(job.version.payload), request);
console.log(reply);
// Keep the version with the result, so you can tell later which instructions produced it.
console.error(`\nAnswered with version ${job.version.version.id} (${job.version.version.digest}).`);
