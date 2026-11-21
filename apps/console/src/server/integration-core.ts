import { consoleClient } from './console-client';
import { allPages } from './listing';
import { ApiError } from '@acclimate/sdk';
import type {
  AcclimateClient,
  DeliveryReceipt,
  Connection,
  ConnectionObservation,
  ConnectionCredential,
  Page,
} from '@acclimate/sdk';
import { requireSession, actorScope, type Environment } from './selection';

export type IntegrationCommand =
  | { action: 'create'; displayName: string; key: string }
  | {
      action: 'issue';
      id: string;
      kind: 'content-read' | 'receipt-write';
      key: string;
      replacementOf?: string;
    }
  | { action: 'revoke'; id: string; key: string }
  | { action: 'revokeCredential'; id: string; credentialId: string; key: string }
  | { action: 'receipts'; id: string; cursor?: string };
export type IssuedCredentialMetadata = {
  credentialId: string;
  kind: 'content-read' | 'receipt-write';
  revokedAt: string | null;
};
export type IntegrationResult =
  | { ok: false; message: string; issuedCredential?: IssuedCredentialMetadata }
  | {
      ok: true;
      credential?: ConnectionCredential;
      receipts?: Page<DeliveryReceipt>;
      integration?: Connection;
    };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Preserve the terminal page allowed after 1000 continuation cursors.
const MAX_LISTING_PAGES = 1001;
function failure(error?: unknown): IntegrationResult {
  if (error instanceof ApiError && error.code === 'credential_already_issued')
    return {
      ok: false,
      message:
        'This credential was already issued. Its secret is unavailable. Confirm revocation before creating a replacement.',
      issuedCredential: issuedMetadata(error.details),
    };
  return {
    ok: false,
    message:
      error instanceof ApiError && [401, 403].includes(error.status)
        ? 'Access denied. Connection administration requires a current workspace administrator.'
        : 'Could not confirm the service response. Refresh to check current connections before repeating an action.',
  };
}
function issuedMetadata(value: unknown): IssuedCredentialMetadata | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.credentialId !== 'string' ||
    !uuid.test(record.credentialId) ||
    !['content-read', 'receipt-write'].includes(String(record.kind)) ||
    !(
      record.revokedAt === null ||
      (typeof record.revokedAt === 'string' && Number.isFinite(Date.parse(record.revokedAt)))
    )
  )
    return;
  return {
    credentialId: record.credentialId,
    kind: record.kind as IssuedCredentialMetadata['kind'],
    revokedAt: record.revokedAt as string | null,
  };
}
async function context(env: Environment, fetcher: typeof fetch) {
  if (!env.CONSOLE_WORKSPACE || !env.CONSOLE_BUNDLE) throw Error('Select a workspace');
  const workspace = await workspaceContext(env, env.CONSOLE_WORKSPACE, fetcher);
  const bundleId = env.CONSOLE_BUNDLE,
    channel = env.CONSOLE_CHANNEL || 'stable';
  return {
    ...workspace,
    bundleId,
    channel,
    integrations: workspace.integrations.filter(
      (i) => i.bundleId === bundleId && i.channel === channel,
    ),
  };
}
async function workspaceContext(env: Environment, workspaceId: string, fetcher: typeof fetch) {
  requireSession(env);
  if (!validScopePart(workspaceId) || !env.CONSOLE_SERVICE_TOKEN) throw Error('Select a workspace');
  const client = consoleClient(env, fetcher);
  const projects = await allPages(
    (cursor) => client.listWorkspaces({ limit: 100, cursor }),
    MAX_LISTING_PAGES,
  );
  const project = projects.find((p) => p.id === workspaceId);
  if (!project) throw new ApiError(403, 'denied', 'Workspace unavailable', '');
  // The list itself is an admin route. Recheck live rights for every server command.
  const admin = project.role === 'admin';
  if (!admin) throw new ApiError(403, 'denied', 'Administrator required', '');
  const integrations = await allPages(
    (cursor) => client.listConnections(workspaceId, { limit: 100, cursor }),
    MAX_LISTING_PAGES,
  );
  if (integrations.some((i) => i.workspaceId !== workspaceId))
    throw Error('Connection scope mismatch');
  return {
    client,
    workspaceId,
    project,
    integrations,
    canManage: admin && env.CONSOLE_ALLOW_EDITS === 'true',
  };
}
async function readReceiptPage(client: AcclimateClient, integration: Connection, cursor?: string) {
  const { workspaceId, id, bundleId } = integration;
  const receipts = await client.listDeliveryReceipts(workspaceId, id, { limit: 20, cursor });
  if (
    receipts.items.some(
      (receipt) =>
        receipt.workspaceId !== workspaceId ||
        receipt.connectionId !== id ||
        receipt.bundleId !== bundleId,
    )
  )
    throw Error('Receipt scope mismatch');
  return receipts;
}

export async function integrationCommand(
  env: Environment,
  input: IntegrationCommand,
  fetcher: typeof fetch = fetch,
): Promise<IntegrationResult> {
  if (
    !input ||
    !['create', 'issue', 'revoke', 'revokeCredential', 'receipts'].includes(input.action)
  )
    return { ok: false, message: 'Invalid integration action.' };
  const mutating = input.action !== 'receipts';
  if (mutating && env.CONSOLE_ALLOW_EDITS !== 'true')
    return { ok: false, message: 'Editing is disabled for this console.' };
  if (mutating && (!('key' in input) || !uuid.test(input.key)))
    return { ok: false, message: 'Invalid operation ID.' };
  try {
    const c = await context(env, fetcher);
    if (input.action === 'create') {
      if (
        typeof input.displayName !== 'string' ||
        !input.displayName.trim() ||
        input.displayName.length > 120
      )
        return { ok: false, message: 'Use a display name of 1–120 characters.' };
      const integration = await c.client.createConnection(
        c.workspaceId,
        { bundleId: c.bundleId, channel: c.channel, displayName: input.displayName.trim() },
        input.key,
      );
      return { ok: true, integration };
    } else {
      const integration = c.integrations.find((item) => item.id === input.id);
      if (!uuid.test(input.id) || !integration)
        return { ok: false, message: 'Connection is outside the selected bundle and channel.' };
      if (input.action === 'receipts') {
        if (input.cursor && !uuid.test(input.cursor))
          return { ok: false, message: 'Invalid history cursor.' };
        const receipts = await readReceiptPage(c.client, integration, input.cursor);
        return { ok: true, receipts };
      }
      if (input.action === 'issue') {
        if (!['content-read', 'receipt-write'].includes(input.kind))
          return { ok: false, message: 'Invalid credential kind.' };
        if (input.replacementOf) {
          const original = integration.credentials?.find((item) => item.id === input.replacementOf);
          if (
            !uuid.test(input.replacementOf) ||
            !original ||
            original.kind !== input.kind ||
            !original.revokedAt
          )
            return {
              ok: false,
              message:
                'Refresh and confirm that the original scoped credential is revoked before creating a replacement.',
            };
        }
        const credential = await c.client.createConnectionCredential(
          c.workspaceId,
          input.id,
          { kind: input.kind },
          input.key,
        );
        return { ok: true, credential };
      }
      if (input.action === 'revoke')
        await c.client.revokeConnection(c.workspaceId, input.id, input.key);
      if (input.action === 'revokeCredential') {
        if (!uuid.test(input.credentialId)) return { ok: false, message: 'Invalid credential ID.' };
        await c.client.revokeConnectionCredential(
          c.workspaceId,
          input.id,
          input.credentialId,
          input.key,
        );
      }
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Canonical workspace commands bind the destination rendered with the form. */
export type ConnectionCommand = IntegrationCommand & {
  workspaceId: string;
  bundleId: string;
  channel: string;
};
export async function connectionCommand(
  env: Environment,
  input: ConnectionCommand,
  fetcher: typeof fetch = fetch,
): Promise<IntegrationResult> {
  if (
    !input ||
    !validScopePart(input.workspaceId) ||
    !validScopePart(input.bundleId) ||
    !validScopePart(input.channel)
  )
    return { ok: false, message: 'An explicit workspace, bundle and channel are required.' };
  return integrationCommand(
    {
      ...env,
      CONSOLE_WORKSPACE: input.workspaceId,
      CONSOLE_BUNDLE: input.bundleId,
      CONSOLE_CHANNEL: input.channel,
    },
    input,
    fetcher,
  );
}

function validScopePart(value: unknown): value is string {
  return typeof value === 'string' && /^[^\x00-\x20\x7f/]{1,200}$/.test(value);
}

export type ConnectionBundle = {
  id: string;
  name: string;
  compatibilityTarget?: 'generic' | 'codex' | 'claude' | 'pi' | 'cursor';
  channels: { name: string; revision: string }[];
};
export type ConnectionsState = {
  workspaceId: string;
  publicApiUrl: string;
  workspaceName: string;
  actorScope: string;
  canManage: boolean;
  integrations: Connection[];
  bundles: ConnectionBundle[];
  reports?: Record<
    string,
    Pick<NonNullable<ConnectionObservation['latestObservation']>, 'stage' | 'receivedAt'> | null
  >;
  selected?: {
    integration: Connection;
    receipts: Page<DeliveryReceipt>;
    currentVersionId: string;
    currentDigest: string;
    currentRevision: string;
  };
};
export type ConnectionsResult =
  | { ok: true; state: ConnectionsState }
  | { ok: false; message: string; connectionMissing?: boolean };

export async function readConnectionsState(
  env: Environment,
  input: { workspaceId: string; connectionId?: string },
  fetcher: typeof fetch = fetch,
): Promise<ConnectionsResult> {
  try {
    const c = await workspaceContext(env, input.workspaceId, fetcher);
    const [summaries, observations] = await Promise.all([
      allPages(
        (cursor) => c.client.listBundles(c.workspaceId, { limit: 100, cursor }),
        MAX_LISTING_PAGES,
      ),
      input.connectionId
        ? undefined
        : allPages(
            (cursor) => c.client.listConnectionObservations(c.workspaceId, { limit: 100, cursor }),
            MAX_LISTING_PAGES,
          ).catch(() => undefined),
    ]);
    const reports =
      observations &&
      Object.fromEntries(
        observations.map(({ id, latestObservation }) => [
          id,
          latestObservation
            ? { stage: latestObservation.stage, receivedAt: latestObservation.receivedAt }
            : null,
        ]),
      );
    const bundles = await Promise.all(
      summaries.map(async (bundle) => ({
        id: bundle.id,
        name: bundle.name,
        compatibilityTarget: bundle.compatibilityTarget,
        channels: await allPages(
          (cursor) => c.client.listChannels(c.workspaceId, bundle.id, { limit: 100, cursor }),
          MAX_LISTING_PAGES,
        ),
      })),
    );
    const integration = input.connectionId
      ? c.integrations.find((item) => item.id === input.connectionId)
      : undefined;
    if (input.connectionId && !integration)
      return {
        ok: false,
        message: 'Connection not found in this workspace.',
        connectionMissing: true,
      };
    let selected: ConnectionsState['selected'];
    if (integration) {
      const [receipts, result] = await Promise.all([
        readReceiptPage(c.client, integration),
        c.client.resolveChannel(c.workspaceId, integration.bundleId, integration.channel),
      ]);
      if (!result.resolution) throw Error('Channel unavailable');
      selected = {
        integration,
        receipts,
        currentVersionId: result.resolution.version.id,
        currentDigest: result.resolution.version.digest,
        currentRevision: result.resolution.revision,
      };
    }
    return {
      ok: true,
      state: {
        workspaceId: c.workspaceId,
        publicApiUrl: env.CONSOLE_PUBLIC_API_URL!,
        workspaceName: c.project.name,
        actorScope: actorScope(env),
        canManage: c.canManage,
        integrations: c.integrations,
        reports,
        bundles,
        selected,
      },
    };
  } catch (error) {
    const result = failure(error);
    return { ok: false, message: result.ok ? 'Connections unavailable.' : result.message };
  }
}
