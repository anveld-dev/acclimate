import { useState, useEffect } from 'react';
import type { LearningScope } from '../lib/learning';
import {
  mediaTypes,
  type CentralRequest,
  type TaskCard,
  type Trial,
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
}: {
  card: TaskCard;
  edit: boolean;
  run: (data: Partial<CentralRequest> & Pick<CentralRequest, 'action'>) => void;
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
        {card.admission}
      </p>
      {card.flagReason && <p>Flagged · {card.flagReason}</p>}
      {card.admissionReason && <p>{card.admissionReason.replaceAll('-', ' ')}</p>}
      <h4>Input</h4>
      <pre className="whitespace-pre-wrap break-words">{pretty(card.input)}</pre>
      <h4>{card.grader.type === 'exact' ? 'Expected answer' : 'Criteria'}</h4>
      <pre className="whitespace-pre-wrap break-words">
        {pretty(card.grader.type === 'exact' ? card.grader.expected : card.grader.criteria)}
      </pre>
      {edit && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => run({ action: 'try', id: card.taskId })}>
              Try task
            </Button>
            {card.split === 'held-out' && card.grader.type === 'criteria' && !card.confirmedBy && (
              <Button
                onClick={() =>
                  run({ action: 'edit', id: card.taskId, payload: '{"confirm":true}' })
                }
              >
                Confirm criteria
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                if (window.confirm('Retire this task?')) run({ action: 'retire', id: card.taskId });
              }}
            >
              Delete task
            </Button>
          </div>
          <details>
            <summary>Edit task</summary>
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                try {
                  const input = JSON.parse(String(data.get('input')));
                  const value = JSON.parse(String(data.get('value')));
                  const grader =
                    card.grader.type === 'exact'
                      ? { type: 'exact', expected: value }
                      : { ...card.grader, criteria: value };
                  setError('');
                  run({
                    action: 'edit',
                    id: card.taskId,
                    payload: JSON.stringify({ input, grader }),
                  });
                } catch {
                  setError('Enter valid JSON for both fields.');
                }
              }}
            >
              <label>
                Input JSON
                <textarea
                  className={field}
                  name="input"
                  defaultValue={pretty(card.input)}
                  required
                />
              </label>
              <label>
                {card.grader.type === 'exact' ? 'Expected answer JSON' : 'Criteria JSON array'}
                <textarea
                  className={field}
                  name="value"
                  defaultValue={pretty(
                    card.grader.type === 'exact' ? card.grader.expected : card.grader.criteria,
                  )}
                  required
                />
              </label>
              <Button>Save task</Button>
              {error && <p role="alert">{error}</p>}
            </form>
          </details>
        </>
      )}
    </article>
  );
}
async function readCards(scope: LearningScope) {
  const cards: TaskCard[] = [];
  let id: string | undefined;
  do {
    const page = await learningRequest<{ items: TaskCard[]; next: string | null }>({
      ...scope,
      action: 'tasks',
      id,
    });
    cards.push(...page.items);
    id = page.next ?? undefined;
  } while (id);
  return cards;
}
function encoded(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Error('Could not read file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
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
  const [trial, setTrial] = useState<Trial>();
  const [busy, setBusy] = useState(false);
  const [error, report] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [source, setSource] = useState('');
  const [page, setPage] = useState(0);
  const visible =
    cards?.filter((c) => (!flagged || c.flagReason) && (!source || source === c.source)) ?? [];
  const lastPage = Math.max(0, Math.ceil(visible.length / 10) - 1);
  const currentPage = Math.min(lastPage, page);
  const [revision, reload] = useState(0);
  useEffect(() => {
    let active = true;
    const target = { workspaceId, bundleId };
    void Promise.all([
      readCards(target),
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
  const trialId = trial?.status === 'pending' ? trial.trialId : undefined;
  const importId = job?.pending ? job.importId : undefined;
  useEffect(() => {
    const pending = trialId || importId || cards?.some((card) => card.admission === 'pending');
    let active = true;
    const timer = setTimeout(
      async () => {
        try {
          const target = { workspaceId, bundleId };
          const [t, j] = await Promise.all([
            trialId ? learningRequest<Trial>({ ...target, action: 'trial', id: trialId }) : null,
            importId
              ? learningRequest<ImportStatus>({ ...target, action: 'progress', id: importId })
              : null,
          ]);
          if (active) {
            if (t) setTrial(t);
            if (j) setJob(j);
            reload((n) => n + 1);
            await refresh();
          }
        } catch {
          if (active) report('Could not refresh learning progress.');
        }
      },
      pending ? 3000 : 30000,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trialId, importId, cards, workspaceId, bundleId, refresh]);
  async function run(data: Partial<CentralRequest> & Pick<CentralRequest, 'action'>) {
    setBusy(true);
    report('');
    try {
      const request = { ...scope, ...data };
      if (data.action === 'try') {
        const result = await learningRequest<{ trialId: string }>(request);
        setTrial({ trialId: result.trialId, status: 'pending' });
      } else if (data.action === 'import') setJob(await learningRequest<ImportStatus>(request));
      else if (data.action === 'export') {
        const result = await learningRequest<unknown>(request);
        const url = URL.createObjectURL(new Blob([pretty(result)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'held-out-tasks.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else await learningRequest(request);
      reload((n) => n + 1);
      await refresh();
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
              const data = new FormData(e.currentTarget);
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
                await run({
                  action: 'import',
                  mediaType: format,
                  filename: file?.size ? file.name : 'conversations.txt',
                  payload: await encoded(file?.size ? file : new Blob([paste])),
                });
              } catch {
                report('Could not read material.');
              }
            }}
          >
            <label htmlFor="learning-file">
              Spreadsheet, CSV or JSONL
              <Input id="learning-file" name="file" type="file" accept=".xlsx,.csv,.jsonl,.txt" />
            </label>
            <label>
              Paste conversations
              <textarea name="paste" className={field} />
            </label>
            <Button>Import tasks</Button>
          </form>
          {job && (
            <p role="status">
              {job.rows} rows · {job.converted} converted · {job.pending} pending ·{' '}
              {job.setAside ?? 0} set aside
            </p>
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
                  payload: JSON.stringify({
                    input: String(data.get('input')),
                    grader: { type: 'exact', expected: String(data.get('answer')) },
                  }),
                });
                if (ok) form.reset();
              }}
            >
              <label>
                Task input
                <textarea className={field} name="input" required />
              </label>
              <label>
                Expected answer
                <textarea className={field} name="answer" required />
              </label>
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
          <label>
            <input
              type="checkbox"
              checked={flagged}
              onChange={(e) => {
                setFlagged(e.target.checked);
                setPage(0);
              }}
            />{' '}
            Flagged only
          </label>
          <label>
            Task source
            <select
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
            </select>
          </label>
          <Button variant="outline" onClick={() => void run({ action: 'export' })}>
            Export held-out tasks
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              report('');
              reload((n) => n + 1);
            }}
          >
            Refresh tasks
          </Button>
        </div>
        {trial && (
          <section
            aria-label="Trial result"
            className="space-y-2 rounded-md border p-3"
            role="status"
          >
            <h3>Trial · {trial.status === 'failed' ? 'Executor error' : trial.status}</h3>
            {trial.verdict && (
              <>
                <p>{trial.verdict.passed ? 'Passed' : 'Failed'} · Judge reasoning</p>
                <pre className="whitespace-pre-wrap">{pretty(trial.verdict.reasons)}</pre>
                <p>Output</p>
                <pre className="whitespace-pre-wrap">{trial.output}</pre>
                <details>
                  <summary>Gateway log</summary>
                  <pre className="whitespace-pre-wrap">{pretty(trial.gatewayLog)}</pre>
                </details>
              </>
            )}
          </section>
        )}
        {!cards ? (
          'Loading tasks…'
        ) : visible.length === 0 ? (
          <p>
            {flagged
              ? 'No flagged tasks.'
              : source
                ? 'No tasks from this source.'
                : 'No tasks yet.'}
          </p>
        ) : (
          visible.slice(currentPage * 10, (currentPage + 1) * 10).map((card) => (
            <div key={card.taskId + ':' + card.addedRevision}>
              <TaskEditor card={card} edit={edit} run={(data) => void run(data)} />
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
