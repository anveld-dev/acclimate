import { LearningConfirm } from './learning-confirm';
import { useBackgroundRefresh } from './use-background-refresh';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { useState, useEffect } from 'react';
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
import { LearningEvidence } from './learning-evidence';
import { Button } from './ui/button';
import { Input } from './ui/input';
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const field = 'w-full rounded-md border bg-background p-2';
export function TaskEditor({
  card,
  edit,
  run,
  trial,
}: {
  trial?: CardTrial;
  card: TaskCard;
  edit: boolean;
  run: (data: CentralCommand) => void;
}) {
  const [error, setError] = useState('');
  return (
    <article className="space-y-2 rounded-md border p-4">
      <p className="text-sm">
        {card.source === 'outcome'
          ? 'Production outcome'
          : card.source === 'import'
            ? 'Imported'
            : 'Console'}{' '}
        {card.sourceFile} {card.sourceRow && '· row ' + card.sourceRow} · {card.split} ·{' '}
        {describeLearning(card.admission)}
      </p>
      {card.flagReason && <p>{describeLearning(card.flagReason)}</p>}
      {card.admissionReason && <p>{describeLearning(card.admissionReason)}</p>}
      <h4>Input</h4>
      <pre className="whitespace-pre-wrap break-words">{fieldText(card.input)}</pre>
      <h4>{card.grader.type === 'exact' ? 'Expected answer' : 'Criteria'}</h4>
      {card.grader.type === 'exact' ? (
        <pre className="whitespace-pre-wrap break-words">{fieldText(card.grader.expected)}</pre>
      ) : (
        <ul className="list-disc pl-5">
          {card.grader.criteria.map((criterion, i) => (
            <li key={i}>{criterion}</li>
          ))}
        </ul>
      )}
      {card.grader.type === 'criteria' && card.grader.reference != null && (
        <p>Reference answer: {fieldText(card.grader.reference)}</p>
      )}
      {card.split === 'held-out' && !card.confirmedBy && (
        <p>Review and confirm this held-out task before it can count toward learning.</p>
      )}
      {edit && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => run({ action: 'try', id: card.taskId })}>
              Try task
            </Button>
            {card.split === 'held-out' && !card.confirmedBy && (
              <Button
                onClick={() => run({ action: 'edit', id: card.taskId, body: { confirm: true } })}
              >
                {card.grader.type === 'criteria' ? 'Confirm criteria' : 'Confirm expected answer'}
              </Button>
            )}
            <LearningConfirm
              label="Delete task"
              description="Retire this task from future rounds. Past rounds keep their original task revision."
              onConfirm={() => run({ action: 'retire', id: card.taskId })}
            />
          </div>
          <details>
            <summary>Edit task</summary>
            <form
              className="grid gap-2"
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
              <Label>
                Task input
                <Textarea
                  className={field}
                  name="input"
                  defaultValue={fieldText(card.input)}
                  required
                />
              </Label>
              <Label>
                {card.grader.type === 'exact' ? 'Expected answer' : 'Criteria (one per line)'}
                <Textarea
                  className={field}
                  name="value"
                  defaultValue={
                    card.grader.type === 'exact'
                      ? fieldText(card.grader.expected)
                      : card.grader.criteria.join('\n')
                  }
                  required
                />
              </Label>
              {card.grader.type === 'criteria' && (
                <Label>
                  Reference answer (optional)
                  <Textarea name="reference" defaultValue={fieldText(card.grader.reference)} />
                </Label>
              )}
              <Button>Save task</Button>
              {error && <p role="alert">{error}</p>}
            </form>
          </details>
        </>
      )}
      {trial?.taskId === card.taskId && (
        <section
          aria-label="Trial result"
          className="space-y-2 rounded-md border p-3"
          role="status"
        >
          <h3>
            Trial ·{' '}
            {trial.status === 'failed'
              ? 'Executor error'
              : trial.status === 'pending'
                ? 'Waiting for executor'
                : 'Completed'}
          </h3>
          {trial.verdict && (
            <>
              <p>{trial.verdict.passed ? 'Passed' : 'Failed'} · Judge reasoning</p>
              <pre className="whitespace-pre-wrap break-words">{pretty(trial.verdict.reasons)}</pre>
              <p>Output</p>
              <pre className="whitespace-pre-wrap break-words">{fieldText(trial.output)}</pre>
              <details>
                <summary>Gateway log</summary>
                <pre className="whitespace-pre-wrap break-words">{pretty(trial.gatewayLog)}</pre>
              </details>
            </>
          )}
        </section>
      )}
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
  const [graderType, setGraderType] = useState('criteria');
  const [interval, setIntervalMs] = useState(3000);
  const [source, setSource] = useState('');
  const [page, setPage] = useState(0);
  const visible =
    cards?.filter(
      (c) =>
        (!admission || c.admission === admission) &&
        (!flagged || c.flagReason) &&
        (!source || source === c.source),
    ) ?? [];
  const lastPage = Math.max(0, Math.ceil(visible.length / 10) - 1);
  const currentPage = Math.min(lastPage, page);
  const [revision, reload] = useState(0);
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
  const { trialId, importId, enabled } = pendingTaskReads(trial, job);
  useBackgroundRefresh(
    async () => {
      try {
        if (trialId) {
          const next = await learningRequest<Trial>({ ...scope, action: 'trial', id: trialId });
          setTrial((current) =>
            current && current.trialId === trialId ? { ...next, taskId: current.taskId } : current,
          );
        }
        if (importId) {
          const next = await learningRequest<ImportStatus>({
            ...scope,
            action: 'progress',
            id: importId,
          });
          setJob((current) => (current?.importId === importId ? next : current));
          if (job?.pending !== next.pending || job?.status !== next.status) {
            setCards(await learningRequest<TaskCard[]>({ ...scope, action: 'tasks' }));
          }
        }
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
  return (
    <fieldset disabled={busy} className="min-w-0 space-y-5">
      {error && (
        <p role="alert" className="workspace-panel p-4">
          {error}
        </p>
      )}
      {edit && (
        <section className="workspace-panel space-y-3 p-5">
          <h2 className="font-semibold">Import material</h2>
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const data = new FormData(form);
              const file = data.get('file') as File;
              const paste = String(data.get('paste')).trim();
              if (file.size > 64 * 1024 * 1024) {
                report('Imports must fit in 64 MiB.');
                return;
              }
              if (Boolean(file?.size) === Boolean(paste)) {
                report('Choose one file or paste conversations.');
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
                setJob(await response.json());
                setIntervalMs(3000);
                form.reset();
                reload((n) => n + 1);
                await refresh();
              } catch (e) {
                report(e instanceof Error ? e.message : 'Could not import material.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <Label htmlFor="learning-file">
              Spreadsheet, CSV or JSONL
              <Input id="learning-file" name="file" type="file" accept=".xlsx,.csv,.jsonl,.txt" />
            </Label>
            <Label>
              Paste conversations
              <Textarea name="paste" className={field} />
            </Label>
            <Button>Import tasks</Button>
          </form>
          {job && (
            <p role="status">
              {job.rows} rows · {job.converted} converted · {job.pending} pending ·{' '}
              {job.setAsideCount ??
                (Array.isArray(job.setAside) ? job.setAside.length : (job.setAside ?? 0))}{' '}
              set aside
            </p>
          )}
          {job?.status === 'failed' && <p role="alert">{job.message || 'Import failed.'}</p>}
          {Array.isArray(job?.setAside) && job.setAside.length > 0 && (
            <ul aria-label="Set-aside rows">
              {job.setAside.map(({ row, source, reason }) => (
                <li key={source + ':' + row}>
                  {source} · Row {row}: {describeLearning(reason)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="workspace-panel space-y-3 p-5">
        <h2 className="font-semibold">Tasks</h2>
        {edit && (
          <details>
            <summary>Write a task</summary>
            <form
              className="grid gap-3"
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
              <Label>
                Task input
                <Textarea className={field} name="input" required />
              </Label>
              <Label>
                Grading method
                <NativeSelect value={graderType} onChange={(e) => setGraderType(e.target.value)}>
                  <option value="criteria">Check criteria</option>
                  <option value="exact">Match an expected answer</option>
                </NativeSelect>
              </Label>
              <Label>
                {graderType === 'exact' ? 'Expected answer' : 'Criteria (one per line)'}
                <Textarea className={field} name="answer" required />
              </Label>
              {graderType === 'criteria' && (
                <Label>
                  Reference answer (optional)
                  <Textarea name="reference" />
                </Label>
              )}
              <Button>Create task</Button>
            </form>
          </details>
        )}
        {cards && (
          <p>
            {cards.filter((t) => t.admission === 'admitted').length} admitted ·{' '}
            {cards.filter((t) => t.admission === 'set-aside').length} set aside
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Label>
            <Checkbox
              checked={flagged}
              onCheckedChange={(checked) => {
                setFlagged(checked === true);
                setPage(0);
              }}
            />{' '}
            Flagged only
          </Label>
          <Label>
            Admission
            <NativeSelect
              value={admission}
              onChange={(e) => {
                setAdmission(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All tasks</option>
              {['admitted', 'pending', 'set-aside'].map((a) => (
                <option key={a} value={a}>
                  {describeLearning(a)}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label>
            Task source
            <NativeSelect
              className="block rounded border p-2"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All sources</option>
              <option value="import">Imported</option>
              <option value="outcome">Production</option>
              <option value="console">Console</option>
            </NativeSelect>
          </Label>
          <Button variant="outline" onClick={() => void run({ action: 'export' })}>
            Export held-out tasks
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              report('');
              reload((n) => n + 1);
              void refresh().catch(() => report('Could not refresh learning status.'));
            }}
          >
            Refresh tasks
          </Button>
        </div>
        {!cards ? (
          'Loading tasks…'
        ) : visible.length === 0 ? (
          <p>
            {flagged
              ? 'No flagged tasks.'
              : admission
                ? 'No tasks match this admission filter.'
                : source
                  ? 'No tasks from this source.'
                  : 'No tasks yet.'}
          </p>
        ) : (
          visible.slice(currentPage * 10, (currentPage + 1) * 10).map((card) => (
            <div key={card.taskId + ':' + card.addedRevision}>
              <TaskEditor trial={trial} card={card} edit={edit} run={(data) => void run(data)} />
              {card.flagReason && (
                <LearningEvidence scope={scope} roundIds={rounds} taskId={card.taskId} />
              )}
            </div>
          ))
        )}
        {lastPage > 0 && (
          <nav aria-label="Task pages" className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous tasks
            </Button>
            <span>
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
      </section>
      <section className="workspace-panel space-y-2 p-5">
        <h2 className="font-semibold">Daily usage</h2>
        {!usage
          ? 'Loading usage…'
          : usage.length
            ? usage.map((d) => (
                <p key={d.day}>
                  {d.day} UTC · {d.rounds} rounds · {d.rollouts} rollouts ·{' '}
                  {d.optimizerTokens + d.taskTokens + d.judgeTokens} tokens
                </p>
              ))
            : 'No usage recorded.'}
      </section>
    </fieldset>
  );
}
