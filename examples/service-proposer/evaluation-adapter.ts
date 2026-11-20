import type { InstalledAdapter } from '../evaluation/adapter.js';
import { nativeReviewDescriptor } from '../evaluation/descriptor.js';
import { cases } from './dataset.js';
import { gradeFinding } from './grader.js';
import type { Model } from './workflow.js';
import { withNativeSessionInputs } from '../native-session-lifetime.js';

/** Shares installed snapshots and the independent rubric with the native proposal example. */
export function nativeReviewAdapter(model: Model, { wiringOnly = false } = {}): InstalledAdapter {
  const descriptor = structuredClone(nativeReviewDescriptor);
  if (wiringOnly) {
    descriptor.runtime.model = 'fake-native-review';
    descriptor.runtime.configId = 'native-review-wiring-test';
    descriptor.runtime.app = 'native-review-wiring-test';
  }
  return {
    describe: () => structuredClone(descriptor),
    cases,
    execute: async ({ version, snapshot }) => {
      const response = await model.review(version, snapshot as { diff: string });
      return { output: response.text, usage: response.usage };
    },
    grade: async ({ output, caseId }) => gradeFinding(caseId, output as string),
  };
}

/** Construction makes no paid call; selecting this adapter requires explicit live opt-in. */
export async function codexLunaAdapter(): Promise<InstalledAdapter> {
  const [{ Codex }, { prepare }] = await Promise.all([
    import('@openai/codex-sdk'),
    import('@acclimate/codex-plugin'),
  ]);
  const codex = new Codex();
  let turns = 0;
  return nativeReviewAdapter({
    review: async (version, snapshot) => {
      if (++turns > 4) throw new Error('Installed Luna adapter turn limit exceeded');
      const prepared = await prepare(version);
      return withNativeSessionInputs(prepared, async () => {
        const thread = codex.startThread({
          model: 'gpt-6-luna',
          modelReasoningEffort: 'low',
          workingDirectory: prepared.cwd,
          skipGitRepoCheck: true,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          webSearchMode: 'disabled',
        });
        const result = await thread.run(
          `Read and apply the prepared skill files: ${prepared.skillPaths.join(', ')}.\n` +
            'Review the saved code snapshot. Return only JSON with exactly one boolean field unsafeRetry, ' +
            'indicating whether retries can repeat a side effect without an idempotency key.\n\n' +
            snapshot.diff,
          {
            signal: AbortSignal.timeout(110_000),
            outputSchema: {
              type: 'object',
              properties: { unsafeRetry: { type: 'boolean' } },
              required: ['unsafeRetry'],
              additionalProperties: false,
            },
          },
        );
        return {
          text: result.finalResponse,
          usage: result.usage
            ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
            : null,
        };
      });
    },
  });
}
