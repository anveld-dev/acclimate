import { stages } from './climb';

// The landing hero, shared with the home page's link preview so the two never drift.
export const homeTitle = 'Agent instructions that improve themselves.';
export const homeDescription =
  'Acclimate versions your agent’s instructions, skills and memory and delivers each release to the next job. A learning loop rewrites them against your labelled tasks.';

export const percent = (value: number) => `${Math.round(value * 100)}%`;
export const homeHighlight = `${percent(stages[0].passRate)} → ${percent(stages[stages.length - 1].passRate)} on tasks it never saw`;
