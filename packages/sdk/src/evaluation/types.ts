import type {
  Comparison,
  Evaluation,
  EvaluationDescriptor,
  EvaluationHandoff,
  VerifiedBundle,
} from '../types.js';
import type { ExecutionResult, GradeResult } from '../compare.js';
import type { SafeCode, SafeDiagnostic, SafeNextAction } from './errors.js';
export type { EvaluationDescriptor, EvaluationHandoff } from '../types.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Keep the application's named object types while rejecting non-JSON members
 * such as Date, bigint, functions and undefined array elements. */
type JsonMembers<T> = T extends null | boolean | number | string
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? { [K in keyof T]: K extends symbol ? never : JsonMembers<T[K]> }
      : never;
export type EvaluationExecutionResult<O = Json> = ExecutionResult<
  O & (unknown extends O ? Json : [O] extends [Json] ? O : JsonMembers<O>)
>;
export interface EvaluationCase<I = Json, E = Json> {
  caseId: string;
  input: I;
  expected: E;
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
export interface EvaluationDefinition<I = Json, E = Json, O = Json> {
  configId: string;
  configRevision: string;
  datasetRevision: string;
  graderRevision: string;
  runtime: Readonly<Record<string, string>>;
  execution: 'model-free' | 'live';
  cases: readonly EvaluationCase<I, E>[];
  collection?: EvaluationCollection;
  execute(input: {
    bundle: VerifiedBundle;
    caseId: string;
    repetition: number;
    input: I;
    signal: AbortSignal;
    context: ExecutionContext;
  }): Promise<EvaluationExecutionResult<O>>;
  grade(input: {
    output: O;
    expected: E;
    caseId: string;
    repetition: number;
    signal: AbortSignal;
  }): Promise<EvaluationGradeResult>;
}
declare const appBrand: unique symbol;
export interface EvaluationApp<I = Json, E = Json, O = Json> {
  readonly descriptor: Readonly<EvaluationDescriptor>;
  readonly [appBrand]: [I, E, O];
}
export interface EvaluatorConfig {
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
  } & Pick<SafeDiagnostic, 'pathIssue' | 'field' | 'hint'>>;
  nextAction: SafeNextAction;
}
export interface EvaluationRunResult {
  /** Number of application execution callbacks started by this invocation. */
  callbacksStarted: number;
  reusedEvidence: boolean;
  schemaVersion: 1;
  evaluation: Evaluation;
  comparison: Comparison | null;
  executionState: 'finished' | 'interrupted';
}
export interface PreflightOptions<I = Json, E = Json, O = Json> {
  app: EvaluationApp<I, E, O>;
  configPath: string;
  target: { bundleId: string; requestId?: string } | { handoff: EvaluationHandoff };
}
export interface RunEvaluationOptions<I = Json, E = Json, O = Json> {
  app: EvaluationApp<I, E, O>;
  configPath: string;
  handoff: EvaluationHandoff;
  allowLive?: boolean;
  signal?: AbortSignal;
}
