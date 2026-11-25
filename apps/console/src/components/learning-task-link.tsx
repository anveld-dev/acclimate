import { shortTaskId, taskAnchor } from '../lib/central-learning';

/**
 * A short task ID that opens the task's card on the Learning page's Tasks tab. The link is
 * relative, so it works from any tab of the page.
 */
export function TaskLink({ id }: { id: string }) {
  const short = shortTaskId(id);
  return (
    <a className="underline" href={'?tab=tasks#' + taskAnchor(id)} title={id}>
      <code aria-hidden={short !== id || undefined}>{short}</code>
      {short !== id && <span className="sr-only">{id}</span>}
    </a>
  );
}
