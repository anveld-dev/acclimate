import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { BundlePayload } from '@acclimate/sdk';
import { runCondition, type RunOptions, type RunSummary } from './block.js';
import { ordered, sourceModel, IntegrityError } from './conditions.js';
import { evaluator } from './evaluator.js';
import { heldOut, type Case } from './heldout.js';
import type { OptimizerData } from './adapter.js';

const fixtures = path.resolve('examples/self-improvement-memory/fixtures/w1');
type Input = Omit<RunOptions, 'baseline' | 'evolve' | 'held' | 'grader' | 'respond'>;
const input = JSON.parse(readFileSync(0, 'utf8')) as Input & {
  action?: 'freeze' | 'retention';
  versions?: Record<string, RunSummary['finalVersion']>;
};

function scripted(data: OptimizerData, kind: 'propose' | 'screen' | 'select') {
  if (kind === 'screen')
    return {
      samples: data.candidates!.map(({ sample }) => ({
        sample,
        verdict: 'evaluate',
        reason: 'Evaluate the fixture change.',
      })),
    };
  if (kind === 'select')
    return { decision: 'adopt', sample: 1, reason: 'Adopt the fixture change.' };
  const original = data.harness.files[0].text;
  const problem = data.improvementMemory.problems[0]?.id;
  return {
    schemaVersion: 2,
    rationale: 'Clarify command routing.',
    edits: [
      { path: 'AGENTS.md', oldText: original, newText: original + '\nCheck command routing.' },
    ],
    files: [],
    diagnosis: {
      problem: problem ? { id: problem } : { new: 'Command routing is underspecified.' },
      predicted: [data.feedback.cases[0].caseId],
    },
  };
}

async function main() {
  const grader = path.join(fixtures, 'grade.py');
  const load = <T>(name: string): T =>
    JSON.parse(readFileSync(path.join(fixtures, name), 'utf8')) as T;
  const baseline: BundlePayload = input.modelFree
    ? {
        schemaVersion: 1,
        files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Use the command reference.' }],
      }
    : load('baseline.json');
  const evolve: Case[] = input.modelFree
    ? [
        {
          caseId: 'cli-tiny',
          input: 'Show the path to the log database.',
          expected: 'llm logs path',
        },
      ]
    : [
        ...(
          JSON.parse(execFileSync(input.python, [grader, '--cases'], { encoding: 'utf8' })) as {
            development: Case[];
          }
        ).development,
        ...load<{ development: Case[] }>('40-case-additions.json').development,
      ];
  const held: Case[] = input.modelFree
    ? [
        {
          caseId: 'h-8c8a8bae',
          input: 'Locate the user templates directory.',
          expected: 'llm templates path',
        },
      ]
    : load<Case[]>('held-out.json').map(({ caseId, input, expected }) => ({
        caseId,
        input,
        expected,
      }));
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT'] as const)
    process.once(event, () => controller.abort(new Error(event)));
  if (input.action === 'freeze') {
    const labels = ['full', 'transfer', 'cold'] as const;
    console.log(
      JSON.stringify({
        heldOut: heldOut(held),
        evolve: heldOut(evolve),
        order: ordered(labels, input.seed, 'start', input.block),
        codes: ordered(labels, input.seed, 'codes', input.block),
      }),
    );
  } else if (input.action === 'retention') {
    const runner = evaluator({
      model: sourceModel,
      privateRoots: [process.cwd(), input.evidenceRoot],
      ledger: path.join(input.directory, 'retention.jsonl'),
      seed: [input.seed, input.block, 'retention'],
      held,
      evolve,
      grader,
      sourceTree: input.sourceTree,
      python: input.python,
      modelFree: input.modelFree,
      forbidden: ['A', 'B', 'C', 'S'],
      context: () => Promise.reject(new Error('Offline evaluation')),
      abort: (error) => controller.abort(error),
    });
    const summary: Record<string, unknown> = {};
    for (const code of ordered(
      Object.keys(input.versions!),
      input.seed,
      'retention',
      input.block,
    )) {
      const value = await runner.measure(
        input.versions![code],
        'retention-' + code,
        sourceModel,
        0,
        controller.signal,
      );
      if (value.infraFailures > held.length * 5 * 0.05)
        throw new Error('K5: retention infrastructure failure rate');
      summary[code] = value;
    }
    writeFileSync(path.join(input.directory, 'retention.json'), JSON.stringify(summary) + '\n', {
      mode: 0o600,
    });
  } else {
    await runCondition({
      ...input,
      baseline,
      evolve,
      held,
      grader,
      signal: controller.signal,
      respond: input.modelFree
        ? async (data, kind) => ({
            content: JSON.stringify(scripted(data, kind)),
            inputTokens: 12,
            outputTokens: 3,
          })
        : undefined,
    });
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = error instanceof IntegrityError ? 42 : 1;
  console.error(error);
}
