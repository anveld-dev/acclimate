import { grade, policy, type Batch, type Incident } from './domain.js';

export type Observation = { batch: Batch; grade: ReturnType<typeof grade> };
export type Finding = ReturnType<typeof grade>['outcomes'][number] & { incident: Incident };
export function findings(observations: Observation[]): Finding[] {
  return observations.flatMap((o) =>
    o.grade.outcomes.map((outcome) => ({
      ...outcome,
      incident: o.batch.incidents.find((i) => i.id === outcome.id)!,
    })),
  );
}
export function learningEvidence(input: {
  observations: Observation[];
  rejected: Finding[];
  round: number;
  bytes: number;
  error?: unknown;
}) {
  const current = findings(input.observations),
    mistakes = current.filter((o) => !o.correct),
    correct = current.filter((o) => o.correct);
  const offset = (input.round - 1) % Math.max(1, mistakes.length);
  const examples = [...mistakes.slice(offset), ...mistakes.slice(0, offset)].slice(0, 6);
  const rejected = [...input.rejected]
    .reverse()
    .sort((a, b) => Number(b.unsafe) - Number(a.unsafe))
    .slice(0, 4);
  const compact = (o: Finding) => ({
    ...o,
    actual: o.actual ? { ...o.actual, reason: o.actual.reason.slice(0, 500) } : null,
  });
  const evidence = [
    ...policy,
    JSON.stringify({
      currentCorrect: correct.length,
      total: 24,
      currentBytes: input.bytes,
      round: input.round,
    }),
    ...rejected.map((o) => JSON.stringify({ rejectedCandidateMistake: compact(o) })),
    ...examples.map((o) => JSON.stringify({ approvedDevelopmentCorrection: compact(o) })),
    ...correct.slice(0, 2).map((o) => JSON.stringify({ preserveBehavior: compact(o) })),
    ...(input.error
      ? [JSON.stringify({ previousProposalError: String(input.error).slice(0, 1000) })]
      : []),
  ];
  if (evidence.length > 20 || evidence.some((s) => s.length > 4096))
    throw new Error('Feedback exceeds the real proposal API limits');
  return evidence;
}
