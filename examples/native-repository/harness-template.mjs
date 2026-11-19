// Template: add your own coding agent as a harness.
//
// 1. Copy this file (for example to my-agent-harness.mjs) and fill in run().
// 2. Select it in native.json:
//      "harness": { "name": "my-agent", "module": "./my-agent-harness.mjs" }
//    or compare it with a built-in harness:
//      "harnesses": ["codex", { "name": "my-agent", "module": "./my-agent-harness.mjs" }]
// 3. Run `node smoke.mjs`-style checks with a fake first, then `acclimate-eval describe`.
//
// The evaluator fingerprints this module, so any edit requires a new evaluation request.
import { prepareNativeFiles } from '@acclimate/sdk/native-files';
import { defineHarness } from './harnesses.mjs';

export const harness = defineHarness({
  name: 'my-agent',

  // Stage the verified version where your agent discovers instructions and skills.
  // prepareNativeFiles validates the payload, writes a private 0700 directory under
  // TMPDIR and returns { cwd, instructionPath, skillPaths, memoryFiles, cleanup }.
  async prepare(bundle, { approvedMemoryPaths = [] } = {}) {
    const staged = await prepareNativeFiles(bundle, {
      mapping: { instructionPath: 'AGENTS.md', skillRoot: '.agents/skills', memoryRoot: '.acclimate/memory' },
      prefix: 'my-agent-',
      target: 'codex', // the closest compatibility rules for your agent's layout
    });
    void approvedMemoryPaths; // runRepositoryJob removes unapproved memory after prepare.
    return { ...staged, versionId: bundle.version.id, digest: bundle.version.digest };
  },

  // One fresh turn. It runs in its own process group: when turnTimeoutMs expires the
  // starter aborts `signal`, waits briefly, then kills the whole group and records a
  // confirmed timeout. Everything your agent starts must stay in this process group.
  async run({ context, prompt, policy, signal, acknowledge, progress }) {
    // Record a handle an operator can use to find the job (a PID, thread or run ID).
    await acknowledge({ kind: 'my-agent-run', value: `pid:${process.pid}` });
    // Start your agent with cwd = context.cwd, env = policy.env, model = policy.model,
    // pass `signal`, and await its real completion. Call progress(text) with the
    // latest agent message so a timeout still retains partial output.
    void context; void prompt; void signal; void progress;
    throw new Error('my-agent: implement run() in your harness module');
    // Return the job result. Examples:
    //   { stopped: true, output: 'final message', usage: { inputTokens, outputTokens, costUsd } }
    //   { stopped: true, executionStatus: 'task_failed', output }          // the task failed
    //   { stopped: true, infrastructureFailure: true, error: { code, message } } // provider failure
    //   { stopped: false }  // you cannot confirm a remote job stopped: quarantine it
  },

  // Everything else that changes behavior (versions, flags, sandbox). Hashed into the runtime identity.
  identity: { agent: 'my-agent', version: '0.0.0', sandbox: 'describe it here' },
});
