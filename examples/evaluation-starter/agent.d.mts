import type { VerifiedBundle } from '@acclimate/sdk';
export function runExistingAgent(input: {
  bundle: VerifiedBundle;
  task: { scenario: string };
  signal?: AbortSignal;
}): Promise<{ charges: number; succeeded: boolean; events: Array<{ attempt: number; event: string }> }>;
