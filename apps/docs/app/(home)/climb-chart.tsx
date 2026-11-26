'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { baseline, mistake, stages } from './climb';

const percent = (value: number) => `${Math.round(value * 100)}%`;
const last = stages.length - 1;
const grid = [0, 0.25, 0.5, 0.75, 1];

type Line = { text: string; number?: number; kind: 'same' | 'added' | 'removed' };

// The file's non-blank lines with their real line numbers.
function numbered(text: string) {
  return text
    .split('\n')
    .map((line, index) => ({ text: line, number: index + 1 }))
    .filter((line) => line.text.trim() !== '');
}

// A line diff from the previous release (longest common subsequence; the files are short).
function diff(index: number): Line[] {
  const after = numbered(stages[index].instructions);
  if (index === 0) return after.map((line) => ({ ...line, kind: 'same' }));
  const before = numbered(stages[index - 1].instructions);
  const table = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] =
        before[i].text === after[j].text ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i].text === after[j].text) {
      out.push({ ...after[j], kind: 'same' });
      i++;
      j++;
    } else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) {
      out.push({ ...after[j], kind: 'added' });
      j++;
    } else {
      out.push({ text: before[i].text, kind: 'removed' });
      i++;
    }
  }
  return out;
}

const diffs = stages.map((_, index) => diff(index));
const counts = diffs.map((lines, index) =>
  index === 0
    ? `${lines.length} lines`
    : `+${lines.filter((l) => l.kind === 'added').length} −${lines.filter((l) => l.kind === 'removed').length}`,
);
const wrongLine = diffs[last].find((line) => line.kind !== 'removed' && line.text.includes(mistake.text))?.number;

// Pass rate on the test set as one bar per release. Each column is a radio button that picks the
// release shown in the file beside it.
function Bars({ selected, onSelect }: { selected: number; onSelect: (i: number) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowDown: selected + 1,
      ArrowLeft: selected - 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: last,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, keys[event.key]));
    onSelect(next);
    buttons.current[next]?.focus();
  };
  return (
    <div className="lp-bars">
      <div className="lp-bars-scale" aria-hidden="true">
        {grid.map((g) => (
          <span key={g} style={{ bottom: `${g * 100}%` }}>
            {percent(g)}
          </span>
        ))}
        <i className="lp-bars-baseline" style={{ bottom: `${baseline.passRate * 100}%` }}>
          <span>
            {baseline.label} · {percent(baseline.passRate)}
          </span>
        </i>
      </div>
      <div className="lp-bars-group" role="radiogroup" aria-label="Release scored on the test set" onKeyDown={move}>
        {stages.map((s, i) => (
          <button
            key={s.label}
            ref={(node) => {
              buttons.current[i] = node;
            }}
            type="button"
            role="radio"
            aria-checked={i === selected}
            tabIndex={i === selected ? 0 : -1}
            aria-label={`${s.label}: ${percent(s.passRate)}, ${counts[i]}`}
            onClick={() => onSelect(i)}
          >
            <span className="lp-bar-track">
              <span className="lp-bar" style={{ height: `${s.passRate * 100}%` }}>
                <b>{percent(s.passRate)}</b>
              </span>
            </span>
            <span className="lp-bar-label">
              {s.label}
              <small>{counts[i]}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function File({ selected }: { selected: number }) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLOListElement>(null);
  const stage = stages[selected];
  const lines = diffs[selected];

  const showWrong = () => {
    setOpen(true);
    // Wait for the expanded file to lay out before scrolling to the line.
    requestAnimationFrame(() => {
      const line = body.current?.querySelector<HTMLElement>('[data-wrong]');
      if (!line) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      line.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      line.focus({ preventScroll: true });
    });
  };

  return (
    <figure className="lp-file" data-open={open || undefined}>
      <figcaption className="lp-file-bar">
        <b>instructions.md</b>
        <span aria-live="polite">
          {stage.label} · {percent(stage.passRate)} on test
        </span>
      </figcaption>
      <ol ref={body} className="lp-file-body" aria-label={`instructions.md after ${stage.label}`}>
        {lines.map((line, index) => {
          const wrong = selected === last && line.kind !== 'removed' && line.text.includes(mistake.text);
          const item = line.text.startsWith('- ');
          const text = item ? line.text.slice(2) : line.text;
          const [head, tail] = wrong ? text.split(mistake.text) : [text, undefined];
          return (
            <li
              key={`${line.kind}-${index}-${line.text}`}
              data-kind={line.kind}
              data-item={item || undefined}
              data-wrong={wrong || undefined}
              tabIndex={wrong ? -1 : undefined}
            >
              <span className="lp-file-gutter" aria-hidden="true">
                {line.kind === 'removed' ? '−' : line.number}
              </span>
              {line.kind === 'added' ? <span className="sr-only">Added: </span> : null}
              {line.kind === 'removed' ? <span className="sr-only">Removed: </span> : null}
              <span className="lp-file-text">
                {head}
                {wrong ? (
                  <>
                    <mark>{mistake.text}</mark>
                    {tail}
                    <em>{mistake.note}</em>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="lp-file-foot">
        {selected === last && wrongLine ? (
          <button type="button" className="lp-file-wrong" onClick={showWrong}>
            ✕ One rule is wrong, line {wrongLine}. Show it
          </button>
        ) : (
          <span>{selected === 0 ? 'The starting file.' : 'Lines marked + are new; − were removed.'}</span>
        )}
        <button type="button" className="lp-file-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Collapse' : 'Show the whole file'}
        </button>
      </div>
    </figure>
  );
}

// The heading and fine print stay with the chart, which sticks beside the file on wide screens.
export function Climb({ head, foot }: { head: ReactNode; foot: ReactNode }) {
  const [selected, setSelected] = useState(last);
  return (
    <div className="lp-climb">
      <div className="lp-climb-side">
        {head}
        <Bars selected={selected} onSelect={setSelected} />
        {foot}
      </div>
      <File selected={selected} />
    </div>
  );
}
