import type {
  LearningImport,
  LearningTask,
  LearningTrial,
  LearningUsageDay,
  ModelProvider,
  ModelProviderRequest,
  LearningLoopRequest,
  LearningTaskRequest,
  LearningTaskEdit,
  LearningRollback,
} from '@acclimate/sdk';
export type CentralCommand =
  | { action: 'loop' | 'provider' | 'start' | 'pause' | 'stop' | 'tasks' | 'export' | 'usage' }
  | { action: 'evidence'; id: string; evaluation?: string }
  | { action: 'retire' | 'try' | 'trial' | 'progress' | 'unblock'; id: string }
  | { action: 'saveProvider'; body: ModelProviderRequest }
  | { action: 'configure'; body: LearningLoopRequest }
  | { action: 'rollback'; body: LearningRollback }
  | { action: 'create'; body: LearningTaskRequest }
  | { action: 'edit'; id: string; body: LearningTaskEdit };
export type CentralRequest = { workspaceId: string; bundleId?: string } & CentralCommand;
export type Provider = ModelProvider;
export type TaskCard = LearningTask;
export type ImportStatus = LearningImport;
export type Trial = Omit<LearningTrial, 'kind'>;
export type CardTrial = Trial & { taskId: string };
export function selectedModels(
  allowed: string[],
  taskChoice?: string | null,
  judgeChoice?: string | null,
) {
  const task = allowed.find((model) => model === taskChoice) ?? allowed[0] ?? '';
  const judge =
    allowed.find((model) => model === judgeChoice) ?? allowed.find((model) => model !== task) ?? '';
  return { task, judge };
}
export function pendingTaskReads(
  trial?: Trial,
  job?: ImportStatus,
  cards?: Pick<TaskCard, 'admission'>[],
) {
  const trialId = trial?.status === 'pending' ? trial.trialId : undefined;
  const importId =
    job?.pending && job.status !== 'failed' && job.status !== 'completed'
      ? job.importId
      : undefined;
  return {
    trialId,
    importId,
    enabled: Boolean(trialId || importId || cards?.some((card) => card.admission === 'pending')),
  };
}
export type Usage = LearningUsageDay;
export const splitDeficit = (count: number) => Math.max(0, 20 - count);
export const mediaTypes: Record<string, string> = {
  csv: 'text/csv',
  jsonl: 'application/x-ndjson',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};

const descriptions: Record<string, string> = {
  'round.scoring_incumbent': 'Testing the current version',
  'round.proposing': 'Writing proposed changes',
  'round.screening': 'Checking proposals before testing',
  'round.evaluating': 'Testing candidate versions',
  'round.selecting': 'Choosing whether to release a candidate',
  'round.scoring_held_out': 'Checking the release on held-out tasks',
  'round.completed': 'Completed',
  'round.failed': 'Failed',
  'round.stopped': 'Stopped',
  'evaluation.queued': 'Waiting for an executor.',
  'evaluation.running': 'The executor is testing this version.',
  'evaluation.scored': 'Testing finished.',
  'evaluation.failed': 'Testing failed.',
  'evaluation.cancelled': 'Testing was cancelled.',
  generating: 'The optimizer is writing a proposal.',
  generated: 'The proposal is ready for screening.',
  dropped: 'This proposal was dropped.',
  screened_out: 'This proposal did not pass screening.',
  evaluating: 'The executor is testing this proposal.',
  evaluated: 'Testing finished.',
  evaluation_failed: 'Testing failed.',
  'provider-failed': 'The model provider did not complete the request.',
  'format-rejected': 'The proposal used an invalid format.',
  'scanner-rejected': 'The proposal failed the content scan.',
  'no-change': 'The proposal made no changes.',
  'blocked-version': 'This version was previously blocked.',
  start: 'Learning started.',
  resume: 'Learning resumed.',
  adoption: 'A new version was adopted.',
  retry: 'The service scheduled another attempt.',
  'task-change': 'The admitted task set changed.',
  'selector-kept': 'The selector kept the current version.',
  'no-candidates': 'The optimizer produced no candidates.',
  'no-survivors': 'No candidate passed screening.',
  'no-evaluated-candidates': 'No candidate finished evaluation.',
  'channel-moved': 'The channel changed while this round was running.',
  'incumbent-evaluation-failed': 'Evaluation of the current version failed.',
  'optimizer-required':
    'The service has no optimizer model. An operator must set ACCLIMATE_MODEL_ENDPOINT, ACCLIMATE_MODEL_TOKEN and ACCLIMATE_MODEL on the service. On the local stack, export them and run npm run local:up again.',
  'held-out-evaluation-failed': 'The regression check on held-out tasks could not run.',
  'optimizer-unavailable':
    'The optimizer was unavailable. Ask the operator to check its connection.',
  'selector-unavailable': 'The service could not select a candidate.',
  running: 'Learning is on.',
  paused: 'Learning is paused.',
  stopped: 'Learning has stopped.',
  operator: 'A workspace administrator paused learning.',
  'failed-rounds':
    'Several rounds failed. Inspect the latest round and fix the reported problem before restarting.',
  'optimizer-context-too-large':
    'The optimizer ran out of context. Ask an operator to check its context limit.',
  'tasks-required': 'Add enough admitted tasks to both groups before restarting.',
  'daily-cap':
    'The daily round limit has been reached. Learning resumes when the rolling 24-hour window allows.',
  'no-new-evidence': 'Learning is waiting for new or revised tasks.',
  'no-executor':
    'No executor is available. Ask the operator to start an executor connected to this service.',
  'models-not-allowed':
    'A selected model is no longer allowed. Choose allowed models in learning setup.',
  'no-matching-executor':
    'No executor could run this round with its original settings. Check executor connectivity and the allowed models.',
  pending: 'Waiting for admission checks.',
  admitted: 'Admitted for learning.',
  'set-aside': 'Set aside for review.',
  'rollout-error': 'An executor run ended with an error.',
  'judge-disagreement': 'The judge disagreed across repeated judgments.',
  'split-rollouts': 'Repeated runs gave different verdicts.',
  'persistent-failure': 'Candidates repeatedly failed this task.',
  'no-reference':
    'No usable reference answer or grading criteria. Add an expected answer or grading criteria to the row and import it again.',
  'not-converted': 'The conversion could not turn this row into a task. Edit the row and import it again.',
  'too-large': 'The row is over 64 KiB. Shorten it and import it again.',
  'reference-failed':
    'The reference answer does not meet the grading criteria. Fix the answer or the criteria and save.',
  'empty-passed': 'An empty answer met the grading criteria. Make the criteria stricter and save.',
  'judge-unstable':
    'The judge gave inconsistent results on the reference answer. Make the criteria more specific and save.',
  'check-failed':
    'The check could not run, for example because the model provider or executor was unavailable. Edit and save the task to run it again.',
};
export function describeLearning(code: string) {
  return descriptions[code] ?? code.replaceAll('-', ' ');
}
