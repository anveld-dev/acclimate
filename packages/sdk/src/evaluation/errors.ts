import { ApiError } from '../client.js';

export type SafeCode =
  | 'config.missing'
  | 'config.schema'
  | 'config.permissions'
  | 'config.url'
  | 'runtime.unsupported'
  | 'capabilities.unsupported'
  | 'bundle.missing'
  | 'request.missing'
  | 'version.missing'
  | 'guided_target_unsupported'
  | 'auth.denied'
  | 'auth.principal_mismatch'
  | 'learning.apps_module_missing'
  | 'learning.apps_module_load_failed'
  | 'learning.apps_invalid_export'
  | 'learning.recheck_callback_missing'
  | 'learning.field_replay_callback_missing'
  | 'learning.incident_replay_callback_missing'
  | 'descriptor.mismatch'
  | 'version.binding_mismatch'
  | 'service.unavailable'
  | 'transport.response_too_large'
  | 'journal.busy'
  | 'journal.foreign'
  | 'journal.missing'
  | 'journal.relocated'
  | 'journal.invalid'
  | 'journal.ownership_lost'
  | 'execution.uncertain'
  | 'submission.unconfirmed'
  | 'request.interrupted'
  | 'request.base_conflict'
  | 'request.channel_empty'
  | 'request.intent_mismatch'
  | 'policy.invalid'
  | 'policy.inventory_incompatible'
  | 'evidence.not_terminal'
  | 'evidence.identity_mismatch'
  | 'evidence.malformed'
  | 'evidence.incomplete'
  | 'cost.unknown'
  | 'analysis.nonfinite'
  | 'definition.report_budget_exceeded'
  | 'artifact.missing'
  | 'artifact.hash_mismatch'
  | 'artifact.integrity'
  | 'artifact.selection_invalid'
  | 'artifact.mapper_failed'
  | 'internal.error';
export type EvaluationPhase =
  | 'configure'
  | 'preflight'
  | 'claim'
  | 'verify'
  | 'execute'
  | 'submit'
  | 'finish'
  | 'inspect'
  | 'policy'
  | 'export';
export type ExecutionState = 'not_started' | 'may_have_started' | 'report_saved' | 'finished';
export type SafeNextAction =
  | 'fix_config'
  | 'ask_operator'
  | 'upgrade_service'
  | 'retry_same_command'
  | 'restore_original_journal'
  | 'inspect_external_app'
  | 'interrupt_then_new_request'
  | 'review_terminal_evidence';
const pathGuidance = {
  configAlias: { field: 'configPath', hint: 'Use the absolute realpath of the config file, including all parent directories. On macOS, /var is an alias for /private/var.' },
  journalAlias: { field: 'journalRoot', hint: 'Set journalRoot to the absolute realpath of the journal directory, including all parents. On macOS, /var is an alias for /private/var.' },
  configMode: { field: 'configPath', hint: 'Use a config owned by the current user with mode 0600 (chmod 600) in a private directory owned by that user with mode 0700 (chmod 700).' },
  journalMode: { field: 'journalRoot', hint: 'Use a journal directory owned by the current user with mode 0700 (chmod 700).' },
  exportOverlap: { field: 'outputDirectory', hint: 'Set --out to a new directory outside the config, journal and prepared workspace trees. Choose a separate private sibling of those trees.' },
} as const;
export type PathIssue = keyof typeof pathGuidance;
export interface SafeDiagnostic {
  pathIssue?: PathIssue;
  field?: (typeof pathGuidance)[PathIssue]['field'];
  hint?: string;
  code: SafeCode;
  phase: EvaluationPhase;
  executionState: ExecutionState;
  nextAction: SafeNextAction;
  evaluationRequestId?: string;
  correlationId?: string;
  httpStatus?: number;
  mismatchFields?: readonly string[];
  reportBudget?: {
    estimatedBytes: number;
    limitBytes: number;
    expectedPairs: number;
    maxPairsPerPartition: number;
  };
}
const nextAction = (code: SafeCode): SafeNextAction => {
  if (code === 'capabilities.unsupported') return 'upgrade_service';
  if (code.startsWith('auth.')) return 'ask_operator';
  if (code === 'journal.relocated') return 'restore_original_journal';
  if (
    [
      'execution.uncertain',
      'journal.missing',
      'journal.foreign',
      'journal.ownership_lost',
    ].includes(code)
  )
    return 'inspect_external_app';
  if (['submission.unconfirmed', 'service.unavailable', 'journal.busy'].includes(code))
    return 'retry_same_command';
  if (code === 'request.interrupted') return 'interrupt_then_new_request';
  if (code === 'request.channel_empty') return 'ask_operator';
  return 'fix_config';
};
const allowedFields = new Set([
  'datasetRevision',
  'graderRevision',
  'runtime.configId',
  'runtime.configRevision',
  'runtime',
  'expectedCases',
  'versions',
]);
export class EvaluationError extends Error {
  readonly diagnostic: SafeDiagnostic;
  readonly code: SafeCode;
  constructor(
    code: SafeCode,
    options: Partial<Omit<SafeDiagnostic, 'code'>> = {},
    cause?: ErrorOptions,
  ) {
    super(`Evaluation operation was not confirmed (${code}).`, cause);
    this.name = 'EvaluationError';
    this.code = code;
    this.diagnostic = {
      code,
      ...(options.pathIssue && Object.hasOwn(pathGuidance, options.pathIssue)
        ? { pathIssue: options.pathIssue, ...pathGuidance[options.pathIssue] }
        : {}),
      phase: options.phase ?? 'configure',
      executionState: options.executionState ?? 'not_started',
      nextAction: options.nextAction ?? nextAction(code),
      ...(options.evaluationRequestId && /^[a-f0-9-]{36}$/.test(options.evaluationRequestId)
        ? { evaluationRequestId: options.evaluationRequestId }
        : {}),
      ...(options.correlationId && /^[A-Za-z0-9._:-]{1,128}$/.test(options.correlationId)
        ? { correlationId: options.correlationId }
        : {}),
      ...(Number.isInteger(options.httpStatus) &&
      options.httpStatus! >= 100 &&
      options.httpStatus! <= 599
        ? { httpStatus: options.httpStatus }
        : {}),
      ...(options.mismatchFields
        ? { mismatchFields: options.mismatchFields.filter((x) => allowedFields.has(x)) }
        : {}),
    };
  }
}
/** The application cannot establish quiescence. This is never an ordinary failed case. */
export class ExecutionUncertainError extends EvaluationError {
  constructor(cause?: ErrorOptions) {
    super('execution.uncertain', { phase: 'execute', executionState: 'may_have_started' }, cause);
    this.name = 'ExecutionUncertainError';
  }
}
/** The callback certifies that its external resources are quiescent. */
export class CallbackCancelled extends Error {
  constructor() {
    super('Callback stopped after cooperative cancellation.');
    this.name = 'CallbackCancelled';
  }
}
export function toSafeDiagnostic(
  error: unknown,
  phase: EvaluationPhase = 'configure',
  executionState: ExecutionState = 'not_started',
): SafeDiagnostic {
  if (error instanceof EvaluationError) return { ...error.diagnostic };
  let code: SafeCode = 'internal.error';
  if (error instanceof ApiError) {
    code =
      error.status === 401 || error.status === 403
        ? 'auth.denied'
        : error.status === 413
          ? 'transport.response_too_large'
          : error.status >= 500
            ? 'service.unavailable'
            : 'evidence.malformed';
    return new EvaluationError(code, {
      phase,
      executionState,
      httpStatus: error.status,
      correlationId: error.requestId,
    }).diagnostic;
  }
  if (error instanceof TypeError || error instanceof DOMException) code = 'service.unavailable';
  if (executionState === 'may_have_started') code = 'execution.uncertain';
  if (executionState === 'report_saved') code = 'submission.unconfirmed';
  return new EvaluationError(code, { phase, executionState }).diagnostic;
}
