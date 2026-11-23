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
INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,outcome_id,version_id,added_revision)
SELECT c.project_id,c.bundle_id,c.case_id,coalesce(c.outcome_id::text,c.case_id),c.input,
       jsonb_build_object('type','exact','expected',c.expected),
       CASE c.source WHEN 'setup' THEN 'import' ELSE 'outcome' END,c.outcome_id,c.version_id,c.added_revision
FROM learning_evolve_cases c WHERE c.retired_revision IS NULL
AND NOT EXISTS(SELECT FROM learning_tasks t WHERE (t.project_id,t.bundle_id,t.task_id)=(c.project_id,c.bundle_id,c.case_id))
AND NOT EXISTS(SELECT FROM learning_held_out_tasks t WHERE (t.project_id,t.bundle_id,t.task_id)=(c.project_id,c.bundle_id,c.case_id));
-- A setup case retired through the old route may still have its original task row.
UPDATE learning_tasks t SET retired_revision=c.retired_revision
FROM learning_evolve_cases c WHERE c.retired_revision IS NOT NULL AND c.source='setup'
    AND t.retired_revision IS NULL
    AND (t.project_id,t.bundle_id,t.task_id,t.added_revision)=(c.project_id,c.bundle_id,c.case_id,c.added_revision);
UPDATE learning_loops SET task_revision=greatest(task_revision,evolve_revision);
DROP TABLE learning_evolve_cases;
ALTER TABLE learning_loops DROP COLUMN evolve_revision, DROP COLUMN held_out, DROP COLUMN app_principal;
ALTER TABLE learning_rounds DROP COLUMN held_out;
ALTER TABLE learning_evaluations DROP COLUMN attempt_id, DROP COLUMN deadline_at,
    ADD CHECK (status NOT IN ('running','scored') OR started_at IS NOT NULL);
DROP INDEX learning_evaluations_one_open;
CREATE INDEX learning_evaluations_open ON learning_evaluations(round_id) WHERE status IN ('queued','running');
ALTER TABLE machine_tokens DROP CONSTRAINT machine_tokens_rights_check;
UPDATE machine_tokens t SET rights=coalesce((SELECT array_agg(right_name ORDER BY position)
    FROM (SELECT right_name,min(i) position FROM unnest(t.rights) WITH ORDINALITY AS r(right_name,i)
          WHERE right_name <> 'evaluate' GROUP BY right_name) remaining), ARRAY['read']);
ALTER TABLE machine_tokens ADD CONSTRAINT machine_tokens_rights_check
    CHECK(cardinality(rights) BETWEEN 1 AND 3 AND rights <@ ARRAY['read','write','promote']);

-- Record the identity announced by a credential's most recent lease poll.
ALTER TABLE executor_credentials ADD COLUMN runtime jsonb, ADD COLUMN last_seen_at timestamptz;

CREATE OR REPLACE VIEW learning_flagged_tasks AS
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
         WHEN bool_or(scored AND passes BETWEEN 1 AND 4) THEN 'split-rollouts'
         ELSE 'persistent-failure' END AS reason
FROM evidence GROUP BY project_id,bundle_id,task_id
HAVING bool_or(errored OR disagreed OR (scored AND passes BETWEEN 1 AND 4))
    OR (count(DISTINCT round_id) FILTER(WHERE scored)>=2 AND max(passes) FILTER(WHERE scored)<3);

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

ALTER TABLE learning_rounds
    ADD COLUMN confirmed_parent_score double precision CHECK(confirmed_parent_score BETWEEN 0 AND 1),
    ADD COLUMN confirmed_adoption_score double precision CHECK(confirmed_adoption_score BETWEEN 0 AND 1),
    DROP CONSTRAINT learning_rounds_check1,
    ADD CONSTRAINT learning_round_decision_state CHECK (CASE
        WHEN state IN ('scoring_incumbent','proposing','screening','evaluating','selecting')
            THEN decision IS NULL AND reason IS NULL
        WHEN state IN ('scoring_held_out','completed') THEN decision IS NOT NULL
        WHEN state = 'failed' AND decision IS NOT NULL THEN held_out_error IS NOT NULL
        WHEN state = 'failed' THEN reason IS NOT NULL AND reason IN
            ('incumbent-evaluation-failed','candidate-evaluation-failed','optimizer-unavailable',
             'optimizer-context-too-large','selector-unavailable')
        WHEN state = 'stopped' THEN decision IS NOT NULL OR reason = 'stopped'
    END);
