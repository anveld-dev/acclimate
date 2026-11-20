import { validateOperationTarget } from './operation-target';
// Only submitted text lives here. Unresolved metadata outlives explicit text forgetting.
const owners = ['releases', 'library'] as const;
export type PendingScope = {
  owner: (typeof owners)[number];
  actorScope: string;
  workspaceId: string;
  bundleId?: string;
  channel?: string;
  serviceIdentity: string;
};
export type PendingOperation = {
  version: 1;
  scope: PendingScope;
  action: string;
  key: string;
  createdAt: number;
  body?: string;
};
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const PREFIX = 'acclimate:operation:v1:';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
function slot(scope: PendingScope) {
  return (
    PREFIX +
    JSON.stringify([
      scope.actorScope,
      scope.serviceIdentity,
      scope.workspaceId,
      scope.bundleId,
      scope.channel,
      scope.owner,
    ])
  );
}

export function loadPending(storage: PendingStorage, scope: PendingScope): PendingOperation | null {
  const raw = storage.getItem(slot(scope));
  if (!raw) return null;
  const record = JSON.parse(raw) as PendingOperation;
  if (
    record.version !== 1 ||
    !record.scope ||
    slot(record.scope) !== slot(scope) ||
    !/^[a-f0-9-]{36}$/i.test(record.key) ||
    typeof record.action !== 'string' ||
    !Number.isFinite(record.createdAt)
  )
    throw Error('Invalid recovery record.');
  validateOperationTarget(scope.workspaceId, record.action, scope);
  if (record.body && Date.now() - record.createdAt > MAX_AGE) return forgetPending(storage, scope);
  return record;
}
export function freezePending(
  storage: PendingStorage,
  scope: PendingScope,
  action: string,
  body: unknown,
  key: string = crypto.randomUUID(),
): PendingOperation {
  return freezePendingExact(storage, scope, action, JSON.stringify(body), key);
}

// Accept already serialized requests so recovery replays retain their exact bytes.
export function freezePendingExact(
  storage: PendingStorage,
  scope: PendingScope,
  action: string,
  exact: string | undefined,
  key: string = crypto.randomUUID(),
): PendingOperation {
  try {
    validateOperationTarget(scope.workspaceId, action, scope);
  } catch {
    throw Error('Unsupported pending operation.');
  }
  if (!exact || new TextEncoder().encode(exact).length > MAX_BYTES)
    throw Error('Submitted request exceeds recovery storage limit.');
  JSON.parse(exact);
  const existing = loadPending(storage, scope);
  if (existing) {
    if (existing.key === key && existing.action === action && existing.body === exact)
      return existing;
    throw Error('Resolve or close the earlier operation before submitting another request.');
  }
  const record: PendingOperation = {
    version: 1,
    scope,
    action,
    key,
    createdAt: Date.now(),
    body: exact,
  };
  // Metadata first: if writing text fails, no request may be sent, and uncertainty remains explicit.
  storage.setItem(slot(scope), JSON.stringify({ ...record, body: undefined }));
  storage.setItem(slot(scope), JSON.stringify(record));
  if (storage.getItem(slot(scope)) !== JSON.stringify(record))
    throw Error('Recovery storage could not be verified.');
  return record;
}
export function forgetPending(
  storage: PendingStorage,
  scope: PendingScope,
): PendingOperation | null {
  const raw = storage.getItem(slot(scope));
  if (!raw) return null;
  const record = { ...JSON.parse(raw), body: undefined } as PendingOperation;
  storage.setItem(slot(scope), JSON.stringify(record));
  return record;
}
// Only call once a commit, definitive rejection, or authenticated close is confirmed.
export function resolvePending(storage: PendingStorage, scope: PendingScope) {
  storage.removeItem(slot(scope));
}
export function clearPendingOperations(storage: PendingStorage = sessionStorage, broadcast = true) {
  if (broadcast && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('acclimate:pending-purge');
    channel.postMessage('purge');
    channel.close();
  }
  // Account changes erase text while retaining scoped uncertainty for reconciliation.
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const record = JSON.parse(storage.getItem(key)!);
      delete record.body;
      storage.setItem(key, JSON.stringify(record));
    } catch {
      storage.removeItem(key);
    }
  }
}

// Mount once in the signed-in shell/account menu. A logout in any tab purges that tab's text too.
export function listenForPendingPurge(storage: PendingStorage = sessionStorage): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel('acclimate:pending-purge');
  channel.onmessage = () => clearPendingOperations(storage, false);
  return () => channel.close();
}
