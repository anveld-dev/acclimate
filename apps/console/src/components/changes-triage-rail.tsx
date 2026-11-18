import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleHelp,
  Equal,
  Layers3,
  ListFilter,
} from 'lucide-react';
import {
  pairCounts,
  pairLabels,
  type EvaluationPair,
  type PairFilter,
} from '../lib/evaluation-pairs';
import { Button } from './ui/button';
import './changes-triage-rail.css';

const queues = [
  { filter: 'all', label: 'All cases', Icon: Layers3 },
  { filter: 'lower', label: pairLabels.lower, Icon: ArrowDown },
  { filter: 'higher', label: pairLabels.higher, Icon: ArrowUp },
  { filter: 'same', label: pairLabels.same, Icon: Equal },
  { filter: 'unscored', label: pairLabels.unscored, Icon: CircleHelp },
] as const;

export function ChangesTriageRail({
  rows,
  filter,
  onFilter,
}: {
  rows: EvaluationPair[];
  filter: PairFilter;
  onFilter: (filter: PairFilter) => void;
}) {
  const counts = { all: rows.length, ...pairCounts(rows) };
  return (
    <section className="changes-triage-rail" aria-label="Triage queues">
      <h3 className="changes-triage-rail-heading">
        Triage queues <ListFilter aria-hidden="true" />
      </h3>
      <div className="changes-triage-rail-options" role="group" aria-label="Filter case outcomes">
        {queues.map(({ filter: value, label, Icon }) => (
          <Button
            key={value}
            type="button"
            variant="ghost"
            className="changes-triage-rail-option"
            data-outcome={value}
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
          >
            <Icon className="changes-triage-rail-symbol" aria-hidden="true" />
            <span className="changes-triage-rail-label">{label}</span>
            <span className="changes-triage-rail-count">{counts[value]}</span>
            <ChevronRight className="changes-triage-rail-chevron" aria-hidden="true" />
          </Button>
        ))}
      </div>
    </section>
  );
}
