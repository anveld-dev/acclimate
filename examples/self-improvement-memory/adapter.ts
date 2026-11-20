import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fingerprint, type Case } from './heldout.js';
import { IntegrityError, sha256 } from './conditions.js';

type Kind = 'propose' | 'screen' | 'select';
export type OptimizerData = {
  setting: unknown;
  harness: { files: { path: string; text: string }[] };
  feedback: { cases: Case[] };
  history: unknown[];
  improvementMemory: { problems: { id: string; attempts: unknown[] }[] };
  candidates?: { sample: number }[];
  parserError?: string;
};

export function requestGuard(evolve: Case[], held: Case[], forbidden: string[]) {
  const shared = new Set(evolve.map(({ input }) => fingerprint(input)));
  const inputs = held.map(({ input }) => fingerprint(input)).filter((input) => !shared.has(input));
  return (kind: Kind, data: OptimizerData) => {
    const required = ['setting', 'harness', 'feedback', 'history', 'improvementMemory'];
    if (kind !== 'propose') required.push('candidates');
    const allowed = [...required, ...(kind === 'propose' ? ['parserError'] : [])];
    if (
      required.some((key) => !Object.hasOwn(data, key)) ||
      Object.keys(data).some((key) => !allowed.includes(key))
    ) {
      throw new IntegrityError('K1: unexpected optimizer data keys');
    }
    function visit(value: unknown) {
      if (typeof value === 'string') {
        const normalized = fingerprint(value);
        if (
          held.some(({ caseId }) => value.includes(caseId)) ||
          inputs.some((input) => normalized.includes(input)) ||
          forbidden.some((label) => value === label || (label.length > 3 && value.includes(label)))
        ) {
          throw new IntegrityError('K1: private experiment data in optimizer request');
        }
      } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          visit(key);
          visit(entry);
        }
      }
    }
    visit(data);
  };
}

export interface OptimizerReply {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
}
export function optimizerAdapter(options: {
  model: string;
  reasoningEffort: string;
  token: string;
  ledger: string;
  guard: ReturnType<typeof requestGuard>;
  inspect: (data: OptimizerData, kind: Kind) => Promise<{ round: number; sample: number | null }>;
  respond: (prompt: string, data: OptimizerData, kind: Kind) => Promise<OptimizerReply>;
  recordReply: (round: number, sample: number, content: string, returnedAt: string) => void;
  abort: (error: unknown) => void;
}) {
  const server = createServer((req, res) => {
    void (async () => {
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/chat/completions' ||
        req.headers.authorization !== 'Bearer ' + options.token
      ) {
        res.writeHead(401).end();
        return;
      }
      let raw = '';
      for await (const chunk of req) {
        raw += String(chunk);
        if (Buffer.byteLength(raw) > 32 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      const {
        model,
        reasoning_effort: reasoningEffort,
        messages,
      } = JSON.parse(raw) as {
        model: string;
        reasoning_effort?: string;
        messages: { role: string; content: string }[];
      };
      if (model !== options.model || reasoningEffort !== options.reasoningEffort)
        throw new IntegrityError('K1: unexpected optimizer model or reasoning effort');
      const instruction = messages[0].content;
      const kind = instruction.startsWith('You improve a harness:')
        ? 'propose'
        : instruction.startsWith('Each candidate is a proposed change')
          ? 'screen'
          : instruction.startsWith('Each candidate was evaluated')
            ? 'select'
            : null;
      const fenced = /^<untrusted-data>\n(.*)\n<\/untrusted-data>$/su.exec(messages[1].content);
      if (
        !kind ||
        !fenced ||
        messages.length !== 2 ||
        messages[0].role !== 'system' ||
        messages[1].role !== 'user'
      ) {
        throw new IntegrityError('K1: unknown optimizer request envelope');
      }
      const data = JSON.parse(fenced[1]) as OptimizerData;
      options.guard(kind, data);
      if (/\bh-[a-f0-9]{8}\b/u.test(instruction)) {
        throw new IntegrityError('K1: held-out ID in optimizer instruction');
      }
      const { round, sample } = await options.inspect(data, kind);
      const start = Date.now();
      const identity = {
        round,
        sample,
        kind,
        model,
        reasoningEffort,
        retry: Object.hasOwn(data, 'parserError'),
        digest: sha256(raw),
        bytes: Buffer.byteLength(raw),
        keyBytes: Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            Buffer.byteLength(JSON.stringify(value)),
          ]),
        ),
      };
      const requestId = crypto.randomUUID();
      appendFileSync(
        options.ledger,
        JSON.stringify({ event: 'request', requestId, ...identity }) + '\n',
      );
      const reply = await options.respond(
        messages.map(({ content }) => content).join('\n\n'),
        data,
        kind,
      );
      const returnedAt = new Date().toISOString();
      if (sample !== null) options.recordReply(round, sample, reply.content, returnedAt);
      appendFileSync(
        options.ledger,
        JSON.stringify({
          event: 'reply',
          requestId,
          ...identity,
          milliseconds: Date.now() - start,
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          returnedAt,
        }) + '\n',
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: reply.content } }],
        }),
      );
    })().catch((error: unknown) => {
      if (error instanceof IntegrityError) {
        options.abort(error);
        res.writeHead(400).end();
      } else if (
        error instanceof Error &&
        /context[_ ](?:length|window)|maximum context|prompt is too long|too many (?:input )?tokens/iu.test(
          error.message,
        )
      ) {
        res.writeHead(413).end();
      } else {
        console.error(
          'Optimizer callback failed:',
          error instanceof Error ? error.name : 'unknown',
        );
        res.writeHead(502).end();
      }
    });
  });
  return {
    async start() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}/v1/chat/completions`;
    },
    async close() {
      if (server.listening) {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  };
}
