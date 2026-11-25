import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { BundlePayload, Release, VersionMetadata } from '../../src/index.js';

/** An in-memory service with the bundle, version and release routes the CLI and `release()` use. */
export async function fakeService(workspace = 'project') {
  const bundles: { id: string; name: string }[] = [];
  const versions = new Map<string, { meta: VersionMetadata; bytes: string }>();
  const releases = new Map<string, Release[]>();
  const traffic: { method: string; path: string; key: string | null; body: any }[] = [];
  /** The service's encoding: fields in schema order, no whitespace, and a newline. */
  const encode = (payload: BundlePayload) =>
    JSON.stringify({
      schemaVersion: payload.schemaVersion,
      files: payload.files.map(({ path, kind, text }) => ({ path, kind, text })),
    }) + '\n';
  function addVersion(bundleId: string, payload: BundlePayload, parentVersionId: string | null) {
    const bytes = encode(payload);
    const meta = {
      id: randomUUID(),
      bundleId,
      parentVersionId,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    versions.set(meta.id, { meta, bytes });
    return meta;
  }
  function release(bundleId: string, channel: string, versionId: string, reason: string) {
    const history = releases.get(`${bundleId}:${channel}`) ?? [];
    const item: Release = {
      id: randomUUID(),
      channel,
      revision: String(history.length + 1),
      version: versions.get(versionId)!.meta,
      previousVersionId: history[0]?.version.id ?? null,
      unevaluatedReason: reason,
      reviewer: 'machine',
      createdAt: new Date().toISOString(),
    };
    releases.set(`${bundleId}:${channel}`, [item, ...history]);
    return item;
  }
  function addBundle(name: string, payload?: BundlePayload, channel = 'stable') {
    const bundle = { id: randomUUID(), name, workspaceId: workspace };
    bundles.push(bundle);
    if (payload) release(bundle.id, channel, addVersion(bundle.id, payload, null).id, 'First version');
    return bundle;
  }
  const read = async (req: IncomingMessage) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : null;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fake');
    const body = await read(req);
    const key = req.headers['idempotency-key'];
    traffic.push({ method: req.method!, path: url.pathname, key: typeof key === 'string' ? key : null, body });
    const send = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    const fail = (status: number, code: string, message: string) =>
      send(status, { error: { code, message, requestId: 'fake' } });
    if (req.headers.authorization !== 'Bearer PRIVATE_CANARY') return fail(401, 'unauthenticated', 'Unknown token');
    const prefix = `/v1/workspaces/${workspace}`;
    if (!url.pathname.startsWith(prefix + '/')) return fail(404, 'not_found', 'Workspace not found');
    const route = url.pathname.slice(prefix.length);
    let match: RegExpMatchArray | null;
    if (route === '/bundles' && req.method === 'GET') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      // One bundle per page, so callers must follow the cursor.
      return send(200, {
        items: bundles.slice(cursor, cursor + 1),
        nextCursor: cursor + 1 < bundles.length ? String(cursor + 1) : null,
      });
    }
    if (route === '/bundle-setups' && req.method === 'POST') {
      const bundle = addBundle(body.name);
      const version = addVersion(bundle.id, body.payload, null);
      const promotion = release(bundle.id, body.channel, version.id, body.reason);
      return send(201, {
        bundle,
        version,
        resolution: { channel: body.channel, revision: promotion.revision, version },
        promotion,
      });
    }
    if ((match = route.match(/^\/bundles\/([^/]+)\/versions$/)) && req.method === 'POST') {
      if (!bundles.some((bundle) => bundle.id === match![1])) return fail(404, 'not_found', 'Bundle not found');
      return send(201, addVersion(match[1], body.payload, body.parentVersionId));
    }
    if ((match = route.match(/^\/bundles\/([^/]+)\/versions\/([^/]+)(\/payload)?$/))) {
      const version = versions.get(match[2]);
      if (!version || version.meta.bundleId !== match[1]) return fail(404, 'not_found', 'Version not found');
      return send(200, match[3] ? version.bytes : version.meta);
    }
    if ((match = route.match(/^\/bundles\/([^/]+)\/channels\/([^/]+)\/releases$/))) {
      const history = releases.get(`${match[1]}:${match[2]}`) ?? [];
      if (req.method === 'GET')
        return send(200, {
          items: history.slice(0, Number(url.searchParams.get('limit') ?? 50)),
          nextBeforeRevision: null,
        });
      if (body.expectedRevision !== (history[0]?.revision ?? '0'))
        return fail(409, 'revision_conflict', 'Channel revision changed');
      const version = versions.get(body.versionId);
      if (!version || version.meta.bundleId !== match[1]) return fail(404, 'not_found', 'Version not found');
      return send(201, release(match[1], match[2], body.versionId, body.unevaluatedReason));
    }
    return fail(404, 'not_found', 'Route not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    workspace,
    bundles,
    versions,
    releases,
    traffic,
    addBundle,
    addVersion,
    release,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
