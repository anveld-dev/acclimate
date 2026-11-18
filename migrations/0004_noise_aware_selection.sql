ALTER TABLE connected_learning_policy_epochs
    ADD COLUMN calibration_request_id uuid REFERENCES evaluation_requests(id),
    ADD COLUMN noise_calibration jsonb;

ALTER TABLE connected_learning_field_verdicts
    DROP CONSTRAINT connected_learning_field_verdicts_verdict_check,
    ADD CHECK (verdict IN ('pass', 'regression', 'win', 'tie'));

ALTER TABLE connected_learning_rounds
    ADD COLUMN indeterminate_development_cost boolean NOT NULL DEFAULT false;

ALTER TABLE connected_learning_replay_obligations
    ADD COLUMN attempts text[];

ALTER TABLE connected_learning_rounds
    DROP CONSTRAINT connected_learning_rounds_field_audit_window_size_check,
    ADD CHECK (field_audit_window_size >= 0);
