import { consoleClient } from './console-client';
import { requireSession } from './selection';
import { readVersion } from './version-workflows';
import { validatePayload, type BundlePayload } from '@acclimate/sdk';

export type DraftCommand =
  | { action: 'validate'; payload: BundlePayload }
  | { action: 'list'; cursor?: string }
  | { action: 'open' | 'history'; id: string; cursor?: string };

export async function draftCommand(
  env: Record<string, string | undefined>,
  input: DraftCommand,
  fetcher: typeof fetch = fetch,
) {
  try {
    requireSession(env);
    if (input.action === 'validate') {
      validatePayload(input.payload);
      return { ok: true as const, validated: true };
    }
    const p = env.CONSOLE_WORKSPACE,
      b = env.CONSOLE_BUNDLE,
      c = env.CONSOLE_CHANNEL || 'stable';
    if (!p || !b) throw Error();
    const client = consoleClient(env, fetcher);
    if (input.action === 'list')
      return {
        ok: true as const,
        page: await client.listDrafts(p, b, c, { limit: 20, cursor: input.cursor, status: 'all' }),
      };
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
    return { ok: false as const, message: 'Changes are released by connected learning.' };
  } catch {
    return { ok: false as const, message: 'Could not read the saved draft.' };
  }
}
