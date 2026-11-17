import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BundlePayload, VerifiedBundle } from '@acclimate/sdk';
import {
  textDigest,
  type LearningOperation,
  type LearnerView,
  type MutationOperation,
} from '@acclimate/sdk/learning';
import { payload, retrySkill, type Decision } from './domain.js';
import {
  GroundedAbstentionError,
  groundedExecution,
  readGroundedPolicy,
  type GroundedState,
} from './live-grounded.js';
import {
  callLiveModel,
  liveModels,
  liveModelBudgetProfiles,
  liveModelMaximumCalls,
  type LiveModelBudgetProfile,
  type LiveModelRole,
  type LiveModelResult,
} from './live-model.js';

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const proposalSchema = object({
  retrySkill: { type: ['string', 'null'] },
  reconciliationInstruction: { type: ['string', 'null'] },
  reconciliationSkill: { type: ['string', 'null'] },
  rationale: { type: 'string' },
});
const decisionSchema = object({
  action: {
    type: 'string',
    enum: ['accept', 'reuse-original-key', 'reconcile-then-retry', 'fresh-key'],
  },
  key: { type: 'string' },
});

export function liveCampaignIsSettled(view: Pick<LearnerView, 'phase' | 'nextAction'>) {
  return (
    view.phase === 'finished' ||
    view.phase === 'needs-reconciliation' ||
    [
      'audit-failed',
      'audit-refresh-required',
      'budget-exhausted',
      'round-limit',
      'waiting-for-outcomes',
    ].includes(view.nextAction)
  );
}

export function liveBaseline(): BundlePayload {
  const baseline = payload('initial');
  return {
    ...baseline,
    files: baseline.files.map((file) =>
      file.path === retrySkill
        ? {
            ...file,
            text: '---\nname: retry-review\ndescription: Decide a safe response to a fictional payment incident.\n---\nFor a clean incident, accept it using its original request key. After any failure use a fresh key by appending -new to the original request key.\n',
          }
        : file,
    ),
  };
}

export function liveExecution(output: string, { budgetProfile }: {
  budgetProfile?: LiveModelBudgetProfile;
} = {}) {
  const artifactRoot = path.join(output, 'model-turns');
  const modelAttempts = new Map<
    string,
    { role: LiveModelRole; model: string; usage: LiveModelResult['usage'] }
  >();
  async function turn(
    role: LiveModelRole,
    label: string,
    prompt: string,
    schema: Record<string, unknown>,
    reconcile = false,
  ) {
    const callId = createHash('sha256').update(label).digest('hex');
    const appRoot = path.join(output, 'workspaces', callId);
    await mkdir(appRoot, { recursive: true, mode: 0o700 });
    const inputs = path.join(artifactRoot, 'inputs');
    await mkdir(inputs, { recursive: true, mode: 0o700 });
    const inputPath = path.join(inputs, callId + '.json');
    const input = JSON.stringify({ label, role, model: liveModels[role], prompt }) + '\n';
    try {
      await writeFile(inputPath, input, { flag: 'wx', mode: 0o600, flush: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assert.equal(await readFile(inputPath, 'utf8'), input);
    }
    const options = {
      appRoot,
      artifactRoot,
      callId,
      prompt,
      schema,
      role,
      maxCalls: budgetProfile === undefined
        ? liveModelMaximumCalls
        : liveModelBudgetProfiles[budgetProfile],
      budgetProfile,
    };
    const result = reconcile
      ? await callLiveModel({ ...options, reconcileOnly: true })
      : await callLiveModel(options);
    if (!result) return;
    modelAttempts.set(label, { role, model: result.model, usage: result.usage });
    return { json: JSON.parse(result.text) as unknown, usage: result.usage };
  }
  return {
    modelAttempts,
    async propose(
      operation: Readonly<LearningOperation>,
      baseline: VerifiedBundle,
      reconcile: boolean,
    ) {
      if (readGroundedPolicy(baseline.payload))
        throw new Error('The live learning proposer does not support grounded payment policy bundles');
      assert(operation.admission && operation.teaching.length === 1);
      assert.equal(operation.auditCohort, null);
      const result = await turn(
        'proposer',
        'proposal/' + operation.id,
        [
          'Author instructions for a fictional payment simulation. Implement only the authorized correction. Preserve existing behavior outside its stated condition, including clean and any other uncorrected incident. No payments are ever executed.',
          'Return the full retry-review SKILL.md body and YAML frontmatter in retrySkill if editing that skill. Preserve its existing frontmatter. Use null where no edit is needed.',
          'If the correction requires reconciliation, author a dedicated skill from scratch in reconciliationSkill. Its valid SKILL.md begins with YAML frontmatter, name: reconcile-request, and a description. Write the full instruction in reconciliationInstruction that AGENTS.md will append to select the skill at skills/reconcile-request/SKILL.md. Both fields must be null if not creating this skill.',
          'Prefer the smallest sufficient scoped instruction change. Stay under 750 UTF-8 bytes of new text across all files. Explain your edits briefly in rationale.',
          'The simulator supports accept, fresh-key (append -new), reuse-original-key, and reconcile-then-retry (use original key). Write human-readable policies. Do not use configuration markers or programming code.',
          JSON.stringify({
            currentBundle: baseline.payload,
            authorizedCorrection: operation.teaching,
            priorDevelopment: operation.proposalHistory ?? [],
          }),
        ].join('\n'),
        proposalSchema,
        reconcile,
      );
      if (!result) return;
      const proposal = result.json as {
        retrySkill: string | null;
        reconciliationInstruction: string | null;
        reconciliationSkill: string | null;
        rationale: string;
      };
      assert(typeof proposal.rationale === 'string' && proposal.rationale.length > 0);
      assert.equal(
        proposal.reconciliationInstruction === null,
        proposal.reconciliationSkill === null,
      );
      const operations: MutationOperation[] = [];
      const file = baseline.payload.files.find((item) => item.path === retrySkill)!;
      if (proposal.retrySkill !== null && file.text !== proposal.retrySkill)
        operations.push({
          op: 'editText',
          file: { path: file.path, kind: file.kind, textDigest: textDigest(file.text) },
          replacements: [{ oldText: file.text, newText: proposal.retrySkill }],
        });
      if (proposal.reconciliationInstruction !== null && proposal.reconciliationSkill !== null) {
        const root = baseline.payload.files.find((item) => item.path === 'AGENTS.md')!;
        operations.push(
          {
            op: 'editText',
            file: { path: root.path, kind: root.kind, textDigest: textDigest(root.text) },
            replacements: [
              {
                oldText: root.text,
                newText: root.text + '\n' + proposal.reconciliationInstruction,
              },
            ],
          },
          {
            op: 'createSkill',
            name: 'reconcile-request',
            files: [{ relativePath: 'SKILL.md', text: proposal.reconciliationSkill }],
          },
        );
      }
      return { operations, rationale: proposal.rationale };
    },
    async execute<T extends { signal: unknown; requestKey: string }>(
      content: BundlePayload,
      input: T,
      label: string,
    ): Promise<{
      output: Decision;
      usage: LiveModelResult['usage'];
      classification?: GroundedState;
    }> {
      const policy = readGroundedPolicy(content);
      if (policy) {
        let usage: LiveModelResult['usage'] | undefined;
        const decision = await groundedExecution(policy, input, async (prompt, schema) => {
          try {
            const inferred = await turn('harness', label, prompt, schema);
            assert(inferred);
            usage = inferred.usage;
            return inferred.json;
          } catch (error) {
            if (error instanceof SyntaxError) throw new GroundedAbstentionError('malformed');
            throw error;
          }
        });
        assert(usage);
        return { ...decision, usage };
      }
      const resultTurn = await turn(
        'harness',
        label,
        [
          'Simulate exactly one fictional incident. Use only the delivered instruction files and their declarative settings. Apply the policy even when another action would be advisable in a real system. Never execute a payment.',
          'Decode checkout: 200 clean, 504 response lost, 503 confirmed pre-charge. Decode mobile-receipt: received clean, no-reply response lost, offline confirmed pre-charge. Decode batch-import: S clean, U response lost, R confirmed pre-charge. Decode operator-console: confirmed is clean; otherwise reachedProcessor is response lost and the remaining case is confirmed pre-charge.',
          'When AGENTS.md selects another delivered skill for an incident, follow that more specific skill. Map the delivered policy to one of the allowed output action values.',
          'For fresh-key append -new to the request key. For all other actions use the exact request key.',
          JSON.stringify({
            deliveredFiles: content.files,
            incident: { signal: input.signal, requestKey: input.requestKey },
          }),
        ].join('\n'),
        decisionSchema,
      );
      assert(resultTurn);
      const result = resultTurn.json as Decision;
      assert(
        ['accept', 'reuse-original-key', 'reconcile-then-retry', 'fresh-key'].includes(
          result.action,
        ),
      );
      assert.equal(typeof result.key, 'string');
      return { output: result, usage: resultTurn.usage };
    },
  };
}
