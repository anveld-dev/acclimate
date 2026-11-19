ALTER TABLE proposals ADD COLUMN screening jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE connected_learning_rounds ADD COLUMN proposal_admission_refunded boolean NOT NULL DEFAULT false;

-- PostgreSQL derives and truncates the original constraint name.
DO $$
DECLARE original text;
BEGIN
    SELECT conname INTO STRICT original FROM pg_constraint
    WHERE conrelid = 'connected_learning_rounds'::regclass
      AND pg_get_constraintdef(oid) = 'UNIQUE (project_id, integration_id, correction_id, attempt)';
    EXECUTE format('ALTER TABLE connected_learning_rounds DROP CONSTRAINT %I', original);
END $$;

CREATE UNIQUE INDEX connected_learning_charged_attempt
ON connected_learning_rounds(project_id, integration_id, correction_id, attempt)
WHERE NOT proposal_admission_refunded;
