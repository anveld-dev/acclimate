import { consoleClient } from './console-client';
import { requireSession } from './selection';
import { createHash } from 'node:crypto';
import { validatePayload } from '@acclimate/sdk';
import type { BundlePayload, PromotionPage, VersionMetadata } from '@acclimate/sdk';

type Env = Record<string, string | undefined>;
type Failure = { ok: false; message: string };

function configuredClient(env: Env, fetcher: typeof fetch) {
  if (
    !env.CONSOLE_SERVICE_TOKEN?.trim() ||
    !env.CONSOLE_PROJECT?.trim() ||
    !env.CONSOLE_BUNDLE?.trim()
  )
    throw new Error('Missing configuration');
  return consoleClient(env, fetcher);
}

export async function readVersion(
  env: Env,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; version: VersionMetadata; payload: BundlePayload } | Failure> {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as { versionId?: unknown }).versionId !== 'string' ||
    !(input as { versionId: string }).versionId.trim()
  )
    return { ok: false, message: 'Choose a version to inspect.' };
  try {
    requireSession(env);
    const client = configuredClient(env, fetcher);
    const id = (input as { versionId: string }).versionId;
    const version = await client.getVersion(env.CONSOLE_PROJECT!, env.CONSOLE_BUNDLE!, id);
    const bytes = await client.getPayload(env.CONSOLE_PROJECT!, env.CONSOLE_BUNDLE!, id);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== version.digest)
      return { ok: false, message: 'Content verification failed. No files were displayed.' };
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validatePayload(payload);
    return { ok: true, version, payload };
  } catch {
    return { ok: false, message: 'Could not read this version. Check the connection and retry.' };
  }
}

export async function readHistory(
  env: Env,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; page: PromotionPage } | Failure> {
  const cursor =
    input && typeof input === 'object'
      ? (input as { beforeRevision?: unknown }).beforeRevision
      : undefined;
  if (
    typeof cursor !== 'string' ||
    !/^[1-9][0-9]*$/.test(cursor) ||
    cursor.length > 19 ||
    BigInt(cursor) > 9223372036854775807n
  )
    return { ok: false, message: 'Invalid history cursor.' };
  try {
    requireSession(env);
    const client = configuredClient(env, fetcher);
    const page = await client.listPromotions(
      env.CONSOLE_PROJECT!,
      env.CONSOLE_BUNDLE!,
      env.CONSOLE_CHANNEL || 'stable',
      { limit: 20, beforeRevision: cursor },
    );
    return { ok: true, page };
  } catch {
    return {
      ok: false,
      message: 'Could not read release history. Check the connection and retry.',
    };
  }
}
