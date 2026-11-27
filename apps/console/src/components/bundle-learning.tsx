import { LearningConfirm } from './learning-confirm';
import { NativeSelect } from './ui/native-select';
import { describeLearning, selectedModels } from '../lib/central-learning';
import { useModelProvider } from './use-model-provider';
import { useBackgroundRefresh } from './use-background-refresh';
import type { LearningRound, LearningLoop, LearningRoundSummary } from '@anveld/acclimate-sdk';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowRight, RotateCw } from 'lucide-react';
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

const chart = { width: 840, height: 196, left: 72, right: 812, top: 14, bottom: 160 } as const;

/** Whole points between two scores, signed, for the readout under each figure. */
function pointsText(from: number, to: number) {
  const points = Math.round((to - from) * 100);
  return points === 0 ? 'level' : `${points > 0 ? '+' : '−'}${Math.abs(points)} pts`;
}

/** Round numbers to label on the x axis: every round when there are few, otherwise about six. */
function roundTicks(first: number, last: number) {
  if (last - first <= 12) return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const step = Math.ceil((last - first) / 6);
  const ticks: number[] = [];
  for (let n = first; n < last; n += step) ticks.push(n);
  if (last - ticks[ticks.length - 1] < step / 2) ticks.pop();
  return [...ticks, last];
}

function ScoreCurves({ rounds }: { rounds: LearningRoundSummary[] }) {
  const completed = rounds
    .filter(({ state }) => state === 'completed')
    .sort((a, b) => a.number - b.number);
  if (!completed.some((round) => round.evolveScore !== null || round.heldOutScore !== null))
    return <p className="score-empty">Scores appear as rounds complete.</p>;
  const first = completed[0].number;
  const last = completed[completed.length - 1].number;
  const span = chart.right - chart.left;
  const x = (number: number) =>
    first === last
      ? chart.left + span / 2
      : chart.left + ((number - first) / (last - first)) * span;
  const y = (value: number) => chart.bottom - value * (chart.bottom - chart.top);
  const series = [
    { field: 'evolveScore', key: 'evolve', name: 'Evolve score', color: 'var(--chart-1)' },
    {
      field: 'heldOutScore',
      key: 'held-out',
      name: 'Held-out score (monitoring only)',
      color: 'var(--chart-2)',
    },
  ] as const;
  const changes = completed.filter(
    (round, index) => index > 0 && completed[index - 1].taskRevision !== round.taskRevision,
  );
  return (
    <div className="score-instrument">
      <ul aria-label="Score series" className="score-readout">
        {series.map(({ field, key, name }) => {
          const measured = completed.filter((round) => round[field] !== null);
          const latest = measured.at(-1);
          const start = measured[0];
          const value = latest?.[field] ?? null;
          return (
            <li key={key} className="score-figure" data-series={key}>
              <span className="score-name">
                <span aria-hidden="true" className="score-swatch" />
                {name}
              </span>
              <span className="score-num">
                {value === null ? (
                  '—'
                ) : (
                  <>
                    {Math.round(value * 100)}
                    <small>%</small>
                  </>
                )}
              </span>
              <span className="score-caption">
                {latest ? (
                  <>
                    Round {latest.number}
                    {start && start !== latest && start[field] !== null && value !== null && (
                      <>
                        {' · '}
                        <b>{pointsText(start[field], value)}</b> vs round {start.number}
                      </>
                    )}
                  </>
                ) : (
                  'Not measured yet'
                )}
              </span>
            </li>
          );
        })}
        {changes.length > 0 && (
          <li className="score-marker">
            <span aria-hidden="true" className="score-swatch" />
            Task set changed
          </li>
        )}
      </ul>
      {/* Below ~38rem the chart scrolls instead of shrinking its labels past legibility. */}
      <div className="score-plot" role="region" aria-label="Score chart" tabIndex={0}>
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label="Measured scores by completed round"
          className="score-chart"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((value) => (
            <g key={value} className="score-grid" data-base={value === 0 || undefined}>
              <line x1={chart.left - 24} x2={chart.right + 16} y1={y(value)} y2={y(value)} />
              <text x={chart.left - 32} y={y(value) + 4} textAnchor="end">
                {percent(value)}
              </text>
            </g>
          ))}
          <g className="score-axis">
            <text x={chart.left - 32} y={chart.height - 10} textAnchor="end">
              Round
            </text>
            {roundTicks(first, last).map((number) => (
              <g key={number}>
                <line x1={x(number)} x2={x(number)} y1={chart.bottom} y2={chart.bottom + 5} />
                <text x={x(number)} y={chart.height - 10} textAnchor="middle">
                  {number}
                </text>
              </g>
            ))}
          </g>
          {changes.map((round) => (
            <g key={round.id} className="score-change">
              <line x1={x(round.number)} x2={x(round.number)} y1={chart.top - 8} y2={chart.bottom}>
                <title>Task set changed</title>
              </line>
              {changes.length <= 2 && (
                <text x={x(round.number) + 6} y={chart.top - 2}>
                  Task set changed
                </text>
              )}
            </g>
          ))}
          {series.map(({ field, key, name, color }) => {
            const measured = completed.filter((round) => round[field] !== null);
            const latest = measured.at(-1);
            return (
              <g key={field} className="score-series" data-series={key} fill={color} stroke={color}>
                {completed.map((round, index) => {
                  const value = round[field];
                  if (value === null) return null;
                  const previous = completed[index - 1];
                  const previousValue = previous?.[field];
                  const changed = previous && previous.taskRevision !== round.taskRevision;
                  return (
                    !changed &&
                    previousValue != null &&
                    previous.number + 1 === round.number && (
                      <line
                        key={round.id}
                        x1={x(previous.number)}
                        x2={x(round.number)}
                        y1={y(previousValue)}
                        y2={y(value)}
                      />
                    )
                  );
                })}
                {completed.map((round) => {
                  const value = round[field];
                  if (value === null) return null;
                  const end = round === latest;
                  return (
                    <g key={round.id}>
                      {end && (
                        <circle className="score-halo" cx={x(round.number)} cy={y(value)} r="11" />
                      )}
                      <circle
                        className="score-node"
                        data-end={end || undefined}
                        cx={x(round.number)}
                        cy={y(value)}
                        r={end ? 5.5 : 4.5}
                      >
                        <title>{`Round ${round.number} · ${name} · ${percent(value)}`}</title>
                      </circle>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="score-foot">
        <p>
          Small held-out sets make scores noisy: with 20 tasks, one task that changes from pass to
          fail moves the score by five points, so compare rounds that use the same task set.
        </p>
        <details className="score-data">
          <summary>Score data</summary>
          <div className="score-data-table">
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
    <div className="learning-messages">
      <p>
        {describeLearning(loop.status)} {loop.pauseReason && describeLearning(loop.pauseReason)}{' '}
        {loop.waiting && describeLearning(loop.waiting)}
        {loop.waiting === 'models-not-allowed' && (
          <>
            {' '}
            <ConsoleLink className="learning-inline-link" href={settingsHref}>
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
          <a className="learning-inline-link" href={href(latest.id)}>
            Inspect round {latest.number}
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * The active round as a tracker: its link and scoring progress, then its six steps as a rail
 * with the finished steps in ink and the current one in the signal colour.
 */
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
  const evaluation = !progress ? state.activeEvaluation : null;
  const ratio = progress
    ? progress.total > 0
      ? progress.scored / progress.total
      : 0
    : evaluation && evaluation.cases > 0
      ? evaluation.reportedCases / evaluation.cases
      : null;
  const live = loop.status === 'running' && !loop.waiting;
  return (
    <section aria-label="Active round" className="learning-round">
      <div className="learning-round-head">
        <span className="learning-round-dot" data-live={live || undefined} aria-hidden="true" />
        <a className="learning-round-link" href={href(active.id)}>
          Round {active.number}
          <ArrowRight aria-hidden="true" />
        </a>
        {progress && (
          <p className="learning-round-count">
            {progress.scored} of {progress.total} rollouts scored
            {ratio !== null && <span aria-hidden="true"> · {Math.round(ratio * 100)}%</span>}
          </p>
        )}
        {evaluation && (
          <p className="learning-round-count">
            <span className="capitalize">{evaluation.role}</span>
            {evaluation.sample !== null && ` sample ${evaluation.sample}`}
            {' · '}
            {evaluation.split === 'heldOut' ? 'Held-out monitoring' : 'Evolve'}
            {' · '}
            {describeLearning('evaluation.' + evaluation.status)}
            {' · '}
            {evaluation.reportedCases} of {evaluation.cases} cases reported
          </p>
        )}
      </div>
      {ratio !== null && (
        <div className="learning-progress" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
        </div>
      )}
      <ol className="learning-steps">
        {activeRoundStates.map((roundState, index) => (
          <li
            key={roundState}
            aria-current={active.state === roundState ? 'step' : undefined}
            data-state={
              active.state === roundState ? 'current' : index < current ? 'done' : 'upcoming'
            }
          >
            {describeLearning('round.' + roundState)}
            {active.state === roundState && ' (current)'}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A label and value in the status panel's telemetry strip. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="learning-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
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
  if (!rounds.length) return <p className="learning-empty">No rounds yet.</p>;
  const older = last !== undefined && rounds.some(({ number }) => number < last);
  return (
    <>
      <Table className="learning-ledger">
        <TableHeader>
          <TableRow>
            {['Round', 'Trigger', 'Outcome', 'Evolve score', 'Held-out', 'Version', 'Ended'].map(
              (label) => (
                <TableHead key={label}>{label}</TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.map((round) => {
            const restores = history?.filter((entry) => entry.roundId === round.id) ?? [];
            return (
              <TableRow key={round.id} data-round-state={round.state}>
                <TableHead scope="row">
                  <a className="learning-round-number" href={href(round.id)}>
                    {round.number}
                  </a>
                </TableHead>
                <TableCell className="learning-col-trigger">
                  {round.trigger ? describeLearning(round.trigger) : '—'}
                </TableCell>
                <TableCell className="learning-col-outcome">
                  <RoundOutcome round={round} />
                  {round.reason && (
                    <p className="learning-cell-note">{describeLearning(round.reason)}</p>
                  )}
                  {round.state === 'failed' && round.failureCause && (
                    <p className="learning-cell-note">
                      <FailureCause cause={round.failureCause} />
                    </p>
                  )}
                </TableCell>
                <TableCell className="data-value learning-col-score">
                  {round.decision === 'adopted' && round.evolveScore !== null ? (
                    <>
                      <span className="learning-score-from">{scoreText(round.incumbentScore)}</span>{' '}
                      <span aria-hidden="true" className="learning-score-arrow">
                        →
                      </span>
                      <span className="sr-only">to</span>{' '}
                      <span className="learning-score-to">{percent(round.evolveScore)}</span>
                    </>
                  ) : (
                    scoreText(round.incumbentScore)
                  )}
                </TableCell>
                <TableCell className="data-value learning-col-heldout">
                  {round.heldOutError
                    ? round.adoptedVersionId
                      ? 'This version was released, but the regression check could not run.'
                      : describeLearning(round.heldOutError)
                    : scoreText(round.heldOutScore)}
                </TableCell>
                <TableCell className="learning-col-version">
                  {round.adoptedVersionId ? (
                    <div className="learning-version">
                      <div className="learning-version-row">
                        {round.adoptedSample !== null && (
                          <span className="learning-sample">Sample {round.adoptedSample}</span>
                        )}
                        <VersionId id={round.adoptedVersionId} />
                        {round.adoptedVersionId === head && rollback && (
                          <span className="learning-rollback">
                            <LearningConfirm
                              label="Roll back"
                              description={rollbackDescription}
                              onConfirm={() => rollback(round.id)}
                            />
                          </span>
                        )}
                      </div>
                      {restores.map((entry) => (
                        <p key={entry.time} className="learning-cell-note">
                          Previous version restored by {entry.actor} on{' '}
                          <ReceiptTime value={entry.time} />.
                        </p>
                      ))}
                      {round.adoptedVersionId !== head && manage && !restores.length && (
                        <p className="learning-cell-note">
                          Only the latest release can be rolled back.
                        </p>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="learning-col-ended">
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
  const statusHeading = useId();
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
    const alert = loop?.alert;
    const alertRound = alert && state.rounds.find((r) => r.id === alert.roundId);
    const description = !loop
      ? 'Learning tests changes to this bundle on your tasks and releases the ones that score better.'
      : state.canManage && loop.status !== 'running'
        ? `Starting learning lets the service release adopted changes to the ${loop.channel} channel automatically, without approval. You can roll back the current release.`
        : `Adopted changes are released to the ${loop.channel} channel automatically.`;
    const notes = loop && (
      <>
        {loop.status !== 'running' && noOptimizer && (
          <p role="alert">
            The service has no optimizer model. An operator must set ACCLIMATE_MODEL_ENDPOINT,
            ACCLIMATE_MODEL_TOKEN and ACCLIMATE_MODEL on the service. On the local stack, export
            them and run npm run local:up again.
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
            <a className="learning-inline-link" href={providerHref}>
              Check provider settings
            </a>
          </p>
        )}
        {(splitDeficit(evolve) > 0 || splitDeficit(held) > 0) && (
          <p>
            Start needs {splitDeficit(evolve)} more evolve and {splitDeficit(held)} more held-out
            tasks, so that each score rests on at least 100 runs.{' '}
            <ConsoleLink className="learning-inline-link" href={tabHref('tasks')}>
              Add tasks
            </ConsoleLink>
          </p>
        )}
      </>
    );
    const hasNotes =
      loop &&
      ((loop.status !== 'running' &&
        (noOptimizer || provider?.verification?.status !== 'verified')) ||
        splitDeficit(evolve) > 0 ||
        splitDeficit(held) > 0);
    return (
      <>
        <section aria-labelledby={statusHeading} className="workspace-panel learning-status">
          <header className="learning-status-head">
            <div className="learning-status-title">
              <h2 id={statusHeading}>Learning status</h2>
              <div className="learning-status-line">
                <div role="status" className="learning-state">
                  <StatusBadge tone={badge.tone} className="learning-badge">
                    {badge.label}
                  </StatusBadge>
                  <div className="learning-state-message">
                    {loop ? (
                      <LoopMessages
                        loop={loop}
                        latest={state.rounds[0]}
                        href={roundHref}
                        settingsHref={tabHref('settings')}
                      />
                    ) : (
                      <p>
                        Learning is not set up for this bundle.{' '}
                        {state.canManage ? (
                          <ConsoleLink className="learning-inline-link" href={tabHref('settings')}>
                            Set up learning
                          </ConsoleLink>
                        ) : (
                          'A workspace administrator can set up learning for this bundle.'
                        )}
                      </p>
                    )}
                  </div>
                </div>
                <p className="learning-status-note">{description}</p>
              </div>
            </div>
            {controls && <div className="panel-actions">{controls}</div>}
          </header>
          {alert && (
            <div role="alert" data-tone="danger" className="learning-alert">
              <div className="learning-alert-copy">
                <p className="learning-eyebrow">
                  {alert.kind === 'regression-check-incomplete'
                    ? 'Regression check incomplete'
                    : alert.reverted
                      ? 'Held-out regression · restored'
                      : 'Held-out regression'}
                  {alertRound && ` · Round ${alertRound.number}`}
                </p>
                {alert.kind === 'regression-check-incomplete' ? (
                  <p className="learning-alert-lead">
                    The regression check could not be completed for version{' '}
                    <VersionId id={alert.versionId} />.
                  </p>
                ) : (
                  <>
                    <p className="learning-alert-lead">
                      {alert.score < alert.previousScore
                        ? `Held-out score dropped from ${percent(alert.previousScore)} to ${percent(alert.score)}.`
                        : 'Fewer held-out runs pass than before the release.'}
                    </p>
                    <p className="learning-alert-body">
                      {alert.passRate !== undefined && alert.previousPassRate !== undefined
                        ? `Runs that meet every criterion went from ${percent(alert.previousPassRate)} to ${percent(alert.passRate)}, and `
                        : ''}
                      {alert.flippedTasks} tasks changed from pass to fail.{' '}
                      {alert.reverted
                        ? 'The service restored the previous version.'
                        : 'The drop was below the limit for an automatic restore. Inspect the round and roll back if needed.'}
                    </p>
                  </>
                )}
              </div>
              <div className="learning-alert-actions">
                <Button asChild variant="outline">
                  <a href={roundHref(alert.roundId)}>
                    Inspect round
                    <ArrowRight aria-hidden="true" />
                  </a>
                </Button>
                {state.canManage &&
                  !(alert.kind === undefined && alert.reverted) &&
                  state.rounds.some(
                    (r) =>
                      r.id === alert.roundId &&
                      r.adoptedVersionId !== null &&
                      r.adoptedVersionId === state.channelHead,
                  ) && (
                    <LearningConfirm
                      label="Roll back this release"
                      description={rollbackDescription}
                      disabled={busy}
                      onConfirm={() =>
                        void submit({
                          action: 'rollback',
                          body: { roundId: alert.roundId },
                        })
                      }
                    />
                  )}
              </div>
            </div>
          )}
          {loop && (
            <dl className="learning-facts">
              <Fact label="Channel">
                <code className="learning-channel">{loop.channel}</code>
              </Fact>
              <Fact label="Admitted tasks">
                <ConsoleLink className="learning-fact-link" href={tabHref('tasks')}>
                  <span>
                    {evolve} evolve · {held} held-out
                  </span>
                  <ArrowRight aria-hidden="true" />
                </ConsoleLink>
              </Fact>
              <Fact label="Models">
                <span className="learning-models">
                  <code>{loop.taskModel ?? '—'}</code>
                  <span className="learning-models-join"> · judged by </span>
                  <code>{loop.judgeModel ?? '—'}</code>
                </span>
              </Fact>
            </dl>
          )}
          {hasNotes && <div className="learning-notes">{notes}</div>}
          {loop && <ActiveRound state={state} loop={loop} progress={progress} href={roundHref} />}
        </section>
        {loop && (
          <>
            <Panel title="Scores by round" className="learning-scores" flush>
              <ScoreCurves rounds={state.rounds} />
            </Panel>
            <Panel title="Rounds" className="learning-rounds" flush>
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
            <dl className="learning-fact-grid">
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
    <div className="learning-page">
      <div className="learning-toolbar">
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
          variant="ghost"
          className="learning-refresh"
          disabled={busy}
          onClick={() =>
            void refresh().catch(() => setError('Could not refresh the learning loop.'))
          }
        >
          <RotateCw aria-hidden="true" />
          Refresh learning
        </Button>
      </div>
      {error && (
        <p role="alert" data-tone="danger" className="learning-error">
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
