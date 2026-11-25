import { LearningConfirm } from './learning-confirm';
import { NativeSelect } from './ui/native-select';
import { describeLearning, selectedModels } from '../lib/central-learning';
import { useModelProvider } from './use-model-provider';
import { useBackgroundRefresh } from './use-background-refresh';
import type { LearningRound, LearningLoop, LearningRoundSummary } from '@acclimate/sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { bundleHref } from '../navigation';
import {
  FailureCause,
  ImprovementMemory,
  LearningRoundDetail,
  RoundOutcome,
  VersionId,
  scoreText,
} from './learning-details';
import { ReceiptTime } from './receipt-time';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { learningRequest } from '../server/central-actions';
import { splitDeficit, type CentralCommand } from '../lib/central-learning';
import { LearningTasks } from './learning-tasks';
import { workspaceHref } from '../navigation';
import type { LearningState } from '../server/learning-core';
import { activeRoundStates } from '../lib/learning';
import type { LearningScope } from '../lib/learning';
import { Panel } from './panel';
import { SubTabs } from './sub-tabs';
import { Field, FieldGrid } from './ui/field';
import { StatusBadge, type StatusTone } from './status-badge';
import { ConsoleLink } from './console-link';
import { percent } from '../lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export const learningTabs = ['overview', 'tasks', 'settings', 'memory'] as const;
export type LearningTab = (typeof learningTabs)[number];
const tabLabels: Record<LearningTab, string> = {
  overview: 'Overview',
  tasks: 'Tasks',
  settings: 'Settings',
  memory: 'Memory',
};

/**
 * The Learning sub-tab a URL opens. No `tab` means Overview, except that a `memory` link from
 * before the sub-tabs existed opens Memory.
 */
export function learningTab(search: Record<string, unknown>): LearningTab {
  const tab = search.tab;
  if (typeof tab === 'string' && (learningTabs as readonly string[]).includes(tab))
    return tab as LearningTab;
  return search.memory !== undefined ? 'memory' : 'overview';
}

type ReadyState = Extract<LearningState, { ok: true }>;

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
              {percent(value)}
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
                    <title>{`Round ${round.number} · ${name} · ${percent(value)}`}</title>
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
        <div className="mt-2 max-h-80 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Round</TableHead>
                {series.map(({ name }) => (
                  <TableHead key={name}>{name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {completed.map((round) => (
                <TableRow key={round.id}>
                  <TableHead scope="row">{round.number}</TableHead>
                  <TableCell className="data-value">{scoreText(round.evolveScore)}</TableCell>
                  <TableCell className="data-value">{scoreText(round.heldOutScore)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

/** The loop's state as a badge: running, waiting, paused, stopped or not set up. */
function loopBadge(loop: LearningLoop | null): { label: string; tone: StatusTone } {
  if (!loop) return { label: 'Not set up', tone: 'neutral' };
  if (loop.status === 'paused') return { label: 'Paused', tone: 'warning' };
  if (loop.status === 'stopped') return { label: 'Stopped', tone: 'neutral' };
  if (loop.waiting) return { label: 'Waiting', tone: 'info' };
  return { label: 'Running', tone: 'success' };
}

/** What the loop is doing now, why it waits or paused, and what to do about it. */
function LoopMessages({
  loop,
  latest,
  href,
  settingsHref,
}: {
  loop: LearningLoop;
  latest?: LearningRoundSummary;
  href: (id: string) => string;
  settingsHref: string;
}) {
  const needed = loop.evolveTasksNeeded;
  return (
    <div className="space-y-1 text-sm">
      <p>
        {describeLearning(loop.status)} {loop.pauseReason && describeLearning(loop.pauseReason)}{' '}
        {loop.waiting && describeLearning(loop.waiting)}
        {loop.waiting === 'models-not-allowed' && (
          <>
            {' '}
            <ConsoleLink className="underline" href={settingsHref}>
              Open learning settings
            </ConsoleLink>
          </>
        )}
      </p>
      {(loop.waiting === 'daily-cap' || loop.waiting === 'provider-unavailable') &&
        loop.nextRoundAt && (
          <p>
            The next round can start at <ReceiptTime value={loop.nextRoundAt} />.
          </p>
        )}
      {loop.waiting === 'no-new-evidence' && needed != null && needed > 0 && (
        <p>
          Add or change {needed} more evolve {needed === 1 ? 'task' : 'tasks'} to start another
          round.
        </p>
      )}
      {loop.pauseReason === 'failed-rounds' && latest?.state === 'failed' && (
        <p>
          {latest.failureCause ? (
            <>
              Round {latest.number} failed: <FailureCause cause={latest.failureCause} />
            </>
          ) : (
            <>
              Round {latest.number} failed. {latest.reason && describeLearning(latest.reason)}
            </>
          )}{' '}
          <a className="underline" href={href(latest.id)}>
            Inspect round {latest.number}
          </a>
        </p>
      )}
    </div>
  );
}

/** The active round's steps in one wrapping line, with the current step marked. */
function ActiveRound({
  state,
  loop,
  progress,
  href,
}: {
  state: ReadyState;
  loop: LearningLoop;
  progress: { scored: number; total: number } | null;
  href: (id: string) => string;
}) {
  const active = loop.activeRound;
  if (!active) return null;
  const current = activeRoundStates.indexOf(active.state as (typeof activeRoundStates)[number]);
  return (
    <section aria-label="Active round" className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">
        <a className="underline" href={href(active.id)}>
          Round {active.number}
        </a>
      </p>
      <ol className="flex list-inside list-decimal flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {activeRoundStates.map((roundState, index) => (
          <li
            key={roundState}
            aria-current={active.state === roundState ? 'step' : undefined}
            className={
              active.state === roundState
                ? 'font-medium text-foreground'
                : index < current
                  ? 'text-foreground/70'
                  : undefined
            }
          >
            {describeLearning('round.' + roundState)}
            {active.state === roundState && ' (current)'}
          </li>
        ))}
      </ol>
      {progress && (
        <p>
          {progress.scored} of {progress.total} rollouts scored
        </p>
      )}
      {!progress && state.activeEvaluation && (
        <p>
          <span className="capitalize">{state.activeEvaluation.role}</span>
          {state.activeEvaluation.sample !== null && ` sample ${state.activeEvaluation.sample}`}
          {' · '}
          {state.activeEvaluation.split === 'heldOut' ? 'Held-out monitoring' : 'Evolve'}
          {' · '}
          {describeLearning('evaluation.' + state.activeEvaluation.status)}
          {' · '}
          {state.activeEvaluation.reportedCases} of {state.activeEvaluation.cases} cases reported
        </p>
      )}
    </section>
  );
}

/** A label and value in the status panel's summary. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function RoundList({
  rounds,
  href,
  rollback,
  manage,
  history,
  head,
}: {
  rounds: LearningRoundSummary[];
  href: (id: string) => string;
  history: ReadyState['history'];
  head: string | null;
  manage: boolean;
  rollback?: (id: string) => void;
}) {
  const [before, setBefore] = useState<number>();
  const page = rounds.filter(({ number }) => before === undefined || number < before).slice(0, 20);
  const last = page.at(-1)?.number;
  if (!rounds.length) return <p className="p-4 text-sm text-muted-foreground">No rounds yet.</p>;
  const older = last !== undefined && rounds.some(({ number }) => number < last);
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {['Round', 'Trigger', 'Outcome', 'Evolve score', 'Held-out', 'Version', 'Ended'].map(
              (label) => (
                <TableHead key={label} className="px-3">
                  {label}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.map((round) => {
            const restores = history?.filter((entry) => entry.roundId === round.id) ?? [];
            return (
              <TableRow key={round.id} className="align-top hover:bg-transparent">
                <TableHead scope="row" className="h-auto px-3 py-3 align-top">
                  <a className="underline" href={href(round.id)}>
                    {round.number}
                  </a>
                </TableHead>
                <TableCell className="min-w-[10rem] px-3 py-3 align-top whitespace-normal">
                  {round.trigger ? describeLearning(round.trigger) : '—'}
                </TableCell>
                <TableCell className="min-w-[12rem] max-w-[22rem] px-3 py-3 align-top whitespace-normal">
                  <RoundOutcome round={round} />
                  {round.reason && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {describeLearning(round.reason)}
                    </p>
                  )}
                  {round.state === 'failed' && round.failureCause && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <FailureCause cause={round.failureCause} />
                    </p>
                  )}
                </TableCell>
                <TableCell className="data-value px-3 py-3 align-top">
                  {round.decision === 'adopted' && round.evolveScore !== null ? (
                    <>
                      {scoreText(round.incumbentScore)} <span aria-hidden="true">→</span>
                      <span className="sr-only">to</span> {percent(round.evolveScore)}
                    </>
                  ) : (
                    scoreText(round.incumbentScore)
                  )}
                </TableCell>
                <TableCell className="data-value max-w-[16rem] px-3 py-3 align-top whitespace-normal">
                  {round.heldOutError
                    ? round.adoptedVersionId
                      ? 'This version was released, but the regression check could not run.'
                      : describeLearning(round.heldOutError)
                    : scoreText(round.heldOutScore)}
                </TableCell>
                <TableCell className="min-w-[12rem] px-3 py-3 align-top whitespace-normal">
                  {round.adoptedVersionId ? (
                    <div className="space-y-1.5">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {round.adoptedSample !== null && (
                          <span className="text-muted-foreground">
                            Sample {round.adoptedSample}
                          </span>
                        )}
                        <VersionId id={round.adoptedVersionId} />
                      </p>
                      {restores.map((entry) => (
                        <p key={entry.time} className="text-xs text-muted-foreground">
                          Previous version restored by {entry.actor} on{' '}
                          <ReceiptTime value={entry.time} />.
                        </p>
                      ))}
                      {round.adoptedVersionId === head
                        ? rollback && (
                            <span className="[&>button]:h-7 [&>button]:px-2">
                              <LearningConfirm
                                label="Roll back"
                                description={rollbackDescription}
                                onConfirm={() => rollback(round.id)}
                              />
                            </span>
                          )
                        : manage &&
                          !restores.length && (
                            <p className="text-xs text-muted-foreground">
                              Only the latest release can be rolled back.
                            </p>
                          )}
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="px-3 py-3 align-top">
                  {round.endedAt ? <ReceiptTime value={round.endedAt} relative /> : '—'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {(before !== undefined || older) && (
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          {before !== undefined && (
            <Button variant="outline" onClick={() => setBefore(undefined)}>
              Latest rounds
            </Button>
          )}
          {older && (
            <Button variant="outline" onClick={() => setBefore(last)}>
              Older rounds
            </Button>
          )}
        </div>
      )}
    </>
  );
}

const rollbackDescription =
  'Release this round’s previous version and block the removed version from future adoption.';

export function BundleLearning({
  scope,
  state,
  refresh,
  tab = 'overview',
}: {
  scope: LearningScope;
  state: LearningState;
  refresh: () => Promise<void>;
  tab?: LearningTab;
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
            latest.nextRound !== loop?.nextRound ||
            latest.evolveTasksNeeded !== loop?.evolveTasksNeeded
          )
            await refresh();
        }
      } finally {
        setDelay((n) => Math.min(30000, n * 2));
      }
    },
    {
      enabled: Boolean(roundId || loop?.status === 'running'),
      // An idle loop wakes when tasks change, perhaps in another tab, so it keeps a slow refresh.
      interval: !roundId && loop?.waiting === 'no-new-evidence' ? 60000 : delay,
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
  const page = { ...scope, channel: loop?.channel ?? 'stable' };
  const tabHref = (id: LearningTab) =>
    bundleHref(page, 'learning', { tab: id === 'overview' ? undefined : id });
  function roundHref(round: string) {
    return bundleHref(page, 'learning', { round }) + '#round-detail';
  }
  const providerHref = workspaceHref(ws, 'model-provider');

  function overview(state: ReadyState) {
    const badge = loopBadge(loop);
    const canStart =
      !busy &&
      !noOptimizer &&
      !providerError &&
      provider?.verification?.status === 'verified' &&
      !splitDeficit(evolve) &&
      !splitDeficit(held);
    const controls = loop && state.canManage && (
      <>
        {loop.status === 'running' ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void submit({ action: 'pause' })}
          >
            Pause
          </Button>
        ) : (
          <Button disabled={!canStart} onClick={() => void submit({ action: 'start' })}>
            Start
          </Button>
        )}
        {loop.status !== 'stopped' && (
          <LearningConfirm
            label="Stop learning"
            disabled={busy}
            description="Cancel work in progress and stop scheduling rounds for this bundle."
            onConfirm={() => void submit({ action: 'stop' })}
          />
        )}
      </>
    );
    return (
      <>
        <Panel
          title="Learning status"
          description={
            !loop
              ? 'Learning tests changes to this bundle on your tasks and releases the ones that score better.'
              : state.canManage && loop.status !== 'running'
                ? `Starting learning lets the service release adopted changes to the ${loop.channel} channel automatically, without approval. You can roll back the current release.`
                : `Adopted changes are released to the ${loop.channel} channel automatically.`
          }
          actions={controls || undefined}
        >
          {loop?.alert && (
            <div role="alert" data-tone="danger" className="rounded-md border px-3 py-2 text-sm">
              {loop.alert.kind === 'regression-check-incomplete' ? (
                <>
                  The regression check could not be completed for version{' '}
                  <VersionId id={loop.alert.versionId} />.
                </>
              ) : (
                <>
                  {loop.alert.score < loop.alert.previousScore
                    ? `Held-out score dropped from ${percent(loop.alert.previousScore)} to ${percent(loop.alert.score)}.`
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
              {state.canManage &&
                !(loop.alert.kind === undefined && loop.alert.reverted) &&
                state.rounds.some(
                  (r) =>
                    r.id === loop.alert?.roundId &&
                    r.adoptedVersionId !== null &&
                    r.adoptedVersionId === state.channelHead,
                ) && (
                  <>
                    {' '}
                    <LearningConfirm
                      label="Roll back this release"
                      description={rollbackDescription}
                      disabled={busy}
                      onConfirm={() =>
                        void submit({
                          action: 'rollback',
                          body: { roundId: loop.alert?.roundId ?? '' },
                        })
                      }
                    />
                  </>
                )}
            </div>
          )}
          <div role="status" className="flex flex-wrap items-start gap-3">
            <StatusBadge tone={badge.tone} className="mt-0.5">
              {badge.label}
            </StatusBadge>
            <div className="min-w-0 flex-1">
              {loop ? (
                <LoopMessages
                  loop={loop}
                  latest={state.rounds[0]}
                  href={roundHref}
                  settingsHref={tabHref('settings')}
                />
              ) : (
                <p className="text-sm">
                  Learning is not set up for this bundle.{' '}
                  {state.canManage ? (
                    <ConsoleLink className="underline" href={tabHref('settings')}>
                      Set up learning
                    </ConsoleLink>
                  ) : (
                    'A workspace administrator can set up learning for this bundle.'
                  )}
                </p>
              )}
            </div>
          </div>
          {loop && (
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <Fact label="Channel">{loop.channel}</Fact>
              <Fact label="Admitted tasks">
                <ConsoleLink className="underline" href={tabHref('tasks')}>
                  {evolve} evolve · {held} held-out
                </ConsoleLink>
              </Fact>
              <Fact label="Models">
                {loop.taskModel ?? '—'} · judged by {loop.judgeModel ?? '—'}
              </Fact>
            </dl>
          )}
          {loop && loop.status !== 'running' && (
            <div className="space-y-1 text-sm">
              {noOptimizer && (
                <p role="alert">
                  The service has no optimizer model. An operator must set ACCLIMATE_MODEL_ENDPOINT,
                  ACCLIMATE_MODEL_TOKEN and ACCLIMATE_MODEL on the service. On the local stack,
                  export them and run npm run local:up again.
                </p>
              )}
              {provider?.verification?.status !== 'verified' && (
                <p>
                  {providerError ||
                    (provider?.verification?.status === 'failed'
                      ? 'Provider verification failed.'
                      : provider?.hasKey
                        ? 'Provider verification is pending.'
                        : 'Start requires a verified model provider.')}{' '}
                  <a className="underline" href={providerHref}>
                    Check provider settings
                  </a>
                </p>
              )}
            </div>
          )}
          {loop && (splitDeficit(evolve) > 0 || splitDeficit(held) > 0) && (
            <p className="text-sm">
              Start needs {splitDeficit(evolve)} more evolve and {splitDeficit(held)} more held-out
              tasks, so that each score rests on at least 100 runs.{' '}
              <ConsoleLink className="underline" href={tabHref('tasks')}>
                Add tasks
              </ConsoleLink>
            </p>
          )}
          {loop && <ActiveRound state={state} loop={loop} progress={progress} href={roundHref} />}
        </Panel>
        {loop && (
          <>
            <Panel
              title="Scores by round"
              description="Small held-out sets make scores noisy: with 20 tasks, one task that changes from pass to fail moves the score by five points, so compare rounds that use the same task set."
            >
              <ScoreCurves rounds={state.rounds} />
            </Panel>
            <Panel title="Rounds" flush>
              <RoundList
                history={state.history}
                head={state.channelHead}
                rounds={state.rounds}
                href={roundHref}
                manage={state.canManage}
                rollback={
                  state.canManage && !busy
                    ? (roundId) => void submit({ action: 'rollback', body: { roundId } })
                    : undefined
                }
              />
              {state.history === null && (
                <p className="border-t p-4 text-sm">Rollback history could not be loaded.</p>
              )}
            </Panel>
            {state.detail &&
              (state.detail.ok ? (
                <LearningRoundDetail scope={page} detail={state.detail} />
              ) : (
                <Panel id="round-detail" title="Round detail">
                  <p role="alert">{state.detail.message}</p>
                </Panel>
              ))}
            {state.blocked === null ? (
              <Panel title="Blocked versions">
                <p className="text-sm">Blocked versions could not be loaded.</p>
              </Panel>
            ) : (
              state.blocked.length > 0 && (
                <Panel
                  title="Blocked versions"
                  description="Rounds do not adopt these versions again until you unblock them."
                  flush
                >
                  <ul className="divide-y text-sm">
                    {state.blocked.map((v) => (
                      <li
                        key={v.digest}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      >
                        <div className="min-w-0 space-y-1 break-words">
                          <VersionId id={v.digest} label="Copy version digest" />
                          <p className="text-muted-foreground">
                            Removed by {v.removedBy} on <ReceiptTime value={v.createdAt} />
                            {v.roundId && (
                              <>
                                {' '}
                                from{' '}
                                <a className="underline" href={roundHref(v.roundId)}>
                                  round {v.roundNumber}
                                </a>
                              </>
                            )}
                            {v.note && ` · ${v.note}`}
                          </p>
                        </div>
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
                </Panel>
              )
            )}
          </>
        )}
      </>
    );
  }

  function settings(state: ReadyState) {
    const notes = [
      !state.channels.length && <span key="channel">Release a version on a channel first.</span>,
      !provider ? (
        <span key="provider">
          {providerError ? 'Model provider unavailable.' : 'Loading provider…'}
        </span>
      ) : provider.allowedModels.length < 2 ? (
        <a key="provider" className="underline" href={providerHref}>
          Configure two allowed models in workspace settings
        </a>
      ) : (
        task === judge && <span key="provider">Choose different task and judge models.</span>
      ),
    ].filter(Boolean);
    if (!state.canManage)
      return (
        <Panel title="Learning setup" description="How this bundle learns from its tasks.">
          {loop ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Fact label="Learning channel">{loop.channel}</Fact>
              <Fact label="Task model">{loop.taskModel ?? '—'}</Fact>
              <Fact label="Judge model">{loop.judgeModel ?? '—'}</Fact>
              <Fact label="Maximum rounds per day">{loop.maxRoundsPerDay}</Fact>
              <Fact label="Task domain">{loop.setting.domain}</Fact>
              <Fact label="Benchmark name">{loop.setting.benchmark}</Fact>
            </dl>
          ) : (
            <p className="text-sm">
              A workspace administrator can set up learning for this bundle.
            </p>
          )}
        </Panel>
      );
    return (
      <Panel
        title="Learning setup"
        description="Choose where adopted versions are released and which models run and grade each round."
        footer={
          <>
            {notes.length > 0 && <span className="panel-footer-note">{notes}</span>}
            <Button
              type="submit"
              form="learning-setup"
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
          </>
        }
      >
        <form
          id="learning-setup"
          className="space-y-4"
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
          <FieldGrid columns={2}>
            <Field
              label="Learning channel"
              htmlFor="learning-channel"
              hint="Adopted versions are released here automatically, without approval."
            >
              <NativeSelect
                id="learning-channel"
                className="w-full"
                name="channel"
                defaultValue={loop?.channel}
                aria-describedby="learning-channel-hint"
              >
                {state.channels.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </NativeSelect>
            </Field>
            {(
              [
                [
                  'Task model',
                  'task',
                  task,
                  setTask,
                  'The model the bundle runs on in every rollout.',
                ],
                [
                  'Judge model',
                  'judge',
                  judge,
                  setJudge,
                  'Grades each answer. Pick a model other than the task model; a model grading its own work is lenient.',
                ],
              ] as const
            ).map(([label, key, value, change, hint]) => (
              <Field key={key} label={label} htmlFor={`learning-${key}`} hint={hint}>
                <NativeSelect
                  id={`learning-${key}`}
                  className="w-full"
                  value={value}
                  required
                  aria-describedby={`learning-${key}-hint`}
                  onChange={(e) => change(e.target.value)}
                >
                  {provider?.allowedModels.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </NativeSelect>
              </Field>
            ))}
            <Field
              label="Task domain"
              htmlFor="learning-domain"
              hint="What the bundle’s work is about, such as customer support. It forms each round’s setting."
            >
              <Input
                id="learning-domain"
                required
                name="domain"
                aria-describedby="learning-domain-hint"
                defaultValue={loop?.setting.domain ?? state.bundleName}
              />
            </Field>
            <Field
              label="Benchmark name"
              htmlFor="learning-benchmark"
              hint="Names this task set. The optimizer trusts improvement memory from it most, so rename it when the tasks change in kind."
            >
              <Input
                id="learning-benchmark"
                required
                name="benchmark"
                aria-describedby="learning-benchmark-hint"
                defaultValue={loop?.setting.benchmark ?? 'Learning tasks'}
              />
            </Field>
            <Field
              label="Maximum rounds per day"
              htmlFor="learning-cap"
              hint="Limits rounds, and provider spend, in any 24 hours. A round runs every evolve task five times for up to six versions."
            >
              <Input
                id="learning-cap"
                type="number"
                min="1"
                required
                name="cap"
                aria-describedby="learning-cap-hint"
                defaultValue={loop?.maxRoundsPerDay ?? 4}
              />
            </Field>
          </FieldGrid>
          {!loop && (
            <p className="text-sm text-muted-foreground">
              After you save these settings, add or import evolve and held-out tasks on the Tasks
              tab.
            </p>
          )}
        </form>
      </Panel>
    );
  }

  function tasks(state: ReadyState) {
    if (!loop)
      return (
        <NotSetUp state={state} settingsHref={tabHref('settings')}>
          Save the learning settings before you add tasks.
        </NotSetUp>
      );
    return (
      <LearningTasks
        rounds={state.rounds.map((r) => r.id)}
        scope={scope}
        edit={state.canEditCases}
        refresh={refresh}
      />
    );
  }

  function memory(state: ReadyState) {
    if (!loop)
      return (
        <NotSetUp state={state} settingsHref={tabHref('settings')}>
          Improvement memory fills as learning rounds run.
        </NotSetUp>
      );
    const current = state.memory?.ok ? state.memory.memory : undefined;
    return (
      <Panel
        id="improvement-memory"
        title="Improvement memory"
        description="What the optimizer sees, never delivered to jobs."
        actions={
          current &&
          current.memoryRevision !== current.currentRevision && (
            <Button asChild variant="outline">
              <ConsoleLink href={tabHref('memory')}>Latest memory revision</ConsoleLink>
            </Button>
          )
        }
      >
        <form action="#improvement-memory" method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="memory" />
          <Field label="Memory revision" htmlFor="learning-memory-revision">
            <Input
              id="learning-memory-revision"
              name="memory"
              type="number"
              className="w-32"
              min={0}
              max={current?.currentRevision}
              required
            />
          </Field>
          <Button type="submit" variant="outline">
            View revision
          </Button>
        </form>
        {!state.memory ? (
          <ConsoleLink className="text-sm underline" href={tabHref('memory')}>
            View improvement memory
          </ConsoleLink>
        ) : state.memory.ok ? (
          <ImprovementMemory memory={state.memory.memory} />
        ) : (
          <p role="alert">{state.memory.message}</p>
        )}
      </Panel>
    );
  }

  const content = { overview, tasks, settings, memory }[tab];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {state.ok && (
          <SubTabs
            label="Learning sections"
            current={tab}
            href={tabHref}
            tabs={learningTabs.map((id) => ({
              id,
              label: tabLabels[id],
              count: id === 'tasks' && loop ? evolve + held : undefined,
            }))}
          />
        )}
        <Button
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() =>
            void refresh().catch(() => setError('Could not refresh the learning loop.'))
          }
        >
          Refresh learning
        </Button>
      </div>
      {error && (
        <p role="alert" data-tone="danger" className="rounded-md border px-4 py-3 text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {!state.ok ? (
        <p role="alert" className="workspace-panel p-4">
          {state.message}
        </p>
      ) : (
        content(state)
      )}
    </div>
  );
}

function NotSetUp({
  state,
  settingsHref,
  children,
}: {
  state: ReadyState;
  settingsHref: string;
  children: ReactNode;
}) {
  return (
    <Panel title="Learning is not set up">
      <p className="text-sm">
        {children}{' '}
        {state.canManage ? (
          <ConsoleLink className="underline" href={settingsHref}>
            Open learning settings
          </ConsoleLink>
        ) : (
          'A workspace administrator can set up learning for this bundle.'
        )}
      </p>
    </Panel>
  );
}
