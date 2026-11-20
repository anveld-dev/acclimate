import { Codex } from '@openai/codex-sdk';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AcclimateClient } from '@acclimate/sdk';
import { prepare } from '@acclimate/codex-plugin';
import type { VerifiedVersion } from '@acclimate/sdk';
import { improve, type Model } from './improvement/workflow.js';
import { improve as improveService } from './service-proposer/workflow.js';

const args = process.argv.slice(2);
const required = (name: string, alias?: string) => {
  const value = process.env[name] ?? (alias ? process.env[alias] : undefined);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const client = () =>
  new AcclimateClient({
    baseUrl: required('ACCLIMATE_URL', 'ACCLIMATE_BASE_URL'),
    token: required('ACCLIMATE_TOKEN'),
    scope: required('ACCLIMATE_SCOPE'),
  });
if (args[0] === 'run' || args[0] === 'run-service') {
  const serviceAuthored = args[0] === 'run-service';
  if (!args.includes('--live'))
    throw new Error(
      serviceAuthored
        ? 'Pass --live to authorize a service proposal and up to four paid Luna reviews'
        : 'Pass --live to authorize one paid Sol draft and up to four paid Luna reviews',
    );
  const authorModel = 'gpt-6.2-sol';
  const reviewModel = process.env.ACCLIMATE_CODEX_MODEL ?? 'gpt-6-luna';
  if (!['gpt-6-luna', 'gpt-5.6-luna'].includes(reviewModel))
    throw new Error('ACCLIMATE_CODEX_MODEL must be gpt-6-luna or gpt-5.6-luna');
  const sdk = JSON.parse(
    await readFile(
      fileURLToPath(new URL('../package.json', import.meta.resolve('@openai/codex-sdk'))),
      'utf8',
    ),
  ) as { version: string };
  const maxTurns = serviceAuthored ? 4 : 5;
  const codex = new Codex();
  let turns = 0;
  const run = async (
    model: string,
    version: VerifiedVersion,
    prompt: string,
    outputSchema: unknown,
  ) => {
    if (++turns > maxTurns) throw new Error('Paid turn limit exceeded');
    const prepared = await prepare(version);
    try {
      const thread = codex.startThread({
        model,
        workingDirectory: prepared.cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
      });
      return await thread.run(
        `${prompt}\n\nRead and apply the prepared skill file(s): ${prepared.skillPaths.join(', ')}.`,
        { signal: AbortSignal.timeout(110_000), outputSchema },
      );
    } finally {
      await prepared.cleanup();
    }
  };
  const model: Model = {
    draft: async (parent, skillPath) => {
      const skill = parent.payload.files.find((f) => f.path === skillPath)!;
      const result = await run(
        authorModel,
        parent,
        `Revise this skill to help a reviewer identify unsafe retries of side-effecting operations. Return the entire replacement skill text, including its original YAML name and a description, in skillText. Make one bounded edit.\n\n${skill.text}`,
        {
          type: 'object',
          properties: { skillText: { type: 'string' } },
          required: ['skillText'],
          additionalProperties: false,
        },
      );
      const parsed: unknown = JSON.parse(result.finalResponse);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        typeof (parsed as { skillText?: unknown }).skillText !== 'string'
      )
        throw new Error('Draft response must contain only skillText');
      return (parsed as { skillText: string }).skillText;
    },
    review: async (version, snapshot) => {
      const result = await run(
        reviewModel,
        version,
        `Use the prepared review skill to review this saved code snapshot. Return only JSON with exactly one boolean field unsafeRetry indicating whether retries can repeat a side effect without an idempotency key.\n\n${snapshot.diff}`,
        {
          type: 'object',
          properties: { unsafeRetry: { type: 'boolean' } },
          required: ['unsafeRetry'],
          additionalProperties: false,
        },
      );
      return {
        text: result.finalResponse,
        usage: result.usage
          ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
          : null,
      };
    },
  };
  const acclimate = client();
  const config = {
    workspace: required('ACCLIMATE_WORKSPACE', 'ACCLIMATE_WORKSPACE_ID'),
    bundle: required('ACCLIMATE_BUNDLE', 'ACCLIMATE_BUNDLE_ID'),
    channel: required('ACCLIMATE_CHANNEL'),
    skillPath: required('ACCLIMATE_SKILL_PATH'),
    outputDir: process.env.ACCLIMATE_OUTPUT_DIR ?? `improvement-${randomUUID()}`,
    model: reviewModel,
    sdkVersion: sdk.version,
  };
  const result = serviceAuthored
    ? await improveService(acclimate, config, model)
    : await improve(acclimate, { ...config, authorModel }, model);
  console.log(JSON.stringify(result, null, 2));
} else throw new Error('Usage: improve-review.ts run --live | run-service --live');
