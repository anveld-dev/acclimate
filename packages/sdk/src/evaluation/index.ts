export { defineEvaluation } from './definition.js';
export { preflightEvaluation, runEvaluation } from './runner.js';
export {
  EvaluationError,
  ExecutionUncertainError,
  CallbackCancelled,
  toSafeDiagnostic,
} from './errors.js';
export type {
  SafeCode,
  SafeDiagnostic,
  SafeNextAction,
  EvaluationPhase,
  ExecutionState,
} from './errors.js';
export type {
  Json,
  EvaluationCase,
  EvaluationDefinition,
  EvaluationCollection,
  EvaluationApp,
  EvaluationGradeResult,
  ExecutionContext,
  EvaluationRunResult,
  PreflightResult,
  RunEvaluationOptions,
  PreflightOptions,
} from './types.js';

export * from './analysis.js';
export * from './manifest.js';
export { createEvaluationProgressReporter } from './progress.js';
export type { EvaluationProgressScope, EvaluationProgressUpdate } from './progress.js';
