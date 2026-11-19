import type { InstalledAdapter } from '../../examples/evaluation/adapter.js';
import { localEvaluationDescriptor, presenceDescriptor } from './descriptors.js';
import type { BundlePayload } from '../../packages/sdk/src/types.js';

export interface ChargeTrace {
  policyError?: string;
  charges: number;
  succeeded: boolean;
  events: Array<{ attempt: number; key: string | null; event: string }>;
}

/** Executes declarative policy against an in-memory payment processor, with observable effects. */
export function simulatePayment(payload: BundlePayload, scenario: string): ChargeTrace {
  const trace: ChargeTrace = { charges: 0, succeeded: false, events: [] };
  let policy: { maxAttempts: number; idempotency: 'request' | 'attempt' | 'none' };
  try {
    const file = payload.files.find((file) => file.path === 'payment-policy.json');
    if (!file) throw new Error('Missing installed payment-policy.json data');
    const value = JSON.parse(file.text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'idempotency,maxAttempts' ||
        !Number.isInteger(value.maxAttempts) || Number(value.maxAttempts) < 1 || Number(value.maxAttempts) > 3 ||
        !['request', 'attempt', 'none'].includes(String(value.idempotency)))
      throw new Error('Invalid declarative payment policy');
    policy = value as unknown as typeof policy;
  } catch {
    return { ...trace, policyError: 'Missing or invalid declarative payment policy' };
  }
  const chargedKeys = new Set<string>();
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const key = policy.idempotency === 'request' ? 'request-1' : policy.idempotency === 'attempt' ? `attempt-${attempt}` : null;
    if (scenario === 'transient-before-charge' && attempt === 1) {
      trace.events.push({ attempt, key, event: 'transient-failure-before-charge' });
      continue;
    }
    if (key && chargedKeys.has(key)) trace.events.push({ attempt, key, event: 'deduplicated' });
    else {
      trace.charges++;
      if (key) chargedKeys.add(key);
      trace.events.push({ attempt, key, event: 'charged' });
    }
    if (scenario === 'response-lost' && attempt === 1) {
      trace.events.push({ attempt, key, event: 'response-lost-after-charge' });
      continue;
    }
    trace.succeeded = true;
    trace.events.push({ attempt, key, event: 'success-response' });
    break;
  }
  return trace;
}

export const paymentAdapter: InstalledAdapter = {
  describe: () => structuredClone(localEvaluationDescriptor),
  cases: ['response-lost', 'transient-before-charge', 'clean'].map((caseId) => ({
    caseId, snapshot: { scenario: caseId }, settings: {}, repetitions: 2,
  })),
  execute: async ({ bundle, snapshot }) => ({
    output: simulatePayment(bundle.payload, (snapshot as { scenario: string }).scenario),
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  }),
  grade: async ({ output }) => {
    const trace = output as ChargeTrace;
    return { reward: Number(!trace.policyError && trace.charges === 1 && trace.succeeded) };
  },
};

export const presenceAdapter: InstalledAdapter = {
  describe: () => structuredClone(presenceDescriptor),
  cases: ['instructions-present', 'skills-present'].map((caseId) => ({
    caseId, snapshot: { kind: caseId === 'instructions-present' ? 'instruction' : 'skill' }, settings: {}, repetitions: 2,
  })),
  execute: async ({ bundle, snapshot }) => ({
    output: { present: bundle.payload.files.some((f) => f.kind === (snapshot as { kind: string }).kind && f.text.trim().length > 0) },
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  }),
  grade: async ({ output }) => ({ reward: Number((output as { present: boolean }).present) }),
};
