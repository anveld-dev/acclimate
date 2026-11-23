import { LearningConfirm } from './learning-confirm';
import { NativeSelect } from './ui/native-select';
import { Label } from './ui/label';
import { describeLearning, selectedModels } from '../lib/central-learning';
import { useModelProvider } from './use-model-provider';
import { useBackgroundRefresh } from './use-background-refresh';
import type { LearningRound, LearningLoop, LearningRoundSummary } from '@acclimate/sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { bundleHref } from '../navigation';
import { ImprovementMemory, LearningRoundDetail } from './learning-details';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { learningRequest } from '../server/central-actions';
import { splitDeficit, type CentralCommand } from '../lib/central-learning';
import { LearningTasks } from './learning-tasks';
import { workspaceHref } from '../navigation';
import type { LearningState } from '../server/learning-core';
import { activeRoundStates } from '../lib/learning';
import type { LearningScope } from '../lib/learning';

// A judged score is a share of criteria, so it is rarely a short decimal.
const score = (value: number | null) => (value === null ? '—' : String(Number(value.toFixed(3))));
const percent = (value: number) => `${Math.round(value * 100)}%`;
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
  history,
  head,
}: {
  rounds: LearningRoundSummary[];
  href: (id: string) => string;
  history: Extract<LearningState, { ok: true }>['history'];
  head: string | null;
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
                <td>{round.trigger ? describeLearning(round.trigger) : '—'}</td>
                <td>{describeLearning('round.' + round.state)}</td>
                <td className="capitalize">{round.decision ?? '—'}</td>
                <td>{round.reason ? describeLearning(round.reason) : '—'}</td>
                <td>{score(round.incumbentScore)}</td>
                <td>
                  {round.adoptedSample ?? '—'}
                  {round.adoptedVersionId && (
                    <>
                      {' '}
                      / <code>{round.adoptedVersionId}</code>
                      {history
                        ?.filter((entry) => entry.roundId === round.id)
                        .map((entry) => (
                          <p key={entry.time}>
                            Previous version restored by {entry.actor} on{' '}
                            <time dateTime={entry.time}>{entry.time}</time>.
                          </p>
                        ))}
                      {rollback && round.adoptedVersionId === head && (
                        <LearningConfirm
                          label="Roll back"
                          description="Release this round’s previous version and block the removed version from future adoption."
                          onConfirm={() => rollback(round.id)}
                        />
                      )}
                    </>
                  )}
                </td>
                <td>
                  {round.heldOutError
                    ? round.adoptedVersionId
                      ? 'This version was released, but the regression check could not run.'
                      : describeLearning(round.heldOutError)
                    : score(round.heldOutScore)}
                </td>
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
  const [selectedTask, setTask] = useState('');
  const [selectedJudge, setJudge] = useState('');
  const loop = state.ok ? state.loop : null;
  const [liveProgress, setLiveProgress] = useState<{
    round: string;
    scored: number;
    total: number;
  }>();
  const [delay, setDelay] = useState(3000);
  const roundId = loop?.activeRound?.id;
  useEffect(() => {
    setDelay(3000);
    setLiveProgress(undefined);
  }, [roundId, loop?.status]);
  useBackgroundRefresh(
    async () => {
      try {
        if (roundId) {
          const round = await learningRequest<LearningRound>({
            ...scope,
            action: 'evidence',
            id: roundId,
          });
          if (round.progress) setLiveProgress({ round: roundId, ...round.progress });
          if (round.state !== loop?.activeRound?.state) await refresh();
        } else {
          const latest = await learningRequest<LearningLoop>({ ...scope, action: 'loop' });
          if (
            latest.activeRound ||
            latest.status !== loop?.status ||
            latest.waiting !== loop?.waiting ||
            latest.nextRound !== loop?.nextRound
          )
            await refresh();
        }
      } finally {
        setDelay((n) => Math.min(30000, n * 2));
      }
    },
    {
      enabled: Boolean(
        roundId || (loop?.status === 'running' && loop.waiting !== 'no-new-evidence'),
      ),
      interval: delay,
      allowScroll: true,
      allowButtonFocus: true,
    },
  );
  const progress =
    liveProgress && liveProgress.round === roundId
      ? liveProgress
      : state.ok
        ? state.progress
        : null;
  const ws = scope.workspaceId;
  const { task, judge } = selectedModels(
    provider?.allowedModels ?? [],
    selectedTask || loop?.taskModel,
    selectedJudge || loop?.judgeModel,
  );
  // An absent field comes from a service that predates the flag; treat it as configured.
  const noOptimizer = loop?.optimizerConfigured === false;
  const evolve = loop?.admittedEvolve ?? 0,
    held = loop?.admittedHeldOut ?? 0;
  async function submit(command: CentralCommand) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await learningRequest<{ message?: string }>({ ...scope, ...command });
      await refresh();
      if (command.action === 'rollback') setNotice(result.message ?? 'Rollback request completed.');
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
  const started = loop?.status === 'running' || (state.ok && state.rounds.length > 0);
  const monitoring = state.ok && loop && (
    <>
      {loop.status === 'running' || state.rounds.length > 0 ? (
        <p>
          {describeLearning(loop.status)} {loop.waiting && describeLearning(loop.waiting)}{' '}
          {loop.pauseReason && describeLearning(loop.pauseReason)}
        </p>
      ) : null}
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
                  {describeLearning('round.' + roundState)}
                  {loop.activeRound?.state === roundState && ' (current)'}
                </li>
              ))}
            </ol>
            {progress && (
              <p>
                {progress.scored} of {progress.total} rollouts scored
              </p>
            )}
            {!progress && state.activeEvaluation && (
              <p className="text-sm">
                <span className="capitalize">{state.activeEvaluation.role}</span>
                {state.activeEvaluation.sample !== null &&
                  ` sample ${state.activeEvaluation.sample}`}
                {' · '}
                {state.activeEvaluation.split === 'heldOut' ? 'Held-out monitoring' : 'Evolve'}
                {' · '}
                {describeLearning('evaluation.' + state.activeEvaluation.status)}
                {' · '}
                {state.activeEvaluation.reportedCases} of {state.activeEvaluation.cases} cases
                reported
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
          Small held-out sets make scores noisy. With 20 tasks, one task that changes from pass to
          fail can move the score by five percentage points. Compare rounds using the same task set.
        </p>
      </Panel>
      <Panel title="Rounds">
        <RoundList
          history={state.history}
          head={state.channelHead}
          rounds={state.rounds}
          href={roundHref}
          rollback={
            state.canManage && !busy
              ? (roundId) => void submit({ action: 'rollback', body: { roundId } })
              : undefined
          }
        />
        {state.history === null && <p>Rollback history could not be loaded.</p>}
        {state.blocked === null && <p>Blocked versions could not be loaded.</p>}
        {Boolean(state.blocked?.length) && (
          <section>
            <h3>Blocked versions</h3>
            <ul>
              {state.blocked?.map((v) => (
                <li key={v.digest} className="break-words">
                  <code>{v.digest}</code> · Removed by {v.removedBy} on {v.createdAt} {v.note}
                  {state.canManage && (
                    <LearningConfirm
                      label="Unblock version"
                      description="Future rounds may adopt this version again."
                      disabled={busy}
                      onConfirm={() => void submit({ action: 'unblock', id: v.digest })}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
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
                <Label htmlFor="learning-memory-revision" className="grid gap-1 text-sm">
                  Memory revision
                  <Input
                    id="learning-memory-revision"
                    name="memory"
                    type="number"
                    min={0}
                    max={state.memory.ok ? state.memory.memory.currentRevision : undefined}
                    required
                  />
                </Label>
                <Button type="submit" variant="outline">
                  View revision
                </Button>
              </form>
            </>
          )}
        </Panel>
      </div>
    </>
  );
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
              {loop.alert.kind === 'regression-check-incomplete' ? (
                `The regression check could not be completed for version ${loop.alert.versionId}.`
              ) : (
                <>
                  {loop.alert.score < loop.alert.previousScore
                    ? `Held-out score dropped from ${score(loop.alert.previousScore)} to ${score(loop.alert.score)}.`
                    : 'Fewer held-out runs pass than before the release.'}{' '}
                  {loop.alert.passRate !== undefined && loop.alert.previousPassRate !== undefined
                    ? `Runs that meet every criterion went from ${percent(loop.alert.previousPassRate)} to ${percent(loop.alert.passRate)}, and `
                    : ''}
                  {loop.alert.flippedTasks} tasks changed from pass to fail.{' '}
                  {loop.alert.reverted
                    ? 'The service restored the previous version.'
                    : 'The drop was below the limit for an automatic restore. Inspect the round and roll back if needed.'}
                </>
              )}{' '}
              <a className="underline" href={roundHref(loop.alert.roundId)}>
                Inspect round
              </a>
            </p>
          )}
          {started && monitoring}
          <Panel title="Learning setup">
            <p>{loop?.channel ?? 'Choose a published channel'}</p>
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
                    body: {
                      channel: String(data.get('channel')),
                      setting: {
                        domain: String(data.get('domain')),
                        benchmark: String(data.get('benchmark')),
                      },
                      taskModel: task,
                      judgeModel: judge,
                      maxRoundsPerDay: Number(data.get('cap')),
                    },
                  });
                }}
              >
                <Label>
                  Learning channel
                  <NativeSelect
                    className="block w-full rounded border p-2"
                    name="channel"
                    defaultValue={loop?.channel}
                  >
                    {state.channels.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </NativeSelect>
                </Label>
                {(
                  [
                    ['Task model', task, setTask],
                    ['Judge model', judge, setJudge],
                  ] as const
                ).map(([label, value, change]) => (
                  <Label key={label}>
                    {label}
                    <NativeSelect
                      className="block w-full rounded border p-2"
                      value={value}
                      required
                      onChange={(e) => change(e.target.value)}
                    >
                      {provider?.allowedModels.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </NativeSelect>
                  </Label>
                ))}
                <Label>
                  Task domain
                  <Input
                    required
                    name="domain"
                    defaultValue={loop?.setting.domain ?? state.bundleName}
                  />
                </Label>
                <Label>
                  Benchmark name
                  <Input
                    required
                    name="benchmark"
                    defaultValue={loop?.setting.benchmark ?? 'Learning tasks'}
                  />
                </Label>
                <Label htmlFor="learning-cap">
                  Maximum rounds per day
                  <Input
                    id="learning-cap"
                    type="number"
                    min="1"
                    required
                    name="cap"
                    defaultValue={loop?.maxRoundsPerDay ?? 4}
                  />
                </Label>
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
                  disabled={
                    busy ||
                    !state.channels.length ||
                    !provider?.allowedModels.includes(task) ||
                    !provider.allowedModels.includes(judge) ||
                    task === judge
                  }
                >
                  Save learning settings
                </Button>
              </form>
            )}
            {loop && (
              <>
                <p>
                  {describeLearning(loop.status)}{' '}
                  {loop.pauseReason && describeLearning(loop.pauseReason)}{' '}
                  {loop.waiting && describeLearning(loop.waiting)}
                </p>
                <p>
                  {evolve} admitted evolve tasks guide changes. {held} admitted held-out tasks check
                  the result independently.
                </p>
                {state.canManage && loop.status !== 'stopped' && (
                  <LearningConfirm
                    label="Stop learning"
                    disabled={busy}
                    description="Cancel work in progress and stop scheduling rounds for this bundle."
                    onConfirm={() => void submit({ action: 'stop' })}
                  />
                )}
                {state.canManage && loop.status !== 'running' && (
                  <p>
                    Starting learning lets the service release adopted changes to this channel
                    automatically, without approval. You can roll back the current release.
                  </p>
                )}
                {state.canManage &&
                  (loop.status === 'running' ? (
                    <Button disabled={busy} onClick={() => void submit({ action: 'pause' })}>
                      Pause
                    </Button>
                  ) : (
                    <Button
                      disabled={
                        busy ||
                        noOptimizer ||
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
                {loop.status !== 'running' && noOptimizer && (
                  <p role="alert">
                    The service has no optimizer model. An operator must set
                    ACCLIMATE_MODEL_ENDPOINT, ACCLIMATE_MODEL_TOKEN and ACCLIMATE_MODEL on the
                    service. On the local stack, export them and run npm run local:up again.
                  </p>
                )}
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
            <LearningTasks
              rounds={state.rounds.map((r) => r.id)}
              scope={scope}
              edit={state.canEditCases}
              refresh={refresh}
            />
          )}
          {!started && monitoring}
        </>
      )}
    </div>
  );
}
