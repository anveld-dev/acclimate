import { randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AcclimateClient, ApiError, DeliveryError, verifyPayloadBytes } from '../index.js';
import type {
  BundlePayload,
  Comparison,
  Outcome,
  ProposalRequest,
  PolicyOverride,
} from '../types.js';

const commands: Record<string, string[]> = {
  'request-proposal': ['parent', 'path', 'hypothesis', 'evidence', 'key'],
  proposal: ['id'],
  review: ['comparison', 'proposal'],
  history: ['limit', 'before'],
  promote: ['version', 'comparison', 'expected-revision', 'key', 'ack-policy', 'override-reason'],
  rollback: ['version', 'reason', 'expected-revision', 'key'],
};
const common = ['workspace', 'bundle', 'channel', 'output'];
export function parseArgs(args: string[]) {
  const command = args.shift();
  if (!command || !commands[command])
    throw new Error('Expected request-proposal, proposal, review, history, promote, or rollback');
  const flags: Record<string, string[]> = {};
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--json') {
      if (flags.json) throw new Error('Duplicate --json');
      flags.json = ['true'];
      continue;
    }
    if (!arg.startsWith('--') || ![...common, ...commands[command]].includes(arg.slice(2)))
      throw new Error(`Unknown option: ${arg}`);
    const name = arg.slice(2),
      value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (flags[name] && !['path', 'evidence', 'ack-policy'].includes(name)) throw new Error(`Duplicate --${name}`);
    (flags[name] ??= []).push(value);
  }
  return { command, flags };
}
const one = (flags: Record<string, string[]>, name: string) => flags[name]?.[0];
const required = (flags: Record<string, string[]>, name: string) => {
  const value = one(flags, name);
  if (!value?.trim()) throw new Error(`--${name} is required`);
  return value;
};
function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
async function verified(client: AcclimateClient, workspace: string, bundle: string, id: string) {
  const version = await client.getVersion(workspace, bundle, id);
  if (
    version.id !== id ||
    version.bundleId !== bundle ||
    !/^sha256:[a-f0-9]{64}$/.test(version.digest)
  )
    throw new Error('Invalid version metadata');
  const bytes = await client.getPayload(workspace, bundle, id);
  try {
    return { version, payload: verifyPayloadBytes(bytes, version.digest) };
  } catch (error) {
    if (error instanceof DeliveryError && error.code === 'digest_mismatch')
      throw new Error('Payload digest mismatch');
    throw error;
  }
}
function excerpt(text: string) {
  return { text: text.slice(0, 4096), truncated: text.length > 4096 };
}
function changes(before: BundlePayload, after: BundlePayload) {
  const a = new Map(before.files.map((f) => [f.path, f])),
    b = new Map(after.files.map((f) => [f.path, f]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((path) => {
    const old = a.get(path),
      next = b.get(path);
    if (old && next && old.text === next.text && old.kind === next.kind) return [];
    return [
      {
        path,
        before: old ? { kind: old.kind, ...excerpt(old.text) } : null,
        after: next ? { kind: next.kind, ...excerpt(next.text) } : null,
      },
    ];
  });
}
function outcome(o: Outcome) {
  return {
    executionStatus: o.executionStatus,
    gradingStatus: o.gradingStatus,
    reward: o.reward,
    error: o.error,
    usage: o.usage,
    outputRef: o.outputRef,
  };
}
function evidence(c: Comparison) {
  const side = (which: 'parent' | 'candidate') => {
    const outcomes = c.results.map((r) => r[which]);
    const scores = outcomes.flatMap((o) => (typeof o.reward === 'number' ? [o.reward] : []));
    const usage = (key: 'inputTokens' | 'outputTokens' | 'costUsd') => ({
      knownTotal: outcomes.reduce((sum, o) => sum + (o.usage?.[key] ?? 0), 0),
      unknownCount: outcomes.filter((o) => o.usage?.[key] == null).length,
    });
    return {
      scored: scores.length,
      meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      taskFailures: outcomes.filter((o) => o.executionStatus === 'task_failed').length,
      infrastructureFailures: outcomes.filter((o) => o.executionStatus === 'infrastructure_failed')
        .length,
      missingGrades: outcomes.filter((o) => o.gradingStatus !== 'scored').length,
      inputTokens: usage('inputTokens'),
      outputTokens: usage('outputTokens'),
      costUsd: usage('costUsd'),
    };
  };
  return {
    id: c.id,
    complete: c.complete,
    datasetRevision: c.datasetRevision,
    runtime: c.runtime,
    graderRevision: c.graderRevision,
    expectedPairs: c.expectedCases.length,
    observedPairs: c.results.length,
    missingPairs: c.expectedCases.length - c.results.length,
    parent: side('parent'),
    candidate: side('candidate'),
    expectedCases: c.expectedCases,
    results: c.results.map((r) => ({
      caseId: r.caseId,
      repetition: r.repetition,
      parent: outcome(r.parent),
      candidate: outcome(r.candidate),
    })),
  };
}
async function savePrivate(path: string, content: string) {
  if (process.platform === 'win32') throw new Error('Private artifact writes require POSIX');
  const target = resolve(path),
    dir = dirname(target);
  let current = '/';
  for (const part of dir.split('/').filter(Boolean)) {
    current = resolve(current, part);
    const s = await lstat(current);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new Error('Artifact path contains a symlink or non-directory');
  }
  const s = await lstat(dir);
  if ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid()))
    throw new Error('Artifact directory must be private and owned by the current user');
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}
export async function run(args: string[], client?: AcclimateClient) {
  const { command, flags } = parseArgs([...args]);
  const workspace = required(flags, 'workspace'),
    bundle = required(flags, 'bundle');
  client ??= new AcclimateClient({
    baseUrl: env('ACCLIMATE_URL'),
    token: env('ACCLIMATE_TOKEN'),
    scope: env('ACCLIMATE_SCOPE'),
  });
  let result: unknown;
  if (command === 'request-proposal') {
    const request: ProposalRequest = {
      parentVersionId: required(flags, 'parent'),
      allowedPaths: flags.path ?? [],
      hypothesis: required(flags, 'hypothesis'),
      evidence: flags.evidence ?? [],
    };
    if (!request.allowedPaths.length) throw new Error('At least one --path is required');
    result = await client.createProposal(
      workspace,
      bundle,
      request,
      one(flags, 'key') ?? randomUUID(),
    );
  } else if (command === 'proposal')
    result = await client.getProposal(workspace, bundle, required(flags, 'id'));
  else if (command === 'history') {
    const limit = one(flags, 'limit');
    if (limit && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit))
      throw new Error('--limit must be 1..100');
    const beforeRevision = one(flags, 'before');
    if (beforeRevision && !/^[1-9][0-9]*$/.test(beforeRevision))
      throw new Error('--before must be a positive canonical revision');
    result = await client.listReleases(workspace, bundle, required(flags, 'channel'), {
      ...(limit ? { limit: Number(limit) } : {}),
      ...(beforeRevision ? { beforeRevision } : {}),
    });
  } else if (command === 'review') {
    const channel = required(flags, 'channel'),
      comparison = await client.getComparison(workspace, bundle, required(flags, 'comparison'));
    if (comparison.id !== required(flags, 'comparison'))
      throw new Error('Comparison identity mismatch');
    const [parent, candidate, current, proposal] = await Promise.all([
      verified(client, workspace, bundle, comparison.parentVersionId),
      verified(client, workspace, bundle, comparison.candidateVersionId),
      client.resolveChannel(workspace, bundle, channel),
      one(flags, 'proposal') ? client.getProposal(workspace, bundle, one(flags, 'proposal')!) : null,
    ]);
    if (
      parent.version.digest !== comparison.parentDigest ||
      candidate.version.digest !== comparison.candidateDigest ||
      candidate.version.parentVersionId !== parent.version.id
    )
      throw new Error('Comparison versions or digests do not match verified payloads');
    if (!current.resolution || current.resolution.channel !== channel)
      throw new Error('Invalid channel resolution');
    if (
      proposal &&
      (proposal.id !== one(flags, 'proposal') ||
        proposal.parentVersionId !== parent.version.id ||
        proposal.candidate?.id !== candidate.version.id ||
        proposal.candidate.digest !== candidate.version.digest)
    )
      throw new Error('Proposal does not identify the compared candidate');
    let policyReview;
    try {
      const [receipts, blockers] = await Promise.all([
        client.listComparisonPolicyReceipts(workspace, bundle, comparison.id),
        client.listCandidatePolicyReceipts(workspace, bundle, candidate.version.id),
      ]);
      policyReview = { status: 'available', receipts: receipts.items, blockers: blockers.items };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      policyReview = { status: 'unavailable' };
    }
    result = {
      workspace,
      bundle,
      channel,
      current: current.resolution,
      parent: parent.version,
      candidate: candidate.version,
      proposal,
      comparison: evidence(comparison),
      policyReview,
      changes: changes(parent.payload, candidate.payload),
    };
  } else {
    const channel = required(flags, 'channel'),
      versionId = required(flags, 'version'),
      expectedRevision = required(flags, 'expected-revision');
    if (!/^(0|[1-9][0-9]*)$/.test(expectedRevision))
      throw new Error('--expected-revision must be a canonical revision');
    let policyOverride: PolicyOverride | undefined;
    if (flags['ack-policy'] || flags['override-reason']) {
      const reason = required(flags, 'override-reason');
      if (!flags['ack-policy']?.length) throw new Error('Acknowledge each reviewed receipt with --ack-policy COMPARISON_ID@sha256:DIGEST');
      const receipts = flags['ack-policy'].map((value) => {
        const match = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})@(sha256:[a-f0-9]{64})$/.exec(value);
        if (!match) throw new Error('Expected --ack-policy COMPARISON_ID@sha256:DIGEST');
        return { comparisonId: match[1], policyDigest: match[2] };
      });
      policyOverride = { reason, receipts };
    }
    const request =
      command === 'promote'
        ? { versionId, expectedRevision, comparisonId: required(flags, 'comparison'), ...(policyOverride ? { policyOverride } : {}) }
        : { versionId, expectedRevision, unevaluatedReason: required(flags, 'reason') };
    result = await client.createRelease(
      workspace,
      bundle,
      channel,
      request,
      one(flags, 'key') ?? randomUUID(),
    );
  }
  // JSON escapes C0 controls; additionally escape terminal control and bidi characters.
  const text =
    JSON.stringify(result, null, flags.json ? 0 : 2).replace(
      /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ) + '\n';
  if (one(flags, 'output')) await savePrivate(one(flags, 'output')!, text);
  return text;
}
export const operatorUsage = [
  'Usage: acclimate-operator COMMAND --workspace ID --bundle ID [options] [--json] [--output FILE]',
  '',
  'Commands:',
  '  request-proposal --parent VERSION --path PATH... --hypothesis TEXT --evidence TEXT... [--key KEY]',
  '  proposal --id PROPOSAL',
  '  review --channel NAME --comparison COMPARISON [--proposal PROPOSAL]',
  '  history --channel NAME [--limit 1..100] [--before REVISION]',
  '  promote --channel NAME --version CANDIDATE --comparison COMPARISON --expected-revision REVISION',
  '          [--override-reason TEXT --ack-policy COMPARISON_ID@sha256:DIGEST...] [--key KEY]',
  '  rollback --channel NAME --version PREVIOUS --reason TEXT --expected-revision REVISION [--key KEY]',
  '',
  'Set ACCLIMATE_URL, ACCLIMATE_TOKEN and ACCLIMATE_SCOPE. Output is JSON; errors go to stderr.',
].join('\n');

/** Run one operator command and write its JSON result. Returns the process exit status. */
export async function operatorMain(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(operatorUsage + '\n');
    return argv.length ? 0 : 1;
  }
  try {
    process.stdout.write(await run(argv));
    return 0;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n',
    );
    return 1;
  }
}
