-- The executor's redacted message for a rollout that failed for infrastructure reasons.
ALTER TABLE learning_rollouts
    ADD COLUMN error_message text CHECK (char_length(error_message) <= 500);

-- The first failed rollout of the evaluation that ended a round. A held-out cause keeps the
-- code only, so held-out content never reaches the round document.
ALTER TABLE learning_rounds
    ADD COLUMN failure_code text,
    ADD COLUMN failure_message text CHECK (char_length(failure_message) <= 500),
    ADD COLUMN failure_split text CHECK (failure_split IN ('evolve','held_out')),
    ADD CHECK ((failure_code IS NULL) = (failure_split IS NULL)),
    ADD CHECK (failure_message IS NULL OR failure_split = 'evolve'),
    DROP CONSTRAINT learning_round_decision_state,
    ADD CONSTRAINT learning_round_decision_state CHECK (CASE
        WHEN state IN ('scoring_incumbent','proposing','screening','evaluating','selecting')
            THEN decision IS NULL AND reason IS NULL
        WHEN state IN ('scoring_held_out','completed') THEN decision IS NOT NULL
        WHEN state = 'failed' AND decision IS NOT NULL THEN held_out_error IS NOT NULL
        WHEN state = 'failed' THEN reason IS NOT NULL AND reason IN
            ('incumbent-evaluation-failed','candidate-evaluation-failed','optimizer-unavailable',
             'optimizer-context-too-large','selector-unavailable','no-matching-executor',
             'provider-unavailable')
        WHEN state = 'stopped' THEN decision IS NOT NULL OR reason = 'stopped'
    END);

ALTER TABLE learning_loops
    DROP CONSTRAINT learning_loops_waiting_check,
    ADD CONSTRAINT learning_loops_waiting_check CHECK (waiting IN
        ('no-new-evidence','daily-cap','no-executor','models-not-allowed','provider-unavailable'));
