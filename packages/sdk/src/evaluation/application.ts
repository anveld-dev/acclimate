import type { EvaluationManifestInput } from './manifest.js';
import type { EvaluationCase, EvaluationDefinition, Json, JsonOutputCheck } from './types.js';

/**
 * The exports an application module provides to acclimate-eval. Export them by name, or
 * export one default object, ideally built with `defineApplication`.
 */
export interface ApplicationAdapter<I = Json, E = Json, O = Json>
  extends Pick<EvaluationDefinition<I, E, O>, 'execute' | 'grade'> {
  /** Cases to evaluate. ACCLIMATE_EVALUATOR_CASES replaces them with a private JSON file. */
  cases?: readonly EvaluationCase<I, E>[];
  /** Files, relative to the module, whose bytes are part of the grader identity. */
  revisionFiles?: readonly string[];
  configId?: string;
  /** Pairs in flight at once (1–64, default 1). Changes the descriptor fingerprint. */
  concurrency?: number;
  /** Extra grade attempts after a grader throws or times out (0–5, default 0). */
  gradeRetries?: number;
  /**
   * Native harnesses this adapter prepares bundles for, such as `'claude'` or `['codex', 'pi']`.
   * Payloads are checked against their compatibility rules before any callback runs.
   */
  compatibilityTarget?: EvaluationDefinition<I, E, O>['compatibilityTarget'];
  grader?: EvaluationManifestInput['grader'];
  runtime?: Partial<EvaluationManifestInput['runtime']>;
  /**
   * `'live'` (default) requires --live because callbacks call models. Use `'model-free'`
   * for deterministic adapters that need no authorization.
   */
  execution?: 'live' | 'model-free';
}

/**
 * Type-check an application adapter and return it unchanged. Use it as the module's
 * default export: `export default defineApplication({ cases, execute, grade })`.
 */
export function defineApplication<I = Json, E = Json, O = Json>(
  adapter: ApplicationAdapter<I, E, O> & JsonOutputCheck<O>,
): ApplicationAdapter<I, E, O> {
  return adapter;
}

