import type { Comparison, Evaluation } from '@acclimate/sdk';

/** Read scope and identity. A different identity must never reuse a history cache. */
export interface ChangesHistoryScope {
  projectId: string;
  bundleId: string;
  channel: string;
  actorScope: string;
  serviceIdentity: string;
}

export type RequestEvidence =
  | { status: 'bound'; comparison: Comparison }
  | { status: 'mismatch' | 'unbound'; comparison: Comparison; message: string }
  | { status: 'none' | 'loading' | 'unavailable'; message?: string };

export interface EvaluationHistoryModel {
  /** Only cursor-loaded records; a direct selection outside these pages is separate. */
  requests: Evaluation[];
  evidence: Record<string, RequestEvidence>;
  selectedRequest: Evaluation | null;
  selectedState: 'none' | 'loading' | 'ready' | 'unavailable' | 'mismatch';
  selectedError: string | null;
  cursor: string | null;
  loading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
}

export interface EvaluationHistoryOptions {
  scope: ChangesHistoryScope;
  selectedRequestId?: string;
  selectedCandidateId?: string;
}

export interface EvaluationHistoryViewProps {
  model: EvaluationHistoryModel;
  selectedCandidateId?: string;
  selectedRequestId?: string;
  onSelectRequest: (request: Evaluation | null) => void;
  reviewHref: (request: Evaluation) => string;
}
