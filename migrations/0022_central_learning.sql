ALTER TABLE learning_rounds ADD COLUMN runtime jsonb;

CREATE TABLE executor_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE workspace_model_providers (
    project_id text PRIMARY KEY REFERENCES projects(id),
    base_url text NOT NULL,
    encrypted_key bytea NOT NULL,
    allowed_models text[] NOT NULL
);

CREATE TABLE learning_trials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    version_id uuid NOT NULL,
    runtime jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,bundle_id,version_id) REFERENCES versions(project_id,bundle_id,id)
);

CREATE TABLE learning_rollouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id uuid REFERENCES learning_evaluations(id),
    trial_id uuid REFERENCES learning_trials(id),
    task_id text NOT NULL,
    rollout smallint NOT NULL CHECK (rollout BETWEEN 1 AND 5),
    input jsonb NOT NULL,
    grader jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','grading','scored','failed','cancelled')),
    lease_id uuid,
    lease_token_hash text,
    lease_owner uuid REFERENCES executor_credentials(id),
    lease_expires_at timestamptz,
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
    score double precision CHECK (score BETWEEN 0 AND 1),
    passed boolean,
    reasons jsonb,
    gateway_log jsonb,
    output text,
    stop text CHECK (stop IN ('completed','token-limit','time-limit')),
    judge_log jsonb,
    error_code text,
    tokens jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(evaluation_id,trial_id) = 1),
    CHECK ((status = 'scored') = (score IS NOT NULL)),
    CHECK ((status = 'scored') = (passed IS NOT NULL)),
    CHECK ((status = 'failed') = (error_code IS NOT NULL)),
    UNIQUE NULLS NOT DISTINCT (evaluation_id,trial_id,task_id,rollout),
    UNIQUE (lease_id)
);
CREATE INDEX learning_rollouts_queue ON learning_rollouts ((trial_id IS NULL),created_at,id) WHERE status='queued';
CREATE INDEX learning_rollouts_expiry ON learning_rollouts (lease_expires_at) WHERE status IN ('running','grading');

-- Service-owned tasks. The revision participates in the key so pinned content survives edits.
ALTER TABLE learning_loops ADD COLUMN task_revision bigint NOT NULL DEFAULT 0;
UPDATE learning_loops SET task_revision = evolve_revision;
CREATE TABLE learning_tasks (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    task_id text NOT NULL CHECK (task_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    "group" text NOT NULL,
    input jsonb NOT NULL,
    grader jsonb NOT NULL,
    source text NOT NULL CHECK (source IN ('import','console','outcome')),
    author text,
    source_file text,
    source_row bigint,
    outcome_id uuid,
    version_id uuid,
    output jsonb,
    confirmed_by text,
    admission text NOT NULL DEFAULT 'pending' CHECK (admission IN ('pending','admitted','set-aside')),
    admission_reason text,
    added_revision bigint NOT NULL,
    retired_revision bigint CHECK (retired_revision > added_revision),
    CHECK ((admission = 'set-aside') = (admission_reason IS NOT NULL)),
    PRIMARY KEY (project_id,bundle_id,task_id,added_revision),
    FOREIGN KEY (project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id)
);
CREATE UNIQUE INDEX learning_tasks_live ON learning_tasks(project_id,bundle_id,task_id) WHERE retired_revision IS NULL;
CREATE TABLE learning_held_out_tasks (LIKE learning_tasks INCLUDING ALL,
    FOREIGN KEY (project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id),
    CHECK (admission <> 'admitted' OR confirmed_by IS NOT NULL)
);
INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,outcome_id,version_id,added_revision)
SELECT project_id,bundle_id,case_id,coalesce(outcome_id::text,case_id),input,jsonb_build_object('type','exact','expected',expected),
       CASE source WHEN 'setup' THEN 'import' ELSE 'outcome' END,outcome_id,version_id,added_revision
FROM learning_evolve_cases WHERE retired_revision IS NULL;
CREATE VIEW learning_round_tasks AS SELECT * FROM learning_tasks WHERE admission='admitted' AND retired_revision IS NULL;
CREATE VIEW learning_round_held_out_tasks AS SELECT * FROM learning_held_out_tasks WHERE admission='admitted' AND retired_revision IS NULL;

CREATE TABLE learning_task_imports (
    id uuid PRIMARY KEY, project_id text NOT NULL, bundle_id uuid NOT NULL, source text NOT NULL,
    digest text NOT NULL, author text NOT NULL, format text NOT NULL, row_count bigint NOT NULL,
    converted_rows bigint NOT NULL DEFAULT 0, set_aside_rows bigint NOT NULL DEFAULT 0,
    FOREIGN KEY(project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id)
);
CREATE TABLE learning_task_import_rows (
    import_id uuid NOT NULL REFERENCES learning_task_imports(id), row_number bigint NOT NULL,
    material jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','converted','set-aside')),
    reason text, PRIMARY KEY(import_id,row_number)
);
-- Remember import source groups and normalized inputs across uploads of the same material.
CREATE TABLE learning_task_groups (
    project_id text NOT NULL, bundle_id uuid NOT NULL, alias text NOT NULL, "group" text NOT NULL,
    PRIMARY KEY(project_id,bundle_id,alias),
    FOREIGN KEY(project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id)
);

-- Executor grading and trial work
ALTER TABLE learning_trials
    ADD COLUMN kind text NOT NULL DEFAULT 'try' CHECK (kind IN ('try','admission','conversion')),
    ADD CHECK (runtime IS NULL OR (coalesce(jsonb_typeof(runtime->'judgeModel') = 'string' AND jsonb_typeof(runtime->'taskModel') = 'string', false) AND runtime->>'judgeModel' <> runtime->>'taskModel'));
ALTER TABLE learning_rounds
    ADD CHECK (runtime IS NULL OR (coalesce(jsonb_typeof(runtime->'judgeModel') = 'string' AND jsonb_typeof(runtime->'taskModel') = 'string', false) AND runtime->>'judgeModel' <> runtime->>'taskModel'));
ALTER TABLE learning_rollouts
    ADD COLUMN votes jsonb,
    ADD COLUMN conversion_result jsonb,
    DROP CONSTRAINT learning_rollouts_status_check,
    ADD CHECK (status IN ('queued','running','grading','scored','converted','failed','cancelled'));

-- The joining task service can consume this row in its own revision transaction.
CREATE VIEW learning_admission_results AS
SELECT t.id AS trial_id, t.project_id, t.bundle_id,
       CASE WHEN NOT ready THEN 'pending'
            WHEN reason IS NULL THEN 'admitted' ELSE 'set-aside' END AS admission,
       CASE WHEN ready THEN reason END AS admission_reason
FROM learning_trials t
JOIN learning_rollouts empty_answer ON empty_answer.trial_id=t.id AND empty_answer.task_id='empty'
LEFT JOIN learning_rollouts reference ON reference.trial_id=t.id AND reference.task_id='reference'
CROSS JOIN LATERAL (
    SELECT empty_answer.status='scored' AND (reference.id IS NULL OR reference.status='scored') AS ready,
           CASE WHEN reference.passed=false THEN 'reference-failed'
                WHEN empty_answer.passed THEN 'empty-passed'
                WHEN coalesce(reference.votes,empty_answer.votes) @> '[true,false]'::jsonb
                     THEN 'judge-unstable' END AS reason
) outcome
WHERE t.kind='admission';

-- Service-side round controls and accounting.
ALTER TABLE learning_loops
    ADD COLUMN task_model text,
    ADD COLUMN judge_model text,
    ADD COLUMN max_rounds_per_day integer NOT NULL DEFAULT 4 CHECK (max_rounds_per_day > 0),
    ADD COLUMN started_at timestamptz,
    ADD COLUMN resumed_at timestamptz,
    ADD COLUMN waiting text CHECK (waiting IN ('no-new-evidence','daily-cap')),
    ADD COLUMN alert jsonb,
    DROP CONSTRAINT learning_loops_pause_reason_check,
    ADD CHECK (pause_reason IN ('operator','failed-rounds','optimizer-context-too-large','tasks-required'));
ALTER TABLE learning_rounds
    ADD COLUMN task_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN task_model text,
    ADD COLUMN judge_model text,
    ADD COLUMN trigger text NOT NULL DEFAULT 'start',
    ADD COLUMN incumbent_reused boolean NOT NULL DEFAULT false;
ALTER TABLE learning_candidates DROP CONSTRAINT learning_candidates_drop_reason_check,
    ADD CHECK (drop_reason IN ('provider-failed','format-rejected','scanner-rejected','no-change','blocked-version'));
CREATE TABLE learning_blocked_versions (
    project_id text NOT NULL, bundle_id uuid NOT NULL, digest text NOT NULL,
    removed_by text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id,bundle_id,digest),
    FOREIGN KEY(project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id)
);
CREATE TABLE learning_usage (
    project_id text NOT NULL, bundle_id uuid NOT NULL, day date NOT NULL,
    rounds bigint NOT NULL DEFAULT 0, rollouts bigint NOT NULL DEFAULT 0,
    optimizer_tokens bigint NOT NULL DEFAULT 0, task_tokens bigint NOT NULL DEFAULT 0, judge_tokens bigint NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id,bundle_id,day),
    FOREIGN KEY(project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id)
);
CREATE FUNCTION learning_record_rollout_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO learning_usage(project_id,bundle_id,day,rollouts,task_tokens,judge_tokens)
    SELECT r.project_id,r.bundle_id,(now() AT TIME ZONE 'UTC')::date,1,
        coalesce((NEW.tokens #>> '{task,input}')::bigint,0)+coalesce((NEW.tokens #>> '{task,output}')::bigint,0),
        coalesce((NEW.tokens #>> '{judge,input}')::bigint,0)+coalesce((NEW.tokens #>> '{judge,output}')::bigint,0)
    FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id WHERE e.id=NEW.evaluation_id
    ON CONFLICT(project_id,bundle_id,day) DO UPDATE SET rollouts=learning_usage.rollouts+1,
        task_tokens=learning_usage.task_tokens+excluded.task_tokens,judge_tokens=learning_usage.judge_tokens+excluded.judge_tokens;
    RETURN NEW;
END $$;
CREATE TRIGGER learning_rollout_usage AFTER UPDATE OF status ON learning_rollouts FOR EACH ROW
    WHEN (NEW.evaluation_id IS NOT NULL AND NEW.status='scored' AND OLD.status<>'scored') EXECUTE FUNCTION learning_record_rollout_usage();
ALTER TABLE learning_evaluations ADD COLUMN measurement text NOT NULL DEFAULT 'initial'
    CHECK (measurement IN ('initial','confirm-parent','confirm-adoption')),
    DROP CONSTRAINT learning_evaluations_round_id_role_sample_key,
    ADD UNIQUE NULLS NOT DISTINCT (round_id,role,sample,measurement),
    ADD CHECK (measurement='initial' OR role='retained');

-- Evidence from real candidate evaluations only. A task edit resets its evidence.
CREATE VIEW learning_flagged_tasks AS
SELECT t.project_id,t.bundle_id,t.task_id,
    CASE WHEN bool_or(errored) THEN 'rollout-error'
         WHEN bool_or(passes BETWEEN 1 AND 4) THEN 'split-rollouts'
         ELSE 'persistent-failure' END AS reason
FROM learning_tasks t JOIN learning_rounds r ON (r.project_id,r.bundle_id)=(t.project_id,t.bundle_id)
    AND r.task_revision>=t.added_revision
JOIN learning_evaluations e ON e.round_id=r.id AND e.role='candidate' AND e.status='scored'
CROSS JOIN LATERAL jsonb_array_elements(e.report->'cases') c
CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE v->>'passed'='true') passes,bool_or(v->>'error' IS NOT NULL) errored
    FROM jsonb_array_elements(c->'rollouts') v
) verdict
WHERE t.retired_revision IS NULL AND c->>'caseId'=t.task_id
GROUP BY t.project_id,t.bundle_id,t.task_id
HAVING bool_or(errored OR passes BETWEEN 1 AND 4)
    OR (count(DISTINCT r.number)>=2 AND max(passes)<3);

-- Admission can finish after the round that pinned the pending task's revision.
ALTER TABLE learning_tasks ADD COLUMN admission_revision bigint;
ALTER TABLE learning_held_out_tasks ADD COLUMN admission_revision bigint;
CREATE FUNCTION learning_stamp_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE learning_loops SET task_revision=task_revision+1
    WHERE (project_id,bundle_id)=(NEW.project_id,NEW.bundle_id)
    RETURNING task_revision INTO NEW.admission_revision;
    RETURN NEW;
END $$;
CREATE TRIGGER learning_evolve_admission_revision BEFORE UPDATE OF admission ON learning_tasks
    FOR EACH ROW WHEN (OLD.admission IS DISTINCT FROM NEW.admission AND
        (OLD.admission='admitted' OR NEW.admission='admitted')) EXECUTE FUNCTION learning_stamp_admission();
CREATE TRIGGER learning_held_out_admission_revision BEFORE UPDATE OF admission ON learning_held_out_tasks
    FOR EACH ROW WHEN (OLD.admission IS DISTINCT FROM NEW.admission AND
        (OLD.admission='admitted' OR NEW.admission='admitted')) EXECUTE FUNCTION learning_stamp_admission();

-- Admission and conversion are dispatched from their durable source rows.
ALTER TABLE learning_loops ADD COLUMN IF NOT EXISTS task_model text,
                           ADD COLUMN IF NOT EXISTS judge_model text;
ALTER TABLE learning_tasks ADD COLUMN admission_trial uuid REFERENCES learning_trials(id);
ALTER TABLE learning_held_out_tasks ADD COLUMN admission_trial uuid REFERENCES learning_trials(id);
ALTER TABLE learning_task_imports ADD COLUMN conversion_trial uuid REFERENCES learning_trials(id);
ALTER TABLE learning_trials ADD COLUMN held_out boolean NOT NULL DEFAULT true;

CREATE INDEX learning_tasks_admission_trial ON learning_tasks(admission_trial) WHERE admission_trial IS NOT NULL;
CREATE INDEX learning_held_out_tasks_admission_trial ON learning_held_out_tasks(admission_trial) WHERE admission_trial IS NOT NULL;
CREATE INDEX learning_imports_conversion_trial ON learning_task_imports(conversion_trial) WHERE conversion_trial IS NOT NULL;
