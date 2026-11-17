import type { Decision, Incident } from './domain.js';

type Classification = Incident['situation'];
type Signal =
  | { transport: 'gateway-journal'; records: string[] }
  | { transport: 'queue-delivery'; processorDeliveries: number; processorReceipt: string | null }
  | { transport: 'terminal-serial'; processorReceiptFrame: string | null; lastCheckpoint: string }
  | { transport: 'support-transcript'; transcript: string };

type FreshCase = {
  id: string;
  classification: Classification;
  input: { signal: Signal; requestKey: string };
};

/** Frozen held-out families and labels. Pass only each case's input to the model. */
export const freshCases: readonly FreshCase[] = [
  {
    id: 'fj-41',
    classification: 'response-lost',
    input: {
      requestKey: 'web-eu/04A620',
      signal: {
        transport: 'gateway-journal',
        records: ['edge:received', 'processor:request-delivered', 'edge:result-read-timed-out'],
      },
    },
  },
  {
    id: 'fq-78',
    classification: 'transient-before-charge',
    input: {
      requestKey: 'q/008190',
      signal: { transport: 'queue-delivery', processorDeliveries: 0, processorReceipt: null },
    },
  },
  {
    id: 'ft-63',
    classification: 'clean',
    input: {
      requestKey: 'Store7:005ABC',
      signal: {
        transport: 'terminal-serial',
        processorReceiptFrame: 'POSTED/00482',
        lastCheckpoint: 'processor-receipt-read',
      },
    },
  },
  {
    id: 'fs-42',
    classification: 'transient-before-charge',
    input: {
      requestKey: 'callcenter/3_752',
      signal: {
        transport: 'support-transcript',
        transcript:
          'Intake created ticket 1408. The outage interrupted the local send; the worker confirmed it never opened a processor connection for this request.',
      },
    },
  },
  {
    id: 'fj-95',
    classification: 'clean',
    input: {
      requestKey: 'web-us/013CC-new',
      signal: {
        transport: 'gateway-journal',
        records: ['edge:received', 'processor:request-delivered', 'processor:posted'],
      },
    },
  },
  {
    id: 'fq-24',
    classification: 'response-lost',
    input: {
      requestKey: 'q/08dF_92',
      signal: { transport: 'queue-delivery', processorDeliveries: 1, processorReceipt: null },
    },
  },
  {
    id: 'ft-39',
    classification: 'transient-before-charge',
    input: {
      requestKey: 'Store2:17F-new',
      signal: {
        transport: 'terminal-serial',
        processorReceiptFrame: null,
        lastCheckpoint: 'stopped-before-processor-dispatch',
      },
    },
  },
  {
    id: 'fs-86',
    classification: 'clean',
    input: {
      requestKey: 'callcenter/0186.B',
      signal: {
        transport: 'support-transcript',
        transcript:
          'The customer closed the page before the receipt displayed. Support retrieved the definitive posting confirmation directly from the processor for this request.',
      },
    },
  },
  {
    id: 'fj-27',
    classification: 'transient-before-charge',
    input: {
      requestKey: 'web-apac/0F022',
      signal: {
        transport: 'gateway-journal',
        records: [
          'edge:received',
          'edge:connection-pool-unavailable',
          'edge:closed-before-processor-dispatch',
        ],
      },
    },
  },
  {
    id: 'fq-51',
    classification: 'clean',
    input: {
      requestKey: 'q/009021-B',
      signal: { transport: 'queue-delivery', processorDeliveries: 1, processorReceipt: '000073' },
    },
  },
  {
    id: 'ft-72',
    classification: 'response-lost',
    input: {
      requestKey: 'Store8:0FF9-new',
      signal: {
        transport: 'terminal-serial',
        processorReceiptFrame: null,
        lastCheckpoint: 'request-delivered-to-processor',
      },
    },
  },
  {
    id: 'fs-19',
    classification: 'response-lost',
    input: {
      requestKey: 'callcenter/24_06',
      signal: {
        transport: 'support-transcript',
        transcript:
          'The processor acknowledged delivery. The return connection dropped before the result arrived. Intake can only find internal ticket 6401.',
      },
    },
  },
];

const sharedPolicyActions: Record<Classification, Decision['action']> = {
  clean: 'accept',
  'response-lost': 'reuse-original-key',
  'transient-before-charge': 'reconcile-then-retry',
};

/** Compare against the standing domain goal using manually assigned case labels. */
export function freshExpected({ classification, input }: FreshCase): Decision {
  return { action: sharedPolicyActions[classification], key: input.requestKey };
}

export const freshQualificationCriteria = {
  targetCasesRequired: 4,
  minimumTargetRepairs: 1,
  cleanGuardsRequired: 4,
  otherFailureGuardsRequired: 4,
  matchFields: ['action', 'key'],
  cleanGuard: 'Candidate matches both the shared policy and pinned decision.',
  otherFailureGuard: 'Candidate matches the pinned decision.',
} as const;

type FreshObservation = { id: string; pinned: Decision; candidate: Decision };
type TargetClassification = Exclude<Classification, 'clean'>;

function decisionsMatch(left: Decision, right: Decision) {
  return left.action === right.action && left.key === right.key;
}

export function scoreFreshCandidate(
  target: TargetClassification,
  observations: readonly FreshObservation[],
) {
  const observationsById = new Map(
    observations.map((observation) => [observation.id, observation]),
  );
  if (observations.length !== freshCases.length || observationsById.size !== freshCases.length)
    throw new Error('Expected one pinned and candidate decision for every frozen case');

  const rows = freshCases.map((fixture) => {
    const observation = observationsById.get(fixture.id);
    if (!observation) throw new Error(`Missing observation: ${fixture.id}`);
    const expected = freshExpected(fixture);
    return {
      id: fixture.id,
      classification: fixture.classification,
      pinnedCorrect: decisionsMatch(observation.pinned, expected),
      candidateCorrect: decisionsMatch(observation.candidate, expected),
      behaviorPreserved: decisionsMatch(observation.pinned, observation.candidate),
    };
  });
  const targeted = rows.filter((row) => row.classification === target);
  const targetCorrect = targeted.filter((row) => row.candidateCorrect).length;
  const targetRepairs = targeted.filter((row) => row.candidateCorrect && !row.pinnedCorrect).length;
  const cleanGuardsPassed = rows.filter(
    (row) => row.classification === 'clean' && row.candidateCorrect && row.behaviorPreserved,
  ).length;
  const otherFailureGuardsPassed = rows.filter(
    (row) =>
      row.classification !== target && row.classification !== 'clean' && row.behaviorPreserved,
  ).length;
  return {
    passed:
      targetCorrect === freshQualificationCriteria.targetCasesRequired &&
      targetRepairs >= freshQualificationCriteria.minimumTargetRepairs &&
      cleanGuardsPassed === freshQualificationCriteria.cleanGuardsRequired &&
      otherFailureGuardsPassed === freshQualificationCriteria.otherFailureGuardsRequired,
    targetCorrect,
    targetRepairs,
    cleanGuardsPassed,
    otherFailureGuardsPassed,
    pinnedSharedPolicyCorrect: rows.filter((row) => row.pinnedCorrect).length,
    candidateSharedPolicyCorrect: rows.filter((row) => row.candidateCorrect).length,
    rows,
  };
}
