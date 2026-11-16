/** Browser-only qualification fixture; never imported by application routes. */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Comparison } from '@acclimate/sdk';
import { ComparisonEvidence } from '../../src/components/comparison-evidence';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../../src/components/ui/chart';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';

export function mountFixture(node: HTMLElement, first: Comparison) {
  const root = createRoot(node);
  function render(comparison: Comparison) {
    flushSync(() =>
      root.render(
        <>
          <button id="outside-evidence">Outside evidence</button>
          <ComparisonEvidence comparison={comparison} compact />
          <ChartContainer
            config={{ reward: { label: 'Reward', color: 'var(--chart-1)' } }}
            className="h-48 w-full"
            id="chart-smoke"
          >
            <BarChart
              accessibilityLayer
              data={[
                { round: 'Parent', reward: -1 },
                { round: 'Candidate', reward: 2 },
              ]}
            >
              <CartesianGrid vertical={false} />
              <XAxis dataKey="round" />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="reward" fill="var(--color-reward)" />
            </BarChart>
          </ChartContainer>
        </>,
      ),
    );
  }
  render(first);
  return { render, unmount: () => root.unmount() };
}
