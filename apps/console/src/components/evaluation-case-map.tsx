import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { EvaluationPair, PairFilter } from '../lib/evaluation-pairs';
import { pairCounts, pairLabels, pairSymbols } from '../lib/evaluation-pairs';
import { Button } from './ui/button';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';

export function EvaluationCaseMap({
  rows,
  filter,
  onFilter,
  selected,
  onSelect,
}: {
  rows: EvaluationPair[];
  filter: PairFilter;
  onFilter: (filter: PairFilter) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const counts = pairCounts(rows);
  const expected = rows.filter((row) => row.expected);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? expected : expected.slice(0, 256);
  const [focused, setFocused] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const grid = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const focusWithin = useRef(false);
  useLayoutEffect(() => {
    if (focusWithin.current && focused && !shown.some((row) => row.id === focused)) {
      const next = shown[0]?.id;
      if (next) buttons.current.get(next)?.focus();
      focusWithin.current = !!next;
    }
  }, [focused, shown]);
  const tabStop = shown.some((row) => row.id === focused) ? focused : shown[0]?.id;
  return (
    <TooltipProvider>
      <section className="evaluation-case-map space-y-3" aria-label="Case reward changes">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Where did it change?</h3>
          <span className="text-sm text-muted-foreground">
            Candidate vs. parent · each tile is one pair
          </span>
        </div>
        <ToggleGroup
          type="single"
          value={filter}
          variant="outline"
          size="sm"
          className="evaluation-case-filters"
          aria-label="Filter case results"
          onValueChange={(value) => {
            if (value) {
              onFilter(value as PairFilter);
              onSelect(null);
            }
          }}
        >
          <ToggleGroupItem value="all">
            All <span>{rows.length}</span>
          </ToggleGroupItem>
          {(['lower', 'higher', 'same', 'unscored'] as const).map((change) => (
            <ToggleGroupItem key={change} value={change} className={`pair-filter-${change}`}>
              <span aria-hidden="true">{pairSymbols[change]}</span> {pairLabels[change]}{' '}
              <span>{counts[change]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {!!expected.length && (
          <div
            ref={grid}
            onFocusCapture={() => {
              focusWithin.current = true;
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget as Node)
              ) {
                focusWithin.current = false;
              }
            }}
            role="group"
            className="evaluation-case-grid"
            aria-label="Expected case pairs"
            aria-describedby={helpId}
          >
            {shown.map((row, index) => {
              const label = `${row.key.caseId} / ${row.key.repetition}: ${pairLabels[row.change]}`;
              const scores =
                row.change === 'unscored'
                  ? `No comparable pair of scores. Parent ${row.pair?.parent?.reward ?? 'missing'}; candidate ${row.pair?.candidate?.reward ?? 'missing'}`
                  : `Parent ${row.pair!.parent.reward!} → candidate ${row.pair!.candidate.reward!}`;
              return (
                <Tooltip key={row.id}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={`evaluation-case-tile is-${row.change}`}
                      ref={(element) => {
                        if (element) buttons.current.set(row.id, element);
                        else buttons.current.delete(row.id);
                      }}
                      tabIndex={tabStop === row.id ? 0 : -1}
                      onFocus={() => setFocused(row.id)}
                      onKeyDown={(event) => {
                        const columns = grid.current
                          ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length
                          : 1;
                        const target =
                          event.key === 'ArrowRight'
                            ? index + 1
                            : event.key === 'ArrowLeft'
                              ? index - 1
                              : event.key === 'ArrowDown'
                                ? index + columns
                                : event.key === 'ArrowUp'
                                  ? index - columns
                                  : event.key === 'Home'
                                    ? 0
                                    : event.key === 'End'
                                      ? shown.length - 1
                                      : null;
                        if (target !== null) {
                          event.preventDefault();
                          buttons.current
                            .get(shown[Math.max(0, Math.min(target, shown.length - 1))].id)
                            ?.focus();
                        }
                      }}
                      aria-label={`${label}. ${scores}`}
                      aria-pressed={selected === row.id}
                      data-dimmed={filter !== 'all' && filter !== row.change}
                      onClick={() => {
                        onFilter('all');
                        onSelect(selected === row.id ? null : row.id);
                      }}
                    >
                      {pairSymbols[row.change]}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span>
                      {label}
                      <br />
                      {scores}
                    </span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}
        <p className="sr-only" id={helpId}>
          Use arrow keys to move between pairs. Enter selects a pair. Tab leaves the map.
        </p>
        {expected.length > 256 && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show first 256 pairs' : `Show all ${expected.length} pairs`}
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          Pick a tile to inspect its outcomes. Higher reward is not a release decision.
          {rows.length > expected.length &&
            ` ${rows.length - expected.length} unexpected pairs appear in the table only.`}
        </p>
      </section>
    </TooltipProvider>
  );
}
