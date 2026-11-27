'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { mistake, run, stages, type Stage } from './climb';

const last = stages.length - 1;
const pct = (value: number) => Math.round(value * 100);

// Stations sit at the centres of five equal columns, matching the selector below the plot, on a
// 0–100% scale.
const sx = (index: number) => ((index + 0.5) / stages.length) * 100;
const sy = (rate: number) => 100 - rate * 100;

function delta(index: number): ReactNode {
  const now = stages[index];
  if (index === 0)
    return (
      <>
        <b>{pct(now.passRate)}%</b> · as written
      </>
    );
  const before = stages[index - 1];
  const pts = pct(now.passRate - before.passRate);
  return (
    <>
      {pct(before.passRate)}% → <b>{pct(now.passRate)}%</b> · {pts > 0 ? `+${pts} pts` : 'held'}
    </>
  );
}

// Underline the one wrong phrase in the last release.
function Text({ text }: { text: string }) {
  const at = text.indexOf(mistake.text);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="lp-flag">{mistake.text}</mark>
      {text.slice(at + mistake.text.length)}
    </>
  );
}

function Release({ stage, index }: { stage: Stage; index: number }) {
  return (
    <>
      <div className="lp-diff-head">
        <span className="lp-diff-file">instructions.md</span>
        <span className="lp-diff-delta">{delta(index)}</span>
      </div>
      <ol className="lp-diff-lines">
        {stage.lines.map((line) => (
          <li key={line} data-added={stage.added || undefined}>
            <span className="lp-diff-gutter" aria-hidden="true">
              {stage.added ? '+' : ''}
            </span>
            <span className="lp-diff-text">
              {stage.added ? <span className="sr-only">Added: </span> : null}
              <Text text={line} />
            </span>
          </li>
        ))}
      </ol>
      {index === last ? (
        <p className="lp-diff-note" data-flag>
          Still wrong: members get 365 days, not 180, so {mistake.misses} test tasks fail.
        </p>
      ) : (
        <p className="lp-diff-note">{stage.taught}</p>
      )}
    </>
  );
}

export function Climb({ initial = 3 }: { initial?: number }) {
  const [selected, setSelected] = useState(initial);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const first = stages[0];
  const final = stages[last];
  const current = stages[selected];

  const move = (event: KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowDown: selected + 1,
      ArrowLeft: selected - 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: last,
    };
    if (!(event.key in step)) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, step[event.key]));
    setSelected(next);
    radios.current[next]?.focus();
  };

  const points = stages.map((s, i) => `${sx(i)},${sy(s.passRate)}`).join(' ');

  return (
    <div className="lp-panel">
      <div className="lp-panel-head">
        <span className="lp-eyebrow" id="proof-label">
          Gear returns · {run.testTasks} unseen tasks
        </span>
        <span className="lp-eyebrow" aria-hidden="true">
          Pass rate
        </span>
      </div>

      <p className="lp-readout">
        <span className="lp-figure" data-from>
          <span className="lp-num">
            {pct(first.passRate)}
            <small>%</small>
          </span>
          <span className="lp-cap">Start</span>
        </span>
        <span className="lp-readout-arrow" aria-hidden="true" />
        <span className="sr-only">to</span>
        <span className="lp-figure" data-to>
          <span className="lp-num">
            {pct(final.passRate)}
            <small>%</small>
          </span>
          <span className="lp-cap">After {run.batches} batches</span>
        </span>
      </p>

      <div className="lp-plot" aria-hidden="true">
        {[100, 50, 0].map((level) => (
          <span
            key={level}
            className="lp-grid"
            data-base={level === 0 || undefined}
            style={{ top: `${100 - level}%` }}
          >
            <span>{level}</span>
          </span>
        ))}
        <span
          className="lp-drop"
          style={{ left: `${sx(selected)}%`, top: `${sy(current.passRate)}%` }}
        />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="lp-line">
          <polyline points={points} />
        </svg>
        {stages.map((stage, i) => (
          <span
            key={stage.label}
            className="lp-point"
            data-end={i === last || undefined}
            data-selected={i === selected || undefined}
            style={{
              left: `${sx(i)}%`,
              top: `${sy(stage.passRate)}%`,
              ['--i' as string]: i,
            }}
          />
        ))}
      </div>

      <div
        className="lp-ticks"
        role="radiogroup"
        aria-label={`Pass rate on ${run.testTasks} unseen test tasks after each release`}
        onKeyDown={move}
      >
        {stages.map((stage, i) => (
          <button
            key={stage.label}
            ref={(node) => {
              radios.current[i] = node;
            }}
            type="button"
            role="radio"
            aria-checked={i === selected}
            tabIndex={i === selected ? 0 : -1}
            className="lp-tick"
            onClick={() => setSelected(i)}
          >
            {stage.label}
            <span>{pct(stage.passRate)}%</span>
          </button>
        ))}
      </div>

      {/* Every release is laid out in the same cell so the panel keeps the height of the longest;
          only the selected one is shown and announced. */}
      <div className="lp-diff">
        {stages.map((stage, i) => (
          <div key={stage.label} className="lp-diff-sizer" aria-hidden="true">
            <Release stage={stage} index={i} />
          </div>
        ))}
        <div className="lp-diff-active" aria-live="polite">
          <div key={selected} className="lp-diff-swap">
            <Release stage={current} index={selected} />
          </div>
        </div>
      </div>
    </div>
  );
}
