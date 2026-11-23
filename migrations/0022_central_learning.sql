ALTER TABLE learning_rounds ADD COLUMN runtime jsonb CHECK (runtime IS NULL OR (coalesce(jsonb_typeof(runtime->'judgeModel') = 'string' AND jsonb_typeof(runtime->'taskModel') = 'string', false) AND runtime->>'judgeModel' <> runtime->>'taskModel'));

CREATE TABLE executor_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    runtime jsonb,
    last_seen_at timestamptz,
    revoked_at timestamptz
);

CREATE TABLE workspace_model_providers (
    project_id text PRIMARY KEY REFERENCES projects(id),
    base_url text NOT NULL,
    encrypted_key bytea NOT NULL,
    verification jsonb NOT NULL DEFAULT '{"status":"pending","checkedAt":null,"models":[]}',
    probe_id uuid UNIQUE,
    probe_token text,
    probe_owner uuid REFERENCES executor_credentials(id),
    probe_expires timestamptz,
    probe_attempts smallint NOT NULL DEFAULT 0,
    allowed_models text[] NOT NULL
);

CREATE TABLE learning_trials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    version_id uuid NOT NULL,
    kind text NOT NULL DEFAULT 'try' CHECK (kind IN ('try','admission','conversion','head-monitor')),
    task_revision bigint,
    held_out boolean NOT NULL DEFAULT true,
    runtime jsonb NOT NULL CHECK (runtime IS NULL OR (coalesce(jsonb_typeof(runtime->'judgeModel') = 'string' AND jsonb_typeof(runtime->'taskModel') = 'string', false) AND runtime->>'judgeModel' <> runtime->>'taskModel')),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,bundle_id,version_id) REFERENCES versions(project_id,bundle_id,id)
);

CREATE FUNCTION learning_rollouts_per_task() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

CREATE TABLE learning_rollouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id uuid REFERENCES learning_evaluations(id),
    trial_id uuid REFERENCES learning_trials(id),
    task_id text NOT NULL,
    rollout smallint NOT NULL CHECK (rollout BETWEEN 1 AND learning_rollouts_per_task()),
    input jsonb NOT NULL,
    grader jsonb NOT NULL,
    votes jsonb,
    conversion_result jsonb,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','grading','scored','converted','failed','cancelled')),
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
    stop text CHECK (stop IN ('completed','token-limit','time-limit','invalid-output')),
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
    admission_revision bigint,
    admission_trial uuid REFERENCES learning_trials(id),
    admission_reason text,
    added_revision bigint NOT NULL,
    retired_revision bigint CHECK (retired_revision > added_revision),
    CHECK ((admission = 'set-aside') = (admission_reason IS NOT NULL)),
    PRIMARY KEY (project_id,bundle_id,task_id,added_revision),
    FOREIGN KEY (project_id,bundle_id) REFERENCES learning_loops(project_id,bundle_id)
);
CREATE UNIQUE INDEX learning_tasks_live ON learning_tasks(project_id,bundle_id,task_id) WHERE retired_revision IS NULL;
CREATE TABLE learning_held_out_tasks (LIKE learning_tasks INCLUDING ALL,
    FOREIGN KEY(admission_trial) REFERENCES learning_trials(id),
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
    conversion_trial uuid REFERENCES learning_trials(id),
    UNIQUE(project_id,bundle_id,digest),
    failure text,
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
    SELECT empty_answer.status IN ('failed','cancelled') OR coalesce(reference.status IN ('failed','cancelled'),false) OR
           (empty_answer.status='scored' AND (reference.id IS NULL OR reference.status='scored')) AS ready,
           CASE WHEN empty_answer.status IN ('failed','cancelled') OR reference.status IN ('failed','cancelled') THEN 'check-failed'
                WHEN reference.passed=false THEN 'reference-failed'
                WHEN empty_answer.passed THEN 'empty-passed'
                WHEN reference.votes @> '[true,false]'::jsonb OR empty_answer.votes @> '[true,false]'::jsonb
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
    ADD COLUMN waiting text CHECK (waiting IN ('no-new-evidence','daily-cap','no-executor','models-not-allowed')),
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
    FOREIGN KEY(project_id,bundle_id) REFERENCES bundles(project_id,id)
);
CREATE FUNCTION learning_record_rollout_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO learning_usage(project_id,bundle_id,day,rollouts,task_tokens,judge_tokens)
    SELECT r.project_id,r.bundle_id,(now() AT TIME ZONE 'UTC')::date,1,
        coalesce((NEW.tokens #>> '{task,input}')::bigint,0)+coalesce((NEW.tokens #>> '{task,output}')::bigint,0),
        coalesce((NEW.tokens #>> '{judge,input}')::bigint,0)+coalesce((NEW.tokens #>> '{judge,output}')::bigint,0)
    FROM (SELECT r.project_id,r.bundle_id FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id WHERE e.id=NEW.evaluation_id
          UNION ALL SELECT project_id,bundle_id FROM learning_trials WHERE id=NEW.trial_id) r
    ON CONFLICT(project_id,bundle_id,day) DO UPDATE SET rollouts=learning_usage.rollouts+1,
        task_tokens=learning_usage.task_tokens+excluded.task_tokens,judge_tokens=learning_usage.judge_tokens+excluded.judge_tokens;
    RETURN NEW;
END $$;
CREATE TRIGGER learning_rollout_usage AFTER UPDATE OF status ON learning_rollouts FOR EACH ROW
    WHEN (OLD.status IN ('running','grading') AND NEW.status IN ('queued','failed','scored','converted')) EXECUTE FUNCTION learning_record_rollout_usage();
ALTER TABLE learning_evaluations ADD COLUMN measurement text NOT NULL DEFAULT 'initial'
    CHECK (measurement IN ('initial','baseline-parent','confirm-parent','confirm-adoption')),
    DROP CONSTRAINT learning_evaluations_round_id_role_sample_key,
    ADD UNIQUE NULLS NOT DISTINCT (round_id,role,sample,measurement),
    ADD CHECK (measurement='initial' OR role='retained');

CREATE INDEX learning_tasks_admission_trial ON learning_tasks(admission_trial) WHERE admission_trial IS NOT NULL;
CREATE INDEX learning_held_out_tasks_admission_trial ON learning_held_out_tasks(admission_trial) WHERE admission_trial IS NOT NULL;
CREATE INDEX learning_imports_conversion_trial ON learning_task_imports(conversion_trial) WHERE conversion_trial IS NOT NULL;

CREATE INDEX learning_rollouts_trial ON learning_rollouts(trial_id) WHERE trial_id IS NOT NULL;
