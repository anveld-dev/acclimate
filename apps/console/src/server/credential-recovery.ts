/** Metadata only: a credential secret must never enter browser storage. */
export type CredentialRecovery = {
  key: string;
  kind: 'content-read' | 'receipt-write';
  credentialId?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function credentialRecoveryKey(actor: string, project: string, integration: string) {
  return `acclimate.credential-recovery.v1:${JSON.stringify([actor, project, integration])}`;
}
export function readCredentialRecovery(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): CredentialRecovery | undefined {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    if (
      !value ||
      !uuid.test(value.key) ||
      !['content-read', 'receipt-write'].includes(value.kind) ||
      (value.credentialId !== undefined && !uuid.test(value.credentialId))
    )
      return;
    return {
      key: value.key,
      kind: value.kind,
      ...(value.credentialId ? { credentialId: value.credentialId } : {}),
    };
  } catch {
    return;
  }
}
export function saveCredentialRecovery(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  value: CredentialRecovery,
) {
  // Explicit projection prevents secrets and arbitrary server payloads being retained.
  storage.setItem(
    key,
    JSON.stringify({
      key: value.key,
      kind: value.kind,
      ...(value.credentialId ? { credentialId: value.credentialId } : {}),
    }),
  );
}
