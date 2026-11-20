import type { Operation, PolicyOverride } from './types.js';
import { AcclimateError, AcclimateUsageError, TransportError } from './errors.js';
import type { PrepareDeliveryOptions, PreparedDelivery } from './prepare.js';
import { registerEvaluationMutation } from './internal/http-bridge.js';
import type {
  ComparisonPolicyReceipt,
  ComparisonPolicyReport,
  EvaluationCapabilities,
  ConnectionObservation,
  EvaluationProgressRequest,
  EvaluationProgressView,
} from './types.js';
import type {
  Channel,
  Connection,
  CreateConnectionRequest,
  ConnectionCredential,
  ConnectionCredentialKind,
  DeliveryReceipt,
  DeliveryReceiptRequest,
  LearningEnrollment,
  LearningEnrollmentRequest,
  LearningEnrollmentStatus,
  LearningFieldAuditReceipt,
  LearningFieldAuditRequest,
  LearningFieldRequalification,
  LearningFieldReplay,
  LearningOutcomeReceipt,
  LearningOutcomeStatus,
  LearningIncidentReplay,
  LearningOutcomeRequest,
  LearningCorrectionRequest,
  LearningRecheckRequest,
  LearningReviewReceipt,
  LearningRestoreRequest,
  LearningRenewalRequest,
  LearningRenewalReceipt,
  LearningWork,
} from './types.js';
import type {
  Evaluation,
  EvaluationRequest,
  StartEvaluationRequest,
  FinishEvaluationRequest,
  AbandonEvaluationRequest,
  InterruptEvaluationRequest,
} from './types.js';
import type {
  Page,
  ListOptions,
  Workspace,
  BundleSetup,
  BundleSetupRequest,
  Draft,
  CreateDraftRequest,
  SaveDraftRequest,
  DiscardDraftRequest,
  PublishDraftRequest,
  DraftSnapshot,
} from './types.js';
import type {
  ApiErrorBody,
  Bundle,
  ChannelResolution,
  Comparison,
  ComparisonRequest,
  CreateVersionRequest,
  Release,
  ReleasePage,
  CreateReleaseRequest,
  Proposal,
  ProposalRequest,
  VersionMetadata,
} from './types.js';

/** Error codes the Acclimate service returns, plus codes the client assigns to HTTP failures. */
export type ApiErrorCode =
  | 'already_adopted'
  | 'already_member'
  | 'base_conflict'
  | 'credential_already_issued'
  | 'denied'
  | 'draft_closed'
  | 'email_not_verified'
  | 'email_unavailable'
  | 'evaluation_conflict'
  | 'evaluation_progress_conflict'
  | 'generation_conflict'
  | 'guided_target_unsupported'
  | 'http_error'
  | 'idempotency_conflict'
  | 'invalid_compatibility'
  | 'invalid_console_transport'
  | 'invalid_content'
  | 'invalid_cursor'
  | 'invalid_session'
  | 'invitation_closed'
  | 'invitation_exists'
  | 'invitation_limit'
  | 'last_admin'
  | 'learning_conflict'
  | 'learning_processing_error'
  | 'machine_principal_required'
  | 'not_found'
  | 'operation_closed'
  | 'parent_conflict'
  | 'payload_too_large'
  | 'policy_binding_mismatch'
  | 'policy_override_required'
  | 'policy_receipt_conflict'
  | 'resend_unavailable'
  | 'response_too_large'
  | 'review_already_decided'
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
    registerEvaluationMutation(this, (route, body, key) =>
      this.request('POST', route, body, key, { 'X-Acclimate-Durable-Operation': 'true' }),
    );
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
  ): Promise<T> {
    const mutation = method !== 'GET' && method !== 'HEAD';
    if (mutation && (!idempotencyKey || !/^[\x20-\x7e]{1,128}$/.test(idempotencyKey)))
      throw new AcclimateUsageError(
        'mutations require a printable ASCII idempotency key (1..128 characters)',
        'idempotencyKey',
      );
    let last: unknown;
    for (let attempt = 0; attempt <= (mutation ? this.retries : 0); attempt++) {
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
          if (mutation && response.status >= 500 && attempt < this.retries) continue;
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
        if (attempt >= (mutation ? this.retries : 0)) throw error;
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
  private learningPath(workspaceId: string, connectionId: string): string {
    return this.path(workspaceId, `/connections/${this.part(connectionId)}/learning`);
  }
  enrollLearning(
    workspaceId: string,
    connectionId: string,
    body: LearningEnrollmentRequest,
    key: string,
  ): Promise<LearningEnrollment> {
    return this.request(
      'PUT',
      this.learningPath(workspaceId, connectionId),
      JSON.stringify(body),
      key,
    );
  }
  getLearningEnrollment(
    workspaceId: string,
    connectionId: string,
  ): Promise<LearningEnrollmentStatus> {
    return this.request('GET', this.learningPath(workspaceId, connectionId));
  }
  stopLearning(workspaceId: string, connectionId: string, key: string): Promise<LearningEnrollment> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/stop',
      undefined,
      key,
    );
  }
  getLearningOutcome(
    workspaceId: string,
    connectionId: string,
    outcomeId: string,
  ): Promise<LearningOutcomeStatus> {
    return this.request(
      'GET',
      this.learningPath(workspaceId, connectionId) + '/outcomes/' + this.part(outcomeId),
    );
  }
  reportLearningIncidentReplay(
    workspaceId: string,
    connectionId: string,
    body: LearningIncidentReplay,
  ): Promise<{ accepted: true }> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/incident-replays',
      JSON.stringify(body),
      body.roundId,
    );
  }
  reportLearningOutcome(
    workspaceId: string,
    connectionId: string,
    body: LearningOutcomeRequest,
    key = body.outcomeId,
  ): Promise<LearningOutcomeReceipt> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/outcomes',
      JSON.stringify(body),
      key,
    );
  }
  reportLearningCorrection(
    workspaceId: string,
    connectionId: string,
    body: LearningCorrectionRequest,
  ): Promise<{ correctionId: string; outcomeId: string; accepted: true }> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/corrections',
      JSON.stringify(body),
      body.correctionId,
    );
  }
  reportLearningRecheck(
    workspaceId: string,
    connectionId: string,
    body: LearningRecheckRequest,
  ): Promise<{
    correctionId: string;
    revision: string;
    verdict: LearningRecheckRequest['verdict'];
    accepted: true;
  }> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/rechecks',
      JSON.stringify(body),
      body.correctionId + ':' + body.revision,
    );
  }
  getLearningWork(workspaceId: string, connectionId: string): Promise<LearningWork> {
    return this.request('GET', this.learningPath(workspaceId, connectionId) + '/work');
  }
  getLearningFieldRequalification(
    workspaceId: string,
    connectionId: string,
    versionId: string,
  ): Promise<LearningFieldRequalification> {
    return this.request(
      'GET',
      this.learningPath(workspaceId, connectionId) +
        '/field-requalifications/' +
        encodeURIComponent(versionId),
    );
  }
  reportLearningFieldReplay(
    workspaceId: string,
    connectionId: string,
    body: LearningFieldReplay,
  ): Promise<{ accepted: true }> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/field-requalifications',
      JSON.stringify(body),
      [body.outcomeId, body.versionId, body.baselineRevision].join(':'),
    );
  }
  reportLearningFieldAudit(
    workspaceId: string,
    connectionId: string,
    body: LearningFieldAuditRequest,
    key = body.outcomeId,
  ): Promise<LearningFieldAuditReceipt> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/field-audits',
      JSON.stringify(body),
      key,
    );
  }
  reviewLearningRound(
    workspaceId: string,
    connectionId: string,
    roundId: string,
    approve: boolean,
    key: string,
    policyOverride?: PolicyOverride,
  ): Promise<LearningReviewReceipt> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + `/rounds/${this.part(roundId)}/review`,
      JSON.stringify({ approve, policyOverride }),
      key,
    );
  }
  renewLearning(
    workspaceId: string,
    connectionId: string,
    body: LearningRenewalRequest,
    key = body.renewalId,
  ): Promise<LearningRenewalReceipt> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/renew',
      JSON.stringify(body),
      key,
    );
  }
  restoreLearning(
    workspaceId: string,
    connectionId: string,
    body: LearningRestoreRequest,
    key = body.restoreId,
  ): Promise<Release> {
    return this.request(
      'POST',
      this.learningPath(workspaceId, connectionId) + '/restore',
      JSON.stringify(body),
      key,
    );
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
  createProposal(
    workspaceId: string,
    bundleId: string,
    request: ProposalRequest,
    key: string,
  ): Promise<Proposal> {
    return this.request(
      'POST',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/proposals`),
      JSON.stringify(request),
      key,
    );
  }
  getProposal(workspaceId: string, bundleId: string, id: string): Promise<Proposal> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/proposals/${this.part(id)}`),
    );
  }
  createComparison(
    workspaceId: string,
    bundleId: string,
    request: ComparisonRequest,
    key: string,
  ): Promise<Comparison> {
    return this.request(
      'POST',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/comparisons`),
      JSON.stringify(request),
      key,
    );
  }
  getComparison(workspaceId: string, bundleId: string, id: string): Promise<Comparison> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/comparisons/${this.part(id)}`),
    );
  }
  private comparisonPolicyPath(workspaceId: string, bundleId: string, comparisonId: string) {
    return this.path(
      workspaceId,
      `/bundles/${this.part(bundleId)}/comparisons/${this.part(comparisonId)}/policy-receipts`,
    );
  }
  listComparisonPolicyReceipts(
    workspaceId: string,
    bundleId: string,
    comparisonId: string,
  ): Promise<{ items: ComparisonPolicyReceipt[] }> {
    return this.request('GET', this.comparisonPolicyPath(workspaceId, bundleId, comparisonId));
  }
  listCandidatePolicyReceipts(
    workspaceId: string,
    bundleId: string,
    versionId: string,
  ): Promise<{ items: ComparisonPolicyReceipt[] }> {
    return this.request(
      'GET',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/versions/${this.part(versionId)}/policy-receipts`,
      ),
    );
  }
  reportComparisonPolicyReceipt(
    workspaceId: string,
    bundleId: string,
    comparisonId: string,
    report: ComparisonPolicyReport,
  ): Promise<ComparisonPolicyReceipt> {
    return this.request(
      'POST',
      this.comparisonPolicyPath(workspaceId, bundleId, comparisonId),
      JSON.stringify(report),
      `policy:${comparisonId}:${report.policy.sha256}`,
    );
  }
  private listing(options: ListOptions = {}): string {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    return query.size ? `?${query}` : '';
  }
  private draftPath(workspaceId: string, bundleId: string, channel: string, id?: string): string {
    return this.path(
      workspaceId,
      `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}/drafts${id === undefined ? '' : `/${this.part(id)}`}`,
    );
  }
  listWorkspaces(options: ListOptions = {}): Promise<Page<Workspace>> {
    return this.request('GET', `/v1/workspaces${this.listing(options)}`);
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
  createDraft(
    workspaceId: string,
    bundleId: string,
    channel: string,
    request: CreateDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(workspaceId, bundleId, channel),
      JSON.stringify(request),
      key,
    );
  }
  listDrafts(
    workspaceId: string,
    bundleId: string,
    channel: string,
    options: ListOptions & { status?: Draft['status'] | 'all' } = {},
  ): Promise<Page<Draft>> {
    return this.request(
      'GET',
      this.draftPath(workspaceId, bundleId, channel) +
        this.listing(options) +
        (options.status
          ? `${this.listing(options) ? '&' : '?'}status=${encodeURIComponent(options.status)}`
          : ''),
    );
  }
  getDraft(workspaceId: string, bundleId: string, channel: string, id: string): Promise<Draft> {
    return this.request('GET', this.draftPath(workspaceId, bundleId, channel, id));
  }
  getDraftHistory(
    workspaceId: string,
    bundleId: string,
    channel: string,
    id: string,
    options: ListOptions = {},
  ): Promise<Page<DraftSnapshot>> {
    return this.request(
      'GET',
      this.draftPath(workspaceId, bundleId, channel, id) + '/history' + this.listing(options),
    );
  }
  saveDraft(
    workspaceId: string,
    bundleId: string,
    channel: string,
    id: string,
    request: SaveDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(workspaceId, bundleId, channel, id) + '/save',
      JSON.stringify(request),
      key,
    );
  }
  discardDraft(
    workspaceId: string,
    bundleId: string,
    channel: string,
    id: string,
    request: DiscardDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(workspaceId, bundleId, channel, id) + '/discard',
      JSON.stringify(request),
      key,
    );
  }
  publishDraft(
    workspaceId: string,
    bundleId: string,
    channel: string,
    id: string,
    request: PublishDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(workspaceId, bundleId, channel, id) + '/publish',
      JSON.stringify(request),
      key,
    );
  }
  listProposals(
    workspaceId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Proposal>> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/proposals${this.listing(options)}`),
    );
  }
  listComparisons(
    workspaceId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Comparison>> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/comparisons${this.listing(options)}`),
    );
  }
  createEvaluation(
    workspaceId: string,
    bundleId: string,
    request: EvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/evaluation-requests`),
      JSON.stringify(request),
      key,
    );
  }
  startEvaluation(
    workspaceId: string,
    bundleId: string,
    id: string,
    request: StartEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/start`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  getEvaluationProgress(
    workspaceId: string,
    bundleId: string,
    id: string,
  ): Promise<EvaluationProgressView> {
    return this.request(
      'GET',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/progress`,
      ),
    );
  }
  reportEvaluationProgress(
    workspaceId: string,
    bundleId: string,
    id: string,
    report: EvaluationProgressRequest,
  ): Promise<EvaluationProgressView> {
    // The server uses attempt + sequence, not retained operation records. This
    // transport key enables safe same-body network retries without key growth.
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/progress`,
      ),
      JSON.stringify(report),
      `progress:${report.sequence}`,
    );
  }
  finishEvaluation(
    workspaceId: string,
    bundleId: string,
    id: string,
    request: FinishEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/finish`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  /** Abandon an attempt whose outcome is unknown. Its evidence never counts, and a
   * new request for the same candidate may then start. This is not proof that the
   * original worker stopped. */
  abandonEvaluation(
    workspaceId: string,
    bundleId: string,
    id: string,
    request: AbandonEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/abandon`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  interruptEvaluation(
    workspaceId: string,
    bundleId: string,
    id: string,
    request: InterruptEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/interrupt`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  listEvaluations(
    workspaceId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Evaluation>> {
    return this.request(
      'GET',
      this.path(
        workspaceId,
        `/bundles/${this.part(bundleId)}/evaluation-requests${this.listing(options)}`,
      ),
    );
  }
  getEvaluation(workspaceId: string, bundleId: string, id: string): Promise<Evaluation> {
    return this.request(
      'GET',
      this.path(workspaceId, `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}`),
    );
  }
  getEvaluationCapabilities(workspaceId: string): Promise<EvaluationCapabilities> {
    return this.request('GET', this.path(workspaceId, '/evaluation-capabilities'));
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
