import { ApiError } from '../client.js';
import { AcclimateError, AcclimateUsageError, TransportError } from '../errors.js';

/**
 * Every diagnostic code the evaluator can report. `EVALUATION_ERROR_CODES` holds the
 * message, next action and CLI exit code for each one, and the docs page
 * reference/error-codes is checked against it.
 */
export type SafeCode =
  | 'usage.missing_command'
  | 'usage.unknown_command'
  | 'usage.unknown_flag'
  | 'usage.missing_flag'
  | 'usage.invalid_flag'
  | 'usage.conflicting_flags'
  | 'config.missing'
  | 'config.schema'
  | 'config.permissions'
  | 'config.url'
  | 'handoff.missing'
  | 'definition.invalid'
  | 'definition.report_budget_exceeded'
  | 'application.invalid'
  | 'application.import_failed'
  | 'output.invalid'
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
  | 'evidence.reward_out_of_range'
  | 'evidence.incomplete'
  | 'cost.unknown'
  | 'analysis.nonfinite'
  | 'analysis.invalid_config'
  | 'analysis.invalid_observations'
  | 'analysis.identity_mismatch'
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
  | 'fix_command'
  | 'fix_config'
  | 'fix_application'
  | 'check_service'
  | 'ask_operator'
  | 'upgrade_service'
  | 'retry_same_command'
  | 'restore_original_journal'
  | 'inspect_external_app'
  | 'interrupt_then_new_request'
  | 'review_terminal_evidence';

/**
 * Evaluator CLI exit codes. Each one names what to do next, so CI can tell a
 * quality decision from a broken pipeline.
 */
export const EXIT_CODES = {
  /** The command succeeded. For a policy check, the candidate passed. */
  ok: 0,
  /** Fix the command line, config, application module or definition, then rerun. */
  usage: 1,
  /** The quality gate failed: the policy verdict is `fail`. */
  gateFailed: 2,
  /** The evidence cannot support a verdict yet: the policy is indeterminate, the run is not terminal, or exported evidence is missing. */
  indeterminate: 3,
  /** The run or the service failed: the request finished as `failed`, or the service was unreachable or returned a server error. */
  infrastructure: 4,
  /** Recovery is required before retrying: execution may have started, a submission is unconfirmed, the journal needs attention, or the request was interrupted or conflicts with a newer parent. */
  recovery: 5,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const pathGuidance = {
  configAlias: { field: 'configPath', hint: 'Use the absolute realpath of the config file, including all parent directories. On macOS, /var is an alias for /private/var.' },
  journalAlias: { field: 'journalRoot', hint: 'Set journalRoot to the absolute realpath of the journal directory, including all parents. On macOS, /var is an alias for /private/var.' },
  configMode: { field: 'configPath', hint: 'Use a config owned by the current user with mode 0600 (chmod 600) in a private directory owned by that user with mode 0700 (chmod 700).' },
  journalMode: { field: 'journalRoot', hint: 'Use a journal directory owned by the current user with mode 0700 (chmod 700).' },
  exportOverlap: { field: 'outputDirectory', hint: 'Set --out to a new directory outside the config, journal and prepared workspace trees. Choose a separate private sibling of those trees.' },
} as const;
export type PathIssue = keyof typeof pathGuidance;

interface CodeInfo {
  message: string;
  nextAction: SafeNextAction;
  exitCode: ExitCode;
}
const usage = (message: string): CodeInfo => ({ message, nextAction: 'fix_command', exitCode: 1 });
const config = (message: string): CodeInfo => ({ message, nextAction: 'fix_config', exitCode: 1 });
const app = (message: string): CodeInfo => ({ message, nextAction: 'fix_application', exitCode: 1 });
const operator = (message: string): CodeInfo => ({ message, nextAction: 'ask_operator', exitCode: 1 });
const recovery = (message: string, nextAction: SafeNextAction): CodeInfo => ({ message, nextAction, exitCode: 5 });

/** Message, default next action and CLI exit code for every diagnostic code. */
export const EVALUATION_ERROR_CODES: Readonly<Record<SafeCode, Readonly<CodeInfo>>> = Object.freeze({
  'usage.missing_command': usage('No command given. Run with --help to list the commands.'),
  'usage.unknown_command': usage('Unknown command. Run with --help to list the commands.'),
  'usage.unknown_flag': usage('This command does not accept that flag.'),
  'usage.missing_flag': usage('A required flag is missing.'),
  'usage.invalid_flag': usage('A flag has an invalid or repeated value.'),
  'usage.conflicting_flags': usage('These flags cannot be used together.'),
  'config.missing': config('The evaluator config file does not exist.'),
  'config.schema': config('The evaluator config, handoff or command input has an invalid field.'),
  'config.permissions': config('A private file or directory has unsafe ownership, mode or path.'),
  'config.url': config('serviceUrl must be an https:// origin, or http:// on localhost, with no path, query or credentials.'),
  'handoff.missing': config('The handoff file does not exist.'),
  'definition.invalid': app('The evaluation definition is invalid.'),
  'definition.report_budget_exceeded': app('The case inventory exceeds the comparison report size limit. Split the cases into smaller evaluations.'),
  'application.invalid': app('The application module does not export a valid adapter.'),
  'application.import_failed': app('The application module could not be imported.'),
  'output.invalid': app('A callback returned a value that is not plain JSON.'),
  'runtime.unsupported': config('This platform cannot run the durable evaluator. Use Linux or macOS with python3 available.'),
  'capabilities.unsupported': { message: 'The service does not support retained evaluation operations.', nextAction: 'upgrade_service', exitCode: 1 },
  'bundle.missing': config('The bundle does not exist in this workspace or the evaluator cannot read it.'),
  'request.missing': config('The evaluation request does not exist in this workspace.'),
  'version.missing': config('A parent or candidate version does not exist in this workspace.'),
  guided_target_unsupported: config('The workspace, bundle, request or channel identifier is not in the supported format.'),
  'auth.denied': operator('The service denied this token. Check the evaluator or reader token and its permissions.'),
  'auth.principal_mismatch': operator('The token belongs to a different principal or workspace than the config names.'),
  'learning.apps_module_missing': config('The learning application module is missing.'),
  'learning.apps_module_load_failed': config('The learning application module could not be loaded.'),
  'learning.apps_invalid_export': config('The learning application module has an invalid export.'),
  'learning.recheck_callback_missing': config('The learning application does not export the recheck callback.'),
  'learning.field_replay_callback_missing': config('The learning application does not export the field replay callback.'),
  'learning.incident_replay_callback_missing': config('The learning application does not export the incident replay callback.'),
  'descriptor.mismatch': app('The installed cases, grader or runtime differ from the ones the request was created with.'),
  'version.binding_mismatch': config('The parent or candidate version does not match the request, config or handoff.'),
  'service.unavailable': { message: 'The Acclimate service is unreachable or returned a server error.', nextAction: 'check_service', exitCode: 4 },
  'transport.response_too_large': { message: 'A service response exceeded the size limit.', nextAction: 'fix_config', exitCode: 4 },
  'journal.busy': recovery('Another evaluator process owns this request. No execution started here.', 'retry_same_command'),
  'journal.foreign': recovery('The journal belongs to a different request or evaluator.', 'inspect_external_app'),
  'journal.missing': recovery('The request has started, but this machine has no journal for it.', 'inspect_external_app'),
  'journal.relocated': recovery('The journal moved from its original location.', 'restore_original_journal'),
  'journal.invalid': recovery('The journal is corrupt or was edited.', 'fix_config'),
  'journal.ownership_lost': recovery('This process lost ownership of the journal during the run.', 'inspect_external_app'),
  'execution.uncertain': recovery('Callbacks may have started, and the evaluator cannot prove they stopped.', 'inspect_external_app'),
  'submission.unconfirmed': recovery('The report was saved locally, but the service has not confirmed the submission.', 'retry_same_command'),
  'request.interrupted': recovery('The request was interrupted.', 'interrupt_then_new_request'),
  'request.base_conflict': recovery('The published parent changed after this request was created.', 'fix_config'),
  'request.channel_empty': operator('The channel has no published release, so there is no parent to compare with.'),
  'request.intent_mismatch': config('The saved run intent differs from this command. Reuse the original inputs, or start a new run name.'),
  'policy.invalid': config('The quality policy is invalid.'),
  'policy.inventory_incompatible': config('The policy requires cases that are not in the evaluation inventory.'),
  'evidence.not_terminal': { message: 'The request has not finished, so there is no complete evidence yet.', nextAction: 'fix_config', exitCode: 3 },
  'evidence.identity_mismatch': config('The evidence does not match the expected request, attempt or submitter.'),
  'evidence.malformed': config('The service returned evidence in an unexpected shape.'),
  'evidence.reward_out_of_range': config('A scored reward is outside the reward scale declared by the policy. Fix the grader or the policy metric.scale.'),
  'evidence.incomplete': { message: 'The service returned incomplete evidence.', nextAction: 'fix_config', exitCode: 3 },
  'cost.unknown': { message: 'Cost evidence is missing for some outcomes.', nextAction: 'fix_config', exitCode: 3 },
  'analysis.nonfinite': config('An analysis input or result is not a finite number.'),
  'analysis.invalid_config': config('The analysis configuration is invalid.'),
  'analysis.invalid_observations': config('An analysis observation is invalid.'),
  'analysis.identity_mismatch': config('An analysis observation does not match the trusted evidence.'),
  'artifact.missing': { message: 'A private review artifact is missing from the journal.', nextAction: 'fix_config', exitCode: 3 },
  'artifact.hash_mismatch': config('A private review artifact does not match its recorded digest.'),
  'artifact.integrity': config('The private artifact index is inconsistent with the saved report.'),
  'artifact.selection_invalid': config('The artifact selection file is invalid.'),
  'artifact.mapper_failed': app('toReviewArtifact threw or returned an invalid value.'),
  'internal.error': { message: 'An unexpected error occurred. Rerun with --verbose or ACCLIMATE_DEBUG=1 for details.', nextAction: 'fix_config', exitCode: 4 },
} satisfies Record<SafeCode, CodeInfo>);

export interface SafeDiagnostic {
  pathIssue?: PathIssue;
  /** The flag, file, definition or output field that caused the error. Local only. */
  field?: string;
  /** Why the field was rejected. Local only. */
  reason?: string;
  hint?: string;
  code: SafeCode;
  phase: EvaluationPhase;
  executionState: ExecutionState;
  nextAction: SafeNextAction;
  evaluationRequestId?: string;
  correlationId?: string;
  httpStatus?: number;
  /** Service origin the evaluator tried to reach. */
  serviceUrl?: string;
  mismatchFields?: readonly string[];
  missingFields?: readonly string[];
  reportBudget?: {
    estimatedBytes: number;
    limitBytes: number;
    expectedPairs: number;
    maxPairsPerPartition: number;
  };
}
const allowedFields = new Set([
  'datasetRevision',
  'graderRevision',
  'runtime.configId',
  'runtime.configRevision',
  'runtime',
  'expectedCases',
  'versions',
]);
const bounded = (value: unknown, limit: number) =>
  typeof value === 'string' && value.length > 0
    ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit)
    : undefined;

export interface EvaluationErrorOptions extends Partial<Omit<SafeDiagnostic, 'code'>> {
  /** Replace the code's default message. */
  message?: string;
}

/** The base class for evaluator errors. `code` is one of the documented diagnostic codes. */
export class EvaluationError extends AcclimateError<SafeCode> {
  readonly diagnostic: SafeDiagnostic;
  constructor(code: SafeCode, options: EvaluationErrorOptions = {}, cause?: ErrorOptions) {
    const info = EVALUATION_ERROR_CODES[code] ?? EVALUATION_ERROR_CODES['internal.error'];
    const field = bounded(options.field, 512);
    const reason = bounded(options.reason, 1024);
    super(
      code,
      options.message ??
        info.message + (field ? ` ${field}${reason ? `: ${reason}` : ''}` : reason ? ` ${reason}` : ''),
      cause,
    );
    this.name = 'EvaluationError';
    const guidance =
      options.pathIssue && Object.hasOwn(pathGuidance, options.pathIssue)
        ? { pathIssue: options.pathIssue, ...pathGuidance[options.pathIssue] }
        : {};
    const hint = bounded(options.hint, 2048);
    const serviceUrl = bounded(options.serviceUrl, 4096);
    this.diagnostic = {
      code,
      ...guidance,
      ...(field ? { field } : {}),
      ...(reason ? { reason } : {}),
      ...(hint ? { hint } : {}),
      phase: options.phase ?? 'configure',
      executionState: options.executionState ?? 'not_started',
      nextAction: options.nextAction ?? info.nextAction,
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
      ...(serviceUrl ? { serviceUrl } : {}),
      ...(options.mismatchFields
        ? { mismatchFields: options.mismatchFields.filter((x) => allowedFields.has(x)) }
        : {}),
      ...(options.missingFields?.length ? { missingFields: [...options.missingFields] } : {}),
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
/** A callback returned a value that is not plain JSON. `field` and `reason` stay in the private job directory. */
export class OutputValidationError extends EvaluationError {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    super('output.invalid', { phase: 'execute', field, reason, message: `${field}: ${reason}` });
    this.name = 'OutputValidationError';
    this.field = field;
    this.reason = reason;
  }
}
/** The evaluation definition passed to defineEvaluation is invalid. */
export class DefinitionError extends EvaluationError {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string, cause?: ErrorOptions) {
    super('definition.invalid', { field, reason }, cause);
    this.name = 'DefinitionError';
    this.field = field;
    this.reason = reason;
  }
}
/** The application module could not be imported, or its exports are invalid. */
export class AppSetupError extends EvaluationError {
  constructor(
    message: string,
    options: {
      code?: 'application.invalid' | 'application.import_failed' | 'definition.invalid';
      field?: string;
      reason?: string;
      hint?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      options.code ?? 'application.invalid',
      { message, field: options.field, reason: options.reason, hint: options.hint },
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppSetupError';
  }
}
/** The command line is invalid. The diagnostic names the flag or command. */
export class EvaluationUsageError extends EvaluationError {
  constructor(
    code:
      | 'usage.missing_command'
      | 'usage.unknown_command'
      | 'usage.unknown_flag'
      | 'usage.missing_flag'
      | 'usage.invalid_flag'
      | 'usage.conflicting_flags',
    options: { field?: string; reason?: string; hint?: string } = {},
  ) {
    super(code, options);
    this.name = 'EvaluationUsageError';
  }
}
/** The callback certifies that its external resources are quiescent. */
export class CallbackCancelled extends Error {
  constructor() {
    super('Callback stopped after cooperative cancellation.');
    this.name = 'CallbackCancelled';
  }
}

/** The CLI exit code for a diagnostic. */
export function exitCodeFor(diagnostic: Pick<SafeDiagnostic, 'code' | 'executionState'>): ExitCode {
  if (diagnostic.executionState === 'may_have_started' || diagnostic.executionState === 'report_saved')
    return EXIT_CODES.recovery;
  return (EVALUATION_ERROR_CODES[diagnostic.code] ?? EVALUATION_ERROR_CODES['internal.error']).exitCode;
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
      ...(code === 'service.unavailable' && { nextAction: 'retry_same_command' }),
    }).diagnostic;
  }
  if (executionState === 'may_have_started') code = 'execution.uncertain';
  else if (executionState === 'report_saved') code = 'submission.unconfirmed';
  else if (error instanceof TransportError)
    return new EvaluationError('service.unavailable', {
      phase,
      executionState,
      serviceUrl: error.serviceUrl,
      hint: `Could not reach ${error.serviceUrl}. Check that the Acclimate service is running and that serviceUrl in the config is correct, then retry the same command.`,
    }).diagnostic;
  else if (error instanceof AcclimateUsageError)
    return new EvaluationError('internal.error', {
      phase,
      executionState,
      field: error.field,
      reason: error.message,
    }).diagnostic;
  return new EvaluationError(code, { phase, executionState }).diagnostic;
}
