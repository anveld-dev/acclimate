import type {
  Comparison,
  Evaluation,
  EvaluationDescriptor,
  EvaluationHandoff,
  VerifiedBundle,
} from '../types.js';
import type { ExecutionResult, GradeResult } from '../compare.js';
import type { SafeCode, SafeNextAction } from './errors.js';
export type { EvaluationDescriptor, EvaluationHandoff } from '../types.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
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
  }): Promise<ExecutionResult<O>>;
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
  }>;
  nextAction: SafeNextAction;
}
export interface EvaluationRunResult {
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
