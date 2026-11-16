import { consoleClient } from './console-client';
import { allPages } from './listing';
import { ApiError } from '@acclimate/sdk';
import type { Integration, IntegrationCredential, DeliveryReceipt, Page } from '@acclimate/sdk';
import { requireSession, actorScope, type Environment } from './selection';

type Entry = { integration: Integration; receipts: Page<DeliveryReceipt> };
export type IntegrationState = {
  projectId: string;
  bundleId: string;
  channel: string;
  currentVersionId: string;
  currentRevision: string;
  canManage: boolean;
  actorScope: string;
  entries: Entry[];
};
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
      state?: IntegrationState;
      credential?: IntegrationCredential;
      receipts?: Page<DeliveryReceipt>;
      integration?: Integration;
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
        ? 'Access denied. Integration administration requires a current workspace administrator.'
        : 'Could not confirm the service response. Refresh to check current integrations before repeating an action.',
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
  if (!env.CONSOLE_PROJECT || !env.CONSOLE_BUNDLE) throw Error('Select a workspace');
  const workspace = await workspaceContext(env, env.CONSOLE_PROJECT, fetcher);
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
async function workspaceContext(env: Environment, projectId: string, fetcher: typeof fetch) {
  requireSession(env);
  if (!validScopePart(projectId) || !env.CONSOLE_SERVICE_TOKEN) throw Error('Select a workspace');
  const client = consoleClient(env, fetcher);
  const projects = await allPages(
    (cursor) => client.listProjects({ limit: 100, cursor }),
    MAX_LISTING_PAGES,
  );
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new ApiError(403, 'denied', 'Project unavailable', '');
  // The list itself is an admin route. Recheck live rights for every server command.
  const admin = project.role === 'admin';
  if (!admin) throw new ApiError(403, 'denied', 'Administrator required', '');
  const integrations = await allPages(
    (cursor) => client.listIntegrations(projectId, { limit: 100, cursor }),
    MAX_LISTING_PAGES,
  );
  if (integrations.some((i) => i.projectId !== projectId))
    throw Error('Integration scope mismatch');
  return {
    client,
    projectId,
    project,
    integrations,
    canManage: admin && env.CONSOLE_ALLOW_EDITS === 'true',
  };
}
export async function readIntegrationState(
  env: Environment,
  fetcher: typeof fetch = fetch,
): Promise<IntegrationResult> {
  try {
    const c = await context(env, fetcher);
    const resolution = (await c.client.resolveChannel(c.projectId, c.bundleId, c.channel))
      .resolution;
    if (!resolution) throw Error('Channel missing');
    const entries = await Promise.all(
      c.integrations.map(async (integration) => ({
        integration,
        receipts: await c.client.listDeliveryReceipts(c.projectId, integration.id, { limit: 20 }),
      })),
    );
    return {
      ok: true,
      state: {
        projectId: c.projectId,
        bundleId: c.bundleId,
        channel: c.channel,
        currentVersionId: resolution.version.id,
        currentRevision: resolution.revision,
        canManage: c.canManage,
        actorScope: actorScope(env),
        entries,
      },
    };
  } catch (error) {
    return failure(error);
  }
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
      const integration = await c.client.createIntegration(
        c.projectId,
        { bundleId: c.bundleId, channel: c.channel, displayName: input.displayName.trim() },
        input.key,
      );
      return { ok: true, integration };
    } else {
      if (!uuid.test(input.id) || !c.integrations.some((i) => i.id === input.id))
        return { ok: false, message: 'Integration is outside the selected bundle and channel.' };
      if (input.action === 'receipts') {
        if (input.cursor && !uuid.test(input.cursor))
          return { ok: false, message: 'Invalid history cursor.' };
        const receipts = await c.client.listDeliveryReceipts(c.projectId, input.id, {
          limit: 20,
          cursor: input.cursor,
        });
        if (receipts.items.some((r) => r.bundleId !== c.bundleId || r.integrationId !== input.id))
          throw Error('Receipt scope mismatch');
        return { ok: true, receipts };
      }
      if (input.action === 'issue') {
        if (!['content-read', 'receipt-write'].includes(input.kind))
          return { ok: false, message: 'Invalid credential kind.' };
        if (input.replacementOf) {
          const original = c.integrations
            .find((i) => i.id === input.id)
            ?.credentials?.find((item) => item.id === input.replacementOf);
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
        const credential = await c.client.createIntegrationCredential(
          c.projectId,
          input.id,
          { kind: input.kind },
          input.key,
        );
        return { ok: true, credential };
      }
      if (input.action === 'revoke')
        await c.client.revokeIntegration(c.projectId, input.id, input.key);
      if (input.action === 'revokeCredential') {
        if (!uuid.test(input.credentialId)) return { ok: false, message: 'Invalid credential ID.' };
        await c.client.revokeIntegrationCredential(
          c.projectId,
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
  projectId: string;
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
    !validScopePart(input.projectId) ||
    !validScopePart(input.bundleId) ||
    !validScopePart(input.channel)
  )
    return { ok: false, message: 'An explicit workspace, bundle and channel are required.' };
  return integrationCommand(
    {
      ...env,
      CONSOLE_PROJECT: input.projectId,
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
  projectId: string;
  projectName: string;
  actorScope: string;
  canManage: boolean;
  integrations: Integration[];
  bundles: ConnectionBundle[];
  selected?: {
    integration: Integration;
    receipts: Page<DeliveryReceipt>;
    currentVersionId: string;
    currentRevision: string;
  };
};
export type ConnectionsResult =
  | { ok: true; state: ConnectionsState }
  | { ok: false; message: string };

export async function readConnectionsState(
  env: Environment,
  input: { projectId: string; integrationId?: string },
  fetcher: typeof fetch = fetch,
): Promise<ConnectionsResult> {
  try {
    const c = await workspaceContext(env, input.projectId, fetcher);
    const summaries = await allPages(
      (cursor) => c.client.listBundles(c.projectId, { limit: 100, cursor }),
      MAX_LISTING_PAGES,
    );
    const bundles = await Promise.all(
      summaries.map(async (bundle) => ({
        id: bundle.id,
        name: bundle.name,
        compatibilityTarget: bundle.compatibilityTarget,
        channels: await allPages(
          (cursor) => c.client.listChannels(c.projectId, bundle.id, { limit: 100, cursor }),
          MAX_LISTING_PAGES,
        ),
      })),
    );
    const integration = input.integrationId
      ? c.integrations.find((item) => item.id === input.integrationId)
      : undefined;
    if (input.integrationId && !integration)
      return { ok: false, message: 'Connection not found in this workspace.' };
    let selected: ConnectionsState['selected'];
    if (integration) {
      const [receipts, result] = await Promise.all([
        c.client.listDeliveryReceipts(c.projectId, integration.id, { limit: 20 }),
        c.client.resolveChannel(c.projectId, integration.bundleId, integration.channel),
      ]);
      if (!result.resolution) throw Error('Channel unavailable');
      if (
        receipts.items.some(
          (r) => r.integrationId !== integration.id || r.bundleId !== integration.bundleId,
        )
      )
        throw Error('Receipt scope mismatch');
      selected = {
        integration,
        receipts,
        currentVersionId: result.resolution.version.id,
        currentRevision: result.resolution.revision,
      };
    }
    return {
      ok: true,
      state: {
        projectId: c.projectId,
        projectName: c.project.name,
        actorScope: actorScope(env),
        canManage: c.canManage,
        integrations: c.integrations,
        bundles,
        selected,
      },
    };
  } catch (error) {
    const result = failure(error);
    return { ok: false, message: result.ok ? 'Connections unavailable.' : result.message };
  }
}
