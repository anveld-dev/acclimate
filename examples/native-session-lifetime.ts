export class ExecutionUncertainError extends Error {
  constructor() { super('Native execution may still be running.'); }
}

/**
 * Application-owned native work must settle successfully before its inputs are
 * removed. A failed SDK await is not proof that external work stopped.
 * Durable job discovery/quarantine is supplied by the native-repository starter.
 */
export async function withNativeSessionInputs<T>(
  prepared: { cleanup(): Promise<void> },
  execute: () => Promise<T>,
): Promise<T> {
  let settled = false;
  try {
    const value = await execute();
    settled = true;
    return value;
  } catch {
    throw new ExecutionUncertainError();
  } finally {
    if (settled) await prepared.cleanup();
  }
}
