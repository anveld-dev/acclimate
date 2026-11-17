export const cases = [
  { caseId: 'lost-response', input: { scenario: 'lost-response' }, expected: { charges: 1, succeeded: true } },
  { caseId: 'clean', input: { scenario: 'clean' }, expected: { charges: 1, succeeded: true } },
];

export function gradeResult(output, expected) {
  return {
    reward: Number(output.charges === expected.charges && output.succeeded === expected.succeeded),
    explanation: { singleCharge: output.charges === 1, succeeded: output.succeeded === true },
  };
}
