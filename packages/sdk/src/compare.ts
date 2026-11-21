import { AcclimateError } from './errors.js';
import type { Usage } from './evaluation/types.js';

export interface ExecutionResult<TOutput = unknown> {
  /** Structured-cloneable data; each grade attempt receives its own copy. */
  output: TOutput;
  /** A task-level failure with a gradeable output (for example, a saved error response). */
  executionStatus?: 'completed' | 'task_failed';
  error?: string | null;
  outputRef?: string | null;
  usage?: Usage | null;
}
export interface GradeResult {
  reward: number;
  error?: string | null;
}
/** Throw from an execute callback when the task failed without gradeable output. */
export class TaskExecutionError extends AcclimateError<'task.failed'> {
  readonly kind = 'task';
  constructor(message = 'The task failed without gradeable output.', options?: ErrorOptions) {
    super('task.failed', message, options);
    this.name = 'TaskExecutionError';
  }
}
/** Throw from an execute callback when the environment, not the agent, failed. */
export class InfrastructureError extends AcclimateError<'infrastructure.failed'> {
  readonly kind = 'infrastructure';
  constructor(message = 'The execution environment failed.', options?: ErrorOptions) {
    super('infrastructure.failed', message, options);
    this.name = 'InfrastructureError';
  }
}
