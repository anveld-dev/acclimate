/** Rights an evaluator token can carry. `evaluate` is the least-privilege choice for CI. */
export const MACHINE_TOKEN_RIGHTS = ['evaluate', 'read', 'write', 'propose', 'promote'] as const;
export type MachineTokenRight = (typeof MACHINE_TOKEN_RIGHTS)[number];

export type EvaluatorConfigInput = {
  publicApiUrl: string;
  workspaceId: string;
  principalId: string;
  journalRoot: string;
  /** Omit to read the token from ACCLIMATE_EVALUATOR_TOKEN or `evaluatorTokenFile`. */
  token?: string;
};

export function validJournalRoot(value: string) {
  return value.startsWith('/') && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The private evaluator.json the SDK evaluator CLI reads. Keep it mode 0600 in a 0700 directory. */
export function evaluatorConfig(input: EvaluatorConfigInput): string {
  if (!validJournalRoot(input.journalRoot))
    throw new Error('Journal directory must be an absolute path.');
  // Match the console's request handoffs exactly; evaluators compare the two.
  const serviceUrl = new URL(input.publicApiUrl).origin;
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        serviceUrl,
        workspaceId: input.workspaceId,
        evaluatorPrincipalId: input.principalId,
        ...(input.token ? { evaluatorToken: input.token } : {}),
        journalRoot: input.journalRoot,
      },
      null,
      2,
    ) + '\n'
  );
}
