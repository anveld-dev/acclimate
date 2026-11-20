/** Optional observation has its own credential, deadline and failure boundary. */
import { AcclimateClient, createReceiptReporter } from '@acclimate/sdk';

/** Environment variables renamed in 0.2.0, old name first. */
const RENAMED_ENVIRONMENT = [
  ['ACCLIMATE_PROJECT', 'ACCLIMATE_WORKSPACE'],
  ['ACCLIMATE_PROJECT_ID', 'ACCLIMATE_WORKSPACE_ID'],
  ['ACCLIMATE_INTEGRATION', 'ACCLIMATE_CONNECTION'],
] as const;

/** Fail on a pre-0.2.0 variable name rather than silently ignoring it. */
export function rejectRenamedEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const [old, current] of RENAMED_ENVIRONMENT)
    if (env[old] && !env[current]) throw new Error(`${old} was renamed to ${current} in 0.2.0`);
}

export function optionalReceipts(env: NodeJS.ProcessEnv, workspaceId: string) {
  if (!env.ACCLIMATE_RECEIPT_TOKEN && !env.ACCLIMATE_CONNECTION) return undefined;
  try {
    if (!env.ACCLIMATE_RECEIPT_TOKEN || !env.ACCLIMATE_CONNECTION)
      throw new Error('Both receipt token and connection ID are required');
    return createReceiptReporter({
      client: new AcclimateClient({
        baseUrl: env.ACCLIMATE_URL ?? 'http://127.0.0.1:3000',
        token: env.ACCLIMATE_RECEIPT_TOKEN,
        scope: `${env.ACCLIMATE_SCOPE ?? 'demo-app'}:receipts`,
        timeoutMs: 1000,
        retries: 0,
      }),
      workspaceId,
      connectionId: env.ACCLIMATE_CONNECTION,
    });
  } catch {
    console.error('Optional delivery reporting is unavailable.');
    return undefined;
  }
}

export function observeOptional(action: () => unknown): void {
  try {
    Promise.resolve(action()).catch(() => {});
  } catch {}
}

/** Give optional observations a short chance to finish before a CLI exits. */
export async function settleOptional(reporter: ReturnType<typeof optionalReceipts>): Promise<void> {
  if (!reporter) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reporter.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1200);
      }),
    ]);
  } catch {
  } finally {
    if (timer) clearTimeout(timer);
    reporter.close();
  }
}

/** Called by actual app events; repeated observations report only one start. */
export function observeStartOnce(
  matches: (event: { type: string; status?: string }) => boolean,
  reportStarted: () => unknown,
) {
  let started = false;
  return (event: { type: string; status?: string }) => {
    if (!started && matches(event)) {
      started = true;
      observeOptional(reportStarted);
    }
  };
}
