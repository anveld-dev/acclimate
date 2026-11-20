import { consoleClient } from './console-client';
import { allPages } from './listing';
import { ApiError } from '@acclimate/sdk';
import type {
  AcclimateClient,
  DeliveryReceipt,
  Connection,
  ConnectionObservation,
  ConnectionCredential,
  LearningEnrollmentStatus,
  LearningOutcomeStatus,
  LearningReleaseEvidence,
  LearningRound,
  Page,
} from '@acclimate/sdk';
import { requireSession, actorScope, type Environment } from './selection';
import {
  learningPolicy,
  renewalSettings,
  skillPermissions,
  permittedBundlePaths,
  type LearningSetup,
} from './connection-learning-policy';
import { randomUUID } from 'node:crypto';

type Entry = { integration: Connection; receipts: Page<DeliveryReceipt> };
export type IntegrationState = {
  workspaceId: string;
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

export async function readIntegrationState(
  env: Environment,
  fetcher: typeof fetch = fetch,
): Promise<IntegrationResult> {
  try {
    const c = await context(env, fetcher);
    const resolution = (await c.client.resolveChannel(c.workspaceId, c.bundleId, c.channel))
      .resolution;
    if (!resolution) throw Error('Channel missing');
    const entries = await Promise.all(
      c.integrations.map(async (integration) => ({
        integration,
        receipts: await readReceiptPage(c.client, integration),
      })),
    );
    return {
      ok: true,
      state: {
        workspaceId: c.workspaceId,
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

type LearningTarget = { workspaceId: string; connectionId: string };
export type LearningRequest = LearningTarget &
  (
    | { action: 'read' }
    | { action: 'enroll'; setup: LearningSetup }
    | { action: 'authorize' }
    | { action: 'rollback'; automaticRollback: boolean }
    | { action: 'stop' }
    | {
        action: 'skills';
        createSkillNames: string;
        retireSkillNames: string;
        permittedPaths?: string;
      }
    | {
        action: 'renew';
        renewalId: string;
        expectedRevision: number;
        proposalAdmissions: string;
        descriptors: string;
        development?: string;
        selectionPolicies?: string;
      }
  );
type LearningStatus = Pick<
  LearningEnrollmentStatus,
  | 'requiresRolloutAuthorization'
  | 'automaticRollback'
  | 'stoppedAt'
  | 'enabled'
  | 'auditCount'
  | 'remainingAudits'
  | 'noiseCalibration'
  | 'renewalRevision'
  | 'proposalAdmissions'
  | 'maxProposalAdmissions'
  | 'deliveredVersionId'
  | 'deliveredRevision'
  | 'skillPackages'
  | 'permittedPaths'
> & {
  rounds: LearningRound[];
  policySummary?: { development: string; audit: string };
  developmentCommitted: boolean;
};
export type LearningResult =
  | { ok: true; status: LearningStatus | null }
  | { ok: false; message: string };

export type OutcomeLookupResult =
  | { ok: true; outcome: LearningOutcomeStatus }
  | { ok: false; message: string };

function releaseEvidence(
  release: LearningReleaseEvidence | null | undefined,
): LearningReleaseEvidence | null {
  if (!release) return null;
  const {
    promotionId,
    versionId,
    revision,
    withdrawn,
    rollback,
    developmentRequestId,
    auditRequestId,
  } = release;
  return {
    promotionId,
    versionId,
    revision,
    withdrawn,
    rollback: rollback && {
      promotionId: rollback.promotionId,
      versionId: rollback.versionId,
      revision: rollback.revision,
    },
    developmentRequestId,
    auditRequestId,
  };
}

export async function lookupLearningOutcome(
  env: Environment,
  input: LearningTarget & { outcomeId: string },
  fetcher: typeof fetch = fetch,
): Promise<OutcomeLookupResult> {
  if (
    !input ||
    !validScopePart(input.workspaceId) ||
    !uuid.test(input.connectionId) ||
    !uuid.test(input.outcomeId)
  )
    return { ok: false, message: 'Enter the outcome UUID your application reported.' };
  try {
    requireSession(env);
    const result = await consoleClient(env, fetcher).getLearningOutcome(
      input.workspaceId,
      input.connectionId,
      input.outcomeId,
    );
    if (result.outcomeId !== input.outcomeId.toLowerCase()) throw Error('Outcome mismatch');
    const {
      outcomeId,
      status,
      versionId,
      deliveryRevision,
      receivedAt,
      corrections,
      bundleId,
      channel,
      currentDelivery,
      fieldAudit,
    } = result;
    return {
      ok: true,
      outcome: {
        outcomeId,
        status,
        versionId,
        deliveryRevision,
        receivedAt,
        bundleId,
        channel,
        currentDelivery: currentDelivery && {
          versionId: currentDelivery.versionId,
          revision: currentDelivery.revision,
        },
        servedRelease: releaseEvidence(result.servedRelease),
        fieldAudit: fieldAudit && {
          verdict: fieldAudit.verdict,
          controlVersionId: fieldAudit.controlVersionId,
          triggeredRollback: fieldAudit.triggeredRollback,
        },
        corrections: corrections.map(
          ({
            correctionId,
            state,
            roundId,
            reason,
            incidentReplay,
            release,
            candidateVersionId,
            developmentRequestId,
            auditRequestId,
          }) => ({
            correctionId,
            state,
            roundId,
            reason,
            incidentReplay,
            release: releaseEvidence(release),
            candidateVersionId,
            developmentRequestId,
            auditRequestId,
          }),
        ),
      },
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return { ok: false, message: 'No outcome with that ID was received on this connection.' };
    return {
      ok: false,
      message: 'Could not read this outcome. Check workspace access and try again.',
    };
  }
}

export async function connectionLearning(
  env: Environment,
  input: LearningRequest,
  fetcher: typeof fetch = fetch,
): Promise<LearningResult> {
  if (
    !input ||
    ![
      'read',
      'enroll',
      'authorize',
      'rollback',
      'stop',
      'renew',
      'skills',
    ].includes(input.action) ||
    !validScopePart(input.workspaceId) ||
    typeof input.connectionId !== 'string' ||
    !uuid.test(input.connectionId)
  )
    return { ok: false, message: 'Select a connection in this workspace.' };
  if (input.action !== 'read' && env.CONSOLE_ALLOW_EDITS !== 'true')
    return { ok: false, message: 'Editing is disabled for this console.' };

  try {
    const { client, integrations, workspaceId } = await workspaceContext(
      env,
      input.workspaceId,
      fetcher,
    );
    const integration = integrations.find((item) => item.id === input.connectionId);
    if (!integration) return { ok: false, message: 'Connection not found in this workspace.' };
    const { id, bundleId, channel } = integration;
    async function inspect() {
      try {
        const status = await client.getLearningEnrollment(workspaceId, id);
        if (
          status.workspaceId !== workspaceId ||
          status.connectionId !== id ||
          status.bundleId !== bundleId ||
          status.channel !== channel
        )
          throw Error('Learning scope mismatch');
        return { ...status, automaticRollback: status.automaticRollback ?? true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && error.code === 'not_found')
          return null;
        throw error;
      }
    }
    switch (input.action) {
      case 'enroll': {
        if (!integration.enabled) return { ok: false, message: 'This connection is revoked.' };
        let policy;
        try {
          policy = learningPolicy(input.setup);
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Invalid learning setup.',
          };
        }
        await client.enrollLearning(workspaceId, id, policy, randomUUID());
        break;
      }
      case 'authorize':
      case 'rollback':
      case 'skills': {
        if (input.action === 'rollback' && typeof input.automaticRollback !== 'boolean')
          return { ok: false, message: 'Choose a post-rollout policy.' };
        const current = await inspect();
        if (!current?.enabled || current.stoppedAt || !current.audits?.length)
          return { ok: false, message: 'This learning enrollment is unavailable for editing.' };
        if (current.requiresRolloutAuthorization && input.action !== 'authorize')
          return { ok: false, message: 'Authorize automatic releases before changing these settings.' };
        let skills;
        let paths = current.permittedPaths;
        if (input.action === 'skills') {
          try {
            skills = skillPermissions(input.createSkillNames, input.retireSkillNames);
            if (input.permittedPaths !== undefined)
              paths = permittedBundlePaths(input.permittedPaths);
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : 'Invalid skill permissions.',
            };
          }
        }
        if (skills || current.requiresRolloutAuthorization ||
            (input.action === 'rollback' && current.automaticRollback !== input.automaticRollback)) {
          await client.enrollLearning(
            workspaceId,
            id,
            {
              installationId: current.installationId,
              outcomePrincipal: current.outcomePrincipal,
              evaluatorPrincipal: current.evaluatorPrincipal,
              permittedPaths: paths,
              maxProposalAdmissions: current.maxProposalAdmissions,
              development: current.development,
              audits: current.audits,
              maxCorrectionsPerRound: current.maxCorrectionsPerRound,
              ...(input.action === 'rollback'
                ? { automaticRollback: input.automaticRollback }
                : {}),
              ...(current.selectionPolicies
                ? { selectionPolicies: current.selectionPolicies }
                : {}),
              ...(skills ? { skillPackages: skills } : {}),
            },
            randomUUID(),
          );
        }
        break;
      }
      case 'stop':
        await client.stopLearning(workspaceId, id, randomUUID());
        break;
      case 'renew': {
        if (
          typeof input.renewalId !== 'string' ||
          !uuid.test(input.renewalId) ||
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 0
        )
          return { ok: false, message: 'Refresh to get the current enrollment revision.' };
        let settings;
        try {
          settings = renewalSettings(
            input.proposalAdmissions,
            input.descriptors,
            input.development,
            input.selectionPolicies,
          );
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Invalid renewal settings.',
          };
        }
        await client.renewLearning(workspaceId, id, {
          ...settings,
          renewalId: input.renewalId,
          expectedRevision: input.expectedRevision,
        });
        break;
      }
    }
    const status = await inspect();
    return {
      ok: true,
      status: status && {
        enabled: status.enabled,
        stoppedAt: status.stoppedAt,
        requiresRolloutAuthorization: status.requiresRolloutAuthorization,
        automaticRollback: status.automaticRollback,
        auditCount: status.auditCount,
        remainingAudits: status.remainingAudits,
        noiseCalibration: status.noiseCalibration,
        renewalRevision: status.renewalRevision,
        proposalAdmissions: status.proposalAdmissions,
        maxProposalAdmissions: status.maxProposalAdmissions,
        deliveredVersionId: status.deliveredVersionId,
        deliveredRevision: status.deliveredRevision,
        permittedPaths: status.permittedPaths,
        developmentCommitted: status.development.fixtureProtocol === 'installed-v1',
        ...(status.skillPackages
          ? {
              skillPackages: {
                createSkillNames: status.skillPackages.createSkillNames,
                retireSkillNames: status.skillPackages.retireSkillNames,
              },
            }
          : {}),
        ...(status.selectionPolicies
          ? {
              policySummary: {
                development: `${status.selectionPolicies.development.id} · ${status.selectionPolicies.development.revision}`,
                audit: `${status.selectionPolicies.audit.id} · ${status.selectionPolicies.audit.revision}`,
              },
            }
          : {}),
        rounds: status.rounds.map((round) => ({
            id: round.id,
            outcomeId: round.outcomeId,
            incidentReplay: round.incidentReplay,
            state: round.state,
            ...(round.policyEpoch === undefined ? {} : { policyEpoch: round.policyEpoch }),
            ...(round.correctionId ? { correctionId: round.correctionId } : {}),
            ...(round.attempt === undefined ? {} : { attempt: round.attempt }),
            reason: round.reason,
            parentVersionId: round.parentVersionId,
            candidateVersionId: round.candidateVersionId,
            proposalId: round.proposalId,
            developmentRequestId:
              round.cumulativeDevelopmentRequestId ?? round.developmentRequestId,
            developmentComparisonId:
              round.cumulativeDevelopmentComparisonId ?? round.developmentComparisonId,
            auditRequestId: round.auditRequestId,
            auditComparisonId: round.auditComparisonId,
            promotionId: round.promotionId,
            fieldAudits: round.fieldAudits && {
              windowSize: round.fieldAudits.windowSize,
              regressions: round.fieldAudits.regressions,
              rollbackPromotionId: round.fieldAudits.rollbackPromotionId,
            },
          })),
      },
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if ([401, 403].includes(error.status))
        return { ok: false, message: 'Learning administration requires current workspace access.' };
      if (error.status === 400)
        return {
          ok: false,
          message:
            input.action === 'authorize'
              ? 'Automatic rollout requires a committed development evaluator and a fresh committed audit cohort.'
              : 'Check the fixture commitments, selection policies, permitted paths, skill names and machine grants.',
        };
      if (error.status === 409)
        return {
          ok: false,
          message:
            input.action === 'renew' || input.action === 'skills'
                ? 'Refresh the enrollment. Apply policy changes between rounds and use newly registered audit fixtures.'
                : 'Refresh the learning state and review the current enrollment settings.',
        };
    }
    return {
      ok: false,
      message: 'Could not confirm the learning state. Refresh status before trying again.',
    };
  }
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
