import type { LearningLoop, LearningRoundSummary } from '@acclimate/sdk';
import { useState, type FormEvent, type ReactNode } from 'react';
import { bundleHref } from '../navigation';
import { ImprovementMemory, LearningRoundDetail } from './learning-details';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { runLearningLoop } from '../server/learning-loop';
import type { LearningState } from '../server/learning-core';
import { activeRoundStates, enrollmentError, evolveCaseBody } from '../lib/learning';
import type { LearningCommand, LearningScope } from '../lib/learning';

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
const formValue = (data: FormData, name: string) => String(data.get(name) ?? '');

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="workspace-panel space-y-4 p-5">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Enrollment({
  channels,
  principals,
  loop,
  busy,
  submit,
  report,
}: {
  channels: string[];
  principals: { name: string; principalId: string }[];
  loop: LearningLoop | null;
  busy: boolean;
  submit: (command: LearningCommand) => Promise<void>;
  report: (message: string) => void;
}) {
  const [principal, setPrincipal] = useState(loop?.appPrincipalId ?? '');
  function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      channel: formValue(data, 'channel'),
      appPrincipalId: principal.trim(),
      setting: {
        domain: formValue(data, 'domain'),
        benchmark: formValue(data, 'benchmark'),
        policyModel: formValue(data, 'policyModel'),
      },
      heldOut: { digest: formValue(data, 'digest').trim(), cases: Number(data.get('cases')) },
    };
    const error = enrollmentError(body);
    if (error) report(error);
    else void submit({ action: 'enroll', body });
  }
  if (!channels.length)
    return <p>Release a version on a channel before enrolling a learning loop.</p>;
  return (
    <form method="post" onSubmit={enroll} className="space-y-4">
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Learning channel
          <select
            name="channel"
            className="rounded-md border bg-background p-2"
            defaultValue={loop?.channel ?? channels[0]}
          >
            {channels.map((channel) => (
              <option key={channel}>{channel}</option>
            ))}
          </select>
        </label>
        {principals.length > 0 && (
          <label className="grid gap-1 text-sm">
            Active machine token
            <select
              className="rounded-md border bg-background p-2"
              value={
                principals.some(({ principalId }) => principalId === principal) ? principal : ''
              }
              onChange={(event) => setPrincipal(event.target.value)}
            >
              <option value="">Enter a principal manually</option>
              {principals.map(({ name, principalId }) => (
                <option key={principalId} value={principalId}>
                  {name} ({principalId})
                </option>
              ))}
            </select>
          </label>
        )}
        <label htmlFor="learning-appPrincipalId" className="grid gap-1 text-sm">
          App principal ID
          <Input
            id="learning-appPrincipalId"
            name="appPrincipalId"
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
            required
            maxLength={1024}
          />
        </label>
        {(
          [
            ['domain', 'Domain'],
            ['benchmark', 'Benchmark'],
            ['policyModel', 'Policy model'],
          ] as const
        ).map(([name, label]) => (
          <label key={name} className="grid gap-1 text-sm">
            {label}
            <Input name={name} required maxLength={256} defaultValue={loop?.setting[name]} />
          </label>
        ))}
        <p className="break-words text-sm text-muted-foreground sm:col-span-2">
          Run <code>acclimate-learning held-out --app ./learning-app.mjs</code> to get the digest
          and case count.
        </p>
        <label htmlFor="learning-digest" className="grid gap-1 text-sm">
          Held-out digest
          <Input
            id="learning-digest"
            name="digest"
            required
            pattern="sha256:[a-f0-9]{64}"
            defaultValue={loop?.heldOut.digest}
          />
        </label>
        <label htmlFor="learning-cases" className="grid gap-1 text-sm">
          Held-out case count
          <Input
            id="learning-cases"
            name="cases"
            type="number"
            required
            min={1}
            max={10000}
            defaultValue={loop?.heldOut.cases}
          />
        </label>
      </fieldset>
      <Button type="submit" disabled={busy}>
        {loop ? 'Restart loop' : 'Enroll loop'}
      </Button>
    </form>
  );
}

function AddCase({
  busy,
  submit,
  report,
}: {
  busy: boolean;
  submit: (command: LearningCommand) => Promise<void>;
  report: (message: string) => void;
}) {
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const command = {
      action: 'addCase' as const,
      caseId: formValue(data, 'caseId'),
      input: formValue(data, 'input'),
      expected: formValue(data, 'expected'),
    };
    try {
      evolveCaseBody(command);
    } catch (error) {
      report((error as Error).message);
      return;
    }
    void submit(command);
  }
  return (
    <details>
      <summary className="cursor-pointer text-sm font-medium">Add an evolve case</summary>
      <form method="post" onSubmit={add} className="mt-4 space-y-3" autoComplete="off">
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          <label htmlFor="learning-caseId" className="grid gap-1 text-sm">
            Case ID
            <Input id="learning-caseId" name="caseId" required maxLength={128} />
          </label>
          <label className="grid gap-1 text-sm">
            Input (JSON)
            <textarea
              name="input"
              required
              rows={4}
              className="rounded-md border bg-background p-2 font-mono"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Expected result (JSON)
            <textarea
              name="expected"
              required
              rows={4}
              className="rounded-md border bg-background p-2 font-mono"
            />
          </label>
        </fieldset>
        <Button type="submit" disabled={busy}>
          Add case
        </Button>
      </form>
    </details>
  );
}

function ScoreCurves({ rounds }: { rounds: LearningRoundSummary[] }) {
  const completed = rounds
    .filter(({ state }) => state === 'completed')
    .sort((a, b) => a.number - b.number);
  if (!completed.some((round) => round.incumbentScore !== null || round.heldOutScore !== null))
    return <p className="text-sm text-muted-foreground">Scores appear as rounds complete.</p>;
  const first = completed[0].number;
  const last = completed[completed.length - 1].number;
  const x = (number: number) =>
    first === last ? 330 : 46 + ((number - first) / (last - first)) * 568;
  const y = (value: number) => 180 - value * 156;
  const series = [
    { field: 'incumbentScore', name: 'Incumbent evolve score', color: 'var(--chart-1)' },
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
              return (
                <g key={round.id}>
                  {previousValue != null && previous.number + 1 === round.number && (
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
                  <td>{score(round.incumbentScore)}</td>
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

function RetireCase({
  busy,
  submit,
  report,
}: {
  busy: boolean;
  submit: (command: LearningCommand) => Promise<void>;
  report: (message: string) => void;
}) {
  function retire(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = {
      action: 'retireCase' as const,
      caseId: formValue(new FormData(event.currentTarget), 'caseId'),
    };
    try {
      evolveCaseBody(command);
    } catch (error) {
      report((error as Error).message);
      return;
    }
    void submit(command);
  }
  return (
    <details>
      <summary className="cursor-pointer text-sm font-medium">Retire an evolve case</summary>
      <form method="post" onSubmit={retire} className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor="learning-retire-case" className="grid gap-1 text-sm">
          Case ID to retire
          <Input id="learning-retire-case" name="caseId" required maxLength={128} disabled={busy} />
        </label>
        <Button type="submit" disabled={busy} variant="outline">
          Retire case
        </Button>
      </form>
    </details>
  );
}

function RoundList({
  rounds,
  href,
}: {
  rounds: LearningRoundSummary[];
  href: (id: string) => string;
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
  const [confirmStop, setConfirmStop] = useState(false);
  async function reload() {
    setBusy(true);
    setError('');
    try {
      await refresh();
    } catch {
      setError('Could not refresh the learning loop.');
    } finally {
      setBusy(false);
    }
  }
  async function submit(command: LearningCommand) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = await runLearningLoop({ data: { scope, command } });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirmStop(false);
      if ('receipt' in result && result.receipt) {
        const { added, retired, evolveRevision } = result.receipt;
        setNotice(
          command.action === 'retireCase'
            ? `Case ${retired ? 'retired' : 'already retired'} at evolve revision ${evolveRevision}.`
            : `Case ${added ? 'added' : 'already exists'} at evolve revision ${evolveRevision}.`,
        );
      }
      await refresh();
    } catch {
      setError('Could not confirm the change. Refresh the learning page before trying again.');
    } finally {
      setBusy(false);
    }
  }
  const loop = state.ok ? state.loop : null;
  function roundHref(round: string) {
    return (
      bundleHref({ ...scope, channel: loop?.channel ?? 'stable' }, 'learning', { round }) +
      '#round-detail'
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void reload()}>
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
          <Panel title="Loop status">
            {loop ? (
              <>
                <dl className="grid gap-4 break-words text-sm sm:grid-cols-2 lg:grid-cols-3 [&_dt]:text-muted-foreground">
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <span className="capitalize">{loop.status}</span>
                      {loop.pauseReason && ` · ${loop.pauseReason}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Learning channel</dt>
                    <dd>{loop.channel}</dd>
                  </div>
                  <div>
                    <dt>App principal</dt>
                    <dd>
                      <code>{loop.appPrincipalId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Domain</dt>
                    <dd>{loop.setting.domain}</dd>
                  </div>
                  <div>
                    <dt>Benchmark</dt>
                    <dd>{loop.setting.benchmark}</dd>
                  </div>
                  <div>
                    <dt>Policy model</dt>
                    <dd>{loop.setting.policyModel}</dd>
                  </div>
                  <div>
                    <dt>Held-out cases</dt>
                    <dd>{loop.heldOut.cases}</dd>
                  </div>
                  <div>
                    <dt>Evolve revision</dt>
                    <dd>
                      {loop.evolveRevision} · {loop.liveCases} live cases
                    </dd>
                  </div>
                  <div>
                    <dt>Memory revision</dt>
                    <dd>{loop.memoryRevision}</dd>
                  </div>
                  <div>
                    <dt>Consecutive failed rounds</dt>
                    <dd>{loop.failedRounds}</dd>
                  </div>
                </dl>
                {loop.status === 'running' && !loop.liveCases && (
                  <p>Waiting for the first evolve case.</p>
                )}
                {state.canManage && loop.status !== 'stopped' && (
                  <div className="flex flex-wrap gap-2">
                    {loop.status === 'running' ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void submit({ action: 'pause' })}
                      >
                        Pause
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void submit({ action: 'resume' })}
                      >
                        Resume
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy || confirmStop}
                      onClick={() => setConfirmStop(true)}
                    >
                      Stop
                    </Button>
                  </div>
                )}
                {confirmStop && state.canManage && loop.status !== 'stopped' && (
                  <div className="space-y-3 rounded-md border p-4">
                    <p>Stop this loop and cancel its active evaluations?</p>
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void submit({ action: 'stop' })}
                      >
                        Stop loop
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirmStop(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p>This bundle has no learning loop.</p>
            )}
            {state.canManage && (!loop || loop.status === 'stopped') && (
              <Enrollment
                key={loop?.updatedAt ?? 'new'}
                channels={state.channels}
                principals={state.principals}
                loop={loop}
                busy={busy}
                submit={submit}
                report={setError}
              />
            )}
          </Panel>
          {loop && (
            <>
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
              <Panel title="Evolve cases">
                <p className="text-sm">
                  {loop.liveCases} live cases in revision {loop.evolveRevision}.
                </p>
                {state.caseSnapshot ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Cases reported in round {state.caseSnapshot.roundNumber}, evolve revision{' '}
                      {state.caseSnapshot.revision}.
                    </p>
                    <div className="max-h-72 overflow-auto">
                      <table className="w-full text-left text-sm [&_td]:p-2 [&_th]:p-2">
                        <thead>
                          <tr>
                            <th>Case ID</th>
                            <th>Passed rollouts</th>
                            <th>Mean score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state.caseSnapshot.cases.map((item) => (
                            <tr className="border-t" key={item.caseId}>
                              <th scope="row">
                                <code>{item.caseId}</code>
                              </th>
                              <td>{item.passedRollouts}</td>
                              <td>{item.meanScore}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Case IDs appear after the evaluator reports results.
                  </p>
                )}
                {state.canEditCases && (
                  <>
                    <AddCase busy={busy} submit={submit} report={setError} />
                    <RetireCase busy={busy} submit={submit} report={setError} />
                  </>
                )}
              </Panel>
              <Panel title="Scores by round">
                <ScoreCurves rounds={state.rounds} />
              </Panel>
              <Panel title="Rounds">
                <RoundList rounds={state.rounds} href={roundHref} />
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
