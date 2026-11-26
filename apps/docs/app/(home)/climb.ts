// The recorded gear-returns run: examples/gear-returns/results.json and its README.
// Pass rate on the 60-task test set, which the loop never sees, after each batch of tasks.
export const stages = [
  { label: 'Start', note: 'no policy', passRate: 0.478 },
  { label: 'Batch 1', note: '+3 rules', passRate: 0.578 },
  { label: 'Batch 2', note: '+2 rules', passRate: 0.772 },
  { label: 'Batch 3', note: '+2 rules', passRate: 0.967 },
  { label: 'Batch 4', note: '+2 rules', passRate: 0.967 },
];

// Always answering STORE_CREDIT, the most common outcome, passes 21 of the 60 test tasks.
export const baseline = { passRate: 21 / 60, label: 'Always STORE_CREDIT' };

// An excerpt of the released instructions.md: the two starting lines, which the loop kept, and
// sentences it added between them, quoted exactly.
export const instructions: { text: string; added?: boolean }[] = [
  { text: 'You handle return requests for Basecamp Outfitters, an outdoor gear shop.' },
  {
    added: true,
    text: 'If a customer with a receipt reports that part of a purchased item broke or failed to function in normal use, treat it as a defect claim: REPAIR.',
  },
  { added: true, text: 'Rentals and field-used climbing safety equipment do not qualify: DENY.' },
  {
    added: true,
    text: 'Before considering a remedy, DENY if the return is past day 90 for a nonmember or past day 365 for a Summit Club member.',
  },
  { added: true, text: 'Footwear worn outdoors qualifies for EXCHANGE only, even after the ordinary refund window closes.' },
  { added: true, text: 'Opened electronics qualify for STORE_CREDIT only.' },
  { added: true, text: 'Nonmember: REFUND through day 60; STORE_CREDIT on days 61–90.' },
  {
    text: 'Read the customer’s request and decide the outcome. Reply with exactly one word: REFUND, EXCHANGE, STORE_CREDIT, REPAIR or DENY.',
  },
];

export const run = {
  rounds: 18,
  testTasks: 60,
  story:
    'A returns agent started with two lines and none of the shop’s nine return rules. Labelled tasks arrived in four batches, like corrections from a live agent. After each batch, the released version was scored on 60 tasks the loop never sees.',
  details:
    'Synthetic data: 102 tasks in four batches and a 60-task test set, each answered three times. Task model gpt-6-luna, optimizer gpt-6.2-astra. 18 rounds, one failed during a provider outage, 21,899 rollouts, about five hours.',
};
