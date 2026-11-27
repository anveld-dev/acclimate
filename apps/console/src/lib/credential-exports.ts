import type { ConnectionCredentialKind } from '@anveld/sdk';

/** Quote a value for a POSIX shell: single quotes, with each embedded quote closed and escaped. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One `export` line with everything the delivery checks and SDKs read for a connection.
 * A receipt credential goes in ACCLIMATE_RECEIPT_TOKEN, a read credential in ACCLIMATE_TOKEN.
 */
export function credentialShellExports(values: {
  url: string;
  workspaceId: string;
  bundleId: string;
  connectionId: string;
  kind: ConnectionCredentialKind;
  secret: string;
}): string {
  const settings: [string, string][] = [
    ['ACCLIMATE_URL', values.url],
    ['ACCLIMATE_WORKSPACE', values.workspaceId],
    ['ACCLIMATE_BUNDLE', values.bundleId],
    ['ACCLIMATE_CONNECTION', values.connectionId],
    [values.kind === 'receipt-write' ? 'ACCLIMATE_RECEIPT_TOKEN' : 'ACCLIMATE_TOKEN', values.secret],
  ];
  return 'export ' + settings.map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ');
}
