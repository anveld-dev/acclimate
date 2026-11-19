-- Record scanner rejections as an explicit round decision, alongside critic rejections.
ALTER TABLE connected_learning_rounds DROP CONSTRAINT connected_learning_rounds_decision_check,
    ADD CONSTRAINT connected_learning_rounds_decision_check
    CHECK (decision IN ('policy_review','automatic_rollout','review_declined','expired_review',
                        'chain_discarded','chain_promoted','critic_rejected','scanner_rejected'));

UPDATE proposals SET failure_kind=error
WHERE status='failed' AND failure_kind IS NULL AND error='scanner-rejected';

UPDATE connected_learning_rounds SET decision='scanner_rejected'
WHERE state='rejected' AND decision IS NULL AND reason='scanner-rejected';
