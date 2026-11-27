import { ConfirmDialog, LearningConfirm } from './learning-confirm';
import { useBackgroundRefresh } from './use-background-refresh';
import { Checkbox } from './ui/checkbox';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronRight, FileUp, MoreHorizontal } from 'lucide-react';
import type { LearningScope } from '../lib/learning';
import {
  mediaTypes,
  describeLearning,
  pendingTaskReads,
  type CentralCommand,
  type TaskCard,
  type Trial,
  type CardTrial,
  type Usage,
  type ImportStatus,
} from '../lib/central-learning';
import { learningRequest } from '../server/central-actions';
import { taskReviewRequest } from '../server/task-review-actions';
import {
  checkFailed,
  confirmAllDescription,
  confirmationSummary,
  describeAdmissionReason,
  describeTrialError,
  emptyListText,
  filterCards,
  linkedTask,
  needsConfirmation as awaitsConfirmation,
  pageSize,
  pasteHelp,
  pasteLabel,
  recheckQueued,
  recheckSummary,
  scoreText,
  shortTaskId,
  taskElementId,
  type Confirmation,
  type SplitFilter,
  type TaskReviewCommand,
} from '../lib/task-review';
import { LearningImports, TaskId } from './task-review';
import { LearningEvidence } from './learning-evidence';
import { Panel } from './panel';
import { Field } from './ui/field';
import { StatusBadge, type StatusTone } from './status-badge';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const codeBlock =
  'rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words';
const sectionLabel = 'text-xs font-medium text-muted-foreground';
const maxImportBytes = 64 * 1024 * 1024;
const pastePlaceholder =
  'Customer: Can I pause my subscription?\nAgent: Yes, for up to three months.\n---\nCustomer: How do I export my data?\nAgent: Open Settings, then Exports.';

function admissionBadge(card: TaskCard): { label: string; tone: StatusTone } {
  if (awaitsConfirmation(card)) return { label: 'Needs your confirmation', tone: 'warning' };
  if (card.admission === 'admitted') return { label: 'Admitted', tone: 'success' };
  if (card.admission === 'set-aside') return { label: 'Set aside', tone: 'danger' };
  if (card.admission === 'pending') return { label: 'Pending', tone: 'info' };
  return { label: describeLearning(card.admission), tone: 'neutral' };
}

function taskSource(card: TaskCard) {
  const place = card.sourceFile
    ? card.sourceFile + (card.sourceRow ? ', row ' + card.sourceRow : '')
    : card.sourceRow
      ? 'Row ' + card.sourceRow
      : '';
  if (card.source === 'import') return place || 'Imported';
  return place ? 'Console · ' + place : 'Written in the console';
}

export function TaskEditor({
  card,
  edit,
  run,
  recheck,
  trial,
  focused,
  children,
}: {
  trial?: CardTrial;
  card: TaskCard;
  edit: boolean;
  run: (data: CentralCommand) => void;
  recheck?: (id: string) => void;
  focused?: boolean;
  /** Extra content at the foot of the card, such as the last rollout of a flagged task. */
  children?: ReactNode;
}) {
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const elementId = taskElementId(card.taskId);
  const short = shortTaskId(card.taskId);
  const unconfirmed = card.split === 'held-out' && !card.confirmedBy;
  const admission = admissionBadge(card);
  const exact = card.grader.type === 'exact';
  return (
    <article
      id={elementId}
      tabIndex={-1}
      className={
        'space-y-3 rounded-lg border bg-card p-4 outline-none' +
        (focused ? ' ring-2 ring-primary' : '')
      }
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <TaskId id={card.taskId} />
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={card.split === 'held-out' ? 'info' : 'neutral'}>
            {card.split}
          </StatusBadge>
          <StatusBadge
            tone={admission.tone}
            title={awaitsConfirmation(card) ? undefined : describeLearning(card.admission)}
          >
            {admission.label}
          </StatusBadge>
        </span>
        <span className="min-w-0 text-sm break-words text-muted-foreground sm:ml-auto">
          {taskSource(card)}
        </span>
      </header>
      {card.flagReason && (
        <p data-tone="warning" className="rounded-md border px-3 py-2 text-sm">
          {describeLearning(card.flagReason)}
        </p>
      )}
      {card.admissionReason && (
        <p
          data-tone={card.admission === 'set-aside' ? 'danger' : 'neutral'}
          className="rounded-md border px-3 py-2 text-sm"
        >
          {describeAdmissionReason(card.admissionReason)}
        </p>
      )}
      <div className="space-y-1.5">
        <h4 className={sectionLabel}>Input</h4>
        <pre className={codeBlock}>{fieldText(card.input)}</pre>
      </div>
      <div className="space-y-1.5">
        <h4 className={sectionLabel}>{exact ? 'Expected answer' : 'Criteria'}</h4>
        {card.grader.type === 'exact' ? (
          <pre className={codeBlock}>{fieldText(card.grader.expected)}</pre>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {card.grader.criteria.map((criterion, i) => (
              <li key={i}>{criterion}</li>
            ))}
          </ul>
        )}
      </div>
      {card.grader.type === 'criteria' && card.grader.reference != null && (
        <details className="group/reference text-sm">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 transition-transform group-open/reference:rotate-90"
            />
            Reference answer
          </summary>
          <p className="mt-1.5 pl-5 whitespace-pre-wrap">{fieldText(card.grader.reference)}</p>
        </details>
      )}
      {unconfirmed && (
        <div
          data-tone="warning"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm"
        >
          <p className="min-w-0 flex-1 basis-80">
            Held-out tasks catch regressions and are never shown to the optimizer, so a person
            confirms the {exact ? 'expected answer' : 'criteria'} before the task counts. Review
            this task and confirm it.
          </p>
          {edit && (
            <Button
              size="sm"
              onClick={() => run({ action: 'edit', id: card.taskId, body: { confirm: true } })}
            >
              {exact ? 'Confirm expected answer' : 'Confirm criteria'}
            </Button>
          )}
        </div>
      )}
      {edit && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => run({ action: 'try', id: card.taskId })}>
              Try task
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={editing}
              aria-controls={elementId + '-edit'}
              onClick={() => setEditing((open) => !open)}
            >
              Edit task
            </Button>
            {recheck && checkFailed(card) && (
              <Button variant="outline" size="sm" onClick={() => recheck(card.taskId)}>
                Run check again
              </Button>
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={more}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`More actions for task ${short}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-40">
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  Delete task
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog
              open={deleting}
              onOpenChange={setDeleting}
              label="Delete task"
              description="Retire this task from future rounds. Past rounds keep their original task revision."
              destructive
              returnFocusRef={more}
              onConfirm={() => run({ action: 'retire', id: card.taskId })}
            />
          </div>
          {editing && (
            <form
              id={elementId + '-edit'}
              aria-label={`Edit task ${short}`}
              className="space-y-4 rounded-md border bg-muted/20 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                try {
                  const input = readField(data, 'input', card.input);
                  const value = String(data.get('value'));
                  const grader: TaskCard['grader'] =
                    card.grader.type === 'exact'
                      ? { type: 'exact', expected: readField(data, 'value', card.grader.expected) }
                      : {
                          type: 'criteria',
                          criteria: lines(value),
                          ...(String(data.get('reference') ?? '').trim()
                            ? { reference: readField(data, 'reference', card.grader.reference) }
                            : {}),
                        };
                  setError('');
                  run({
                    action: 'edit',
                    id: card.taskId,
                    body: { input, grader },
                  });
                } catch {
                  setError('Keep structured inputs and answers in valid JSON.');
                }
              }}
            >
              <Field label="Task input" htmlFor={elementId + '-input'}>
                <Textarea
                  id={elementId + '-input'}
                  name="input"
                  defaultValue={fieldText(card.input)}
                  required
                />
              </Field>
              <Field
                label={exact ? 'Expected answer' : 'Criteria (one per line)'}
                htmlFor={elementId + '-value'}
              >
                <Textarea
                  id={elementId + '-value'}
                  name="value"
                  defaultValue={
                    card.grader.type === 'exact'
                      ? fieldText(card.grader.expected)
                      : card.grader.criteria.join('\n')
                  }
                  required
                />
              </Field>
              {card.grader.type === 'criteria' && (
                <Field label="Reference answer (optional)" htmlFor={elementId + '-reference'}>
                  <Textarea
                    id={elementId + '-reference'}
                    name="reference"
                    defaultValue={fieldText(card.grader.reference)}
                  />
                </Field>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button>Save task</Button>
              </div>
            </form>
          )}
        </>
      )}
      {trial?.taskId === card.taskId && (
        <section
          aria-label="Trial result"
          className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm"
          role="status"
        >
          <h3 className="font-medium">
            Trial ·{' '}
            {trial.status === 'failed'
              ? 'Executor error'
              : trial.status === 'pending'
                ? 'Waiting for executor'
                : 'Completed'}
          </h3>
          {trial.status === 'failed' && (
            <p>
              {describeTrialError(trial.error?.code)}
              {trial.error?.code && <> Error code: {trial.error.code}.</>}
            </p>
          )}
          {trial.verdict && (
            <>
              <p>
                {trial.verdict.passed ? 'Passed' : 'Failed'}
                {typeof trial.verdict.score === 'number' &&
                  ' · ' + scoreText(trial.verdict.score)}{' '}
                · Judge reasoning
              </p>
              <pre className={codeBlock}>{pretty(trial.verdict.reasons)}</pre>
              <p className={sectionLabel}>Output</p>
              <pre className={codeBlock}>{fieldText(trial.output)}</pre>
              <details>
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Gateway log
                </summary>
                <pre className={codeBlock + ' mt-1.5'}>{pretty(trial.gatewayLog)}</pre>
              </details>
            </>
          )}
        </section>
      )}
      {children}
    </article>
  );
}
const lines = (value: string) =>
  value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const fieldText = (value: unknown) => (typeof value === 'string' ? value : pretty(value));
function readField(data: FormData, name: string, original: unknown) {
  const value = String(data.get(name) ?? '');
  return original === undefined || typeof original === 'string' ? value : JSON.parse(value);
}

/** A file chooser in a drop zone that shows the chosen file name. */
function FilePicker({
  id,
  name,
  accept,
  describedBy,
  fileName,
  onFileName,
}: {
  id: string;
  name: string;
  accept: string;
  describedBy: string;
  fileName: string;
  onFileName: (name: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || !input.current) return;
    const files = new DataTransfer();
    files.items.add(file);
    input.current.files = files.files;
    onFileName(file.name);
  };
  return (
    <div
      className={
        'flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4 transition-colors has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/30 ' +
        (dragging ? 'border-ring bg-muted/60' : 'bg-muted/20')
      }
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <input
        ref={input}
        id={id}
        name={name}
        type="file"
        accept={accept}
        className="sr-only"
        aria-describedby={describedBy}
        onChange={(e) => onFileName(e.currentTarget.files?.[0]?.name ?? '')}
      />
      <FileUp aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <Button
        type="button"
        variant="outline"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => input.current?.click()}
      >
        Choose file
      </Button>
      <span className="min-w-0 truncate text-sm" aria-hidden="true">
        {fileName || (
          <span className="text-muted-foreground">No file chosen, or drop one here</span>
        )}
      </span>
    </div>
  );
}

function ImportMaterial({
  scope,
  job,
  writing,
  writeRef,
  onWrite,
  setBusy,
  report,
  onImported,
}: {
  scope: LearningScope;
  job?: ImportStatus;
  writing: boolean;
  writeRef: RefObject<HTMLButtonElement | null>;
  onWrite: () => void;
  setBusy: (busy: boolean) => void;
  report: (message: string) => void;
  onImported: (job: ImportStatus) => Promise<void>;
}) {
  const [fileName, setFileName] = useState('');
  const setAside = job
    ? (job.setAsideCount ??
      (Array.isArray(job.setAside) ? job.setAside.length : (job.setAside ?? 0)))
    : 0;
  return (
    <Panel
      title="Import material"
      description="Turn past requests and answers into tasks. Each row or conversation becomes one task."
      actions={
        <Button
          ref={writeRef}
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={writing}
          aria-controls="learning-write-task"
          onClick={onWrite}
        >
          Write a task
        </Button>
      }
      footer={
        <>
          <span className="panel-footer-note" role="status">
            {job &&
              `${job.rows} rows · ${job.converted} converted · ${job.pending} pending · ${setAside} set aside`}
          </span>
          <Button type="submit" form="learning-import-form">
            Import tasks
          </Button>
        </>
      }
    >
      <form
        id="learning-import-form"
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const file = data.get('file') as File;
          const paste = String(data.get('paste')).trim();
          if (file.size > maxImportBytes) {
            report('Imports must fit in 64 MiB.');
            return;
          }
          if (Boolean(file?.size) === Boolean(paste)) {
            report('Choose a file or paste conversations, not both.');
            return;
          }
          const format = file?.size
            ? mediaTypes[file.name.split('.').at(-1)!.toLowerCase()]
            : 'text/plain';
          if (!format) {
            report('Choose an XLSX, CSV, JSONL or text file.');
            return;
          }
          try {
            setBusy(true);
            report('');
            const params = new URLSearchParams({
              ...scope,
              filename: file.size ? file.name : 'conversations.txt',
            });
            const response = await fetch('/learning-import?' + params, {
              method: 'POST',
              headers: { 'content-type': format },
              body: file.size ? file : paste,
            });
            if (!response.ok)
              throw Error(
                (await response.json().catch(() => null))?.error?.message || 'Import failed.',
              );
            const next: ImportStatus = await response.json();
            form.reset();
            setFileName('');
            await onImported(next);
          } catch (e) {
            report(e instanceof Error ? e.message : 'Could not import material.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Spreadsheet, CSV or JSONL"
          htmlFor="learning-file"
          hint="XLSX, CSV, JSONL or text, up to 64 MiB."
        >
          <FilePicker
            id="learning-file"
            name="file"
            accept=".xlsx,.csv,.jsonl,.txt"
            describedBy="learning-file-hint"
            fileName={fileName}
            onFileName={setFileName}
          />
        </Field>
        <Field label={pasteLabel} htmlFor="learning-paste" hint={pasteHelp}>
          <Textarea
            id="learning-paste"
            name="paste"
            className="min-h-28 font-mono text-sm"
            placeholder={pastePlaceholder}
            aria-describedby="learning-paste-hint"
          />
        </Field>
      </form>
      {job?.status === 'failed' && (
        <p role="alert" data-tone="danger" className="rounded-md border px-3 py-2 text-sm">
          {job.message || 'Import failed.'}
        </p>
      )}
      {Array.isArray(job?.setAside) && job.setAside.length > 0 && (
        <ul aria-label="Set-aside rows" className="space-y-1 text-sm">
          {job.setAside.map(({ row, source, reason }) => (
            <li key={source + ':' + row}>
              {source} · Row {row}: {describeLearning(reason)}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function WriteTask({
  run,
  onClose,
}: {
  run: (data: CentralCommand) => Promise<boolean>;
  onClose: () => void;
}) {
  const [graderType, setGraderType] = useState('criteria');
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <Panel
      id="learning-write-task"
      title="Write a task"
      description="Add one task by hand. Use an expected answer for a value that must match, or criteria for free text."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="learning-write-task-form">
            Create task
          </Button>
        </>
      }
    >
      <form
        id="learning-write-task-form"
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const ok = await run({
            action: 'create',
            body: {
              input: String(data.get('input')),
              grader:
                graderType === 'exact'
                  ? { type: 'exact', expected: String(data.get('answer')) }
                  : {
                      type: 'criteria',
                      criteria: lines(String(data.get('answer'))),
                      ...(data.get('reference')
                        ? { reference: String(data.get('reference')) }
                        : {}),
                    },
            },
          });
          if (ok) form.reset();
        }}
      >
        <Field label="Task input" htmlFor="write-task-input">
          <Textarea ref={first} id="write-task-input" name="input" required />
        </Field>
        <Field label="Grading method" htmlFor="write-task-method">
          <NativeSelect
            id="write-task-method"
            className="w-full sm:w-72"
            value={graderType}
            onChange={(e) => setGraderType(e.target.value)}
          >
            <option value="criteria">Check criteria</option>
            <option value="exact">Match an expected answer</option>
          </NativeSelect>
        </Field>
        <Field
          label={graderType === 'exact' ? 'Expected answer' : 'Criteria (one per line)'}
          htmlFor="write-task-answer"
        >
          <Textarea id="write-task-answer" name="answer" required />
        </Field>
        {graderType === 'criteria' && (
          <Field label="Reference answer (optional)" htmlFor="write-task-reference">
            <Textarea id="write-task-reference" name="reference" />
          </Field>
        )}
      </form>
    </Panel>
  );
}

const tokens = new Intl.NumberFormat('en-US');

export function LearningTasks({
  scope,
  rounds,
  edit,
  refresh,
}: {
  scope: LearningScope;
  rounds: string[];
  edit: boolean;
  refresh: () => Promise<void>;
}) {
  const { workspaceId, bundleId } = scope;
  const [cards, setCards] = useState<TaskCard[]>();
  const [usage, setUsage] = useState<Usage[]>();
  const [job, setJob] = useState<ImportStatus>();
  const [trial, setTrial] = useState<CardTrial>();
  const [busy, setBusy] = useState(false);
  const [error, report] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [admission, setAdmission] = useState('');
  const [interval, setIntervalMs] = useState(3000);
  const [source, setSource] = useState('');
  const [split, setSplit] = useState<SplitFilter>('');
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const [focus, setFocus] = useState<string>();
  const [writing, setWriting] = useState(false);
  const writeButton = useRef<HTMLButtonElement>(null);
  const filters = { split, admission, source, flagged, needsConfirmation: confirming };
  const visible = cards ? filterCards(cards, filters) : [];
  const lastPage = Math.max(0, Math.ceil(visible.length / pageSize) - 1);
  const currentPage = Math.min(lastPage, page);
  const shown = visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const toConfirm = shown.filter(awaitsConfirmation).map((c) => c.taskId);
  const failedChecks = cards?.filter(checkFailed).length ?? 0;
  const [revision, reload] = useState(0);
  const load = useCallback(
    <T,>(data: Parameters<typeof taskReviewRequest>[0]) => taskReviewRequest<T>(data),
    [],
  );
  useEffect(() => {
    let active = true;
    const target = { workspaceId, bundleId };
    void Promise.all([
      learningRequest<TaskCard[]>({ ...target, action: 'tasks' }),
      learningRequest<{ items: Usage[] }>({ ...target, action: 'usage' }),
    ]).then(
      ([tasks, days]) => {
        if (active) {
          setCards(tasks);
          setUsage(days.items);
        }
      },
      () => {
        if (active) report('Could not load tasks or usage.');
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId, bundleId, revision]);
  // Follow `#task-<id>` and `?task=<id>` links once the cards are loaded.
  const loaded = cards !== undefined;
  const scrolled = useRef<string>(undefined);
  useEffect(() => {
    if (!loaded) return;
    const follow = () => {
      scrolled.current = undefined;
      setFocus(linkedTask(window.location));
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [loaded]);
  useEffect(() => {
    if (!focus || !cards) return;
    let index = visible.findIndex((c) => c.taskId === focus);
    if (index < 0 && cards.some((c) => c.taskId === focus)) {
      // The linked task is hidden by a filter: clear the filters so it can be shown.
      setSplit('');
      setAdmission('');
      setSource('');
      setFlagged(false);
      setConfirming(false);
      index = cards.findIndex((c) => c.taskId === focus);
    }
    if (index < 0) {
      setNotice(
        `Task ${shortTaskId(focus)} was not found. It may have been deleted. Check the task ID in the link.`,
      );
      setFocus(undefined);
      return;
    }
    setPage(Math.floor(index / pageSize));
    // Place the linked task once per link, so polling does not move the page again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, loaded]);
  const focusShown = Boolean(focus) && shown.some((c) => c.taskId === focus);
  useEffect(() => {
    if (!focus || !focusShown || scrolled.current === focus) return;
    scrolled.current = focus;
    const element = document.getElementById(taskElementId(focus));
    element?.scrollIntoView({ block: 'start' });
    element?.focus({ preventScroll: true });
  }, [focus, focusShown]);
  const { trialId, importId, enabled } = pendingTaskReads(trial, job, cards);
  useBackgroundRefresh(
    async () => {
      try {
        if (trialId) {
          const next = await learningRequest<Trial>({ ...scope, action: 'trial', id: trialId });
          setTrial((current) =>
            current && current.trialId === trialId ? { ...next, taskId: current.taskId } : current,
          );
        }
        let reloadCards = cards?.some((card) => card.admission === 'pending');
        if (importId) {
          const next = await learningRequest<ImportStatus>({
            ...scope,
            action: 'progress',
            id: importId,
          });
          setJob((current) => (current?.importId === importId ? next : current));
          if (job?.pending !== next.pending || job?.status !== next.status) {
            reloadCards = true;
          }
        }
        if (reloadCards) setCards(await learningRequest<TaskCard[]>({ ...scope, action: 'tasks' }));
      } finally {
        setIntervalMs((n) => Math.min(30000, n * 2));
      }
    },
    { enabled, interval, allowScroll: true, allowButtonFocus: true },
  );
  async function run(data: CentralCommand) {
    setBusy(true);
    report('');
    try {
      const request = { ...scope, ...data };
      if (data.action === 'try') {
        const result = await learningRequest<{ trialId: string }>(request);
        setIntervalMs(3000);
        setTrial({ taskId: data.id, trialId: result.trialId, status: 'pending' });
      } else if (data.action === 'export') {
        const result = await learningRequest<unknown>(request);
        const url = URL.createObjectURL(new Blob([pretty(result)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'held-out-tasks.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else await learningRequest(request);
      if (!['try', 'export'].includes(data.action)) {
        reload((n) => n + 1);
        await refresh();
      }
      return true;
    } catch (e) {
      report(e instanceof Error ? e.message : 'Request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function review(data: TaskReviewCommand) {
    setBusy(true);
    report('');
    setNotice('');
    try {
      const request = { workspaceId, bundleId, ...data };
      if (data.action === 'confirm') {
        setNotice(confirmationSummary(await taskReviewRequest<Confirmation>(request)));
      } else if (data.action === 'recheck') {
        await taskReviewRequest(request);
        setNotice(recheckQueued);
      } else if (data.action === 'recheckAll') {
        const result = await taskReviewRequest<{ taskIds: string[] }>(request);
        setNotice(recheckSummary(result.taskIds.length));
      }
      setIntervalMs(3000);
      reload((n) => n + 1);
      await refresh();
    } catch (e) {
      report(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  const admitted = cards?.filter((t) => t.admission === 'admitted').length ?? 0;
  const setAside = cards?.filter((t) => t.admission === 'set-aside').length ?? 0;
  return (
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      {error && (
        <p role="alert" data-tone="danger" className="rounded-lg border px-4 py-3 text-sm">
          {error}
        </p>
      )}
      {edit && (
        <div className="space-y-4">
          <ImportMaterial
            scope={scope}
            job={job}
            writing={writing}
            writeRef={writeButton}
            onWrite={() => setWriting((open) => !open)}
            setBusy={setBusy}
            report={report}
            onImported={async (next) => {
              setJob(next);
              setIntervalMs(3000);
              reload((n) => n + 1);
              await refresh();
            }}
          />
          {writing && (
            <WriteTask
              run={run}
              onClose={() => {
                setWriting(false);
                writeButton.current?.focus();
              }}
            />
          )}
        </div>
      )}
      <LearningImports
        scope={{ workspaceId, bundleId }}
        revision={`${revision}:${job?.importId}:${job?.status}:${job?.pending}`}
        load={load}
      />
      <Panel
        title="Tasks"
        description={cards ? `${admitted} admitted · ${setAside} set aside` : undefined}
        flush
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void run({ action: 'export' })}>
              Export held-out tasks
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                report('');
                reload((n) => n + 1);
                void refresh().catch(() => report('Could not refresh learning status.'));
              }}
            >
              Refresh tasks
            </Button>
          </>
        }
      >
        <div role="group" aria-label="Filter tasks" className="list-toolbar">
          <div className="flex min-h-9 items-center gap-2">
            <label htmlFor="task-filter-split" className="text-sm text-muted-foreground">
              Split
            </label>
            <NativeSelect
              id="task-filter-split"
              value={split}
              onChange={(e) => {
                setSplit(e.target.value as SplitFilter);
                setPage(0);
              }}
            >
              <option value="">All splits</option>
              <option value="evolve">Evolve</option>
              <option value="held-out">Held-out</option>
            </NativeSelect>
          </div>
          <div className="flex min-h-9 items-center gap-2">
            <Checkbox
              id="task-filter-confirmation"
              checked={confirming}
              onCheckedChange={(checked) => {
                setConfirming(checked === true);
                setPage(0);
              }}
            />
            <label htmlFor="task-filter-confirmation" className="text-sm">
              Needs confirmation
            </label>
          </div>
          <div className="flex min-h-9 items-center gap-2">
            <Checkbox
              id="task-filter-flagged"
              checked={flagged}
              onCheckedChange={(checked) => {
                setFlagged(checked === true);
                setPage(0);
              }}
            />
            <label htmlFor="task-filter-flagged" className="text-sm">
              Flagged only
            </label>
          </div>
          <div className="flex min-h-9 items-center gap-2">
            <label htmlFor="task-filter-admission" className="text-sm text-muted-foreground">
              Admission
            </label>
            <NativeSelect
              id="task-filter-admission"
              value={admission}
              onChange={(e) => {
                setAdmission(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All tasks</option>
              <option value="admitted">Admitted</option>
              <option value="pending">Pending</option>
              <option value="set-aside">Set aside</option>
            </NativeSelect>
          </div>
          <div className="flex min-h-9 items-center gap-2">
            <label htmlFor="task-filter-source" className="text-sm text-muted-foreground">
              Task source
            </label>
            <NativeSelect
              id="task-filter-source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All sources</option>
              <option value="import">Imported</option>
              <option value="console">Console</option>
            </NativeSelect>
          </div>
        </div>
        <div className="grid gap-3 p-4">
          {notice && (
            <p role="status" data-tone="info" className="rounded-md border px-3 py-2 text-sm">
              {notice}
            </p>
          )}
          {edit && (toConfirm.length > 0 || failedChecks > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {toConfirm.length > 0 && (
                <LearningConfirm
                  label="Confirm all shown"
                  description={confirmAllDescription(toConfirm.length)}
                  onConfirm={() => void review({ action: 'confirm', taskIds: toConfirm })}
                />
              )}
              {failedChecks > 0 && (
                <Button variant="outline" onClick={() => void review({ action: 'recheckAll' })}>
                  Run all failed checks again
                </Button>
              )}
            </div>
          )}
          {!cards ? (
            <p className="text-sm text-muted-foreground">Loading tasks…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{emptyListText(filters)}</p>
          ) : (
            shown.map((card) => (
              <TaskEditor
                key={card.taskId + ':' + card.addedRevision}
                trial={trial}
                card={card}
                edit={edit}
                focused={focus === card.taskId}
                run={(data) => void run(data)}
                recheck={(id) => void review({ action: 'recheck', id })}
              >
                {card.flagReason && (
                  <LearningEvidence scope={scope} roundIds={rounds} taskId={card.taskId} />
                )}
              </TaskEditor>
            ))
          )}
          {lastPage > 0 && (
            <nav
              aria-label="Task pages"
              className="flex flex-wrap items-center justify-between gap-3 pt-1"
            >
              <Button
                variant="outline"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous tasks
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {currentPage + 1} of {lastPage + 1}
              </span>
              <Button
                variant="outline"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                Next tasks
              </Button>
            </nav>
          )}
        </div>
      </Panel>
      <Panel
        title="Daily usage"
        description="Rounds, rollouts and model tokens for each UTC day."
        flush
      >
        {!usage ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading usage…</p>
        ) : usage.length ? (
          <ul className="divide-y text-sm">
            {usage.map((d) => (
              <li
                key={d.day}
                className="data-value flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2"
              >
                <span className="font-medium">{d.day} UTC</span>
                <span className="text-muted-foreground">
                  {d.rounds} rounds · {d.rollouts} rollouts ·{' '}
                  {tokens.format(d.optimizerTokens + d.taskTokens + d.judgeTokens)} tokens
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">No usage recorded.</p>
        )}
      </Panel>
    </fieldset>
  );
}
