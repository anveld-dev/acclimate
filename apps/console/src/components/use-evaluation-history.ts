import { useEffect, useRef, useState } from 'react';
import type { Comparison, Evaluation, EvaluationProgressView } from '@acclimate/sdk';
import type {
  EvaluationHistoryModel,
  EvaluationHistoryOptions,
  RequestEvidence,
} from '../lib/changes-workspace';
import { requestEvidence } from '../lib/evaluation-history';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';
import { runImprovement } from '../server/improvement-actions';

const initial = {
  requests: [] as Evaluation[],
  evidence: {} as Record<string, RequestEvidence>,
  selectedRequest: null as Evaluation | null,
  selectedProgress: null as EvaluationProgressView | null,
  selectedId: undefined as string | undefined,
  selectedState: 'none' as EvaluationHistoryModel['selectedState'],
  selectedError: null as string | null,
  cursor: null as string | null,
  loading: true,
  error: null as string | null,
};

export function useEvaluationHistory(options: EvaluationHistoryOptions): EvaluationHistoryModel {
  const { projectId, bundleId, channel, actorScope, serviceIdentity } = options.scope;
  const scopeKey = JSON.stringify([projectId, bundleId, channel, actorScope, serviceIdentity]);
  const [state, setState] = useState(() => ({ ...initial, scopeKey }));
  const selection = useRef({
    id: options.selectedRequestId,
    candidate: options.selectedCandidateId,
  });
  selection.current = { id: options.selectedRequestId, candidate: options.selectedCandidateId };
  const controller = useRef<{ refreshSelection: () => void; loadMore: () => Promise<void> } | null>(
    null,
  );

  useEffect(() => {
    let alive = true,
      busy = false,
      pendingSelection = false,
      olderLoaded = false;
    let selectionEpoch = 0,
      timer: ReturnType<typeof setTimeout>;
    let rows: Evaluation[] = [],
      cursor: string | null = null,
      selected: Evaluation | null = null;
    const cache = new Map<string, Comparison>();
    const scope = { projectId, bundleId, channel };
    setState({ ...initial, scopeKey });
    const publishEvidence = async () => {
      const all = selected ? [...rows, selected] : rows;
      const ids = [...new Set(all.flatMap((row) => (row.comparisonId ? [row.comparisonId] : [])))];
      const missing = ids.filter((id) => !cache.has(id));
      if (alive)
        setState((old) => ({
          ...old,
          evidence: Object.fromEntries(
            all.map((row) => [
              row.id,
              !row.comparisonId
                ? { status: 'none' }
                : cache.has(row.comparisonId)
                  ? requestEvidence(row, cache.get(row.comparisonId))
                  : { status: 'loading' },
            ]),
          ),
        }));
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, missing.length) }, async () => {
          while (alive && index < missing.length) {
            const id = missing[index++];
            try {
              const result = await runImprovement({ data: { action: 'comparison', id, scope } });
              if (alive && result.ok && result.comparison) cache.set(id, result.comparison);
            } catch {
              /* Retry on the next poll. */
            }
          }
        }),
      );
      if (!alive) return;
      const current = selected ? [...rows, selected] : rows;
      setState((old) => ({
        ...old,
        evidence: Object.fromEntries(
          current.map((row) => [
            row.id,
            !row.comparisonId
              ? { status: 'none' }
              : cache.has(row.comparisonId)
                ? requestEvidence(row, cache.get(row.comparisonId))
                : {
                    status: 'unavailable',
                    message: 'Evidence unavailable; retrying automatically.',
                  },
          ]),
        ),
      }));
    };
    const readSelection = async () => {
      const version = ++selectionEpoch,
        { id, candidate } = selection.current;
      if (!id) {
        selected = null;
        if (alive)
          setState((old) => ({
            ...old,
            selectedRequest: null,
            selectedProgress: null,
            selectedId: undefined,
            selectedState: 'none',
            selectedError: null,
          }));
        return;
      }
      if (alive)
        setState((old) => ({
          ...old,
          selectedRequest: old.selectedRequest?.id === id ? old.selectedRequest : null,
          selectedProgress: null,
          selectedId: id,
          selectedState: old.selectedRequest?.id === id ? old.selectedState : 'loading',
          selectedError: old.selectedRequest?.id === id ? old.selectedError : null,
        }));
      try {
        const result = await runImprovement({ data: { action: 'request', id, scope } });
        if (!alive || version !== selectionEpoch) return;
        if (!result.ok || !result.request)
          throw new Error(result.ok ? 'Evaluation request unavailable.' : result.message);
        selected = result.request;
        const mismatch = !!candidate && candidate !== selected.candidateVersionId;
        setState((old) => ({
          ...old,
          selectedRequest: selected,
          selectedProgress: result.progress ?? null,
          selectedState: mismatch ? 'mismatch' : 'ready',
          selectedError: mismatch ? 'The selected request belongs to a different candidate.' : null,
        }));
      } catch (error) {
        if (!alive || version !== selectionEpoch) return;
        if (selected?.id !== id) selected = null;
        setState((old) => ({
          ...old,
          selectedRequest: selected,
          selectedProgress: null,
          selectedState: 'unavailable',
          selectedError: `${error instanceof Error ? error.message : 'Request unavailable.'} Retrying automatically.`,
        }));
      }
    };
    const load = async (next?: string) => {
      if (busy) {
        if (!next) pendingSelection = true;
        return;
      }
      busy = true;
      if (alive) setState((old) => ({ ...old, loading: true }));
      try {
        const result = await runImprovement({
          data: { action: 'requests', requestCursor: next, scope },
        });
        if (!alive) return;
        if (!result.ok || !result.requests)
          throw new Error(result.ok ? 'Evaluation history unavailable.' : result.message);
        const merged = mergeHistory(rows, result.requests.items, !!next);
        let refreshFailed = false;
        const updates = await refreshKnownActive(
          merged.filter((row) => !result.requests!.items.some((item) => item.id === row.id)),
          async (id) => {
            try {
              const read = await runImprovement({ data: { action: 'request', id, scope } });
              if (!read.ok || !read.request) {
                refreshFailed = true;
                return undefined;
              }
              return read.request;
            } catch {
              refreshFailed = true;
              return undefined;
            }
          },
          () => alive,
        );
        if (!alive) return;
        const byId = new Map(updates.map((row) => [row.id, row]));
        rows = merged.map((row) => byId.get(row.id) || row);
        if (next || !olderLoaded) cursor = result.requests.nextCursor;
        if (next) olderLoaded = true;
        setState((old) => ({
          ...old,
          requests: rows,
          cursor,
          error: refreshFailed
            ? 'Some active requests could not be refreshed; history may be stale. Retrying automatically.'
            : null,
        }));
      } catch (error) {
        if (alive)
          setState((old) => ({
            ...old,
            error: `${error instanceof Error ? error.message : 'History unavailable.'} Retrying automatically.`,
          }));
      }
      if (alive) {
        await readSelection();
        await publishEvidence();
      }
      if (alive) {
        busy = false;
        setState((old) => ({ ...old, loading: false }));
        if (pendingSelection) {
          pendingSelection = false;
          void refreshSelection();
        }
      }
    };
    const refreshSelection = async () => {
      if (busy) {
        pendingSelection = true;
        ++selectionEpoch;
        return;
      }
      busy = true;
      await readSelection();
      if (alive) await publishEvidence();
      if (alive) {
        busy = false;
        if (pendingSelection) {
          pendingSelection = false;
          void refreshSelection();
        }
      }
    };
    controller.current = {
      refreshSelection: () => {
        void refreshSelection();
      },
      loadMore: async () => {
        if (cursor) await load(cursor);
      },
    };
    const poll = async () => {
      await load();
      if (alive) timer = setTimeout(poll, 15000);
    };
    void poll();
    return () => {
      alive = false;
      ++selectionEpoch;
      clearTimeout(timer);
      controller.current = null;
    };
  }, [projectId, bundleId, channel, actorScope, serviceIdentity]);
  useEffect(() => {
    controller.current?.refreshSelection();
  }, [options.selectedRequestId, options.selectedCandidateId]);
  // Effects run after render, so never expose the preceding identity's data in between.
  const current = state.scopeKey === scopeKey ? state : initial;
  const requested = options.selectedRequestId;
  const currentSelection = !requested
    ? {
        selectedRequest: null,
        selectedProgress: null,
        selectedState: 'none' as const,
        selectedError: null,
      }
    : current.selectedId !== requested
      ? {
          selectedRequest: null,
          selectedProgress: null,
          selectedState: 'loading' as const,
          selectedError: null,
        }
      : current.selectedRequest?.id === requested &&
          options.selectedCandidateId &&
          current.selectedRequest.candidateVersionId !== options.selectedCandidateId
        ? {
            selectedRequest: current.selectedRequest,
            selectedState: 'mismatch' as const,
            selectedError: 'The selected request belongs to a different candidate.',
          }
        : current.selectedRequest?.id === requested && current.selectedState === 'mismatch'
          ? { selectedState: 'ready' as const, selectedError: null }
          : {};
  return {
    ...current,
    ...currentSelection,
    loadMore: () => controller.current?.loadMore() ?? Promise.resolve(),
  };
}
