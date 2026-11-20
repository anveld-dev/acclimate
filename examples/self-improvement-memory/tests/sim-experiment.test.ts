import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const read = async <T>(filename: string): Promise<T> =>
  JSON.parse(await readFile(filename, 'utf8')) as T;
const lines = async <T>(filename: string): Promise<T[]> =>
  (await readFile(filename, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
type Round = {
  r: number;
  number: number;
  state: string;
  memoryRevision: number;
  historyDigest: string;
  optimizerModel: string;
  optimizerReasoningEffort: string;
  memory: { improvementMemory: { problems: { attempts: unknown[] }[] } };
  candidates: { diagnosis: unknown; evaluationId: string; sample: number }[];
  evaluations: {
    id: string;
    role: string;
    versionId: string;
    createdAt: string;
    report?: unknown;
  }[];
  retained: { versionId: string };
  adoptedVersionId: string;
  turns: Record<string, number>;
  optimizer: {
    event: string;
    kind: string;
    returnedAt: string;
    sample: number;
    model: string;
    endpoint: string;
    reasoningEffort: string;
  }[];
};
type Summary = {
  finalDigest: string;
  startDigest: string;
  memoryRevision: number;
  turns: number;
  finalVersion: { version: { id: string } };
};
test(
  'one block uses a real checkpoint and counts exactly two rounds per leg',
  { timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'acclimate-sim-'));
    try {
      const result = await exec(
        process.env.SIM_PYTHON ?? '/opt/homebrew/bin/python3',
        [
          'examples/self-improvement-memory/run.py',
          '--stage',
          'S0a',
          '--output',
          directory,
          '--pg-bin',
          process.env.SIM_PG_BIN ?? '/opt/homebrew/opt/postgresql@16/bin',
        ],
        { timeout: 220_000 },
      );
      assert.equal(result.stderr, '');
      const setup = await read<{ proxy: { baseURL: string } }>(path.join(directory, 'seed.json'));
      const endpoint = setup.proxy.baseURL + '/chat/completions';
      const observed = await lines<{ endpoint: string; model: string; reasoningEffort: string }>(
        path.join(directory, 'proxy-requests.jsonl'),
      );
      const expectedCalls = new Map<string, number>([['gpt-6.2-astra', 0]]);
      const key = (
        await read<Record<string, Record<string, string>>>(path.join(directory, 'key.json'))
      )['1'];
      const summaries = new Map<string, Summary>();
      for (const [code, condition] of Object.entries({ ...key, S: 'source' })) {
        const root = path.join(directory, 'S0a', 'b1', code);
        assert.equal(await readFile(path.join(root, 'checks.txt'), 'utf8'), '');
        const records = await lines<Round>(path.join(root, 'rounds.jsonl'));
        assert.deepEqual(
          records.map((r) => [r.r, r.state]),
          [
            [1, 'completed'],
            [2, 'completed'],
          ],
        );
        const summary = await read<Summary>(path.join(root, 'summary.json'));
        summaries.set(condition, summary);
        assert.equal(records[1].retained.versionId, summary.finalVersion.version.id);
        assert.equal(records[0].memoryRevision, condition === 'full' ? 2 : 0);
        assert.equal(
          records[0].memory.improvementMemory.problems.flatMap((p) => p.attempts).length,
          condition === 'full' ? 2 : 0,
        );
        assert.equal(
          records[0].historyDigest,
          'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        );
        for (const round of records) {
          assert.equal(round.optimizerModel, 'gpt-6.2-astra');
          assert.equal(round.optimizerReasoningEffort, 'high');
          for (const call of round.optimizer) {
            assert.equal(call.endpoint, endpoint);
            assert.equal(call.model, 'gpt-6.2-astra');
            if (call.event === 'request')
              expectedCalls.set(call.model, expectedCalls.get(call.model)! + 1);
            assert.equal(call.reasoningEffort, 'high');
          }
          assert.equal(round.candidates.length, 5);
          assert.equal(round.optimizer.filter((r) => r.event === 'request').length, 7);
          for (const candidate of round.candidates) {
            assert(candidate.diagnosis);
            const evaluation = round.evaluations.find(
              (entry) => entry.id === candidate.evaluationId,
            );
            assert(evaluation);
            const reply = round.optimizer.find(
              (row) =>
                row.event === 'reply' && row.kind === 'propose' && row.sample === candidate.sample,
            );
            assert(reply);
            assert(Date.parse(reply.returnedAt) <= Date.parse(evaluation.createdAt));
          }
          const retained = round.evaluations.find((entry) => entry.role === 'retained');
          assert.equal(retained?.report, undefined);
          assert.equal(retained?.versionId, round.adoptedVersionId);
          assert.deepEqual(round.turns, { incumbent: 5, candidate: 25, retained: 5, rescore: 0 });
        }
        const rollouts = await lines<{
          turns: number;
          role: string;
          model: string;
          endpoint: string;
          reasoningEffort: string;
        }>(path.join(root, 'rollouts.jsonl'));
        assert.equal(
          rollouts.reduce((total, row) => total + row.turns, 0),
          summary.turns,
        );
        const taskModel = condition === 'source' ? 'gpt-6-luna' : 'gpt-6.2-sol';
        for (const row of rollouts) {
          assert.equal(row.endpoint, endpoint);
          assert.equal(row.model, taskModel);
          assert.equal(row.reasoningEffort, 'low');
        }
        expectedCalls.set(taskModel, (expectedCalls.get(taskModel) ?? 0) + summary.turns);
        assert.equal(rollouts.filter((row) => row.role !== 'round-zero').length, 70);
        assert(
          !(await readFile(path.join(root, 'optimizer.jsonl'), 'utf8')).includes('h-8c8a8bae'),
        );
      }
      const actualCalls = new Map<string, number>();
      for (const call of observed) {
        assert.equal(call.endpoint, endpoint);
        assert.equal(call.reasoningEffort, call.model === 'gpt-6.2-astra' ? 'high' : 'low');
        actualCalls.set(call.model, (actualCalls.get(call.model) ?? 0) + 1);
      }
      assert.deepEqual(actualCalls, expectedCalls);
      assert.equal(summaries.get('source')?.finalDigest, summaries.get('full')?.startDigest);
      assert.equal(summaries.get('full')?.startDigest, summaries.get('transfer')?.startDigest);
      assert.equal(summaries.get('source')?.startDigest, summaries.get('cold')?.startDigest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
