import type { Operation, PolicyOverride } from './types.js';
import type { PrepareDeliveryOptions, PreparedDelivery } from './prepare.js';
import { registerEvaluationMutation } from './internal/http-bridge.js';
import type {
  ComparisonPolicyReceipt,
  ComparisonPolicyReport,
  EvaluationCapabilities,
  IntegrationObservation,
  EvaluationProgressRequest,
  EvaluationProgressView,
} from './types.js';
import type {
  Channel,
  Integration,
  CreateIntegrationRequest,
  IntegrationCredential,
  IntegrationCredentialKind,
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
  InterruptEvaluationRequest,
} from './types.js';
import type {
  Page,
  ListOptions,
  Project,
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
  Promotion,
  PromotionPage,
  PromoteRequest,
  Proposal,
  ProposalRequest,
  VersionMetadata,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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
  /** Stable service integration ID of the application installation consuming content. */
  integrationId?: string;
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
  readonly integrationId?: string;
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
    if (!options.baseUrl || !options.token || !options.scope)
      throw new TypeError('baseUrl, token, and scope are required');
    const url = new URL(options.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError(
        'baseUrl must be an HTTP(S) service URL without credentials, query, or fragment',
      );
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.scope = options.scope;
    if (
      options.integrationId !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.integrationId)
    )
      throw new TypeError('integrationId must be a UUID');
    this.integrationId = options.integrationId?.toLowerCase();
    this.token = options.token;
    this.sessionToken = options.sessionToken;
    this.fetcher = options.fetch ?? fetch;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 1024 * 1024;
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? 4 * 1024 * 1024;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3)
      throw new RangeError('retries must be an integer between 0 and 3');
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000)
      throw new RangeError('timeoutMs must be between 1 and 120000');
    if (
      !Number.isFinite(this.maxPayloadBytes) ||
      this.maxPayloadBytes < 1 ||
      this.maxPayloadBytes > 2 * 1024 * 1024
    )
      throw new RangeError('maxPayloadBytes must be between 1 and 2097152');
    if (
      !Number.isSafeInteger(this.maxJsonResponseBytes) ||
      this.maxJsonResponseBytes < 1 ||
      this.maxJsonResponseBytes > 8 * 1024 * 1024
    )
      throw new RangeError('maxJsonResponseBytes must be an integer between 1 and 8388608');
    registerEvaluationMutation(this, (route, body, key) =>
      this.request('POST', route, body, key, { 'X-Acclimate-Durable-Operation': 'true' }),
    );
  }
  private part(value: string): string {
    if (!value || value === '.' || value === '..')
      throw new TypeError('path identifiers must be nonempty and not dot segments');
    return encodeURIComponent(value);
  }
  private path(projectId: string, suffix: string): string {
    return `/v1/projects/${this.part(projectId)}${suffix}`;
  }
  private deliveryHeaders(): Record<string, string> {
    return this.integrationId ? { 'X-Acclimate-Integration-Id': this.integrationId } : {};
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
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > limit) throw fail();
      return bytes;
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
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
  private async readJson<T>(response: Response): Promise<T> {
    const bytes = await this.readBytes(response, this.maxJsonResponseBytes);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  }
  async health(): Promise<string> {
    const response = await this.fetcher(this.baseUrl + '/health', {
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
      throw new TypeError(
        'mutations require a printable ASCII idempotency key (1..128 characters)',
      );
    let last: unknown;
    for (let attempt = 0; attempt <= (mutation ? this.retries : 0); attempt++) {
      try {
        const response = await this.fetcher(this.baseUrl + path, {
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
    projectId: string,
    request: { name: string; compatibilityTarget?: import('./types.js').CompatibilityTarget },
    key: string,
  ): Promise<Bundle> {
    return this.request('POST', this.path(projectId, '/bundles'), JSON.stringify(request), key);
  }
  createVersion(
    projectId: string,
    bundleId: string,
    request: CreateVersionRequest,
    key: string,
  ): Promise<VersionMetadata> {
    return this.request(
      'POST',
      this.path(projectId, `/bundles/${this.part(bundleId)}/versions`),
      JSON.stringify(request),
      key,
    );
  }
  getVersion(projectId: string, bundleId: string, versionId: string): Promise<VersionMetadata> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/versions/${this.part(versionId)}`),
      undefined,
      undefined,
      this.deliveryHeaders(),
    );
  }
  getPayload(projectId: string, bundleId: string, versionId: string): Promise<Uint8Array> {
    return this.request(
      'GET',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/versions/${this.part(versionId)}/payload`,
      ),
      undefined,
      undefined,
      this.deliveryHeaders(),
      true,
    );
  }
  async resolveChannel(
    projectId: string,
    bundleId: string,
    channel: string,
    options: ChannelOptions = {},
  ): Promise<ChannelResult> {
    const result = await this.request<ChannelResult>(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}`),
      undefined,
      undefined,
      { ...this.deliveryHeaders(), ...(options.etag ? { 'If-None-Match': options.etag } : {}) },
      false,
      true,
    );
    return result.notModified ? { resolution: null, etag: result.etag, notModified: true } : result;
  }
  private learningPath(projectId: string, integrationId: string): string {
    return this.path(projectId, `/integrations/${this.part(integrationId)}/learning`);
  }
  enrollLearning(
    projectId: string,
    integrationId: string,
    body: LearningEnrollmentRequest,
    key: string,
  ): Promise<LearningEnrollment> {
    return this.request(
      'PUT',
      this.learningPath(projectId, integrationId),
      JSON.stringify(body),
      key,
    );
  }
  getLearningEnrollment(
    projectId: string,
    integrationId: string,
  ): Promise<LearningEnrollmentStatus> {
    return this.request('GET', this.learningPath(projectId, integrationId));
  }
  stopLearning(projectId: string, integrationId: string, key: string): Promise<LearningEnrollment> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/stop',
      undefined,
      key,
    );
  }
  getLearningOutcome(
    projectId: string,
    integrationId: string,
    outcomeId: string,
  ): Promise<LearningOutcomeStatus> {
    return this.request(
      'GET',
      this.learningPath(projectId, integrationId) + '/outcomes/' + this.part(outcomeId),
    );
  }
  reportLearningIncidentReplay(
    projectId: string,
    integrationId: string,
    body: LearningIncidentReplay,
  ): Promise<{ accepted: true }> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/incident-replays',
      JSON.stringify(body),
      body.roundId,
    );
  }
  reportLearningOutcome(
    projectId: string,
    integrationId: string,
    body: LearningOutcomeRequest,
    key = body.outcomeId,
  ): Promise<LearningOutcomeReceipt> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/outcomes',
      JSON.stringify(body),
      key,
    );
  }
  reportLearningCorrection(
    projectId: string,
    integrationId: string,
    body: LearningCorrectionRequest,
  ): Promise<{ correctionId: string; outcomeId: string; accepted: true }> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/corrections',
      JSON.stringify(body),
      body.correctionId,
    );
  }
  reportLearningRecheck(
    projectId: string,
    integrationId: string,
    body: LearningRecheckRequest,
  ): Promise<{
    correctionId: string;
    revision: string;
    verdict: LearningRecheckRequest['verdict'];
    accepted: true;
  }> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/rechecks',
      JSON.stringify(body),
      body.correctionId + ':' + body.revision,
    );
  }
  getLearningWork(projectId: string, integrationId: string): Promise<LearningWork> {
    return this.request('GET', this.learningPath(projectId, integrationId) + '/work');
  }
  getLearningFieldRequalification(
    projectId: string,
    integrationId: string,
    versionId: string,
  ): Promise<LearningFieldRequalification> {
    return this.request(
      'GET',
      this.learningPath(projectId, integrationId) +
        '/field-requalifications/' +
        encodeURIComponent(versionId),
    );
  }
  reportLearningFieldReplay(
    projectId: string,
    integrationId: string,
    body: LearningFieldReplay,
  ): Promise<{ accepted: true }> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/field-requalifications',
      JSON.stringify(body),
      [body.outcomeId, body.versionId, body.baselineRevision].join(':'),
    );
  }
  reportLearningFieldAudit(
    projectId: string,
    integrationId: string,
    body: LearningFieldAuditRequest,
    key = body.outcomeId,
  ): Promise<LearningFieldAuditReceipt> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/field-audits',
      JSON.stringify(body),
      key,
    );
  }
  reviewLearningRound(
    projectId: string,
    integrationId: string,
    roundId: string,
    approve: boolean,
    key: string,
    policyOverride?: PolicyOverride,
  ): Promise<LearningReviewReceipt> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + `/rounds/${this.part(roundId)}/review`,
      JSON.stringify({ approve, policyOverride }),
      key,
    );
  }
  renewLearning(
    projectId: string,
    integrationId: string,
    body: LearningRenewalRequest,
    key = body.renewalId,
  ): Promise<LearningRenewalReceipt> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/renew',
      JSON.stringify(body),
      key,
    );
  }
  restoreLearning(
    projectId: string,
    integrationId: string,
    body: LearningRestoreRequest,
    key = body.restoreId,
  ): Promise<Promotion> {
    return this.request(
      'POST',
      this.learningPath(projectId, integrationId) + '/restore',
      JSON.stringify(body),
      key,
    );
  }
  listPromotions(
    projectId: string,
    bundleId: string,
    channel: string,
    options: { limit?: number; beforeRevision?: string } = {},
  ): Promise<PromotionPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.beforeRevision !== undefined) query.set('beforeRevision', options.beforeRevision);
    const suffix = query.size ? `?${query}` : '';
    return this.request(
      'GET',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}/promotions${suffix}`,
      ),
    );
  }
  promote(
    projectId: string,
    bundleId: string,
    channel: string,
    request: PromoteRequest,
    key: string,
  ): Promise<Promotion> {
    return this.request(
      'POST',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}/promotions`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  createProposal(
    projectId: string,
    bundleId: string,
    request: ProposalRequest,
    key: string,
  ): Promise<Proposal> {
    return this.request(
      'POST',
      this.path(projectId, `/bundles/${this.part(bundleId)}/proposals`),
      JSON.stringify(request),
      key,
    );
  }
  getProposal(projectId: string, bundleId: string, id: string): Promise<Proposal> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/proposals/${this.part(id)}`),
    );
  }
  createComparison(
    projectId: string,
    bundleId: string,
    request: ComparisonRequest,
    key: string,
  ): Promise<Comparison> {
    return this.request(
      'POST',
      this.path(projectId, `/bundles/${this.part(bundleId)}/comparisons`),
      JSON.stringify(request),
      key,
    );
  }
  getComparison(projectId: string, bundleId: string, id: string): Promise<Comparison> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/comparisons/${this.part(id)}`),
    );
  }
  private comparisonPolicyPath(projectId: string, bundleId: string, comparisonId: string) {
    return this.path(
      projectId,
      `/bundles/${this.part(bundleId)}/comparisons/${this.part(comparisonId)}/policy-receipts`,
    );
  }
  listComparisonPolicyReceipts(
    projectId: string,
    bundleId: string,
    comparisonId: string,
  ): Promise<{ items: ComparisonPolicyReceipt[] }> {
    return this.request('GET', this.comparisonPolicyPath(projectId, bundleId, comparisonId));
  }
  listCandidatePolicyReceipts(
    projectId: string,
    bundleId: string,
    versionId: string,
  ): Promise<{ items: ComparisonPolicyReceipt[] }> {
    return this.request(
      'GET',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/versions/${this.part(versionId)}/policy-receipts`,
      ),
    );
  }
  reportComparisonPolicyReceipt(
    projectId: string,
    bundleId: string,
    comparisonId: string,
    report: ComparisonPolicyReport,
  ): Promise<ComparisonPolicyReceipt> {
    return this.request(
      'POST',
      this.comparisonPolicyPath(projectId, bundleId, comparisonId),
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
  private draftPath(projectId: string, bundleId: string, channel: string, id?: string): string {
    return this.path(
      projectId,
      `/bundles/${this.part(bundleId)}/channels/${this.part(channel)}/drafts${id === undefined ? '' : `/${this.part(id)}`}`,
    );
  }
  listProjects(options: ListOptions = {}): Promise<Page<Project>> {
    return this.request('GET', `/v1/projects${this.listing(options)}`);
  }
  listBundles(projectId: string, options: ListOptions = {}): Promise<Page<Bundle>> {
    return this.request('GET', this.path(projectId, `/bundles${this.listing(options)}`));
  }
  listChannels(
    projectId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Channel>> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/channels${this.listing(options)}`),
    );
  }
  createBundleSetup(
    projectId: string,
    request: BundleSetupRequest,
    key: string,
  ): Promise<BundleSetup> {
    return this.request(
      'POST',
      this.path(projectId, '/bundle-setups'),
      JSON.stringify(request),
      key,
    );
  }
  createDraft(
    projectId: string,
    bundleId: string,
    channel: string,
    request: CreateDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(projectId, bundleId, channel),
      JSON.stringify(request),
      key,
    );
  }
  listDrafts(
    projectId: string,
    bundleId: string,
    channel: string,
    options: ListOptions & { status?: Draft['status'] | 'all' } = {},
  ): Promise<Page<Draft>> {
    return this.request(
      'GET',
      this.draftPath(projectId, bundleId, channel) +
        this.listing(options) +
        (options.status
          ? `${this.listing(options) ? '&' : '?'}status=${encodeURIComponent(options.status)}`
          : ''),
    );
  }
  getDraft(projectId: string, bundleId: string, channel: string, id: string): Promise<Draft> {
    return this.request('GET', this.draftPath(projectId, bundleId, channel, id));
  }
  getDraftHistory(
    projectId: string,
    bundleId: string,
    channel: string,
    id: string,
    options: ListOptions = {},
  ): Promise<Page<DraftSnapshot>> {
    return this.request(
      'GET',
      this.draftPath(projectId, bundleId, channel, id) + '/history' + this.listing(options),
    );
  }
  saveDraft(
    projectId: string,
    bundleId: string,
    channel: string,
    id: string,
    request: SaveDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(projectId, bundleId, channel, id) + '/save',
      JSON.stringify(request),
      key,
    );
  }
  discardDraft(
    projectId: string,
    bundleId: string,
    channel: string,
    id: string,
    request: DiscardDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(projectId, bundleId, channel, id) + '/discard',
      JSON.stringify(request),
      key,
    );
  }
  publishDraft(
    projectId: string,
    bundleId: string,
    channel: string,
    id: string,
    request: PublishDraftRequest,
    key: string,
  ): Promise<Draft> {
    return this.request(
      'POST',
      this.draftPath(projectId, bundleId, channel, id) + '/publish',
      JSON.stringify(request),
      key,
    );
  }
  listProposals(
    projectId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Proposal>> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/proposals${this.listing(options)}`),
    );
  }
  listComparisons(
    projectId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Comparison>> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/comparisons${this.listing(options)}`),
    );
  }
  createEvaluation(
    projectId: string,
    bundleId: string,
    request: EvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(projectId, `/bundles/${this.part(bundleId)}/evaluation-requests`),
      JSON.stringify(request),
      key,
    );
  }
  startEvaluation(
    projectId: string,
    bundleId: string,
    id: string,
    request: StartEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/start`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  getEvaluationProgress(
    projectId: string,
    bundleId: string,
    id: string,
  ): Promise<EvaluationProgressView> {
    return this.request(
      'GET',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/progress`,
      ),
    );
  }
  reportEvaluationProgress(
    projectId: string,
    bundleId: string,
    id: string,
    report: EvaluationProgressRequest,
  ): Promise<EvaluationProgressView> {
    // The server uses attempt + sequence, not retained operation records. This
    // transport key enables safe same-body network retries without key growth.
    return this.request(
      'POST',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/progress`,
      ),
      JSON.stringify(report),
      `progress:${report.sequence}`,
    );
  }
  finishEvaluation(
    projectId: string,
    bundleId: string,
    id: string,
    request: FinishEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/finish`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  interruptEvaluation(
    projectId: string,
    bundleId: string,
    id: string,
    request: InterruptEvaluationRequest,
    key: string,
  ): Promise<Evaluation> {
    return this.request(
      'POST',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}/interrupt`,
      ),
      JSON.stringify(request),
      key,
    );
  }
  listEvaluations(
    projectId: string,
    bundleId: string,
    options: ListOptions = {},
  ): Promise<Page<Evaluation>> {
    return this.request(
      'GET',
      this.path(
        projectId,
        `/bundles/${this.part(bundleId)}/evaluation-requests${this.listing(options)}`,
      ),
    );
  }
  getEvaluation(projectId: string, bundleId: string, id: string): Promise<Evaluation> {
    return this.request(
      'GET',
      this.path(projectId, `/bundles/${this.part(bundleId)}/evaluation-requests/${this.part(id)}`),
    );
  }
  getEvaluationCapabilities(projectId: string): Promise<EvaluationCapabilities> {
    return this.request('GET', this.path(projectId, '/evaluation-capabilities'));
  }
  listIntegrationObservations(
    projectId: string,
    options: ListOptions = {},
  ): Promise<Page<IntegrationObservation>> {
    return this.request(
      'GET',
      this.path(projectId, '/integration-observations' + this.listing(options)),
    );
  }

  createIntegration(
    projectId: string,
    request: CreateIntegrationRequest,
    key: string,
  ): Promise<Integration> {
    return this.request(
      'POST',
      this.path(projectId, '/integrations'),
      JSON.stringify(request),
      key,
    );
  }
  listIntegrations(projectId: string, options: ListOptions = {}): Promise<Page<Integration>> {
    return this.request('GET', this.path(projectId, '/integrations' + this.listing(options)));
  }
  createIntegrationCredential(
    projectId: string,
    id: string,
    request: { kind: IntegrationCredentialKind },
    key: string,
  ): Promise<IntegrationCredential> {
    return this.request(
      'POST',
      this.path(projectId, `/integrations/${this.part(id)}/credentials`),
      JSON.stringify(request),
      key,
    );
  }
  revokeIntegration(projectId: string, id: string, key: string): Promise<Integration> {
    return this.request(
      'POST',
      this.path(projectId, `/integrations/${this.part(id)}/revoke`),
      '{}',
      key,
    );
  }
  revokeIntegrationCredential(
    projectId: string,
    id: string,
    credentialId: string,
    key: string,
  ): Promise<void> {
    return this.request(
      'POST',
      this.path(
        projectId,
        `/integrations/${this.part(id)}/credentials/${this.part(credentialId)}/revoke`,
      ),
      '{}',
      key,
    );
  }
  reportDeliveryReceipt(
    projectId: string,
    id: string,
    request: DeliveryReceiptRequest,
    key: string,
  ): Promise<DeliveryReceipt> {
    return this.request(
      'POST',
      this.path(projectId, `/integrations/${this.part(id)}/receipts`),
      JSON.stringify(request),
      key,
    );
  }
  listDeliveryReceipts(
    projectId: string,
    id: string,
    options: ListOptions = {},
  ): Promise<Page<DeliveryReceipt>> {
    return this.request(
      'GET',
      this.path(projectId, `/integrations/${this.part(id)}/receipts${this.listing(options)}`),
    );
  }
  getOperation(projectId: string, operationId: string, operationPath?: string): Promise<Operation> {
    const query = operationPath ? `?operationPath=${encodeURIComponent(operationPath)}` : '';
    return this.request(
      'GET',
      this.path(projectId, `/operations/${this.part(operationId)}${query}`),
    );
  }
  closeOperation(
    projectId: string,
    operationId: string,
    operationPath?: string,
  ): Promise<Operation> {
    return this.request(
      'POST',
      this.path(projectId, `/operations/${this.part(operationId)}/close`),
      JSON.stringify({ operationPath }),
      operationId,
    );
  }
}
