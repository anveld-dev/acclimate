UPDATE learning_rollouts SET status='cancelled',lease_token_hash=NULL
WHERE evaluation_id IS NOT NULL AND status IN ('queued','running','grading');
UPDATE learning_evaluations SET status='cancelled',error='stopped'
WHERE status IN ('queued','running');
UPDATE learning_optimizer_calls SET status='failed',error_code='cancelled',error='stopped'
WHERE status IN ('queued','running');
UPDATE learning_candidates SET status='evaluation_failed' WHERE status='evaluating';
UPDATE learning_rounds SET state='stopped', ended_at=now(),
    reason=CASE WHEN decision IS NULL THEN 'stopped' ELSE reason END
WHERE ended_at IS NULL;
UPDATE learning_loops SET status='paused',pause_reason='tasks-required',waiting=NULL,started_at=NULL
WHERE status='running';

-- Import live cases written after the additive migration. Preserve a task that was
-- edited or retired through the task API, and avoid duplicating a held-out outcome.
INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,outcome_id,version_id,added_revision,retired_revision)
SELECT c.project_id,c.bundle_id,c.case_id,coalesce(c.outcome_id::text,c.case_id),c.input,
       jsonb_build_object('type','exact','expected',c.expected),
       CASE c.source WHEN 'setup' THEN 'import' ELSE 'outcome' END,c.outcome_id,c.version_id,c.added_revision,c.retired_revision
FROM learning_evolve_cases c WHERE NOT EXISTS(SELECT FROM learning_tasks t WHERE (t.project_id,t.bundle_id,t.task_id)=(c.project_id,c.bundle_id,c.case_id))
AND NOT EXISTS(SELECT FROM learning_held_out_tasks t WHERE (t.project_id,t.bundle_id,t.task_id)=(c.project_id,c.bundle_id,c.case_id));
-- A setup case retired through the old route may still have its original task row.
UPDATE learning_tasks t SET retired_revision=c.retired_revision
FROM learning_evolve_cases c WHERE c.retired_revision IS NOT NULL AND c.source='setup'
    AND t.retired_revision IS NULL
    AND (t.project_id,t.bundle_id,t.task_id,t.added_revision)=(c.project_id,c.bundle_id,c.case_id,c.added_revision);
UPDATE learning_loops SET task_revision=greatest(task_revision,evolve_revision);
DROP TABLE learning_evolve_cases;
ALTER TABLE learning_loops DROP COLUMN evolve_revision, DROP COLUMN held_out, DROP COLUMN app_principal;
UPDATE learning_rounds SET task_revision=evolve_revision WHERE runtime IS NULL;
ALTER TABLE learning_rounds DROP COLUMN held_out, DROP COLUMN evolve_revision;
ALTER TABLE learning_rounds ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE learning_evaluations DROP COLUMN attempt_id, DROP COLUMN deadline_at,
    ADD CHECK (status NOT IN ('running','scored') OR started_at IS NOT NULL);
DROP INDEX learning_evaluations_one_open;
CREATE INDEX learning_evaluations_open ON learning_evaluations(round_id) WHERE status IN ('queued','running');
ALTER TABLE machine_tokens DROP CONSTRAINT machine_tokens_rights_check;
UPDATE machine_tokens t SET rights=ARRAY(
    SELECT mapped FROM unnest(array_replace(t.rights,'evaluate','read')) WITH ORDINALITY AS r(mapped,i)
    GROUP BY mapped ORDER BY min(i)
) WHERE 'evaluate'=ANY(rights);
ALTER TABLE machine_tokens ADD CONSTRAINT machine_tokens_rights_check
    CHECK(cardinality(rights) BETWEEN 1 AND 3 AND rights <@ ARRAY['read','write','promote']);

CREATE FUNCTION learning_flagged_tasks(min_passes integer) RETURNS TABLE(project_id text,bundle_id uuid,task_id text,reason text) LANGUAGE sql STABLE AS $$
WITH evidence AS (
    SELECT t.project_id,t.bundle_id,t.task_id,r.id AS round_id,e.id,
        bool_or(l.status='failed') AS errored,
        bool_or(l.votes @> '[true,false]'::jsonb) AS disagreed,
        count(*) FILTER(WHERE l.passed) AS passes, bool_and(l.status='scored') AS scored
    FROM learning_tasks t JOIN learning_rounds r USING(project_id,bundle_id)
    JOIN learning_evaluations e ON e.round_id=r.id AND e.role='candidate'
    JOIN learning_rollouts l ON l.evaluation_id=e.id AND l.task_id=t.task_id
    WHERE t.retired_revision IS NULL AND r.task_revision>=t.added_revision AND e.status IN ('scored','failed')
    GROUP BY t.project_id,t.bundle_id,t.task_id,r.id,e.id
)
SELECT project_id,bundle_id,task_id,
    CASE WHEN bool_or(errored) THEN 'rollout-error'
         WHEN bool_or(disagreed) THEN 'judge-disagreement'
         ELSE 'persistent-failure' END AS reason
FROM evidence GROUP BY project_id,bundle_id,task_id
HAVING bool_or(errored OR disagreed)
    OR (count(DISTINCT round_id) FILTER(WHERE scored)>=2 AND max(passes) FILTER(WHERE scored)<min_passes);
$$;

CREATE TABLE learning_alert_deliveries (
    round_id uuid NOT NULL REFERENCES learning_rounds(id),
    user_id uuid NOT NULL REFERENCES users(id),
    previous_score double precision NOT NULL,
    score double precision NOT NULL,
    flipped_tasks integer NOT NULL,
    attempts smallint NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    PRIMARY KEY(round_id,user_id)
);

-- 0019 did not name the state/decision check. Resolve its name from the
-- original predicate so the migration also works on renamed constraints.
DO $$
DECLARE old_check name;
BEGIN
    SELECT conname INTO STRICT old_check FROM pg_constraint
    WHERE conrelid='learning_rounds'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%incumbent-evaluation-failed%';
    EXECUTE format('ALTER TABLE learning_rounds DROP CONSTRAINT %I',old_check);
END $$;

ALTER TABLE learning_rounds
    ADD COLUMN reverted boolean NOT NULL DEFAULT false,
    ADD COLUMN unmatched_since timestamptz,
    ADD COLUMN confirmed_parent_score double precision CHECK(confirmed_parent_score BETWEEN 0 AND 1),
    ADD COLUMN confirmed_adoption_score double precision CHECK(confirmed_adoption_score BETWEEN 0 AND 1),
    ADD CONSTRAINT learning_round_decision_state CHECK (CASE
        WHEN state IN ('scoring_incumbent','proposing','screening','evaluating','selecting')
            THEN decision IS NULL AND reason IS NULL
        WHEN state IN ('scoring_held_out','completed') THEN decision IS NOT NULL
        WHEN state = 'failed' AND decision IS NOT NULL THEN held_out_error IS NOT NULL
        WHEN state = 'failed' THEN reason IS NOT NULL AND reason IN
            ('incumbent-evaluation-failed','candidate-evaluation-failed','optimizer-unavailable',
             'optimizer-context-too-large','selector-unavailable','no-matching-executor')
        WHEN state = 'stopped' THEN decision IS NOT NULL OR reason = 'stopped'
    END);

-- The full trace stays on the rollout. The optimizer already receives the bundle.
CREATE FUNCTION learning_feedback_log(entries jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(entry #> '{request,messages}')='array'
    THEN jsonb_set(entry,'{request,messages}',coalesce((
        SELECT jsonb_agg(msg ORDER BY pos) FROM jsonb_array_elements(entry #> '{request,messages}')
        WITH ORDINALITY messages(msg,pos) WHERE msg->>'role' IS DISTINCT FROM 'system'
    ),'[]')) ELSE entry END ORDER BY ord),'[]')
 FROM jsonb_array_elements(entries) WITH ORDINALITY logs(entry,ord)
$$;
