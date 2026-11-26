'use client';

import { useEffect, useRef, useState } from 'react';
import { baseline, mistake, stages, type Stage } from './climb';

const percent = (value: number) => `${Math.round(value * 100)}%`;
const last = stages.length - 1;
const x = (i: number) => (i / last) * 100;
const y = (value: number) => (1 - value) * 100;
const grid = [0.25, 0.5, 0.75, 1];

const lines = (stage: Stage) => stage.instructions.split('\n').filter((line) => line.trim() !== '');

// Pass rate on the test set as a ridge: lines in a stretched SVG with non-scaling strokes, the
// terrain as a clipped, hatched block, and points and labels in HTML so they stay legible.
function Ridge({ selected, onSelect }: { selected: number; onSelect: (i: number) => void }) {
  const path = stages.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(s.passRate)}`).join(' ');
  const terrain = `polygon(${stages.map((s, i) => `${x(i)}% ${y(s.passRate)}%`).join(', ')}, 100% 100%, 0% 100%)`;
  return (
    <div className="lp-ridge">
      <div className="lp-ridge-plot">
        {grid.map((g) => (
          <span key={g} className="lp-ridge-grid" style={{ top: `${y(g)}%` }} aria-hidden="true">
            {percent(g)}
          </span>
        ))}
        <span className="lp-ridge-baseline" style={{ top: `${y(baseline.passRate)}%` }} aria-hidden="true">
          {baseline.label} · {percent(baseline.passRate)}
        </span>
        <div className="lp-ridge-terrain" style={{ clipPath: terrain }} aria-hidden="true" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} className="lp-ridge-line" />
        </svg>
        <span className="lp-ridge-cursor" style={{ left: `${x(selected)}%`, top: `${y(stages[selected].passRate)}%` }} />
        {stages.map((s, i) => (
          // Pointer shortcut only: the labelled buttons below are the accessible control.
          <span
            key={s.label}
            className="lp-ridge-point"
            data-selected={i === selected || undefined}
            style={{ left: `${x(i)}%`, top: `${y(s.passRate)}%` }}
            onClick={() => onSelect(i)}
            aria-hidden="true"
          >
            <b>{percent(s.passRate)}</b>
          </span>
        ))}
      </div>
      <div className="lp-ridge-stages" role="group" aria-label="Show the instructions released after">
        {stages.map((s, i) => (
          <button
            key={s.label}
            type="button"
            style={{ left: `${x(i)}%` }}
            aria-pressed={i === selected}
            aria-label={`${s.label}, ${s.note}: ${percent(s.passRate)}`}
            onClick={() => onSelect(i)}
          >
            {s.label}
            <small>{s.note}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function Instructions({ selected }: { selected: number }) {
  const stage = stages[selected];
  const before = new Set(selected > 0 ? lines(stages[selected - 1]) : []);
  const current = lines(stage);
  const changed = selected > 0 ? current.filter((line) => !before.has(line)).length : 0;
  const body = useRef<HTMLDivElement>(null);

  // Bring the first changed line into view inside the file, without moving the page.
  useEffect(() => {
    const container = body.current;
    const first = container?.querySelector<HTMLElement>('[data-new]');
    if (!container) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top: first ? Math.max(0, first.offsetTop - 16) : 0, behavior: reduce ? 'auto' : 'smooth' });
  }, [selected]);

  return (
    <figure className="lp-file">
      <figcaption className="lp-file-bar">
        <span>instructions.md</span>
        <span className="lp-file-note" aria-live="polite">
          {stage.label} · {percent(stage.passRate)}
          {selected > 0 ? ` · ${changed} changed` : ''}
        </span>
      </figcaption>
      {/* Focusable so keyboard users can scroll the file. */}
      <div ref={body} className="lp-file-body" tabIndex={0} aria-label={`instructions.md after ${stage.label}`}>
        {current.map((line) => {
          const isNew = selected > 0 && !before.has(line);
          const wrong = selected === last && line.includes(mistake.text);
          return (
            <p
              key={line}
              className={line.startsWith('- ') ? 'lp-file-item' : undefined}
              data-new={isNew || undefined}
            >
              {line.replace(/^- /, '')}
              {wrong ? <em className="lp-file-wrong">{mistake.note}</em> : null}
            </p>
          );
        })}
      </div>
    </figure>
  );
}

export function Climb() {
  const [selected, setSelected] = useState(last);
  return (
    <div className="lp-climb">
      <Ridge selected={selected} onSelect={setSelected} />
      <Instructions selected={selected} />
    </div>
  );
}
