ALTER TABLE connected_learning_rounds
    ADD COLUMN developed_at timestamptz,
    ADD COLUMN first_failure_at timestamptz,
    ADD COLUMN pending_ticks integer NOT NULL DEFAULT 0,
    ADD COLUMN chain_promotion_id uuid REFERENCES promotions(id);

UPDATE connected_learning_rounds SET developed_at=updated_at WHERE state='developed';

-- Keep a single round as the owner of the release and its audit evidence.
DO $$
DECLARE original name;
BEGIN
    SELECT conname INTO STRICT original FROM pg_constraint
    WHERE conrelid='connected_learning_rounds'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%(promotion_id IS NOT NULL)%';
    EXECUTE format('ALTER TABLE connected_learning_rounds DROP CONSTRAINT %I', original);
END $$;
ALTER TABLE connected_learning_rounds ADD CONSTRAINT connected_learning_round_release_check
    CHECK ((state='promoted') = (num_nonnulls(promotion_id,chain_promotion_id)=1)
           AND num_nonnulls(promotion_id,chain_promotion_id)<=1);

ALTER TABLE connected_learning_policy_epochs
    ADD COLUMN calibration_failures integer NOT NULL DEFAULT 0,
    ADD COLUMN calibration_stopped_reason text;

ALTER TABLE proposals ADD COLUMN failure_kind text, ADD COLUMN next_claim_at timestamptz NOT NULL DEFAULT now();
UPDATE proposals SET failure_kind=error
WHERE status='failed' AND error IN ('critic-rejected','critic-unavailable','proposal-format-rejected');

UPDATE connected_learning_replay_obligations SET created_at=now() WHERE verdict IS NULL;
CREATE OR REPLACE VIEW connected_learning_replay_results AS
SELECT id,project_id,integration_id,bundle_id,version_id,baseline_revision,
       correction_id,regression_sequence,round_id,verdict
FROM connected_learning_replay_obligations;

ALTER TABLE connected_learning_rounds DROP CONSTRAINT connected_learning_rounds_decision_check,
    ADD CHECK (decision IN ('policy_review','automatic_rollout','review_declined','expired_review',
                            'chain_discarded','chain_promoted','critic_rejected'));

CREATE INDEX connected_learning_pending_replay_deadline
    ON connected_learning_replay_obligations(created_at) WHERE verdict IS NULL;

UPDATE connected_learning_rounds SET decision='critic_rejected'
WHERE state='rejected' AND decision IS NULL AND reason='critic-rejected';

-- Reconcile developed steps already stranded by a completed chain or epoch.
WITH terminal_chains AS (
    SELECT step.round_id, release.promotion_id
    FROM connected_learning_incumbent_events step
    JOIN connected_learning_rounds r ON r.id=step.round_id AND r.state='developed'
    JOIN connected_learning_enrollments e ON (e.project_id,e.integration_id)=(step.project_id,step.integration_id)
    LEFT JOIN LATERAL (
        SELECT h.sequence,h.baseline_version_id,h.baseline_revision
        FROM connected_learning_incumbent_events h
        WHERE (h.project_id,h.integration_id,h.policy_epoch)=(step.project_id,step.integration_id,step.policy_epoch)
          AND h.sequence>step.sequence AND h.chain_length=0
        ORDER BY h.sequence LIMIT 1
    ) reset ON true
    LEFT JOIN LATERAL (
        SELECT head.promotion_id
        FROM connected_learning_incumbent_events accepted
        JOIN connected_learning_rounds head ON head.id=accepted.round_id
        JOIN promotions p ON p.id=head.promotion_id
        WHERE (accepted.project_id,accepted.integration_id,accepted.policy_epoch)
            = (step.project_id,step.integration_id,step.policy_epoch)
          AND accepted.sequence BETWEEN step.sequence AND reset.sequence
          AND (p.version_id,p.revision)=(reset.baseline_version_id,reset.baseline_revision)
        LIMIT 1
    ) release ON true
    WHERE step.chain_length>0 AND (reset.sequence IS NOT NULL OR step.policy_epoch<e.policy_epoch)
), finalized AS (
    UPDATE connected_learning_rounds r
    SET state=CASE WHEN t.promotion_id IS NULL THEN 'rejected' ELSE 'promoted' END,
        decision=CASE WHEN t.promotion_id IS NULL THEN 'chain_discarded' ELSE 'chain_promoted' END,
        reason=CASE WHEN t.promotion_id IS NULL THEN 'Development chain discarded' END,
        chain_promotion_id=t.promotion_id,updated_at=now()
    FROM terminal_chains t WHERE r.id=t.round_id
    RETURNING r.id,r.decision
)
UPDATE connected_learning_corrections c SET pending=true,queued_at=clock_timestamp()
WHERE c.attempts<2 AND EXISTS (
    SELECT 1 FROM connected_learning_round_corrections m JOIN finalized f ON f.id=m.round_id
    WHERE (m.project_id,m.integration_id,m.correction_id)=(c.project_id,c.integration_id,c.correction_id)
      AND f.decision='chain_discarded'
);
