import { AcclimateError, AcclimateUsageError, TransportError } from './errors.js';
import type { PrepareDeliveryOptions, PreparedDelivery } from './prepare.js';
import type {
  ApiErrorBody, Bundle, BundleSetup, BundleSetupRequest, Channel, ChannelResolution,
  Connection, ConnectionCredential, ConnectionCredentialKind, ConnectionObservation,
  CreateConnectionRequest, CreateReleaseRequest, CreateVersionRequest, DeliveryReceipt,
  DeliveryReceiptRequest, ListOptions, Operation, Page, Release, ReleasePage,
  VersionMetadata, Workspace,
  WorkspacePrincipal, LearningLoopRequest, LearningLoop, LearningRoundSummary, LearningRound, LearningMemory,
  LearningEvolveCasesRequest, LearningEvolveCasesReceipt, LearningEvolveCasesPage, LearningOutcomeRequest,
  LearningOutcomeReceipt, LearningWork, LearningEvaluationStart, LearningEvaluationAssignment,
  LearningEvaluationReportRequest, LearningEvaluation,
} from './types.js';

/** Error codes the Acclimate service returns, plus codes the client assigns to HTTP failures. */
export type ApiErrorCode =
  | 'already_adopted'
  | 'already_member'
  | 'base_conflict'
  | 'credential_already_issued'
  | 'denied'
  | 'email_not_verified'
  | 'email_unavailable'
  | 'http_error'
  | 'idempotency_conflict'
  | 'invalid_compatibility'
  | 'invalid_console_transport'
  | 'invalid_content'
  | 'invalid_cursor'
  | 'invalid_session'
  | 'learning_conflict'
  | 'invitation_closed'
  | 'invitation_exists'
  | 'invitation_limit'
  | 'last_admin'
  | 'machine_principal_required'
  | 'not_found'
  | 'operation_closed'
  | 'parent_conflict'
  | 'payload_too_large'
  | 'resend_unavailable'
  | 'response_too_large'
  | 'revision_conflict'
  | 'unauthenticated'
  | 'unavailable'
  | 'workspace_owned'
  // A newer service can return codes this SDK version does not list yet.
  | (string & {});

/** The service answered with a non-success HTTP status. */
export class ApiError extends AcclimateError<ApiErrorCode> {
  readonly status: number;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    requestId: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Trusted console-server session only; never populate from browser state automatically. */
  sessionToken?: string;
  scope: string;
  /** ID of the connection (application installation) that consumes content. A UUID. */
  connectionId?: string;
  fetch?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  /** Bounded decoded JSON responses, including retained-operation envelopes. Default 4 MiB. */
  maxJsonResponseBytes?: number;
}
export interface ChannelOptions {
  etag?: string;
}
export interface ChannelResult {
  resolution: ChannelResolution | null;
  etag: string | null;
  notModified: boolean;
}

export class AcclimateClient {
  readonly baseUrl: string;
  readonly scope: string;
  readonly connectionId?: string;
  private readonly token: string;
  private readonly sessionToken?: string;
  private readonly fetcher: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly maxJsonResponseBytes: number;
  /** Resolve a published channel or pinned version and stage its verified content for one job. */
  async prepare(options: PrepareDeliveryOptions): Promise<PreparedDelivery> {
    const { prepareDelivery } = await import('./prepare.js');
    return prepareDelivery(this, options);
  }
  constructor(options: ClientOptions) {
    for (const field of ['baseUrl', 'token', 'scope'] as const)
      if (!options?.[field])
        throw new AcclimateUsageError(`${field} is required. Pass baseUrl, token and scope.`, field);
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new AcclimateUsageError('baseUrl must be an absolute HTTP(S) URL.', 'baseUrl');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AcclimateUsageError(
        'baseUrl must be an HTTP(S) service URL without credentials, query, or fragment',
        'baseUrl',
      );
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.scope = options.scope;
    if (
      options.connectionId !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.connectionId)
    )
      throw new AcclimateUsageError('connectionId must be a UUID', 'connectionId');
    this.connectionId = options.connectionId?.toLowerCase();
    this.token = options.token;
    this.sessionToken = options.sessionToken;
    this.fetcher = options.fetch ?? fetch;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 1024 * 1024;
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? 4 * 1024 * 1024;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3)
      throw new AcclimateUsageError('retries must be an integer between 0 and 3', 'retries');
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000)
      throw new AcclimateUsageError('timeoutMs must be between 1 and 120000', 'timeoutMs');
    if (
      !Number.isFinite(this.maxPayloadBytes) ||
      this.maxPayloadBytes < 1 ||
      this.maxPayloadBytes > 2 * 1024 * 1024
    )
      throw new AcclimateUsageError('maxPayloadBytes must be between 1 and 2097152', 'maxPayloadBytes');
    if (
      !Number.isSafeInteger(this.maxJsonResponseBytes) ||
      this.maxJsonResponseBytes < 1 ||
      this.maxJsonResponseBytes > 8 * 1024 * 1024
    )
      throw new AcclimateUsageError('maxJsonResponseBytes must be an integer between 1 and 8388608', 'maxJsonResponseBytes');
  }
  private part(value: string): string {
    if (!value || value === '.' || value === '..')
      throw new AcclimateUsageError(
        'path identifiers (workspace, bundle and version IDs) must be nonempty and not dot segments',
        'pathIdentifier',
      );
    return encodeURIComponent(value);
  }
  private path(workspaceId: string, suffix: string): string {
    return `/v1/workspaces/${this.part(workspaceId)}${suffix}`;
  }
  private deliveryHeaders(): Record<string, string> {
    return this.connectionId ? { 'X-Acclimate-Connection-Id': this.connectionId } : {};
  }
  private async readBytes(response: Response, limit: number, payload = false): Promise<Uint8Array> {
    const fail = () =>
      new ApiError(
        413,
        payload ? 'payload_too_large' : 'response_too_large',
        payload
          ? 'Downloaded payload exceeds configured limit'
          : 'JSON response exceeds configured limit',
        '',
      );
    const transport = (error: unknown): never => {
      throw error instanceof AcclimateError ? error : new TransportError(this.baseUrl, error);
    };
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer().catch(transport));
      if (bytes.byteLength > limit) throw fail();
      return bytes;
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read().catch(transport);
        if (item.done) break;
        size += item.value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          throw fail();
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  /** Only network and timeout failures become TransportError; argument and parsing bugs stay distinct. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, init);
    } catch (error) {
      if (error instanceof AcclimateError) throw error;
      throw new TransportError(this.baseUrl, error);
    }
  }
  private async readJson<T>(response: Response): Promise<T> {
    const bytes = await this.readBytes(response, this.maxJsonResponseBytes);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  }
  async health(): Promise<string> {
    const response = await this.send(this.baseUrl + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'manual',
    });
    if (!response.ok) {
      const err = await this.readJson<ApiErrorBody>(response).catch((error) => {
        if (error instanceof ApiError) throw error;
        return null;
      });
      throw new ApiError(
        response.status,
        err?.error?.code ?? 'http_error',
        err?.error?.message ?? `HTTP ${response.status}`,
        err?.error?.requestId ?? response.headers.get('x-request-id') ?? '',
        err?.error?.details,
      );
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      await this.readBytes(response, this.maxJsonResponseBytes),
    );
  }
  private async request<T>(
    method: string,
    path: string,
    body?: string,
    idempotencyKey?: string,
    headers: Record<string, string> = {},
    raw = false,
    channelResolution = false,
    optionalKey = false,
  ): Promise<T> {
    const mutation = method !== 'GET' && method !== 'HEAD';
    if (mutation && !(optionalKey && idempotencyKey === undefined) && (!idempotencyKey || !/^[\x20-\x7e]{1,128}$/.test(idempotencyKey)))
      throw new AcclimateUsageError(
        'mutations require a printable ASCII idempotency key (1..128 characters)',
        'idempotencyKey',
      );
    const retries = mutation && idempotencyKey ? this.retries : 0;
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.send(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(this.sessionToken ? { 'X-Acclimate-Session': this.sessionToken } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            ...headers,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'manual',
        });
        if (response.status === 304)
          return { notModified: true, etag: response.headers.get('etag') } as T;
        if (!response.ok) {
          const err = await this.readJson<ApiErrorBody>(response).catch((error) => {
            if (error instanceof ApiError) throw error;
            return null;
          });
          if (response.status >= 500 && attempt < retries) continue;
          throw new ApiError(
            response.status,
            err?.error?.code ?? 'http_error',
            err?.error?.message ?? `HTTP ${response.status}`,
            err?.error?.requestId ?? response.headers.get('x-request-id') ?? '',
            err?.error?.details,
          );
        }
        if (raw) {
          return (await this.readBytes(response, this.maxPayloadBytes, true)) as T;
        }
        if (response.status === 204) return undefined as T;
        const value = await this.readJson<T>(response);
        if (channelResolution)
          return { resolution: value, etag: response.headers.get('etag'), notModified: false } as T;
        return value;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        last = error;
        if (attempt >= retries) throw error;
      }
    }
    throw last;
  }
  createBundle(
    workspaceId: string,
    request: { name: string; compatibilityTarget?: import('./types.js').CompatibilityTarget },
    key: string,
  ): Promise<Bundle> {
    return this.request('POST', this.path(workspaceId, '/bundles'), JSON.stringify(request), key);
  }
  createVersion(
    workspaceId: string,
    bundleId: string,
    request: CreateVersionRequest,
    key: string,
  ): Promise<VersionMetadata> {
    return this.request(
      'POST',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/versions`),
      JSON.stringify(request),
      key,
    );
  }
  getVersion(workspaceId: string, bundleId: string, versionId: string): Promise<VersionMetadata> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/versions/${this.part(versionId)}`),
      undefined,
      undefined,
      this.deliveryHeaders(),
    );
  }
  getPayload(workspaceId: string, bundleId: string, versionId: string): Promise<Uint8Array> {
    return this.request(
      'GET',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/versions/${this.part(versionId)}/payload`,
      ),
      undefined,
      undefined,
      this.deliveryHeaders(),
      true,
    );
  }
  async resolveChannel(
    workspaceId: string,
    bundleId: string,
    channel: string,
    options: ChannelOptions = {},
  ): Promise<ChannelResult> {
    const result = await this.request<ChannelResult>(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}`),
      undefined,
      undefined,
      { ...this.deliveryHeaders(), ...(options.etag ? { 'If-None-Match': options.etag } : {}) },
      false,
      true,
    );
    return result.notModified ? { resolution: null, etag: result.etag, notModified: true } : result;
  }
  /** Inspect the channel’s latest release for evaluation or management. */
  async inspectSource(workspaceId: string, bundleId: string, channel: string): Promise<ChannelResolution | null> {
    const [release] = (await this.listReleases(workspaceId, bundleId, channel, { limit: 1 })).items;
    return release ? { channel: release.channel, revision: release.revision, version: release.version } : null;
  }
  listReleases(
    workspaceId: string,
    bundleId: string,
    channel: string,
    options: { limit?: number; beforeRevision?: string } = {},
  ): Promise<ReleasePage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.beforeRevision !== undefined) query.set('beforeRevision', options.beforeRevision);
    const suffix = query.size ? `?${query}` : '';
    return this.request(
      'GET',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}/releases${suffix}`,
      ),
    );
  }
  createRelease(
    workspaceId: string,
    bundleId: string,
    channel: string,
    request: CreateReleaseRequest,
    key: string,
  ): Promise<Release> {
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}/releases`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  private loopPath(workspaceId: string, bundleId: string): string {
    return this.path(workspaceId, `/bundles/${this.part(bundleId)}/learning`);
  }
  private learningQuery(options: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options))
      if (value !== undefined) query.set(name, String(value));
    return query.size ? `?${query}` : '';
  }
  enrollLearningLoop(workspaceId: string, bundleId: string, body: LearningLoopRequest, key?: string): Promise<LearningLoop> {
    return this.request('PUT', this.loopPath(workspaceId, bundleId), JSON.stringify(body), key, {}, false, false, true);
  }
  getLearningLoop(workspaceId: string, bundleId: string): Promise<LearningLoop> {
    return this.request('GET', this.loopPath(workspaceId, bundleId));
  }
  pauseLearningLoop(workspaceId: string, bundleId: string, key?: string): Promise<LearningLoop> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + '/pause', undefined, key, {}, false, false, true);
  }
  resumeLearningLoop(workspaceId: string, bundleId: string, key?: string): Promise<LearningLoop> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + '/resume', undefined, key, {}, false, false, true);
  }
  stopLearningLoop(workspaceId: string, bundleId: string, key?: string): Promise<LearningLoop> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + '/stop', undefined, key, {}, false, false, true);
  }
  listLearningRounds(workspaceId: string, bundleId: string, options: { before?: number; limit?: number } = {}): Promise<{ items: LearningRoundSummary[]; next: number | null }> {
    return this.request('GET', this.loopPath(workspaceId, bundleId) + '/rounds' + this.learningQuery(options));
  }
  getLearningRound(workspaceId: string, bundleId: string, roundId: string, options: { evaluation?: string } = {}): Promise<LearningRound> {
    return this.request('GET', this.loopPath(workspaceId, bundleId) + `/rounds/${this.part(roundId)}` + this.learningQuery(options));
  }
  getLearningMemory(workspaceId: string, bundleId: string, options: { revision?: number } = {}): Promise<LearningMemory> {
    return this.request('GET', this.loopPath(workspaceId, bundleId) + '/memory' + this.learningQuery(options));
  }
  listLearningEvolveCases(workspaceId: string, bundleId: string, options: { after?: string; limit?: number } = {}): Promise<LearningEvolveCasesPage> {
    return this.request('GET', this.loopPath(workspaceId, bundleId) + '/evolve-cases' + this.learningQuery(options));
  }
  addLearningEvolveCases(workspaceId: string, bundleId: string, body: LearningEvolveCasesRequest, key?: string): Promise<LearningEvolveCasesReceipt> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + '/evolve-cases', JSON.stringify(body), key, {}, false, false, true);
  }
  reportLearningOutcome(workspaceId: string, bundleId: string, body: LearningOutcomeRequest, key = body.outcomeId): Promise<LearningOutcomeReceipt> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + '/outcomes', JSON.stringify(body), key);
  }
  getLearningWork(workspaceId: string, bundleId: string): Promise<LearningWork> {
    return this.request('GET', this.loopPath(workspaceId, bundleId) + '/work');
  }
  startLearningEvaluation(workspaceId: string, bundleId: string, evaluationId: string, body: LearningEvaluationStart, key = body.attemptId): Promise<LearningEvaluationAssignment> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + `/evaluations/${this.part(evaluationId)}/start`, JSON.stringify(body), key);
  }
  reportLearningEvaluation(workspaceId: string, bundleId: string, evaluationId: string, body: LearningEvaluationReportRequest, key: string): Promise<LearningEvaluation> {
    return this.request('POST', this.loopPath(workspaceId, bundleId) + `/evaluations/${this.part(evaluationId)}/report`, JSON.stringify(body), key);
  }
  private listing(options: ListOptions = {}): string {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    return query.size ? `?${query}` : '';
  }
  listWorkspaces(options: ListOptions = {}): Promise<Page<Workspace>> {
    return this.request('GET', `/v1/workspaces${this.listing(options)}`);
  }
  getPrincipal(workspaceId: string): Promise<WorkspacePrincipal> {
    return this.request('GET', this.path(workspaceId, '/principal'));
  }
  listBundles(workspaceId: string, options: ListOptions = {}): Promise<Page<Bundle>> {
    return this.request('GET', this.path(workspaceId, `/bundles${this.listing(options)}`));
  }
  listChannels(
    workspaceId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Channel>> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/channels${this.listing(options)}`),
    );
  }
  createBundleSetup(
    workspaceId: string,
    request: BundleSetupRequest,
    key: string,
  ): Promise<BundleSetup> {
    return this.request(
      'POST',
      this.path(workspaceId, '/bundle-setups'),
      JSON.stringify(request),
      key,
    );
  }
  listConnectionObservations(
    workspaceId: string,
    options: ListOptions = {},
  ): Promise<Page<ConnectionObservation>> {
    return this.request(
      'GET',
      this.path(workspaceId, '/connection-observations' + this.listing(options)),
    );
  }

  createConnection(
    workspaceId: string,
    request: CreateConnectionRequest,
    key: string,
  ): Promise<Connection> {
    return this.request('POST', this.path(workspaceId, '/connections'), JSON.stringify(request), key);
  }
  listConnections(workspaceId: string, options: ListOptions = {}): Promise<Page<Connection>> {
    return this.request('GET', this.path(workspaceId, '/connections' + this.listing(options)));
  }
  createConnectionCredential(
    workspaceId: string,
    id: string,
    request: { kind: ConnectionCredentialKind },
    key: string,
  ): Promise<ConnectionCredential> {
    return this.request(
      'POST',
      this.path(workspaceId, `/connections/${this.part(id)}/credentials`),
      JSON.stringify(request),
      key,
    );
  }
  revokeConnection(workspaceId: string, id: string, key: string): Promise<Connection> {
    return this.request(
      'POST',
      this.path(workspaceId, `/connections/${this.part(id)}/revoke`),
      '{}',
      key,
    );
  }
  revokeConnectionCredential(
    workspaceId: string,
    id: string,
    credentialId: string,
    key: string,
  ): Promise<void> {
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/connections/${this.part(id)}/credentials/${this.part(credentialId)}/revoke`,
      ),
      '{}',
      key,
    );
  }
  reportDeliveryReceipt(
    workspaceId: string,
    id: string,
    request: DeliveryReceiptRequest,
    key: string,
  ): Promise<DeliveryReceipt> {
    return this.request(
      'POST',
      this.path(workspaceId, `/connections/${this.part(id)}/receipts`),
      JSON.stringify(request),
      key,
    );
  }
  listDeliveryReceipts(
    workspaceId: string,
    id: string,
    options: ListOptions = {},
  ): Promise<Page<DeliveryReceipt>> {
    return this.request(
      'GET',
      this.path(workspaceId, `/connections/${this.part(id)}/receipts${this.listing(options)}`),
    );
  }
  getOperation(workspaceId: string, operationId: string, operationPath?: string): Promise<Operation> {
    const query = operationPath ? `?operationPath=${encodeURIComponent(operationPath)}` : '';
    return this.request(
      'GET',
      this.path(workspaceId, `/operations/${this.part(operationId)}${query}`),
    );
  }
  closeOperation(
    workspaceId: string,
    operationId: string,
    operationPath?: string,
  ): Promise<Operation> {
    return this.request(
      'POST',
      this.path(workspaceId, `/operations/${this.part(operationId)}/close`),
      JSON.stringify({ operationPath }),
      operationId,
    );
  }
}
