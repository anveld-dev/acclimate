import { useModelProvider } from './use-model-provider';
import type { LearningRoundSummary } from '@acclimate/sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { bundleHref } from '../navigation';
import { ImprovementMemory, LearningRoundDetail } from './learning-details';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { learningRequest } from '../server/central-actions';
import { splitDeficit, type CentralRequest } from '../lib/central-learning';
import { LearningTasks } from './learning-tasks';
import { workspaceHref } from '../navigation';
import type { LearningState } from '../server/learning-core';
import { activeRoundStates } from '../lib/learning';
import type { LearningScope } from '../lib/learning';

const stateLabels: Record<LearningRoundSummary['state'], string> = {
  scoring_incumbent: 'Scoring incumbent',
  proposing: 'Proposing',
  screening: 'Screening',
  evaluating: 'Evaluating',
  selecting: 'Selecting',
  scoring_held_out: 'Scoring held-out split',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};
const score = (value: number | null) => (value === null ? '—' : String(value));
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="workspace-panel space-y-4 p-5">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ScoreCurves({ rounds }: { rounds: LearningRoundSummary[] }) {
  const completed = rounds
    .filter(({ state }) => state === 'completed')
    .sort((a, b) => a.number - b.number);
  if (!completed.some((round) => round.evolveScore !== null || round.heldOutScore !== null))
    return <p className="text-sm text-muted-foreground">Scores appear as rounds complete.</p>;
  const first = completed[0].number;
  const last = completed[completed.length - 1].number;
  const x = (number: number) =>
    first === last ? 330 : 46 + ((number - first) / (last - first)) * 568;
  const y = (value: number) => 180 - value * 156;
  const series = [
    { field: 'evolveScore', name: 'Evolve score', color: 'var(--chart-1)' },
    { field: 'heldOutScore', name: 'Held-out score (monitoring only)', color: 'var(--chart-2)' },
  ] as const;
  return (
    <div className="space-y-3">
      <svg
        viewBox="0 0 640 220"
        role="img"
        aria-label="Measured scores by completed round"
        className="w-full max-w-4xl"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((value) => (
          <g key={value}>
            <line x1="46" x2="614" y1={y(value)} y2={y(value)} stroke="var(--border)" />
            <text x="4" y={y(value) + 4} fill="currentColor" fontSize="11">
              {value}
            </text>
          </g>
        ))}
        <text x="46" y="205" fill="currentColor" fontSize="11">
          Round {first}
        </text>
        {first !== last && (
          <text x="614" y="205" textAnchor="end" fill="currentColor" fontSize="11">
            Round {last}
          </text>
        )}
        {series.map(({ field, name, color }) => (
          <g key={field} fill={color} stroke={color}>
            {completed.map((round, index) => {
              const value = round[field];
              if (value === null) return null;
              const previous = completed[index - 1];
              const previousValue = previous?.[field];
              const changed = previous && previous.taskRevision !== round.taskRevision;
              return (
                <g key={round.id}>
                  {changed && field === 'evolveScore' && (
                    <line
                      x1={x(round.number)}
                      x2={x(round.number)}
                      y1="24"
                      y2="180"
                      strokeDasharray="3 3"
                    >
                      <title>Task set changed</title>
                    </line>
                  )}
                  {!changed && previousValue != null && previous.number + 1 === round.number && (
                    <line
                      x1={x(previous.number)}
                      x2={x(round.number)}
                      y1={y(previousValue)}
                      y2={y(value)}
                      strokeWidth="2"
                    />
                  )}
                  <circle cx={x(round.number)} cy={y(value)} r="3">
                    <title>{`Round ${round.number} · ${name} · ${value}`}</title>
                  </circle>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <ul aria-label="Score series" className="flex flex-wrap gap-4 text-sm">
        {series.map(({ name, color }) => (
          <li key={name} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full"
              style={{ background: color }}
            />
            {name}
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-sm">Score data</summary>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left text-sm [&_td]:p-2 [&_th]:p-2">
            <thead>
              <tr>
                <th>Round</th>
                {series.map(({ name }) => (
                  <th key={name}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {completed.map((round) => (
                <tr key={round.id} className="border-t">
                  <th scope="row">{round.number}</th>
                  <td>{score(round.evolveScore)}</td>
                  <td>{score(round.heldOutScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function RoundList({
  rounds,
  href,
  rollback,
}: {
  rounds: LearningRoundSummary[];
  href: (id: string) => string;
  rollback?: (id: string) => void;
}) {
  const [before, setBefore] = useState<number>();
  const page = rounds.filter(({ number }) => before === undefined || number < before).slice(0, 20);
  const last = page.at(-1)?.number;
  return rounds.length ? (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm [&_th]:p-2 [&_td]:p-2">
          <thead>
            <tr>
              {[
                'Round',
                'Trigger',
                'State',
                'Decision',
                'Reason',
                'Incumbent evolve',
                'Adopted sample / version',
                'Held-out (monitoring only)',
                'Ended',
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.map((round) => (
              <tr key={round.id} className="border-t">
                <th scope="row">
                  <a className="underline" href={href(round.id)}>
                    {round.number}
                  </a>
                </th>
                <td>{round.trigger ?? '—'}</td>
                <td>{stateLabels[round.state]}</td>
                <td className="capitalize">{round.decision ?? '—'}</td>
                <td>{round.reason ?? '—'}</td>
                <td>{score(round.incumbentScore)}</td>
                <td>
                  {round.adoptedSample ?? '—'}
                  {round.adoptedVersionId && (
                    <>
                      {' '}
                      / <code>{round.adoptedVersionId}</code>
                      {rollback && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            if (
                              window.confirm(
                                'Re-release the previous version and block this version?',
                              )
                            )
                              rollback(round.id);
                          }}
                        >
                          Roll back
                        </Button>
                      )}
                    </>
                  )}
                </td>
                <td>{round.heldOutError ?? score(round.heldOutScore)}</td>
                <td>
                  {round.endedAt ? <time dateTime={round.endedAt}>{round.endedAt}</time> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        {before !== undefined && (
          <Button variant="outline" onClick={() => setBefore(undefined)}>
            Latest rounds
          </Button>
        )}
        {last !== undefined && rounds.some(({ number }) => number < last) && (
          <Button variant="outline" onClick={() => setBefore(last)}>
            Older rounds
          </Button>
        )}
      </div>
    </>
  ) : (
    <p className="text-sm text-muted-foreground">No rounds yet.</p>
  );
}

export function BundleLearning({
  scope,
  state,
  refresh,
}: {
  scope: LearningScope;
  state: LearningState;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { provider, error: providerError } = useModelProvider(scope.workspaceId);
  const [task, setTask] = useState('');
  const [judge, setJudge] = useState('');
  const loop = state.ok ? state.loop : null;
  const ws = scope.workspaceId;
  const defaultTask = loop?.taskModel || provider?.allowedModels[0] || '';
  const defaultJudge = loop?.judgeModel || provider?.allowedModels[1] || '';
  useEffect(() => {
    setTask(defaultTask);
    setJudge(defaultJudge);
  }, [defaultTask, defaultJudge]);
  const evolve = loop?.admittedEvolve ?? 0,
    held = loop?.admittedHeldOut ?? 0;
  async function submit(command: Pick<CentralRequest, 'action' | 'payload'>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await learningRequest({ ...scope, ...command });
      await refresh();
      if (command.action === 'rollback') setNotice('Previous version restored.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save learning settings.');
    } finally {
      setBusy(false);
    }
  }
  function roundHref(round: string) {
    return (
      bundleHref({ ...scope, channel: loop?.channel ?? 'stable' }, 'learning', { round }) +
      '#round-detail'
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void refresh().catch(() => setError('Could not refresh the learning loop.'))
          }
        >
          Refresh learning
        </Button>
      </div>
      {error && (
        <p role="alert" className="workspace-panel p-4">
          {error}
        </p>
      )}

      {notice && <p role="status">{notice}</p>}
      {!state.ok ? (
        <p role="alert" className="workspace-panel p-4">
          {state.message}
        </p>
      ) : (
        <>
          {loop?.alert && (
            <p role="alert" className="workspace-panel p-5">
              Held-out score dropped from {loop.alert.previousScore} to {loop.alert.score} ·{' '}
              {loop.alert.flippedTasks} tasks flipped.{' '}
              <a className="underline" href={roundHref(loop.alert.roundId)}>
                Inspect round
              </a>
            </p>
          )}
          <Panel title="Learning setup">
            <p>Chat harness · {loop?.channel ?? 'Choose a published channel'}</p>
            {!state.canManage &&
              (loop ? (
                <p>
                  Task model {loop.taskModel} · Judge model {loop.judgeModel} · Up to{' '}
                  {loop.maxRoundsPerDay} rounds per day
                </p>
              ) : (
                <p>A workspace administrator can set up learning for this bundle.</p>
              ))}
            {state.canManage && (
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void submit({
                    action: 'configure',
                    payload: JSON.stringify({
                      channel: data.get('channel'),
                      setting: {
                        domain: loop?.setting.domain ?? 'Chat',
                        benchmark: loop?.setting.benchmark ?? 'Service tasks',
                      },
                      taskModel: task,
                      judgeModel: judge,
                      maxRoundsPerDay: Number(data.get('cap')),
                    }),
                  });
                }}
              >
                <label>
                  Learning channel
                  <select
                    className="block w-full rounded border p-2"
                    name="channel"
                    defaultValue={loop?.channel}
                  >
                    {state.channels.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                {(
                  [
                    ['Task model', task, setTask],
                    ['Judge model', judge, setJudge],
                  ] as const
                ).map(([label, value, change]) => (
                  <label key={label}>
                    {label}
                    <select
                      className="block w-full rounded border p-2"
                      value={value}
                      onChange={(e) => change(e.target.value)}
                    >
                      {provider?.allowedModels.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <label htmlFor="learning-cap">
                  Maximum rounds per day
                  <Input
                    id="learning-cap"
                    type="number"
                    min="1"
                    required
                    name="cap"
                    defaultValue={loop?.maxRoundsPerDay ?? 4}
                  />
                </label>
                {!state.channels.length && <p>Release a version on a channel first.</p>}
                {!provider ? (
                  <p>{providerError ? 'Model provider unavailable.' : 'Loading provider…'}</p>
                ) : provider.allowedModels.length < 2 ? (
                  <a className="underline" href={workspaceHref(ws, 'members') + '#model-provider'}>
                    Configure two allowed models in workspace settings
                  </a>
                ) : (
                  task === judge && <p>Choose different task and judge models.</p>
                )}
                <Button
                  disabled={busy || !state.channels.length || !task || !judge || task === judge}
                >
                  Save learning settings
                </Button>
              </form>
            )}
            {loop && (
              <>
                <p>
                  {loop.status} {loop.pauseReason?.replaceAll('-', ' ')}{' '}
                  {loop.waiting && '· Waiting: ' + loop.waiting.replaceAll('-', ' ')}
                </p>
                <p>
                  {evolve} admitted evolve · {held} admitted held-out
                </p>
                {state.canManage &&
                  (loop.status === 'running' ? (
                    <Button disabled={busy} onClick={() => void submit({ action: 'pause' })}>
                      Pause
                    </Button>
                  ) : (
                    <Button
                      disabled={
                        busy ||
                        !!providerError ||
                        provider?.verification?.status !== 'verified' ||
                        !!splitDeficit(evolve) ||
                        !!splitDeficit(held)
                      }
                      onClick={() => void submit({ action: 'start' })}
                    >
                      Start
                    </Button>
                  ))}
                {loop.status !== 'running' && provider?.verification?.status !== 'verified' && (
                  <p>
                    {providerError ||
                      (provider?.verification?.status === 'failed'
                        ? 'Provider verification failed.'
                        : provider?.hasKey
                          ? 'Provider verification is pending.'
                          : 'Start requires a verified model provider.')}{' '}
                    <a
                      className="underline"
                      href={workspaceHref(ws, 'members') + '#model-provider'}
                    >
                      Check provider settings
                    </a>
                  </p>
                )}
                {(splitDeficit(evolve) > 0 || splitDeficit(held) > 0) && (
                  <p>
                    Start needs {splitDeficit(evolve)} more evolve and {splitDeficit(held)} more
                    held-out tasks.
                  </p>
                )}
              </>
            )}
          </Panel>
          {loop && (
            <>
              <LearningTasks
                rounds={state.rounds.map((r) => r.id)}
                scope={scope}
                edit={state.canEditCases}
                refresh={refresh}
              />
              <Panel title="Active round">
                {loop.activeRound ? (
                  <>
                    <p>
                      <a className="underline" href={roundHref(loop.activeRound.id)}>
                        Round {loop.activeRound.number}
                      </a>
                    </p>
                    <ol className="list-decimal space-y-1 pl-5 text-sm">
                      {activeRoundStates.map((roundState) => (
                        <li
                          key={roundState}
                          aria-current={loop.activeRound?.state === roundState ? 'step' : undefined}
                        >
                          {stateLabels[roundState]}
                          {loop.activeRound?.state === roundState && ' (current)'}
                        </li>
                      ))}
                    </ol>
                    {state.activeEvaluation && (
                      <p className="text-sm">
                        <span className="capitalize">{state.activeEvaluation.role}</span>
                        {state.activeEvaluation.sample !== null &&
                          ` sample ${state.activeEvaluation.sample}`}
                        {' · '}
                        {state.activeEvaluation.split === 'heldOut'
                          ? 'Held-out monitoring'
                          : 'Evolve'}
                        {' · '}
                        {state.activeEvaluation.status}
                        {' · '}
                        {state.activeEvaluation.reportedCases} of {state.activeEvaluation.cases}{' '}
                        cases reported
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No active round.</p>
                )}
              </Panel>
              <Panel title="Scores by round">
                <ScoreCurves rounds={state.rounds} />
                <p className="text-sm text-muted-foreground">
                  Small held-out sets make scores noisy. With 20 tasks, one changed verdict moves
                  the pass rate by five percentage points. Compare rounds using the same task set.
                </p>
              </Panel>
              <Panel title="Rounds">
                <RoundList
                  rounds={state.rounds}
                  href={roundHref}
                  rollback={
                    state.canManage && !busy
                      ? (roundId) =>
                          void submit({ action: 'rollback', payload: JSON.stringify({ roundId }) })
                      : undefined
                  }
                />
                {state.detail && (
                  <div id="round-detail">
                    {state.detail.ok ? (
                      <LearningRoundDetail scope={scope} detail={state.detail} />
                    ) : (
                      <p role="alert">{state.detail.message}</p>
                    )}
                  </div>
                )}
              </Panel>
              <div id="improvement-memory">
                <Panel title="Memory">
                  <p>Improvement memory: what the optimizer sees. Never delivered to jobs.</p>
                  <a
                    className="text-sm underline"
                    href={
                      bundleHref({ ...scope, channel: loop.channel }, 'learning', {
                        memory: 'latest',
                      }) + '#improvement-memory'
                    }
                  >
                    {state.memory ? 'Latest memory revision' : 'View improvement memory'}
                  </a>
                  {state.memory && (
                    <>
                      {state.memory.ok ? (
                        <ImprovementMemory memory={state.memory.memory} />
                      ) : (
                        <p role="alert">{state.memory.message}</p>
                      )}
                      <form
                        action="#improvement-memory"
                        method="get"
                        className="flex flex-wrap items-end gap-3"
                      >
                        <label htmlFor="learning-memory-revision" className="grid gap-1 text-sm">
                          Memory revision
                          <Input
                            id="learning-memory-revision"
                            name="memory"
                            type="number"
                            min={0}
                            max={state.memory.ok ? state.memory.memory.currentRevision : undefined}
                            required
                          />
                        </label>
                        <Button type="submit" variant="outline">
                          View revision
                        </Button>
                      </form>
                    </>
                  )}
                </Panel>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
