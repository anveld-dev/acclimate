import { ApiError } from '../client.js';
import { AcclimateError, AcclimateUsageError, TransportError } from '../errors.js';
import { EvaluationConfigurationError } from '../evaluation-validation.js';

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
  | 'definition.invalid'
  | 'application.invalid'
  | 'application.import_failed'
  | 'learning.apps_invalid_export'
  | 'learning.held_out_mismatch'
  | 'output.invalid'
  | 'payload.incompatible'
  | 'runtime.unsupported'
  | 'bundle.missing'
  | 'guided_target_unsupported'
  | 'auth.denied'
  | 'descriptor.mismatch'
  | 'service.unavailable'
  | 'transport.response_too_large'
  | 'journal.busy'
  | 'journal.invalid'
  | 'journal.ownership_lost'
  | 'execution.uncertain'
  | 'evidence.identity_mismatch'
  | 'evidence.malformed'
  | 'evidence.incomplete'
  | 'internal.error';
export type EvaluationPhase =
  | 'configure'
  | 'preflight'
  | 'verify'
  | 'execute'
  | 'inspect';
export type ExecutionState = 'not_started' | 'may_have_started' | 'report_saved' | 'finished';
export type SafeNextAction =
  | 'none'
  | 'fix_command'
  | 'fix_config'
  | 'fix_application'
  | 'check_service'
  | 'ask_operator'
  | 'retry_same_command'
  | 'inspect_external_app';

/**
 * Evaluator CLI exit codes. Each one describes the command outcome.
 */
export const EXIT_CODES = {
  /** The command succeeded. */
  ok: 0,
  /** Fix the command line, config, application module or definition, then rerun. */
  usage: 1,
  /** The service or local runtime failed. */
  infrastructure: 4,
  /** Recovery is required before retrying because callback execution or local ownership is uncertain. */
  recovery: 5,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const pathGuidance = {
  configAlias: { field: 'configPath', hint: 'Use the absolute realpath of the config file, including all parent directories. On macOS, /var is an alias for /private/var.' },
  journalAlias: { field: 'journalRoot', hint: 'Set journalRoot to the absolute realpath of the journal directory, including all parents. On macOS, /var is an alias for /private/var.' },
  configMode: { field: 'configPath', hint: 'Use a config owned by the current user with mode 0600 (chmod 600) in a private directory owned by that user with mode 0700 (chmod 700).' },
  journalMode: { field: 'journalRoot', hint: 'Use a journal directory owned by the current user with mode 0700 (chmod 700).' },
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
  'config.schema': config('The evaluator config or command input has an invalid field.'),
  'config.permissions': config('A private file or directory has unsafe ownership, mode or path.'),
  'config.url': config('serviceUrl must be an https:// origin, or http:// on localhost, with no path, query or credentials.'),
  'definition.invalid': app('The evaluation definition is invalid.'),
  'application.invalid': app('The application module does not export a valid adapter.'),
  'learning.apps_invalid_export': app('Default-export an object with execute, grade, heldOut and an execution mode.'),
  'learning.held_out_mismatch': app('The installed held-out cases do not match the loop\'s held-out commitment.'),
  'application.import_failed': app('The application module could not be imported.'),
  'payload.incompatible': { message: 'The payload breaks a compatibility rule of a native harness the application declares.', nextAction: 'fix_command', exitCode: 1 },
  'output.invalid': app('A callback returned a value that is not plain JSON.'),
  'runtime.unsupported': config('This platform cannot run the evaluator. Use Linux or macOS with python3 available.'),
  'bundle.missing': config('The bundle does not exist in this workspace or the evaluator cannot read it.'),
  guided_target_unsupported: config('The workspace or bundle identifier is not in the supported format.'),
  'auth.denied': operator('The service denied this token. Check the evaluator token and its permissions.'),
  'descriptor.mismatch': app('The installed descriptor is invalid.'),
  'service.unavailable': { message: 'The Acclimate service is unreachable or returned a server error.', nextAction: 'check_service', exitCode: 4 },
  'transport.response_too_large': { message: 'A service response exceeded the size limit.', nextAction: 'fix_config', exitCode: 4 },
  'journal.busy': recovery('Another evaluator process holds the local evaluator lock. No execution started here.', 'retry_same_command'),
  'journal.invalid': recovery('The journal is corrupt or was edited.', 'fix_config'),
  'journal.ownership_lost': recovery('This process lost ownership of the journal during the run.', 'inspect_external_app'),
  'execution.uncertain': recovery('Callbacks may have started, and the evaluator cannot prove they stopped.', 'inspect_external_app'),
  'evidence.identity_mismatch': config('The version or digest does not match the expected identity.'),
  'evidence.malformed': config('The service returned evidence in an unexpected shape.'),
  'evidence.incomplete': { message: 'The bundle inventory exceeded the preflight read limit.', nextAction: 'fix_config', exitCode: 1 },
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
  correlationId?: string;
  httpStatus?: number;
  /** Service origin the evaluator tried to reach. */
  serviceUrl?: string;
  mismatchFields?: readonly string[];
  missingFields?: readonly string[];
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
  else if (error instanceof TransportError)
    return new EvaluationError('service.unavailable', {
      phase,
      executionState,
      serviceUrl: error.serviceUrl,
      hint: `Could not reach ${error.serviceUrl}. Check that the Acclimate service is running and that serviceUrl in the config is correct, then retry the same command.`,
    }).diagnostic;
  else if (error instanceof EvaluationConfigurationError)
    return new EvaluationError(error.code, {
      phase,
      executionState,
      field: error.field,
      reason: error.reason,
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
