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
  | 'legacy.submission_unconfirmed'
  | 'request.interrupted'
  | 'request.base_conflict'
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
export interface SafeDiagnostic {
  code: SafeCode;
  phase: EvaluationPhase;
  executionState: ExecutionState;
  nextAction: SafeNextAction;
  evaluationRequestId?: string;
  correlationId?: string;
  httpStatus?: number;
  mismatchFields?: readonly string[];
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
      'legacy.submission_unconfirmed',
    ].includes(code)
  )
    return 'inspect_external_app';
  if (['submission.unconfirmed', 'service.unavailable', 'journal.busy'].includes(code))
    return 'retry_same_command';
  if (code === 'request.interrupted') return 'interrupt_then_new_request';
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
  constructor(code: SafeCode, options: Partial<Omit<SafeDiagnostic, 'code'>> = {}) {
    super(`Evaluation operation was not confirmed (${code}).`);
    this.name = 'EvaluationError';
    this.code = code;
    this.diagnostic = {
      code,
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
  constructor() {
    super('execution.uncertain', { phase: 'execute', executionState: 'may_have_started' });
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
