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
