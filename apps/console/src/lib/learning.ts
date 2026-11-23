import type {
  LearningEvaluation,
  LearningEvolveCasesRequest,
  LearningLoopRequest,
} from '@acclimate/sdk';

export type LearningScope = { workspaceId: string; bundleId: string };
export type LearningReadOptions = { round?: string; memory?: string };
export const activeRoundStates = [
  'scoring_incumbent',
  'proposing',
  'screening',
  'evaluating',
  'selecting',
  'scoring_held_out',
] as const;
export type ActiveEvaluation = Pick<
  LearningEvaluation,
  'role' | 'sample' | 'split' | 'status' | 'cases' | 'reportedCases'
>;
export type LearningCommand =
  | { action: 'enroll'; body: LearningLoopRequest }
  | { action: 'pause' | 'resume' | 'stop' }
  | { action: 'addCase'; caseId: string; input: string; expected: string }
  | { action: 'retireCase'; caseId: string };

const bytes = (value: string) => new TextEncoder().encode(value).length;
export function enrollmentError(body: LearningLoopRequest) {
  if (!body || typeof body.channel !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.channel))
    return 'Choose a published learning channel.';
  if (
    typeof body.appPrincipalId !== 'string' ||
    !body.appPrincipalId.trim() ||
    bytes(body.appPrincipalId) > 1024
  )
    return 'Enter an app principal ID of at most 1,024 bytes.';
  for (const field of ['domain', 'benchmark', 'policyModel'] as const) {
    const value = body.setting?.[field];
    if (typeof value !== 'string' || !value.trim() || bytes(value) > 256 || /\p{Cc}/u.test(value))
      return 'Domain, benchmark and policy model must each be 1–256 bytes without control characters.';
  }
  if (
    typeof body.heldOut?.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(body.heldOut.digest)
  )
    return 'Enter the SHA-256 digest printed by the evaluator.';
  if (!Number.isInteger(body.heldOut.cases) || body.heldOut.cases < 1 || body.heldOut.cases > 10000)
    return 'Enter a held-out case count from 1 to 10,000.';
  return undefined;
}

export function evolveCaseBody(
  command: Extract<LearningCommand, { action: 'addCase' | 'retireCase' }>,
): LearningEvolveCasesRequest {
  if (typeof command.caseId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.caseId))
    throw new Error('Enter a valid evolve case ID.');
  if (command.action === 'retireCase') return { retire: [command.caseId] };
  if (command.caseId.startsWith('outcome:')) throw new Error('The outcome: prefix is reserved.');
  const { input, expected } = command;
  if (
    typeof input !== 'string' ||
    typeof expected !== 'string' ||
    bytes(input) > 65536 ||
    bytes(expected) > 65536
  )
    throw new Error('Input and expected result must each fit in 64 KiB.');
  const reviver = (_key: string, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Invalid JSON number');
    return value;
  };
  try {
    return {
      cases: [
        {
          caseId: command.caseId,
          input: JSON.parse(input, reviver),
          expected: JSON.parse(expected, reviver),
        },
      ],
    };
  } catch {
    throw new Error('Enter valid JSON for both input and expected result.');
  }
}
