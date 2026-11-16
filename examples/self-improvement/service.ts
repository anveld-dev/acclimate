/** Qualification-only bridge: real Rust proposer -> authenticated local adapter -> Luna SDK. */
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AcclimateClient } from '../../packages/sdk/src/index.js';
import { Luna, model } from './luna.js';

const patchSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    edits: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
    rationale: { type: 'string' },
  },
  required: ['schemaVersion', 'edits', 'rationale'],
  additionalProperties: false,
};
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return (server.address() as { port: number }).port;
}
export async function startService(
  luna: Luna,
  database: string,
  output: string,
  options: { maximumProposals?: number; authorGuidance?: string } = {},
) {
  const root = process.cwd(),
    project = 'learning-' + randomUUID(),
    token = randomUUID() + randomUUID(),
    providerToken = randomUUID();
  let proposals = 0;
  const authorDir = path.join(output, 'author-workspace');
  await mkdir(authorDir, { mode: 0o700 });
  const provider = createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/v1/chat/completions' ||
      req.headers.authorization !== `Bearer ${providerToken}`
    ) {
      res.writeHead(401).end();
      return;
    }
    const number = ++proposals;
    try {
      if (number > (options.maximumProposals ?? 3)) throw new Error('Proposal budget exhausted');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 2_000_000) throw new Error('Request too large');
      }
      const envelope = JSON.parse(raw);
      if (envelope.model !== model) throw new Error('Only Luna is allowed');
      const input = JSON.parse(envelope.messages[0].content);
      await writeFile(
        path.join(output, `proposal-${number}-input.json`),
        JSON.stringify(input, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      console.log(`Authoring candidate ${number} through the Rust proposal queue…`);
      const turn = await luna.turn(
        authorDir,
        `You maintain reusable payment-triage harness files. Learn only from this approved training feedback. Do not use tools. Do not encode incident IDs, trace IDs, specific fence values, batch IDs, test labels, scoring rules or observed answers as lookup tables. Keep stable provider facts in the memory file, reusable decision steps in the skill, and loading/trust guidance in instructions. Preserve frontmatter and file kinds. Follow the exact edit protocol in input.instruction, using original unique anchors. ${options.authorGuidance ?? ''} Input: ${JSON.stringify(input)}`,
        patchSchema,
        55_000,
      );
      await writeFile(
        path.join(output, `proposal-${number}-model.json`),
        JSON.stringify(
          {
            response: turn.finalResponse,
            usage: turn.usage,
            elapsedMs: turn.elapsedMs,
            itemTypes: turn.items.map((item) => item.type),
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      if (turn.items.some((item) => !['agent_message', 'reasoning', 'error'].includes(item.type)))
        throw new Error('Proposer tried to use tools');
      if (!res.destroyed)
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: turn.finalResponse } }],
          }),
        );
    } catch (error) {
      await writeFile(
        path.join(output, `proposal-${number}-failure.json`),
        JSON.stringify({ error: error instanceof Error ? error.message : 'Provider failure' }) +
          '\n',
        { mode: 0o600 },
      );
      if (!res.destroyed && !res.headersSent) res.writeHead(500).end();
    }
  });
  const modelPort = await listen(provider);
  const reservation = createServer(),
    port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const env = JSON.parse(
    execFileSync(
      process.env.ACCLIMATE_TEST_PYTHON || 'python3',
      ['-m', 'scripts.testing.production'],
      {
        cwd: root,
        input: JSON.stringify({
          database_url: database,
          bind: `127.0.0.1:${port}`,
          project,
          tokens: { operator: token },
          login_token: randomUUID() + randomUUID(),
          console_token: randomUUID() + randomUUID(),
          base_env: process.env,
        }),
        encoding: 'utf8',
      },
    ),
  ) as NodeJS.ProcessEnv;
  const service = spawn(path.join(root, 'target/debug/acclimate-service'), [], {
    cwd: root,
    env: {
      ...env,
      ACCLIMATE_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
      ACCLIMATE_MODEL_TOKEN: providerToken,
      ACCLIMATE_MODEL: model,
    },
    stdio: 'ignore',
  });
  const close = async () => {
    if (service.exitCode === null && service.signalCode === null) {
      const ended = new Promise<void>((resolve) => service.once('exit', () => resolve()));
      service.kill('SIGTERM');
      const timeout = setTimeout(() => service.kill('SIGKILL'), 40_000);
      try {
        await ended;
      } finally {
        clearTimeout(timeout);
      }
    }
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  };
  try {
    for (let index = 0; ; index++) {
      if (index >= 150 || service.exitCode !== null || service.signalCode !== null)
        throw new Error('Rust service did not become ready');
      try {
        if (
          (await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) })).ok
        )
          break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      project,
      client: new AcclimateClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        scope: 'operator',
        retries: 0,
        timeoutMs: 5000,
      }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
