export { assertEvaluationOutput, defineEvaluation } from './definition.js';
export { preflightEvaluation, runEvaluation } from './runner.js';
export {
  runLocalComparison,
  scoreLocalComparison,
  tryEvaluation,
  loadLocalPayload,
  localPayloadDigest,
  localVersion,
  LocalRunError,
  LOCAL_NOTICE,
} from './local.js';
export type {
  LocalComparisonOptions,
  LocalComparisonResult,
  LocalDiagnostic,
  LocalPayload,
  TryOptions,
  TryResult,
  TryCaseResult,
  TryIssue,
} from './local.js';
export { parseDuration, parseSelection, progressLine, runWarnings } from './controls.js';
export type {
  CaseSelection,
  RunControls,
  RunSummary,
  StopReason,
  TrialProgress,
} from './controls.js';
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
  EvaluationExecutionResult,
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

export type { ApplicationAdapter } from './app-cli.js';
