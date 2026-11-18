-- Keep every validation window and preserve unique withdrawal and rollback decisions.
ALTER TABLE connected_learning_field_decisions DROP CONSTRAINT connected_learning_field_decisions_pkey;
CREATE UNIQUE INDEX connected_learning_field_terminal_decisions
    ON connected_learning_field_decisions(promotion_id,kind) WHERE kind <> 'validate';
CREATE UNIQUE INDEX connected_learning_field_validation_windows
    ON connected_learning_field_decisions(promotion_id,triggering_sequence) WHERE kind = 'validate';

ALTER TABLE connected_learning_rounds ADD COLUMN audit_policy_rejected boolean NOT NULL DEFAULT false;
UPDATE connected_learning_rounds SET audit_policy_rejected=true
WHERE state='rejected' AND audit_comparison_id IS NOT NULL AND reason IN (
    'Minimum mean improvement was not reached',
    'Selection policy lacks required case evidence',
    'Protected case threshold failed',
    'Case inventory has too few paired repetitions',
    'Maximum case regression exceeded',
    'Candidate reward threshold was not reached',
    'Maximum candidate task failures exceeded',
    'Maximum candidate cost exceeded',
    'Candidate cost change exceeds policy',
    'Nonfinite selection arithmetic'
);

-- Recompute completed calibration requests with effective repetition counts.
UPDATE connected_learning_policy_epochs SET noise_calibration=NULL
WHERE calibration_request_id IS NOT NULL AND noise_calibration IS NOT NULL;
