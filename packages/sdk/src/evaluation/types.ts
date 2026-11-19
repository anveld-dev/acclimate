import type {
  BundleFile,
  CompatibilityTarget,
  Comparison,
  Evaluation,
  EvaluationDescriptor,
  EvaluationHandoff,
  VerifiedVersion,
} from '../types.js';
import type { ExecutionResult, GradeResult } from '../compare.js';
import type { SafeCode, SafeDiagnostic, SafeNextAction } from './errors.js';
export type { EvaluationDescriptor, EvaluationHandoff } from '../types.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Depth = [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown];
/** The first reason a callback output type is not plain JSON, as a readable path. */
export type NonJsonReason<T, P extends string = 'output', D extends unknown[] = []> =
  D['length'] extends Depth['length']
    ? never
    : unknown extends T
      ? never
      : [T] extends [Json]
        ? never
        : T extends null | boolean | number | string
          ? never
          : T extends undefined
            ? `${P} can be undefined. Use null or omit the field.`
            : T extends bigint
              ? `${P} is a bigint. Encode it as a string.`
              : T extends Date
                ? `${P} is a Date. Return date.toISOString().`
                : T extends (...args: never[]) => unknown
                  ? `${P} is a function. Remove it from the output.`
                  : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
                    ? `${P} is a Map or Set. Convert it to a plain object or array.`
                    : T extends symbol
                      ? `${P} is a symbol. Remove it from the output.`
                      : T extends readonly (infer U)[]
                        ? NonJsonReason<U, `${P}[number]`, [...D, unknown]>
                        : T extends object
                          ? {
                              [K in keyof T]-?: K extends string
                                ? NonJsonReason<T[K], `${P}.${K}`, [...D, unknown]>
                                : `${P} has a symbol key. Use string keys.`;
                            }[keyof T]
                          : `${P} is not a JSON value.`;
/**
 * Resolves to `unknown` when `O` is plain JSON. Otherwise it requires a property whose
 * name and type explain which output field to convert, for example
 * `"output.observedAt is a Date. Return date.toISOString()."`.
 */
export type JsonOutputCheck<O> = [NonJsonReason<O>] extends [never]
  ? unknown
  : { 'Callback output must be plain JSON': NonJsonReason<O> };
export type MaybePromise<T> = T | PromiseLike<T>;
export type EvaluationExecutionResult<O = Json> = ExecutionResult<O>;
export interface EvaluationCase<I = Json, E = Json> {
  caseId: string;
  input: I;
  expected: E;
  /**
   * How many times to run this case, counting from 1. Defaults to 1. Each run gets a
   * 0-based `repetition` index, so `repetitions: 3` yields repetitions 0, 1 and 2.
   */
  repetitions?: number;
}
/** Opt-in arm ordering; applications still own fixture reset and isolation. */
export interface EvaluationCollection {
  protocol: 'seeded-balanced-v1';
  seed: string;
}
export interface ExecutionContext {
  readonly requestId: string;
  readonly attemptId: string;
  readonly side: 'parent' | 'candidate';
  readonly jobId: string;
  readonly privateJobDirectory: string;
  readonly collection?: Readonly<{
    protocol: 'seeded-balanced-v1';
    scheduleDigest: string;
    pairIndex: number;
    armIndex: number;
    firstSide: 'parent' | 'candidate';
  }>;
}
export interface EvaluationGradeResult extends GradeResult {
  explanation?: Json;
}
/** The argument to an execute callback. */
export interface ExecuteInput<I = Json> {
  /** The verified parent or candidate version under test. */
  bundle: VerifiedVersion;
  caseId: string;
  /** 0-based index of this run of the case. */
  repetition: number;
  input: I;
  signal: AbortSignal;
  context: ExecutionContext;
  /** Text of every instruction file in the bundle, joined with blank lines in payload order. */
  readonly instructions: string;
  /** Instruction files in payload order. */
  readonly instructionFiles: readonly BundleFile[];
  /** Skill files in payload order. */
  readonly skillFiles: readonly BundleFile[];
  /** Memory files in payload order. */
  readonly memoryFiles: readonly BundleFile[];
}
/** The argument to a grade callback. */
export interface GradeInput<E = Json, O = Json> {
  output: O;
  expected: E;
  caseId: string;
  /** 0-based index of this run of the case. */
  repetition: number;
  signal: AbortSignal;
}
export interface EvaluationDefinition<I = Json, E = Json, O = Json> {
  configId: string;
  configRevision: string;
  datasetRevision: string;
  graderRevision: string;
  runtime: Readonly<Record<string, string>>;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  collection?: EvaluationCollection;
  /**
   * Native harnesses this evaluation prepares bundles for, such as `'claude'`. `doctor --payload`,
   * `compare --payload`, `compare --local` and `try --payload` check payloads against their
   * compatibility rules before any callback runs. Not part of the descriptor.
   */
  compatibilityTarget?: CompatibilityTarget | readonly CompatibilityTarget[];
  /**
   * Pairs in flight at once (1–64, default 1). Arms within a pair still run in
   * schedule order. Fingerprinted as `runtime.concurrency`.
   */
  concurrency?: number;
  /**
   * Extra grade attempts after a grader throws or times out (0–5, default 0).
   * Execution is never repeated. Fingerprinted as `runtime.gradeRetries`.
   */
  gradeRetries?: number;
  /** Run the agent for one case. Return the result directly or as a promise. */
  execute(input: ExecuteInput<I>): MaybePromise<EvaluationExecutionResult<O>>;
  /** Score one output. Return the result directly or as a promise. */
  grade(input: GradeInput<E, O>): MaybePromise<EvaluationGradeResult>;
}
declare const appBrand: unique symbol;
export interface EvaluationApp<I = Json, E = Json, O = Json> {
  readonly descriptor: Readonly<EvaluationDescriptor>;
  readonly [appBrand]: [I, E, O];
}
export interface EvaluatorConfig {
  /**
   * Record each failed callback's redacted message and stack in its private job directory.
   * Defaults to true. The files stay on this machine. Set false to opt out.
   */
  captureCallbackErrors?: boolean;
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  evaluatorPrincipalId: string;
  evaluatorToken: string;
  journalRoot: string;
}
export interface ReaderConfig {
  schemaVersion: 1;
  serviceUrl: string;
  projectId: string;
  readToken: string;
}
export interface PreflightResult {
  schemaVersion: 1;
  status: 'ready' | 'blocked';
  authorization: 'verified' | 'denied' | 'unverified';
  checkedAt: string;
  checks: Array<{
    check:
      | 'runtime'
      | 'privateConfig'
      | 'journalStorage'
      | 'lock'
      | 'serviceIdentity'
      | 'evaluatorAccess'
      | 'targetBundle'
      | 'targetRequest'
      | 'descriptor'
      | 'versions';
    status: 'passed' | 'failed' | 'not_applicable' | 'unverified';
    code?: SafeCode;
  } & Pick<SafeDiagnostic, 'pathIssue' | 'field' | 'hint' | 'serviceUrl'>>;
  nextAction: SafeNextAction;
}
export interface EvaluationRunResult {
  /** Number of application execution callbacks started by this invocation. */
  callbacksStarted: number;
  /**
   * The first callback that failed in this invocation. `diagnosticFile` is a private local
   * file with the redacted exception message and stack. It is never uploaded.
   */
  firstCallbackFailure?: {
    caseId: string;
    repetition: number;
    side: 'parent' | 'candidate';
    stage: 'execute' | 'grade';
    reason:
      | 'execution_failed'
      | 'task_failed'
      | 'output_invalid'
      | 'grading_failed'
      | 'execution_uncertain';
    diagnosticFile?: string;
  };
  reusedEvidence: boolean;
  schemaVersion: 1;
  evaluation: Evaluation;
  comparison: Comparison | null;
  executionState: 'finished' | 'interrupted';
  /** Present when this invocation executed trials: stop reason, cost and coverage. */
  runSummary?: import('./controls.js').RunSummary;
}
export interface PreflightOptions<I = Json, E = Json, O = Json> {
  app: EvaluationApp<I, E, O>;
  configPath: string;
  target: { bundleId: string; requestId?: string } | { handoff: EvaluationHandoff };
}
export interface RunEvaluationOptions<I = Json, E = Json, O = Json> {
  /** Resolve the connected learner's cache assignment after claiming the request. */
  cachedParent?: () => Promise<import('../types.js').CachedLearningParent | null | undefined>;
  app: EvaluationApp<I, E, O>;
  configPath: string;
  handoff: EvaluationHandoff;
  allowLive?: boolean;
  retryMissingTrial?: boolean;
  signal?: AbortSignal;
  /** Deadline, per-callback timeout, cost limit, case selection and progress. */
  controls?: import('./controls.js').RunControls;
}
