import { consoleClient } from './console-client';
import { exactOperation, lookupOperation } from './exact-operation';
import { requireSession } from './selection';
import { ApiError, validatePayload } from '@acclimate/sdk';
import type { VersionMetadata } from '@acclimate/sdk';
import { readChannel } from './channel';

export type EditCommand =
  | { action: 'save'; path: string; text: string; expectedRevision: string; key: string }
  | {
      action: 'publish' | 'rollback';
      versionId: string;
      expectedRevision: string;
      reason: string;
      key: string;
    };
export type EditResult =
  | { ok: true; version: VersionMetadata; revision?: string }
  | { ok: false; message: string; uncertain?: boolean };

export async function editChannel(
  env: Record<string, string | undefined>,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<EditResult> {
  if (env.CONSOLE_ALLOW_EDITS !== 'true')
    return { ok: false, message: 'Editing is disabled for this console.' };
  if (!input || typeof input !== 'object') return { ok: false, message: 'Invalid edit request.' };
  const command = input as EditCommand;
  if (
    !['save', 'publish', 'rollback'].includes(command.action) ||
    typeof command.key !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(command.key) ||
    typeof command.expectedRevision !== 'string' ||
    !/^[1-9][0-9]*$/.test(command.expectedRevision)
  )
    return { ok: false, message: 'Invalid edit request.' };
  try {
    requireSession(env);
    const operationPath = `/v1/projects/${encodeURIComponent(env.CONSOLE_PROJECT || '')}/bundles/${encodeURIComponent(env.CONSOLE_BUNDLE || '')}/channels/${encodeURIComponent(env.CONSOLE_CHANNEL || 'stable')}/promotions`;
    if (command.action !== 'save') {
      const prior = await lookupOperation(
        env,
        { projectId: env.CONSOLE_PROJECT!, operationPath, key: command.key },
        fetcher,
      );
      if (prior.status === 'committed') {
        const confirmed = await exactOperation<{ version: VersionMetadata; revision: string }>(
          env,
          {
            projectId: env.CONSOLE_PROJECT!,
            operationPath,
            key: command.key,
            body: JSON.stringify({
              versionId: command.versionId,
              expectedRevision: command.expectedRevision,
              unevaluatedReason:
                command.action === 'rollback'
                  ? `Manual rollback (not evaluated): ${command.reason.trim()}`
                  : `Manual web edit (not evaluated): ${command.reason.trim()}`,
            }),
          },
          fetcher,
        );
        return { ok: true, version: confirmed.version, revision: confirmed.revision };
      }
      if (prior.status === 'closed')
        return { ok: false, message: 'This operation was closed. Review a new release.' };
    }
    const current = await readChannel(env, fetcher);
    if (current.status !== 'ready')
      return {
        ok: false,
        message: 'Cannot read the current version. Check the connection and retry.',
      };
    if (!current.canEdit)
      return { ok: false, message: 'Your current workspace role cannot edit content.' };
    if (current.resolution.revision !== command.expectedRevision)
      return {
        ok: false,
        message:
          'The release changed. Check Releases to confirm any prior publish, then refresh before trying again.',
      };
    const client = consoleClient(env, fetcher);
    if (command.action === 'save') {
      if (
        typeof command.path !== 'string' ||
        typeof command.text !== 'string' ||
        Buffer.byteLength(command.text, 'utf8') > 262144
      )
        return { ok: false, message: 'Choose an existing file and keep it under 256 KiB.' };
      const original = current.payload.files.find((file) => file.path === command.path);
      if (!original || original.text === command.text)
        return { ok: false, message: 'Change the selected file before saving a draft.' };
      const payload = {
        ...current.payload,
        files: current.payload.files.map((file) =>
          file.path === command.path ? { ...file, text: command.text } : file,
        ),
      };
      validatePayload(payload);
      const version = await client.createVersion(
        current.projectId,
        current.bundleId,
        { parentVersionId: current.resolution.version.id, payload },
        command.key,
      );
      return { ok: true, version };
    }
    if (
      typeof command.versionId !== 'string' ||
      typeof command.reason !== 'string' ||
      !command.reason.trim() ||
      command.reason.length > 1000
    )
      return { ok: false, message: 'Add a short reason for this manual release.' };
    const version = await client.getVersion(current.projectId, current.bundleId, command.versionId);
    if (command.action === 'rollback' && version.id === current.resolution.version.id)
      return { ok: false, message: 'This version is already the current release.' };
    if (command.action === 'publish' && version.parentVersionId !== current.resolution.version.id)
      return {
        ok: false,
        message: 'This draft belongs to an older release. Refresh and create a new draft.',
      };
    const promotion = await exactOperation<{ revision: string }>(
      env,
      {
        projectId: current.projectId,
        operationPath,
        key: command.key,
        body: JSON.stringify({
          versionId: version.id,
          expectedRevision: command.expectedRevision,
          unevaluatedReason:
            command.action === 'rollback'
              ? `Manual rollback (not evaluated): ${command.reason.trim()}`
              : `Manual web edit (not evaluated): ${command.reason.trim()}`,
        }),
      },
      fetcher,
    );
    return { ok: true, version, revision: promotion.revision };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      return { ok: false, message: 'The release changed. Refresh before publishing this draft.' };
    if (error instanceof ApiError && [401, 403].includes(error.status))
      return { ok: false, message: 'The console token does not have permission for this change.' };
    return {
      ok: false,
      uncertain: !(error instanceof ApiError && error.status < 500),
      message:
        'The change could not be confirmed. Your text is still here; check the service and retry.',
    };
  }
}
