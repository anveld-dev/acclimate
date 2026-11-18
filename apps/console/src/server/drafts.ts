import { canonicalOperationPath } from '../lib/operation-target';
import { consoleClient } from './console-client';
import { ApiError, DeliveryError, validatePayload } from '@acclimate/sdk';
import type { BundlePayload, Draft, PublishDraftRequest } from '@acclimate/sdk';
import { readVersion } from './version-workflows';
import { requireSession } from './selection';
import { exactOperation, lookupOperation, closeOperation } from './exact-operation';
import { draftRequest } from '../lib/content-operation';
export type DraftCommand =
  | { action: 'validate'; payload: BundlePayload }
  | { action: 'list'; cursor?: string }
  | { action: 'open'; id: string }
  | { action: 'history'; id: string; cursor?: string }
  | { action: 'recover' | 'close'; key: string; operationPath?: string }
  | { action: 'retry'; key: string; operationPath: string; body: string }
  | {
      action: 'create';
      key: string;
      baseVersionId: string;
      baseRevision: string;
      payload: BundlePayload;
    }
  | { action: 'save'; key: string; id: string; expectedGeneration: number; payload: BundlePayload }
  | { action: 'discard'; key: string; id: string; expectedGeneration: number }
  | ({ action: 'publish'; key: string; id: string } & PublishDraftRequest);
export async function draftCommand(
  env: Record<string, string | undefined>,
  input: DraftCommand,
  fetcher: typeof fetch = fetch,
) {
  const failure = (message: string, uncertain = false) => ({
    ok: false as const,
    message,
    uncertain,
  });
  const mutating = ['create', 'save', 'discard', 'publish', 'retry', 'close'].includes(
    input?.action,
  );
  if (mutating && env.CONSOLE_ALLOW_EDITS !== 'true')
    return failure('Editing is disabled for this console.');
  if (!env.CONSOLE_SERVICE_TOKEN || !env.CONSOLE_PROJECT || !env.CONSOLE_BUNDLE)
    return failure('Select a configured workspace first.');
  if (
    !input ||
    ![
      'validate',
      'list',
      'open',
      'history',
      'recover',
      'retry',
      'close',
      'create',
      'save',
      'discard',
      'publish',
    ].includes(input.action)
  )
    return failure('Invalid draft command.');
  if (mutating && (!('key' in input) || !/^[a-f0-9-]{36}$/i.test(input.key)))
    return failure('Invalid operation ID.');
  try {
    requireSession(env);
    if ('payload' in input) {
      validatePayload(input.payload);
    }
    if (input.action === 'validate') return { ok: true as const, validated: true };
    const client = consoleClient(env, fetcher);
    const p = env.CONSOLE_PROJECT,
      b = env.CONSOLE_BUNDLE,
      c = env.CONSOLE_CHANNEL || 'stable';
    if (input.action === 'list')
      return {
        ok: true as const,
        page: await client.listDrafts(p, b, c, { limit: 20, cursor: input.cursor, status: 'all' }),
      };
    if (input.action === 'recover' || input.action === 'close')
      return {
        ok: true as const,
        operation: await (input.action === 'close' ? closeOperation : lookupOperation)(
          env,
          { projectId: p, key: input.key, operationPath: input.operationPath },
          fetcher,
        ),
      };
    if (input.action === 'retry') {
      const root = `/v1/workspaces/${encodeURIComponent(p)}/bundles/${encodeURIComponent(b)}/channels/${encodeURIComponent(c)}/drafts`;
      const target = canonicalOperationPath(input.operationPath);
      if (target !== root && !target.startsWith(root + '/'))
        return failure('Operation scope changed.');
      return {
        ok: true as const,
        draft: await exactOperation<Draft>(env, { projectId: p, ...input }, fetcher),
      };
    }
    if (input.action === 'history')
      return {
        ok: true as const,
        history: await client.getDraftHistory(p, b, c, input.id, {
          limit: 20,
          cursor: input.cursor,
        }),
      };
    if (input.action === 'open') {
      const draft = await client.getDraft(p, b, c, input.id);
      const snapshot = await readVersion(env, { versionId: draft.snapshotVersion.id }, fetcher);
      if (!snapshot.ok) return snapshot;
      const base = await readVersion(env, { versionId: draft.baseVersionId }, fetcher);
      if (!base.ok) return base;
      return { ok: true as const, draft, payload: snapshot.payload, base: base.payload };
    }
    const wire = draftRequest(input, { projectId: p, bundleId: b, channel: c });
    const draft = await exactOperation<Draft>(
      env,
      { projectId: p, key: input.key, ...wire },
      fetcher,
    );
    return { ok: true as const, draft };
  } catch (error) {
    if (error instanceof DeliveryError) return failure(error.message);
    if (error instanceof ApiError && error.status >= 500)
      return failure(
        'The service could not confirm the outcome. Recover the operation before issuing another write.',
        mutating,
      );
    if (error instanceof ApiError)
      return failure(
        error.status === 409
          ? 'This draft or channel changed. Reopen the saved draft before making another command. Your browser edits are still here.'
          : `Draft request rejected (${error.status}). Check the content and your access before retrying.`,
        input.action === 'retry',
      );
    return failure(
      mutating
        ? 'The outcome is unknown. Keep this tab open and recover the operation before issuing another command.'
        : 'Could not read drafts. Retry when the connection is available.',
      mutating,
    );
  }
}
