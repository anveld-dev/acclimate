-- Phase 1: remove the hand-made change workflow (D8).
DROP TABLE draft_snapshots;
DROP TABLE drafts;
DROP TABLE evaluation_policy_receipts;

ALTER TABLE promotions
    DROP COLUMN policy_approval_promotion_id,
    DROP COLUMN policy_override;

-- Recovery records for removed draft routes can never be looked up again.
DELETE FROM operation_records WHERE path ~ '^/v1/workspaces/[^/]+/bundles/[^/]+/channels/[^/]+/drafts(/|$)';
DELETE FROM idempotency WHERE path ~ '^/v1/workspaces/[^/]+/bundles/[^/]+/channels/[^/]+/drafts(/|$)';

-- The propose right goes with the public proposals route.
INSERT INTO machine_token_events(project_id, token_id, action, actor_principal, reason)
SELECT project_id, id, 'revoked', 'service:migration', 'The propose right was removed'
FROM machine_tokens
WHERE rights = ARRAY['propose'] AND revoked_at IS NULL;
UPDATE machine_tokens
SET revoked_at = now(), revoked_by = 'service:migration', revoke_reason = 'The propose right was removed'
WHERE rights = ARRAY['propose'] AND revoked_at IS NULL;
ALTER TABLE machine_tokens DROP CONSTRAINT machine_tokens_rights_check;
UPDATE machine_tokens
SET rights = CASE WHEN rights = ARRAY['propose'] THEN ARRAY['read'] ELSE array_remove(rights, 'propose') END
WHERE 'propose' = ANY(rights);
ALTER TABLE machine_tokens ADD CONSTRAINT machine_tokens_rights_check
    CHECK (cardinality(rights) BETWEEN 1 AND 4
           AND rights <@ ARRAY['read', 'evaluate', 'write', 'promote']);
