import { spawn } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Codex } from '@openai/codex-sdk';
import type { LearningLoopApp } from '@acclimate/sdk/learning';
import type { VerifiedVersion } from '@acclimate/sdk';
import { IntegrityError, ordered } from './conditions.js';
import { meanScore, type Case } from './heldout.js';

async function grade(
  python: string,
  grader: string,
  output: string[],
  expected: string,
  signal: AbortSignal,
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(python, [grader], {
      signal,
      timeout: 20_000,
      env: { ...process.env, LLM_LOAD_PLUGINS: '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let result = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      result += chunk;
    });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && /^[01]$/u.test(result.trim())) resolve(Number(result));
      else reject(new Error('Pinned grader failed'));
    });
    child.stdin.end(JSON.stringify({ output, expected }));
  });
}
const argvSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['argv'],
  properties: { argv: { type: 'array', items: { type: 'string' } } },
};

const codexWrapper = fileURLToPath(new URL('./codex-exec.sh', import.meta.url));

export function codexSandbox(privateRoots: string[]) {
  const roots = [...new Set(privateRoots.map((root) => realpathSync(root)))];
  return (
    '(version 1) (allow default) ' +
    roots.map((root) => `(deny file-read* (subpath ${JSON.stringify(root)}))`).join(' ')
  );
}

export function codexTurn(
  model: string,
  cwd: string,
  signal: AbortSignal,
  privateRoots: string[],
  outputSchema?: unknown,
) {
  const code = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const codex = new Codex({
    codexPathOverride: codexWrapper,
    env: { ...code, SIM_CODEX_SANDBOX: codexSandbox(privateRoots), SIM_CODEX_CWD: cwd },
    config: {
      features: {
        shell_tool: outputSchema !== undefined,
        skip_host_skill_discovery: true,
        enable_mcp_apps: false,
      },
      shell_environment_policy: { inherit: 'none' },
    },
  });
  return async (prompt: string) => {
    const result = await codex
      .startThread({
        model,
        modelReasoningEffort: 'low',
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
      })
      .run(prompt, { signal, outputSchema });
    return {
      content: result.finalResponse,
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
    };
  };
}

export interface TrialContext {
  id: string;
  number: number;
  role: string;
  sample: number | null;
}
export interface RolloutRow extends TrialContext {
  caseId: string;
  rollout: number;
  digest: string;
  model: string;
  score: number;
  passed: boolean;
  infraFailure: boolean;
  turns: number;
  milliseconds: number;
  trace: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function evaluator(options: {
  model: string;
  modelFree: boolean;
  fake?: (input: string, rollout: number, version: VerifiedVersion) => string[];
  seed: (string | number)[];
  ledger: string;
  sourceTree: string;
  privateRoots: string[];
  python: string;
  grader: string;
  held: Case[];
  evolve: Case[];
  forbidden: string[];
  context: (version: VerifiedVersion) => Promise<TrialContext>;
  abort: (error: unknown) => void;
}) {
  const rows: RolloutRow[] = [];
  const byId = new Map([...options.evolve, ...options.held].map((item) => [item.caseId, item]));
  async function score(
    item: Case,
    rollout: number,
    version: VerifiedVersion,
    context: TrialContext,
    model: string,
    signal: AbortSignal,
  ) {
    const guidance = version.payload.files.map(({ path, text }) => path + '\n' + text).join('\n');
    if (
      /\bP[1-9]\d*\b|\bimprovementMemory\b/u.test(guidance) ||
      options.forbidden.some((label) =>
        version.payload.files.some(
          ({ path, text }) =>
            path === label ||
            text === label ||
            (label.length > 3 && (path.includes(label) || text.includes(label))),
        ),
      )
    ) {
      const error = new IntegrityError('K1: private experiment data in delivered harness');
      options.abort(error);
      throw error;
    }
    const prompt =
      guidance +
      '\nUse upstream source and docs as reference. Return JSON with argv beginning with llm. Do not run the suggested command. Request: ' +
      item.input;
    const start = Date.now();
    let turns = 0;
    let reply: Awaited<ReturnType<ReturnType<typeof codexTurn>>> | undefined;
    let output: string[] | undefined;
    let error: string | null = null;
    let infraFailure = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      turns++;
      try {
        if (options.modelFree) {
          output = options.fake?.(item.input, rollout, version) ?? ['llm', 'logs', 'path'];
        } else {
          reply = await codexTurn(
            model,
            options.sourceTree,
            AbortSignal.any([signal, AbortSignal.timeout(80_000)]),
            options.privateRoots,
            argvSchema,
          )(prompt);
        }
        break;
      } catch {
        error = 'policy turn failed';
      }
    }
    let value = 0;
    if (reply || output) {
      error = null;
      try {
        output ??= (JSON.parse(reply!.content) as { argv: string[] }).argv;
        if (!Array.isArray(output) || output.some((arg) => typeof arg !== 'string'))
          throw new Error();
      } catch {
        output = undefined;
        error = 'invalid argv response';
      }
      if (output && options.modelFree) {
        value = Number(output.join(' ') === item.expected);
      } else if (output) {
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          try {
            value = await grade(options.python, options.grader, output, item.expected, signal);
            error = null;
            break;
          } catch {
            error = 'grader subprocess failed';
          }
        }
        infraFailure = error !== null;
      }
    } else {
      infraFailure = true;
    }
    const row: RolloutRow = {
      ...context,
      caseId: item.caseId,
      rollout,
      digest: version.version.digest,
      model,
      score: value,
      passed: value === 1,
      turns,
      infraFailure,
      error,
      trace: output ? JSON.stringify({ argv: output }) : null,
      milliseconds: Date.now() - start,
      inputTokens: reply?.inputTokens ?? null,
      outputTokens: reply?.outputTokens ?? null,
    };
    rows.push(row);
    appendFileSync(options.ledger, JSON.stringify(row) + '\n');
    return row;
  }

  const app: LearningLoopApp<string, string, RolloutRow> = {
    execution: options.modelFree ? 'model-free' : 'live',
    heldOut: options.held,
    async execute({ version, input, caseId, rollout, signal }) {
      const context = await options.context(version);
      const item = byId.get(caseId);
      if (!item || item.input !== input) {
        const error = new IntegrityError('K1: evaluator input differs from frozen fixture');
        options.abort(error);
        throw error;
      }
      const order = ordered(
        [0, 1, 2, 3, 4],
        ...options.seed,
        context.number,
        context.role,
        context.sample ?? 0,
        caseId,
      );
      const output = await score(item, order[rollout], version, context, options.model, signal);
      if (output.error) throw new Error(output.error);
      return { output, trace: output.trace ?? undefined };
    },
    grade({ output, expected }) {
      if (byId.get(output.caseId)?.expected !== expected) {
        options.abort(new IntegrityError('K1: evaluator expectation differs from frozen fixture'));
      }
      return { score: output.score, passed: output.passed };
    },
  };
  return {
    app,
    rows,
    async measure(
      version: VerifiedVersion,
      role: string,
      model: string,
      number: number,
      signal: AbortSignal,
      cases = options.held,
    ) {
      const pairs = ordered(
        cases.flatMap((item) => [0, 1, 2, 3, 4].map((rollout) => ({ item, rollout }))),
        ...options.seed,
        number,
        role,
        0,
      );
      const id = crypto.randomUUID();
      const result: RolloutRow[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (next < pairs.length) {
            const { item, rollout } = pairs[next++];
            result.push(
              await score(
                item,
                rollout,
                version,
                { id, role, number, sample: null },
                model,
                signal,
              ),
            );
          }
        }),
      );
      return {
        id,
        score: meanScore(result),
        infraFailures: result.filter((row) => row.infraFailure).length,
      };
    },
  };
}
