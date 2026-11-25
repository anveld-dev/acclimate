-- Keep historical release identities for existing requests, receipts and releases.
DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname INTO STRICT constraint_name
    FROM pg_constraint
    WHERE conrelid = 'connected_learning_rounds'::regclass
      AND contype = 'c'
      AND pg_get_expr(conbin, conrelid) LIKE '%cumulative_request_id IS NULL%release_candidate_id IS NULL%';
    EXECUTE format('ALTER TABLE connected_learning_rounds DROP CONSTRAINT %I', constraint_name);
END
$$;

ALTER TABLE connected_learning_rounds
    ADD CHECK (release_candidate_id IS NULL OR cumulative_request_id IS NOT NULL);

COMMENT ON COLUMN connected_learning_rounds.release_candidate_id IS
    'Historical release identity. New cumulative requests use candidate_version_id.';
