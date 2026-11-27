ALTER TABLE learning_evaluations
    ADD COLUMN mean_task_tokens double precision
    CHECK (mean_task_tokens IS NULL OR mean_task_tokens >= 0);

-- Allow rounds to keep the incumbent when evaluated candidates fail the noise floor or cost budget.
DO $$
DECLARE old_check name;
BEGIN
    SELECT conname INTO STRICT old_check FROM pg_constraint
    WHERE conrelid='learning_rounds'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%no-evaluated-candidates%';
    EXECUTE format('ALTER TABLE learning_rounds DROP CONSTRAINT %I', old_check);
END $$;

ALTER TABLE learning_rounds
    ADD CONSTRAINT learning_round_kept_reason CHECK (
        decision IS DISTINCT FROM 'kept' OR reason IN (
            'selector-kept',
            'no-candidates',
            'no-survivors',
            'no-evaluated-candidates',
            'no-admissible-candidates',
            'channel-moved'
        )
    );
