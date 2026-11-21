import { appendFile } from 'node:fs/promises';
import type { LearningLoopApp } from '../../packages/sdk/src/learning/index.js';
import { setTimeout as delay } from 'node:timers/promises';

export const improvement = 'Verify the requested result.';
export const interruption = 'Check spelling.';
export const heldOutScore = 0.123046875;
export const heldOut = [
  { caseId: 'private-held-out-success', input: 'private-input-success', expected: 'private-grade' },
  { caseId: 'private-held-out-error', input: 'private-input-error', expected: 'private-error' },
];

export default {
  execution: 'model-free',
  heldOut,
  async execute({ instructions, caseId, input, rollout, signal, version }) {
    await appendFile(
      process.env.LEARNING_FIXTURE_EXECUTIONS!,
      JSON.stringify({
        versionId: version.version.id,
        caseId,
        rollout,
      }) + '\n',
    );
    if (instructions.includes(interruption) && caseId === 'fixable' && rollout === 2) {
      // The harness restarts both processes with two completed and one started
      // rollout in this case, before any result for it reaches the service.
      await delay(60_000, undefined, { signal });
      throw new Error('Restart checkpoint was not reached');
    }
    if (input === heldOut[1].input) throw new Error('private execution error');
    return {
      output: instructions.split('\n').includes(improvement),
      trace: input === heldOut[0].input ? 'private execution trace' : 'public evolve trace',
    };
  },
  grade({ output, expected }) {
    if (expected === heldOut[0].expected) return { score: heldOutScore, passed: true };
    const passed = output && expected === 'fixable';
    return { score: Number(passed), passed };
  },
} satisfies LearningLoopApp<string, string, boolean>;
