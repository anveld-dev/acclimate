ALTER TABLE learning_task_imports DROP CONSTRAINT learning_task_imports_project_id_bundle_id_digest_key;
CREATE UNIQUE INDEX learning_import_active_digest ON learning_task_imports(project_id,bundle_id,digest) WHERE failure IS NULL;

ALTER TABLE learning_evaluations ADD COLUMN measurement_retries integer NOT NULL DEFAULT 0;

CREATE VIEW present_executors AS
SELECT id,runtime,last_seen_at FROM executor_credentials WHERE revoked_at IS NULL AND last_seen_at > now()-interval '1 minute'
UNION ALL
SELECT c.id,coalesce(r.runtime,t.runtime)->'executor',c.last_seen_at
FROM learning_rollouts l JOIN executor_credentials c ON c.id=l.lease_owner
LEFT JOIN learning_trials t ON t.id=l.trial_id
LEFT JOIN learning_evaluations e ON e.id=l.evaluation_id
LEFT JOIN learning_rounds r ON r.id=e.round_id
WHERE c.revoked_at IS NULL AND l.status IN ('running','grading') AND l.lease_expires_at>now();

ALTER TABLE learning_alert_deliveries ALTER COLUMN previous_score DROP NOT NULL, ALTER COLUMN score DROP NOT NULL, ALTER COLUMN flipped_tasks DROP NOT NULL;
