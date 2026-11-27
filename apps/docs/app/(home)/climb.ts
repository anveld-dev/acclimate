// The recorded gear-returns run: examples/gear-returns/results.json and its README.
// Pass rate on the 60-task test set, which the loop never sees, after each batch of labelled
// tasks. `lines` are the rules each release added to its stored instructions.md, condensed to
// fit one line each in the panel.
export type Stage = {
  label: string;
  passRate: number;
  // Start shows the hand-written file as context; later stages show what the loop added.
  added: boolean;
  lines: string[];
  // What the batch's labelled tasks covered.
  taught: string;
};

export const stages: Stage[] = [
  {
    label: 'Start',
    passRate: 0.478,
    added: false,
    lines: [
      'You handle return requests for Basecamp Outfitters.',
      'Reply with exactly one word:',
      'REFUND, EXCHANGE, STORE_CREDIT, REPAIR or DENY.',
    ],
    taught: 'Hand-written: the five replies, none of the shop’s nine rules.',
  },
  {
    label: 'Batch 1',
    passRate: 0.578,
    added: true,
    lines: [
      'Rentals, field-used climbing safety gear: DENY.',
      'Nonmember: REFUND through day 60; STORE_CREDIT to day 90.',
      'Use the stated day count rather than rounded months.',
    ],
    taught: 'From eval tasks on rentals, climbing gear and return windows.',
  },
  {
    label: 'Batch 2',
    passRate: 0.772,
    added: true,
    lines: [
      'Final sale, or a gift without the receipt: STORE_CREDIT.',
      'Neither circumstance alone is grounds for denial.',
      'Neither permits a refund, even in the refund window.',
    ],
    taught: 'From eval tasks on final-sale items and gifts without a receipt.',
  },
  {
    label: 'Batch 3',
    passRate: 0.967,
    added: true,
    lines: [
      'DENY past day 90 (nonmember) or day 365 (Summit Club).',
      'Footwear worn outdoors qualifies for EXCHANGE only.',
      'Opened electronics qualify for STORE_CREDIT only.',
    ],
    taught: 'From eval tasks on worn footwear and opened electronics.',
  },
  {
    label: 'Batch 4',
    passRate: 0.967,
    added: true,
    lines: [
      'A receipted part that broke in normal use: REPAIR.',
      'Normal use does not shorten either tier’s refund window.',
      'Summit Club: REFUND during the first 180 days.',
    ],
    taught: 'From eval tasks on normal wear and receipted faults.',
  },
];

// The one rule the released instructions get wrong. test.csv has two member refunds between
// days 181 and 365, so the last release fails exactly those two test tasks.
export const mistake = {
  text: 'first 180 days',
  misses: 2,
};

export const run = {
  testTasks: 60,
  trainTasks: 102,
  batches: 4,
  rounds: 18,
  taskModel: 'gpt\u20116\u2011luna',
};
