import { AcclimateUsageError, TransportError } from './errors.js';
import type { DeliveryObservation, DeliveryObserver } from './reporting.js';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AcclimateClient } from './client.js';
import { ApiError } from './client.js';
import type { BundlePayload, ChannelResolution, VerifiedVersion, VersionMetadata } from './types.js';
import { DeliveryError } from './validation.js';
import { verifyPayloadBytes } from './verification.js';
export { DeliveryError, validatePayload } from './validation.js';
export type Selection =
  | { projectId: string; bundleId: string; channel: string }
  | { projectId: string; bundleId: string; versionId: string };
export type OfflinePolicy = false | { maxAgeMs: number } | { pinnedVersionId: string };
export interface CachePolicy {
  cacheDir: string;
  maxResolutionAgeMs?: number;
  offline?: OfflinePolicy;
  maxCacheBytes?: number;
  /** Optional app reporting; observer errors never affect delivery. */
  reporter?: DeliveryObserver;
}
const MAX_PAYLOAD = 1024 * 1024;

function validateVersion(v: VersionMetadata, bundleId: string): void {
  if (
    !v ||
    typeof v.id !== 'string' ||
    !v.id ||
    v.bundleId !== bundleId ||
    typeof v.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(v.digest) ||
    typeof v.createdAt !== 'string' ||
    !(v.parentVersionId === null || typeof v.parentVersionId === 'string')
  )
    throw new DeliveryError(
      'invalid_response',
      'Version metadata is malformed or belongs to another bundle',
    );
}

async function ensurePrivateDir(path: string): Promise<void> {
  if (process.platform === 'win32')
    throw new DeliveryError('unsupported_platform', 'Private filesystem helpers require POSIX');
  const abs = resolve(path);
  const parsed = abs.split('/');
  let current = '/';
  for (const part of parsed.filter(Boolean)) {
    current = join(current, part);
    try {
      const s = await stat(current);
      const ls = await lstat(current);
      if (ls.isSymbolicLink() || !s.isDirectory())
        throw new DeliveryError('unsafe_cache', 'Cache path contains a symlink or non-directory');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
      try {
        await mkdir(current, { mode: 0o700 });
        await chmod(current, 0o700);
      } catch (createError: any) {
        if (createError?.code !== 'EEXIST') throw createError;
      }
    }
  }
  const final = await lstat(abs);
  if ((final.mode & 0o077) !== 0 || (process.getuid && final.uid !== process.getuid()))
    throw new DeliveryError(
      'unsafe_cache',
      'Existing directory must be private and owned by the current user',
    );
}
function keyFor(client: AcclimateClient, parts: string[]): string {
  if (client.integrationId) {
    return createHash('sha256')
      .update(JSON.stringify([client.baseUrl, client.scope, client.integrationId, ...parts]))
      .digest('hex');
  }
  return createHash('sha256')
    .update([client.baseUrl, client.scope, ...parts].join('\0'))
    .digest('hex');
}
async function loadEntry(dir: string): Promise<any | null> {
  try {
    const s = await lstat(dir);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new DeliveryError('unsafe_cache', 'Cache entry contains a symlink or non-directory');
    const file = join(dir, 'entry.json'),
      fs = await lstat(file);
    if (fs.isSymbolicLink() || !fs.isFile())
      throw new DeliveryError('unsafe_cache', 'Cache entry file contains a symlink or non-file');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

// The client wraps network failures in TransportError. Custom fetchers can still surface
// the native errors: the fetch deadline rejects with TimeoutError, while an explicit caller abort
// rejects with AbortError. Only transport failures and 503 permit offline use.
function isTransportFailure(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status === 503
    : error instanceof TransportError ||
        error instanceof TypeError ||
        (error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

export async function resolveAndCache(
  client: AcclimateClient,
  selection: Selection,
  policy: CachePolicy,
): Promise<VerifiedVersion> {
  const now = Date.now(),
    maxAge = policy.maxResolutionAgeMs ?? 0,
    offline = policy.offline ?? false;
  let resolution: ChannelResolution | undefined,
    resolvedAt = now,
    stale = false;
  if (
    policy.maxResolutionAgeMs !== undefined &&
    (!Number.isFinite(policy.maxResolutionAgeMs) ||
      policy.maxResolutionAgeMs < 0 ||
      policy.maxResolutionAgeMs > 30 * 24 * 60 * 60 * 1000)
  )
    throw new AcclimateUsageError('maxResolutionAgeMs must be between 0 and 30 days', 'maxResolutionAgeMs');
  if (
    policy.maxCacheBytes !== undefined &&
    (!Number.isFinite(policy.maxCacheBytes) ||
      policy.maxCacheBytes < 1 ||
      policy.maxCacheBytes > 1024 * 1024 * 1024)
  )
    throw new AcclimateUsageError('maxCacheBytes must be between 1 and 1073741824', 'maxCacheBytes');
  if (typeof policy.cacheDir !== 'string' || !policy.cacheDir)
    throw new AcclimateUsageError('cacheDir is required', 'cacheDir');
  if (
    typeof offline === 'object' &&
    'maxAgeMs' in offline &&
    (!Number.isFinite(offline.maxAgeMs) ||
      offline.maxAgeMs < 0 ||
      offline.maxAgeMs > 30 * 24 * 60 * 60 * 1000)
  )
    throw new AcclimateUsageError('offline.maxAgeMs must be between 0 and 30 days', 'offline.maxAgeMs');
  await ensurePrivateDir(policy.cacheDir);
  if ('channel' in selection) {
    const mapDir = join(
      resolve(policy.cacheDir),
      keyFor(client, [selection.projectId, selection.bundleId, 'channel', selection.channel]),
    );
    const old = await loadEntry(mapDir);
    const age =
      old && typeof old.resolvedAt === 'number' ? Math.max(0, now - old.resolvedAt) : Infinity;
    try {
      const response = await client.resolveChannel(
        selection.projectId,
        selection.bundleId,
        selection.channel,
        { etag: old?.etag },
      );
      if (response.notModified) {
        if (!old?.resolution)
          throw new DeliveryError(
            'cache_miss',
            'Service returned 304 without a cached channel mapping',
          );
        if (old.resolution.channel !== selection.channel)
          throw new DeliveryError(
            'invalid_response',
            'Cached channel resolution does not match request',
          );
        validateVersion(old.resolution.version, selection.bundleId);
        resolution = old.resolution;
        resolvedAt = now;
        await saveEntry(mapDir, { resolution, resolvedAt, etag: response.etag ?? old.etag });
      } else {
        resolution = response.resolution ?? undefined;
        if (
          !resolution ||
          resolution.channel !== selection.channel ||
          typeof resolution.revision !== 'string' ||
          !/^\d+$/.test(resolution.revision)
        )
          throw new DeliveryError('invalid_response', 'Channel resolution response was malformed');
        validateVersion(resolution.version, selection.bundleId);
        resolvedAt = now;
        await saveEntry(mapDir, { resolution, resolvedAt, etag: response.etag });
      }
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      const permitted =
        offline !== false &&
        old?.resolution &&
        ((typeof offline === 'object' &&
          'pinnedVersionId' in offline &&
          old.resolution.version.id === offline.pinnedVersionId) ||
          (typeof offline === 'object' && 'maxAgeMs' in offline && age <= offline.maxAgeMs));
      if (!permitted) throw error;
      resolution = old.resolution;
      resolvedAt = old.resolvedAt;
      stale = true;
    }
    if (!stale && maxAge > 0 && now - resolvedAt > maxAge)
      throw new DeliveryError('stale_resolution', 'Channel mapping exceeds maxResolutionAgeMs');
  }
  let version: VersionMetadata,
    pinnedOffline = false,
    pinnedAt = now;
  if (resolution) version = resolution.version;
  else {
    if (!('versionId' in selection))
      throw new DeliveryError(
        'invalid_response',
        'Channel resolution did not provide version metadata',
      );
    try {
      version = await client.getVersion(
        selection.projectId,
        selection.bundleId,
        selection.versionId,
      );
    } catch (error) {
      const permitted =
        typeof offline === 'object' &&
        'pinnedVersionId' in offline &&
        offline.pinnedVersionId === selection.versionId;
      if (!permitted || !isTransportFailure(error)) throw error;
      const index = await loadEntry(
        join(
          resolve(policy.cacheDir),
          keyFor(client, [selection.projectId, selection.bundleId, 'version', selection.versionId]),
        ),
      );
      if (!index?.version || !Number.isFinite(index.cachedAt))
        throw new DeliveryError('cache_miss', 'Pinned version is not cached');
      version = index.version;
      pinnedAt = index.cachedAt;
      pinnedOffline = true;
    }
  }
  validateVersion(version, selection.bundleId);
  if ('versionId' in selection && version.id !== selection.versionId)
    throw new DeliveryError(
      'invalid_response',
      'Version metadata ID does not match requested version',
    );
  const entryDir = join(
    resolve(policy.cacheDir),
    keyFor(client, [selection.projectId, selection.bundleId, version.id, version.digest]),
  );
  let downloaded = false;
  let payload: BundlePayload | undefined;
  const cached = await loadEntry(entryDir);
  if (cached?.digest === version.digest && typeof cached.payloadBytes === 'string') {
    const bytes = Buffer.from(cached.payloadBytes, 'base64');
    try {
      payload = verifyPayloadBytes(bytes, version.digest);
    } catch {
      await rm(entryDir, { recursive: true, force: true });
    }
  }
  if (!payload) {
    const bytes = await client.getPayload(selection.projectId, selection.bundleId, version.id);
    if (bytes.byteLength > MAX_PAYLOAD)
      throw new DeliveryError('invalid_payload', 'Downloaded payload exceeds size limit');
    try {
      payload = verifyPayloadBytes(bytes, version.digest);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        throw new DeliveryError('invalid_payload', 'Downloaded payload is not valid UTF-8 JSON');
      throw error;
    }
    downloaded = true;
    await saveEntry(entryDir, {
      digest: version.digest,
      payloadBytes: Buffer.from(bytes).toString('base64'),
      cachedAt: now,
    });
  }
  if (!pinnedOffline)
    await saveEntry(
      join(
        resolve(policy.cacheDir),
        keyFor(client, [selection.projectId, selection.bundleId, 'version', version.id]),
      ),
      { version, cachedAt: now },
    );
  await evict(resolve(policy.cacheDir), policy.maxCacheBytes ?? 20 * 1024 * 1024, entryDir);
  deepFreeze(version);
  deepFreeze(payload);
  if (resolution) deepFreeze(resolution);
  const verified = Object.freeze({
    version,
    payload,
    resolution,
    resolvedAt: pinnedOffline ? pinnedAt : resolvedAt,
    stale: stale || pinnedOffline,
    ...(client.integrationId
      ? {
          connection: Object.freeze({
            projectId: selection.projectId,
            integrationId: client.integrationId,
          }),
        }
      : {}),
  });
  if (policy.reporter) {
    const observation: DeliveryObservation = {
      selection: { ...selection },
      bundle: verified,
      source: downloaded ? 'network' : verified.stale ? 'offline' : 'cache',
      downloaded,
    };
    try {
      // Do not await network/reporting work on the delivery path.
      Promise.resolve(policy.reporter.observeDelivery(observation)).catch(() => {});
    } catch {}
  }
  return verified;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as any)) deepFreeze(child);
  }
  return value;
}
async function saveEntry(dir: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dir);
  const current = await lstat(dir);
  if (current.isSymbolicLink() || !current.isDirectory())
    throw new DeliveryError('unsafe_cache', 'Cache entry is not a private directory');
  const target = join(dir, 'entry.json'),
    tmp = join(dir, `.entry-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
async function evict(root: string, max: number, keep: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const items: Array<{ path: string; size: number; time: number }> = [];
  let total = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.includes('.tmp-')) continue;
    const p = join(root, ent.name);
    try {
      const s = await stat(join(p, 'entry.json'));
      items.push({ path: p, size: s.size, time: s.mtimeMs });
      total += s.size;
    } catch {}
  }
  items.sort((a, b) => a.time - b.time);
  for (const i of items) {
    if (total <= max) break;
    if (i.path === keep) continue;
    await rm(i.path, { recursive: true, force: true });
    total -= i.size;
  }
}
