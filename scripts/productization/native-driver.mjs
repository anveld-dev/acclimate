/** Actual installed native SDK sessions. Never run without external.py --live. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
  const config = JSON.parse(readFileSync(0, 'utf8'));
  assert.equal(config.model, 'gpt-6-luna');
  assert.ok(['claude', 'pi', 'cursor'].includes(config.provider));
  const model = config.model;
  const plugin = await import(`../../packages/${config.provider}-plugin/src/index.ts`);
  const native = await import(`../../packages/${config.provider}-plugin/src/native.ts`);
  function fixture(id) {
    const markers = { instruction: randomUUID(), skill: randomUUID(), memory: randomUUID() };
    const payload = {
      schemaVersion: 1,
      files: [
        {
          path: 'instructions/main.md',
          kind: 'instruction',
          text: 'Workspace instruction marker: ' + markers.instruction,
        },
        {
          path: 'skills/session-marker/SKILL.md',
          kind: 'skill',
          text: `---\nname: session-marker\ndescription: Return the workspace skill marker when explicitly invoked.\n---\nWorkspace skill marker: ${markers.skill}`,
        },
        {
          path: 'memory/session.md',
          kind: 'memory',
          text: 'Workspace memory marker: ' + markers.memory,
        },
      ],
    };
    return {
      markers,
      bundle: {
        version: {
          id,
          bundleId: 'native-qualification',
          parentVersionId: null,
          digest:
            'sha256:' +
            createHash('sha256')
              .update(JSON.stringify(payload) + '\n')
              .digest('hex'),
          createdAt: new Date().toISOString(),
        },
        payload,
        resolvedAt: Date.now(),
        stale: false,
      },
    };
  }
  const first = fixture('v1'),
    second = fixture('v2');
  const old = await plugin.prepare(first.bundle, { approvedMemoryPaths: ['memory/session.md'] });
  let fresh;
  async function run(prepared) {
    const prompt = `Report this workspace's instruction marker, use the native session-marker skill for its marker, and read the approved memory file ${prepared.memoryFiles[0].absolutePath} for its marker. Return exactly three labeled lines INSTRUCTION, SKILL and MEMORY. Do not guess any missing value. Do not write files or run shell commands.`;
    if (config.provider === 'claude') {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 110000);
      let output = '',
        completed = false;
      try {
        for await (const event of query({
          prompt,
          options: {
            ...native.claudeSessionOptions(prepared),
            model,
            tools: ['Read', 'Skill'],
            allowedTools: ['Read', 'Skill'],
            permissionMode: 'dontAsk',
            maxTurns: 3,
            maxBudgetUsd: 1,
            abortController: controller,
          },
        })) {
          if (event.type === 'system' && event.subtype === 'init') assert.equal(event.model, model);
          if (event.type === 'result') {
            assert.equal(event.subtype, 'success');
            for (const used of Object.keys(event.modelUsage ?? {})) assert.equal(used, model);
            output = event.result;
            completed = true;
          }
        }
        assert.ok(completed);
        return output;
      } finally {
        clearTimeout(timer);
      }
    }
    if (config.provider === 'pi') {
      const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(
        '@earendil-works/pi-coding-agent'
      );
      const provider = process.env.ACCLIMATE_QUALIFY_PI_PROVIDER;
      if (!provider)
        throw new Error('Set ACCLIMATE_QUALIFY_PI_PROVIDER to a configured Luna provider');
      const runtime = await ModelRuntime.create({ allowModelNetwork: false });
      const selected = runtime.getModel(provider, model);
      if (!selected || selected.id !== model)
        throw new Error('Configured Pi provider has no Luna model');
      const settings = SettingsManager.inMemory();
      settings.setRetryEnabled(false);
      settings.setCacheWarmingMode('off');
      const originalStream = runtime.streamSimple.bind(runtime);
      let requests = 0;
      runtime.streamSimple = (...args) => {
        if (++requests > 3) throw new Error('Provider request limit');
        assert.equal(args[0].id, model);
        return originalStream(...args);
      };
      const { session } = await createAgentSession({
        cwd: prepared.cwd,
        modelRuntime: runtime,
        model: selected,
        resourceLoader: await native.createPiResourceLoader(prepared, ['memory/session.md']),
        sessionManager: SessionManager.inMemory(prepared.cwd),
        settingsManager: settings,
        tools: ['read'],
      });
      let turns = 0;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'assistant' && ++turns > 3)
          void session.abort();
      });
      const timer = setTimeout(() => void session.abort(), 110000);
      try {
        await session.prompt(prompt);
        assert.ok(turns <= 3);
        return session.messages
          .filter((m) => m.role === 'assistant')
          .flatMap((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text))
          .join('\n');
      } finally {
        clearTimeout(timer);
        unsubscribe();
        session.dispose();
      }
    }
    const { Agent } = await import('@cursor/sdk');
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) throw new Error('Cursor API credential is not configured');
    const options = native.cursorLocalOptions(prepared);
    const agent = await Agent.create({
      apiKey,
      model: { id: model },
      tools: ['read'],
      ...options,
      local: { ...options.local, sandboxOptions: { enabled: true } },
    });
    try {
      const run = await agent.send(prompt);
      const timer = setTimeout(() => void run.cancel(), 110000);
      let output = '',
        turns = 0,
        completed = false;
      try {
        for await (const event of run.stream()) {
          if (event.type === 'system' && event.model) assert.equal(event.model.id, model);
          if (event.type === 'assistant') {
            if (++turns > 3) {
              await run.cancel();
              throw new Error('Turn limit');
            }
            output += event.message.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
          }
          if (event.type === 'status' && event.status === 'FINISHED') completed = true;
        }
        assert.ok(completed);
        return output;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
  function observe(output, expected, other) {
    assert.ok(Object.values(expected).every((marker) => output.includes(marker)));
    assert.ok(Object.values(other).every((marker) => !output.includes(marker)));
  }
  try {
    observe(await run(old), first.markers, second.markers);
    fresh = await plugin.prepare(second.bundle, { approvedMemoryPaths: ['memory/session.md'] });
    observe(await run(fresh), second.markers, first.markers);
    // A new session against the retained v1 workspace proves immutable pinning;
    // this is deliberately not a claim about provider conversation resumption.
    observe(await run(old), first.markers, second.markers);
    console.log(
      JSON.stringify({
        provider: config.provider,
        model,
        marker: config.marker,
        actualProviderSession: true,
        checks: {
          instruction: true,
          skill: true,
          memory: true,
          freshVersion: true,
          oldWorkspacePinned: true,
        },
        limits: { sessions: 3, assistantTurnsPerSession: 3, sessionDeadlineMs: 110000 },
        resumedConversation: 'not tested',
      }),
    );
  } finally {
    await fresh?.cleanup();
    await old.cleanup();
  }
}
main().catch(() => {
  console.error('Native qualification blocked; inspect provider configuration privately.');
  process.exitCode = 1;
});
