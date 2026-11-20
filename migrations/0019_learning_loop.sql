CREATE TABLE learning_loops (
    project_id      text NOT NULL,
    bundle_id       uuid NOT NULL,
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','paused','stopped')),
    channel         text NOT NULL,                 -- the learning channel
    app_principal   text NOT NULL,                 -- a machine-token principal (machine:…) or a static grant principal
    setting         jsonb NOT NULL CHECK (jsonb_typeof(setting) = 'object'),   -- {domain, benchmark, policyModel}
    held_out        jsonb NOT NULL CHECK (jsonb_typeof(held_out) = 'object'),  -- {digest, cases}
    evolve_revision bigint  NOT NULL DEFAULT 0 CHECK (evolve_revision >= 0),
    memory_revision bigint  NOT NULL DEFAULT 0 CHECK (memory_revision >= 0),
    next_round      integer NOT NULL DEFAULT 1 CHECK (next_round >= 1),
    failed_rounds   integer NOT NULL DEFAULT 0 CHECK (failed_rounds >= 0),
    pause_reason    text CHECK (pause_reason IN ('operator','failed-rounds','optimizer-context-too-large')),
    enrolled_by     text NOT NULL,                 -- user:… who last enrolled; record only
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, bundle_id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles (project_id, id),
    FOREIGN KEY (project_id, bundle_id, channel) REFERENCES channels (project_id, bundle_id, name),
    CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
);

CREATE TABLE learning_evolve_cases (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    case_id text NOT NULL,
    input jsonb NOT NULL,
    expected jsonb NOT NULL,
    source text NOT NULL CHECK (source IN ('setup', 'outcome')),
    outcome_id uuid,
    version_id uuid,
    added_revision bigint NOT NULL CHECK (added_revision > 0),
    retired_revision bigint,
    PRIMARY KEY (project_id, bundle_id, case_id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES learning_loops(project_id, bundle_id),
    FOREIGN KEY (project_id, bundle_id, version_id) REFERENCES versions(project_id, bundle_id, id),
    UNIQUE (project_id, bundle_id, outcome_id),
    CHECK ((source = 'outcome') = (outcome_id IS NOT NULL)),
    CHECK ((source = 'outcome') = (version_id IS NOT NULL)),
    CHECK (source = 'setup' OR case_id = 'outcome:' || outcome_id::text),
    CHECK (source = 'outcome' OR case_id NOT LIKE 'outcome:%'),
    CHECK (retired_revision IS NULL OR retired_revision > added_revision),
    CHECK (case_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);
CREATE INDEX learning_evolve_cases_live
    ON learning_evolve_cases (project_id, bundle_id, added_revision)
    WHERE retired_revision IS NULL;

CREATE TABLE learning_rounds (
    id                 uuid PRIMARY KEY,
    project_id         text NOT NULL,
    bundle_id          uuid NOT NULL,
    number             integer NOT NULL CHECK (number >= 1),
    state              text NOT NULL CHECK (state IN
                         ('scoring_incumbent','proposing','screening','evaluating','selecting',
                          'scoring_held_out','completed','failed','stopped')),
    decision           text CHECK (decision IN ('adopted','kept')),
    reason             text,
    parent_version_id  uuid NOT NULL,
    channel            text NOT NULL,     -- the learning channel, pinned at start_round
    channel_revision   bigint NOT NULL,
    evolve_revision    bigint NOT NULL,
    memory_revision    bigint NOT NULL,
    memory_digest      text,              -- set on entering proposing
    history_digest     text,              -- set on entering proposing
    setting            jsonb NOT NULL,
    held_out           jsonb NOT NULL,    -- the held-out commitment {digest, cases}, pinned at start_round
    optimizer_model    text,              -- ACCLIMATE_MODEL at start_round, NULL when none is configured
    adopted_sample     smallint CHECK (adopted_sample BETWEEN 1 AND 5),
    adopted_version_id uuid,
    selection          jsonb,             -- {decision, sample, versionId, digest, reason, model, inputDigest}
    incumbent_score    double precision,
    held_out_score     double precision,
    held_out_error     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    ended_at           timestamptz,
    UNIQUE (project_id, bundle_id, number),
    UNIQUE (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES learning_loops (project_id, bundle_id),
    FOREIGN KEY (project_id, bundle_id, parent_version_id) REFERENCES versions (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, adopted_version_id) REFERENCES versions (project_id, bundle_id, id),
    CHECK ((state IN ('completed','failed','stopped')) = (ended_at IS NOT NULL)),
    CHECK (CASE
        WHEN state IN ('scoring_incumbent','proposing','screening','evaluating','selecting')
            THEN decision IS NULL AND reason IS NULL
        WHEN state IN ('scoring_held_out','completed') THEN decision IS NOT NULL
        WHEN state = 'failed' THEN decision IS NULL AND reason IN
            ('incumbent-evaluation-failed','optimizer-unavailable','optimizer-context-too-large','selector-unavailable')
        WHEN state = 'stopped' THEN decision IS NOT NULL OR reason = 'stopped'
    END),
    CHECK (decision IS DISTINCT FROM 'kept' OR reason IN
        ('selector-kept','no-candidates','no-survivors','no-evaluated-candidates','channel-moved')),
    CHECK (decision IS DISTINCT FROM 'adopted' OR (reason IS NULL AND selection IS NOT NULL)),
    CHECK ((decision IS NOT DISTINCT FROM 'adopted') = (adopted_sample IS NOT NULL)),
    CHECK ((adopted_sample IS NULL) = (adopted_version_id IS NULL)),
    CHECK (reason NOT IN ('selector-kept','channel-moved') OR selection IS NOT NULL),
    CHECK (state NOT IN ('proposing','screening','evaluating','selecting','scoring_held_out','completed')
           OR incumbent_score IS NOT NULL),
    CHECK (state <> 'completed' OR held_out_score IS NOT NULL OR held_out_error IS NOT NULL),
    CHECK (held_out_score IS NULL OR held_out_error IS NULL)
);

CREATE UNIQUE INDEX learning_rounds_one_active ON learning_rounds (project_id, bundle_id)
    WHERE state IN ('scoring_incumbent','proposing','screening','evaluating','selecting','scoring_held_out');

CREATE TABLE learning_evaluations (
    id uuid PRIMARY KEY,
    round_id uuid NOT NULL REFERENCES learning_rounds(id),
    role text NOT NULL CHECK (role IN ('incumbent', 'candidate', 'retained')),
    sample smallint CHECK (sample BETWEEN 1 AND 5),
    split text NOT NULL CHECK (split IN ('evolve', 'held_out')),
    version_id uuid NOT NULL REFERENCES versions(id),
    digest text NOT NULL,
    evolve_revision bigint,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'scored', 'failed', 'cancelled')),
    attempt_id text CHECK (octet_length(attempt_id) BETWEEN 1 AND 128),
    report jsonb NOT NULL DEFAULT '{"cases": []}',
    score double precision CHECK (score >= 0 AND score <= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    deadline_at timestamptz NOT NULL,
    error text CHECK (octet_length(error) <= 4096),
    UNIQUE NULLS NOT DISTINCT (round_id, role, sample),
    CHECK ((role = 'candidate') = (sample IS NOT NULL)),
    CHECK ((role = 'retained') = (split = 'held_out')),
    CHECK ((split = 'evolve') = (evolve_revision IS NOT NULL)),
    CHECK ((status = 'scored') = (score IS NOT NULL)),
    CHECK (status NOT IN ('running', 'scored') OR (attempt_id IS NOT NULL AND started_at IS NOT NULL))
);
-- W3 in loop.md: at most one open evaluation per round.
CREATE UNIQUE INDEX learning_evaluations_one_open ON learning_evaluations (round_id)
    WHERE status IN ('queued', 'running');
