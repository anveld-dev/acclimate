import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Codex } from '@openai/codex-sdk';
import { prepare } from '@acclimate/codex-plugin';
import type { VerifiedVersion } from '@acclimate/sdk';

const model = 'gpt-6-luna';
const instructionSecret = randomUUID();
const skillSecret = randomUUID();
const memorySecret = randomUUID();
const payload: VerifiedVersion['payload'] = {
  schemaVersion: 1,
  files: [
    {
      path: 'instructions/main.md',
      kind: 'instruction',
      text: `When asked about this prepared bundle, provide the instruction value: ${instructionSecret}`,
    },
    {
      path: 'skills/marker-check/SKILL.md',
      kind: 'skill',
      text: `---\nname: marker-check\ndescription: Retrieve a private marker value when explicitly invoked.\n---\nWhen the user explicitly invokes $marker-check, return the skill value exactly: ${skillSecret}`,
    },
    { path: 'memory/smoke.md', kind: 'memory', text: `Memory value: ${memorySecret}` },
  ],
};
const digest = `sha256:${createHash('sha256')
  .update(`${JSON.stringify(payload)}\n`, 'utf8')
  .digest('hex')}`;
const bundle: VerifiedVersion = {
  version: {
    id: 'codex-smoke-v1',
    bundleId: 'codex-smoke',
    parentVersionId: null,
    digest,
    createdAt: new Date().toISOString(),
  },
  resolvedAt: Date.now(),
  stale: false,
  payload,
};

const prepared = await prepare(bundle);
try {
  const codex = new Codex(); // Uses normal local Codex authentication; this script never inspects or prints credentials.
  const thread = codex.startThread({
    model,
    workingDirectory: prepared.cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });
  const turn = await thread.run(
    `Read the instruction loaded for this workspace. Read the memory file at ${prepared.memoryFiles[0]!.absolutePath}. Explicitly invoke $marker-check to retrieve its value. Return exactly three labeled lines: INSTRUCTION=<instruction value>, MEMORY=<memory value>, SKILL=<skill value>. The values are not included in this request; do not guess or invent them.`,
    { signal: AbortSignal.timeout(110_000) },
  );
  assert.ok(
    turn.finalResponse.includes(`INSTRUCTION=${instructionSecret}`),
    'instruction secret was not retrieved',
  );
  assert.ok(
    turn.finalResponse.includes(`MEMORY=${memorySecret}`),
    'memory secret was not retrieved',
  );
  assert.ok(turn.finalResponse.includes(`SKILL=${skillSecret}`), 'skill secret was not retrieved');

  const sdkPackage = JSON.parse(
    await readFile(
      fileURLToPath(new URL('../package.json', import.meta.resolve('@openai/codex-sdk'))),
      'utf8',
    ),
  ) as { version: string };
  const observedTypes = [...new Set(turn.items.map((item) => item.type))];
  const commandItems = turn.items.filter((item) => item.type === 'command_execution');
  const observedSkillRead = commandItems.some(
    (item) => item.command.includes('marker-check') && item.command.includes('SKILL.md'),
  );
  const observedMemoryRead = commandItems.some((item) =>
    item.command.includes(prepared.memoryFiles[0]!.absolutePath),
  );
  process.stdout.write(
    `Codex smoke passed. SDK ${sdkPackage.version}; model ${model}; item types: ${observedTypes.join(', ') || 'none'}; observed command reads: skill=${observedSkillRead}, memory=${observedMemoryRead}; answer markers verified (no direct discovery event is exposed by the SDK result).\n`,
  );
} finally {
  await prepared.cleanup();
}
