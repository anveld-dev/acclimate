import { consoleClient } from './console-client';
import { allPages } from './listing';
import { ApiError } from '@acclimate/sdk';
import type { Integration, IntegrationCredential, DeliveryReceipt, Page } from '@acclimate/sdk';
import type {
  LearningEnrollmentStatus,
  LearningOutcomeStatus,
  LearningReleaseEvidence,
  LearningRestoreTarget,
  LearningRound,
  PolicyOverride,
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

type LearningTarget = { projectId: string; integrationId: string };
export type LearningRequest = LearningTarget &
  (
    | { action: 'read' }
    | { action: 'enroll'; setup: LearningSetup }
    | { action: 'rollout'; automaticRollout: boolean }
    | { action: 'rollback'; automaticRollback: boolean }
    | { action: 'stop' }
    | {
        action: 'restore';
        restoreId: string;
        expectedRevision: string;
        target: LearningRestoreTarget;
        reason: string;
      }
    | {
        action: 'skills';
        createSkillNames: string;
        retireSkillNames: string;
        permittedPaths?: string;
      }
    | { action: 'review'; roundId: string; approve: boolean; policyOverride?: PolicyOverride }
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
export type BlockingLearningPolicy = {
  comparisonId: string;
  requestId: string;
  policyId: string;
  revision: string;
  policyDigest: string;
  verdict: 'fail' | 'indeterminate';
};
type LearningStatus = Pick<
  LearningEnrollmentStatus,
  | 'automaticRollout'
  | 'automaticRollback'
  | 'stoppedAt'
  | 'enabled'
  | 'auditCount'
  | 'remainingAudits'
  | 'renewalRevision'
  | 'proposalAdmissions'
  | 'maxProposalAdmissions'
  | 'deliveredVersionId'
  | 'deliveredRevision'
  | 'skillPackages'
  | 'permittedPaths'
> & {
  rounds: (LearningRound & { blockingPolicies?: BlockingLearningPolicy[] | null })[];
  restoreTargets: LearningRestoreTarget[];
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
    !validScopePart(input.projectId) ||
    !uuid.test(input.integrationId) ||
    !uuid.test(input.outcomeId)
  )
    return { ok: false, message: 'Enter the outcome UUID your application reported.' };
  try {
    requireSession(env);
    const result = await consoleClient(env, fetcher).getLearningOutcome(
      input.projectId,
      input.integrationId,
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
      'rollout',
      'rollback',
      'stop',
      'review',
      'renew',
      'skills',
      'restore',
    ].includes(input.action) ||
    !validScopePart(input.projectId) ||
    typeof input.integrationId !== 'string' ||
    !uuid.test(input.integrationId)
  )
    return { ok: false, message: 'Select a connection in this workspace.' };
  if (input.action !== 'read' && env.CONSOLE_ALLOW_EDITS !== 'true')
    return { ok: false, message: 'Editing is disabled for this console.' };

  try {
    const { client, integrations, projectId } = await workspaceContext(
      env,
      input.projectId,
      fetcher,
    );
    const integration = integrations.find((item) => item.id === input.integrationId);
    if (!integration) return { ok: false, message: 'Connection not found in this workspace.' };
    const { id, bundleId, channel } = integration;
    async function inspect() {
      try {
        const status = await client.getLearningEnrollment(projectId, id);
        if (
          status.projectId !== projectId ||
          status.integrationId !== id ||
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
        await client.enrollLearning(projectId, id, policy, randomUUID());
        break;
      }
      case 'rollout':
      case 'rollback':
      case 'skills': {
        const desired =
          input.action === 'rollback'
            ? input.automaticRollback
            : input.action === 'rollout'
              ? input.automaticRollout
              : undefined;
        if (input.action !== 'skills' && typeof desired !== 'boolean')
          return {
            ok: false,
            message:
              input.action === 'rollback'
                ? 'Choose a post-rollout policy.'
                : 'Choose a rollout policy.',
          };
        const current = await inspect();
        if (!current?.enabled || current.stoppedAt || !current.audits?.length)
          return { ok: false, message: 'This learning enrollment is unavailable for editing.' };
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
        const previous =
          input.action === 'rollback' ? current.automaticRollback : current.automaticRollout;
        if (skills || previous !== desired) {
          await client.enrollLearning(
            projectId,
            id,
            {
              installationId: current.installationId,
              outcomePrincipal: current.outcomePrincipal,
              evaluatorPrincipal: current.evaluatorPrincipal,
              permittedPaths: paths,
              maxProposalAdmissions: current.maxProposalAdmissions,
              development: current.development,
              audits: current.audits,
              automaticRollout:
                input.action === 'rollout' ? input.automaticRollout : current.automaticRollout,
              expectedAutomaticRollout: current.automaticRollout,
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
      case 'restore': {
        const target = input.target;
        if (
          !uuid.test(input.restoreId) ||
          !/^[1-9]\d*$/.test(input.expectedRevision) ||
          !target ||
          !['delivery', 'source'].includes(target.kind) ||
          !/^[1-9]\d*$/.test(target.revision) ||
          !uuid.test(target.versionId) ||
          typeof input.reason !== 'string' ||
          !input.reason.trim() ||
          Buffer.byteLength(input.reason) > 1024
        )
          return {
            ok: false,
            message: 'Select a reviewed delivery target and enter a reason of up to 1,024 bytes.',
          };
        await client.restoreLearning(projectId, id, {
          restoreId: input.restoreId,
          expectedRevision: input.expectedRevision,
          target: { kind: target.kind, revision: target.revision, versionId: target.versionId },
          reason: input.reason.trim(),
        });
        break;
      }
      case 'stop':
        await client.stopLearning(projectId, id, randomUUID());
        break;
      case 'review': {
        if (
          typeof input.roundId !== 'string' ||
          !uuid.test(input.roundId) ||
          typeof input.approve !== 'boolean'
        )
          return { ok: false, message: 'Select a valid round and decision.' };
        const decision = input.policyOverride;
        if (
          decision !== undefined &&
          (!input.approve ||
            !decision ||
            typeof decision.reason !== 'string' ||
            !decision.reason.trim() ||
            Buffer.byteLength(decision.reason.trim()) > 1024 ||
            /[\x00-\x1f\x7f-\x9f]/.test(decision.reason.trim()) ||
            !Array.isArray(decision.receipts) ||
            !decision.receipts.length ||
            decision.receipts.some(
              (ref) =>
                !ref ||
                !uuid.test(ref.comparisonId) ||
                !/^sha256:[a-f0-9]{64}$/.test(ref.policyDigest),
            ))
        )
          return {
            ok: false,
            message: 'Review the blocking policies and enter a reason of up to 1,024 bytes.',
          };
        await client.reviewLearningRound(
          projectId,
          id,
          input.roundId,
          input.approve,
          randomUUID(),
          decision && {
            reason: decision.reason.trim(),
            receipts: decision.receipts.map(({ comparisonId, policyDigest }) => ({
              comparisonId,
              policyDigest,
            })),
          },
        );
        break;
      }
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
        await client.renewLearning(projectId, id, {
          ...settings,
          renewalId: input.renewalId,
          expectedRevision: input.expectedRevision,
        });
        break;
      }
    }
    const status = await inspect();
    async function blockingPolicies(
      round: LearningRound,
    ): Promise<BlockingLearningPolicy[] | null | undefined> {
      if (round.state !== 'awaiting_review' || !round.candidateVersionId) return;
      try {
        const receipts = await client.listCandidatePolicyReceipts(
          projectId,
          bundleId,
          round.candidateVersionId,
        );
        return receipts.items.flatMap(({ comparisonId, requestId, policy, verdict }) =>
          verdict === 'fail' || verdict === 'indeterminate'
            ? [
                {
                  comparisonId,
                  requestId,
                  policyId: policy.id,
                  revision: policy.revision,
                  policyDigest: policy.sha256,
                  verdict,
                },
              ]
            : [],
        );
      } catch {
        return null;
      }
    }
    return {
      ok: true,
      status: status && {
        enabled: status.enabled,
        stoppedAt: status.stoppedAt,
        automaticRollout: status.automaticRollout,
        automaticRollback: status.automaticRollback,
        auditCount: status.auditCount,
        remainingAudits: status.remainingAudits,
        renewalRevision: status.renewalRevision,
        proposalAdmissions: status.proposalAdmissions,
        maxProposalAdmissions: status.maxProposalAdmissions,
        deliveredVersionId: status.deliveredVersionId,
        deliveredRevision: status.deliveredRevision,
        permittedPaths: status.permittedPaths,
        restoreTargets: (status.restoreTargets ?? []).map(({ kind, revision, versionId }) => ({
          kind,
          revision,
          versionId,
        })),
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
        rounds: await Promise.all(
          status.rounds.map(async (round) => ({
            blockingPolicies: await blockingPolicies(round),
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
            developmentRequestId: round.developmentRequestId,
            developmentComparisonId: round.developmentComparisonId,
            auditRequestId: round.auditRequestId,
            auditComparisonId: round.auditComparisonId,
            promotionId: round.promotionId,
            fieldAudits: round.fieldAudits && {
              windowSize: round.fieldAudits.windowSize,
              regressions: round.fieldAudits.regressions,
              rollbackPromotionId: round.fieldAudits.rollbackPromotionId,
            },
          })),
        ),
      },
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (input.action === 'review' && error.status === 403)
        return {
          ok: false,
          message: 'Use an independent reviewer with permission to promote this candidate.',
        };
      if (error.code === 'policy_override_required')
        return {
          ok: false,
          message:
            'The candidate has blocking policy receipts. Refresh learning status and review the current receipts before approving.',
        };
      if ([401, 403].includes(error.status))
        return { ok: false, message: 'Learning administration requires current workspace access.' };
      if (error.status === 400)
        return {
          ok: false,
          message:
            input.action === 'rollout'
              ? 'Automatic rollout requires a committed development evaluator and a fresh committed audit cohort.'
              : 'Check the fixture commitments, selection policies, permitted paths, skill names and machine grants.',
        };
      if (error.status === 409)
        return {
          ok: false,
          message:
            input.action === 'restore'
              ? 'The release or restore target changed. Refresh and review the current targets.'
              : input.action === 'renew' || input.action === 'skills'
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
