/** Opt-in paid qualification: three Luna turns, with separate immutable workspaces. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import { prepare } from '../packages/codex-plugin/src/index.js';
import type { VerifiedBundle } from '../packages/sdk/src/types.js';

const model = 'gpt-6-luna';
function fixture(id: string, parentVersionId: string | null) {
  const markers = { instruction: randomUUID(), skill: randomUUID(), memory: randomUUID() };
  const payload: VerifiedBundle['payload'] = {
    schemaVersion: 1,
    files: [
      {
        path: 'instructions/main.md',
        kind: 'instruction',
        text: `When asked for the workspace instruction marker, return ${markers.instruction}.`,
      },
      {
        path: 'skills/session-marker/SKILL.md',
        kind: 'skill',
        text: `---\nname: session-marker\ndescription: Return the workspace skill marker when explicitly invoked.\n---\nReturn ${markers.skill}.`,
      },
      {
        path: 'memory/session.md',
        kind: 'memory',
        text: `Workspace memory marker: ${markers.memory}`,
      },
    ],
  };
  const digest = `sha256:${createHash('sha256')
    .update(`${JSON.stringify(payload)}\n`)
    .digest('hex')}`;
  const bundle: VerifiedBundle = {
    version: {
      id,
      bundleId: 'session-check',
      parentVersionId,
      digest,
      createdAt: new Date().toISOString(),
    },
    payload,
    resolvedAt: Date.now(),
    stale: false,
  };
  return { bundle, markers };
}
const first = fixture('session-v1', null);
const second = fixture('session-v2', first.bundle.version.id);
const old = await prepare(first.bundle);
let fresh: Awaited<ReturnType<typeof prepare>> | undefined;
try {
  const sdk = JSON.parse(
    await readFile(
      fileURLToPath(new URL('../package.json', import.meta.resolve('@openai/codex-sdk'))),
      'utf8',
    ),
  ) as { version: string };
  const codex = new Codex(); // Uses normal app authentication; no credential inspection.
  const options = (cwd: string): ThreadOptions => ({
    model,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });
  const prompt = (memoryPath: string) =>
    `Report this workspace's instruction marker, read the memory file at ${memoryPath}, and explicitly invoke $session-marker for its marker. Return three lines labeled INSTRUCTION, MEMORY, and SKILL. Do not guess missing markers.`;
  async function observe(
    label: string,
    thread: Thread,
    prepared: typeof old,
    expected: typeof first.markers,
    other: typeof first.markers,
  ) {
    const turn = await thread.run(prompt(prepared.memoryFiles[0]!.absolutePath), {
      signal: AbortSignal.timeout(110_000),
    });
    const response = turn.finalResponse;
    const contains = (values: typeof expected) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, response.includes(value)]),
      );
    const commands = turn.items.filter((item) => item.type === 'command_execution');
    return {
      label,
      appVersionId: prepared.versionId,
      appDigest: prepared.digest,
      expectedMarkersPresent: contains(expected),
      otherVersionMarkersPresent: contains(other),
      itemTypes: [...new Set(turn.items.map((item) => item.type))],
      skillFileReadObserved: commands.some(
        (item) => item.command.includes('session-marker') && item.command.includes('SKILL.md'),
      ),
      memoryFileReadObserved: commands.some((item) =>
        item.command.includes(prepared.memoryFiles[0]!.absolutePath),
      ),
    };
  }
  const pinnedThread = codex.startThread(options(old.cwd));
  const observations = [
    await observe('fresh-v1', pinnedThread, old, first.markers, second.markers),
  ];
  if (!pinnedThread.id) throw new Error('SDK did not return a thread ID after the first turn');
  fresh = await prepare(second.bundle);
  observations.push(
    await observe(
      'fresh-v2-after-refresh',
      codex.startThread(options(fresh.cwd)),
      fresh,
      second.markers,
      first.markers,
    ),
  );
  // A separate Thread object resumes the original ID and original workspace, maintaining the job pin.
  observations.push(
    await observe(
      'resumed-v1-after-refresh',
      codex.resumeThread(pinnedThread.id, options(old.cwd)),
      old,
      first.markers,
      second.markers,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ sdkVersion: sdk.version, model, observations, note: 'Markers are random and appear only in prepared resources. A resumed conversation may remember prior answers; no discovery event or hot-reload guarantee is inferred.' }, null, 2)}\n`,
  );
} finally {
  await fresh?.cleanup();
  await old.cleanup();
}
