import { setTimeout as delay } from 'node:timers/promises';
import type { AcclimateClient } from '../client.js';
import type { LearningRound, LearningRoundSummary } from '../types.js';

// Prevent model-generated line breaks, terminal controls and bidi overrides in progress output.
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 300);
const score = (value: number | null) => value === null ? 'pending' : value.toFixed(2);

export function roundLines(round: LearningRound) {
  const lines = new Map<string, string>([
    ['round', `round ${round.number} · incumbent ${score(round.incumbentScore)}`],
  ]);
  for (const candidate of round.candidates) {
    if (candidate.status === 'generating') continue;
    const { diagnosis, screen, sample } = candidate;
    const problem = diagnosis?.problem;
    const reason = problem
      ? 'id' in problem ? `${plain(problem.id)}` : JSON.stringify(plain(problem.new))
      : null;
    const details = [
      reason && `${reason} · predicts ${diagnosis?.predicted.length}`,
      screen && `${screen.verdict === 'skip' ? 'screened out' : 'passed screen'}: ${plain(screen.reason)}`,
      candidate.dropReason,
      candidate.evolveScore !== null && `evolve ${score(candidate.evolveScore)}`,
      candidate.status === 'evaluation_failed' && 'evaluation failed',
    ].filter(Boolean);
    const marker = candidate.status === 'screened_out' || candidate.status === 'dropped' ||
      candidate.status === 'evaluation_failed' ? '✗' : candidate.evolveScore !== null ? '✓' : '·';
    lines.set(`s${sample}`, `  ${marker} s${sample}  ${details.join(' · ') || candidate.status}`);
  }
  if (round.decision || round.endedAt) {
    const choice = round.decision === 'adopted'
      ? `adopted s${round.adoptedSample} → ${round.adoptedVersionId} released on ${plain(round.channel)}`
      : round.decision ?? round.state;
    const reason = round.selection?.reason ?? round.reason;
    const heldOut = round.heldOutError
      ? `held-out error: ${plain(round.heldOutError)}`
      : `held-out ${score(round.heldOutScore)}`;
    lines.set('decision', `  ${choice}${reason ? ' · ' + plain(reason) : ''} · ${heldOut}`);
  }
  return lines;
}

export async function streamRounds(
  client: Pick<AcclimateClient, 'listLearningRounds' | 'getLearningRound' | 'getLearningLoop'>,
  workspaceId: string,
  bundleId: string,
  beforeStart: number,
  once: boolean,
  signal: AbortSignal,
  print: (line: string) => void,
  onActiveRound: (id: string) => void,
) {
  const displayed = new Map<string, string>();
  let lastFinished = beforeStart;
  let displaying: string | undefined;
  while (!signal.aborted) {
    const rounds: LearningRoundSummary[] = [];
    let before: number | undefined;
    do {
      const page = await client.listLearningRounds(workspaceId, bundleId, { before, limit: 20 });
      rounds.push(...page.items.filter(round => round.number > lastFinished));
      before = page.items.some(round => round.number <= lastFinished) ? undefined : page.next ?? undefined;
    } while (before !== undefined && !signal.aborted);
    for (const summary of rounds.sort((a, b) => a.number - b.number)) {
      if (signal.aborted) return;
      if (displaying !== summary.id) {
        displayed.clear();
        displaying = summary.id;
      }
      const round = await client.getLearningRound(workspaceId, bundleId, summary.id);
      if (!round.endedAt) onActiveRound(round.id);
      for (const [key, line] of roundLines(round)) {
        if (displayed.get(key) !== line) print(line);
        displayed.set(key, line);
      }
      if (round.endedAt) {
        lastFinished = round.number;
        if (once && round.state === 'completed') return;
      }
    }
    if (once) {
      const loop = await client.getLearningLoop(workspaceId, bundleId);
      if (loop.status !== 'running' && !loop.activeRound && !loop.rounds.some(round =>
        round.number > lastFinished && round.state === 'completed'))
        throw new Error(`The learning loop is ${loop.status}${loop.pauseReason ? ' (' + loop.pauseReason + ')' : ''}.`);
    }
    await delay(500, undefined, { signal }).catch(error => {
      if (!signal.aborted) throw error;
    });
  }
}
