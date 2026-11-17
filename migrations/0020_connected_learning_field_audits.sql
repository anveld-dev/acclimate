ALTER TABLE connected_learning_rounds
    ADD COLUMN field_audit_window_size integer NOT NULL DEFAULT 0 CHECK (field_audit_window_size BETWEEN 0 AND 10),
    ADD COLUMN field_audit_regressions integer NOT NULL DEFAULT 0 CHECK (field_audit_regressions BETWEEN 0 AND field_audit_window_size),
    ADD COLUMN rollback_promotion_id uuid UNIQUE REFERENCES promotions(id),
    ADD CHECK (rollback_promotion_id IS NULL OR (state = 'promoted' AND field_audit_regressions >= 3));

CREATE TABLE connected_learning_field_verdicts (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    round_id uuid NOT NULL REFERENCES connected_learning_rounds(id),
    outcome_id uuid NOT NULL,
    started_receipt_id uuid NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('pass', 'regression')),
    evaluator_principal text NOT NULL,
    request jsonb NOT NULL,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, bundle_id, integration_id, outcome_id),
    UNIQUE (project_id, bundle_id, integration_id, started_receipt_id),
    FOREIGN KEY (project_id,bundle_id,integration_id,outcome_id)
        REFERENCES connected_learning_outcomes(project_id,bundle_id,integration_id,outcome_id)
);
CREATE INDEX connected_learning_field_verdicts_window ON connected_learning_field_verdicts(round_id,sequence DESC);
