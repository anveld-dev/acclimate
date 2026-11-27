import type { LearningImportSummary, LearningTaskConfirmation } from '@anveld/acclimate-sdk';
import { describeLearning, type TaskCard } from './central-learning';

export type TaskReviewCommand =
  | { action: 'confirm'; taskIds: string[] }
  | { action: 'recheck'; id: string }
  | { action: 'recheckAll'; taskIds?: string[] }
  | { action: 'imports' };
export type TaskReviewRequest = { workspaceId: string; bundleId: string } & TaskReviewCommand;
export type ImportSummary = LearningImportSummary;
export type Confirmation = LearningTaskConfirmation;

export type SplitFilter = '' | 'evolve' | 'held-out';
export interface TaskFilters {
  split: SplitFilter;
  admission: string;
  source: string;
  flagged: boolean;
  needsConfirmation: boolean;
}
export const pageSize = 10;

/** No admission check is queued for a held-out task until a person confirms it. */
export const needsConfirmation = (card: Pick<TaskCard, 'split' | 'confirmedBy' | 'admission'>) =>
  card.split === 'held-out' && !card.confirmedBy && card.admission === 'pending';
export const checkFailed = (card: Pick<TaskCard, 'admission' | 'admissionReason'>) =>
  card.admission === 'set-aside' && card.admissionReason === 'check-failed';

export function filterCards(cards: TaskCard[], f: TaskFilters) {
  return cards.filter(
    (c) =>
      (!f.split || c.split === f.split) &&
      (!f.admission || c.admission === f.admission) &&
      (!f.flagged || c.flagReason) &&
      (!f.source || f.source === c.source) &&
      (!f.needsConfirmation || needsConfirmation(c)),
  );
}

export function emptyListText(f: TaskFilters) {
  if (f.needsConfirmation) return 'No tasks need your confirmation.';
  if (f.flagged) return 'No flagged tasks.';
  if (f.split) return 'No tasks match these filters.';
  if (f.admission) return 'No tasks match this admission filter.';
  if (f.source) return 'No tasks from this source.';
  return 'No tasks yet.';
}

/** The first block of a UUID, or the whole id when it is already short. */
export const shortTaskId = (id: string) => (id.length > 12 ? id.split('-')[0]!.slice(0, 8) : id);
export const taskElementId = (id: string) => 'task-' + id;

/** Reads the task a link points at, from `#task-<id>` or `?task=<id>`. */
export function linkedTask(location: { hash: string; search: string }) {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (hash.startsWith('task-') && hash.length > 5) return hash.slice(5);
  return new URLSearchParams(location.search).get('task') || undefined;
}

export const confirmAllDescription = (count: number) =>
  `Confirm ${count} held-out ${count === 1 ? 'task' : 'tasks'} on this page. Confirming says that ` +
  'you have read each task and that its expected answer or criteria are right for it. Held-out ' +
  'tasks are never shown to the optimizer. They measure whether a release made the agent worse, ' +
  'so a wrong criterion hides or invents a regression. Each confirmed task then runs its ' +
  'admission check.';

export function confirmationSummary(result: Confirmation) {
  const count = (kind: string) => result.results.filter((r) => r.result === kind).length;
  const confirmed = count('confirmed');
  const parts = [
    `Confirmed ${confirmed} ${confirmed === 1 ? 'task' : 'tasks'}. Their admission checks run next.`,
  ];
  const already = count('already-confirmed');
  if (already) parts.push(`${already} had already been confirmed.`);
  const missing = count('not-found');
  if (missing) parts.push(`${missing} no longer exist. Refresh the tasks to see the current list.`);
  return parts.join(' ');
}

export const recheckSummary = (count: number) =>
  count
    ? `Queued ${count} ${count === 1 ? 'check' : 'checks'} again. Results appear on the cards when an executor runs them.`
    : 'No failed checks were left to run. Refresh the tasks to see the current list.';

export const recheckQueued =
  'The check is queued again. The result appears on this card when an executor runs it.';

const trialErrors: Record<string, string> = {
  'gateway-upstream':
    'The model provider returned an error. Check the provider in workspace settings and try again.',
  'provider-rejected':
    'The model provider rejected the request, for example because the key was revoked or the model is not available. Check the provider settings.',
  'judge-budget':
    'The judge ran out of its token budget. Shorten the criteria or the reference answer and try again.',
  'judge-invalid-reply':
    'The judge did not return a usable verdict. Try again, and make the criteria more specific if it keeps happening.',
  'sandbox-start':
    'The executor could not start a sandbox. Ask the operator to check the executor host, then try again.',
  executor:
    'The executor stopped before finishing. Ask the operator to check the executor, then try again.',
  cancelled:
    'The trial was cancelled because the provider settings or the executor changed. Try again.',
};
export function describeTrialError(code?: string | null) {
  if (!code) return 'The trial did not finish. Try again.';
  return trialErrors[code] ?? `The trial failed (${code}). Try again.`;
}

export const scoreText = (score?: number) =>
  typeof score === 'number' ? 'Score ' + (Math.round(score * 1000) / 1000).toFixed(3) : '';

export function describeImportReason(reason: string) {
  return reason === 'duplicate'
    ? 'This row matches a task that already exists.'
    : describeLearning(reason);
}

export function describeAdmissionReason(reason: string) {
  return describeLearning(reason);
}
