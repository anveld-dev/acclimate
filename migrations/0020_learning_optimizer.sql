CREATE TABLE learning_candidates (
  round_id      uuid NOT NULL REFERENCES learning_rounds(id) ON DELETE CASCADE,
  sample        smallint NOT NULL CHECK (sample BETWEEN 1 AND 5),
  status        text NOT NULL DEFAULT 'generating' CHECK (status IN
                  ('generating','generated','dropped','screened_out','evaluating','evaluated','evaluation_failed')),
  drop_reason   text CHECK (drop_reason IN
                  ('provider-failed','format-rejected','scanner-rejected','no-change')),
  rationale     text,
  changes       jsonb,
  diagnosis     jsonb,
  scan          jsonb,
  screen        jsonb,
  version_id    uuid REFERENCES versions(id),
  evaluation_id uuid REFERENCES learning_evaluations(id),
  evolve_score  double precision CHECK (evolve_score BETWEEN 0 AND 1),
  PRIMARY KEY (round_id, sample),
  CHECK ((status = 'dropped') = (drop_reason IS NOT NULL)),
  -- predictions are on disk before any screen or evaluation can exist
  CHECK (status IN ('generating','dropped')
         OR (rationale IS NOT NULL AND changes IS NOT NULL AND diagnosis IS NOT NULL AND scan IS NOT NULL)),
  CHECK (drop_reason IS DISTINCT FROM 'scanner-rejected'
         OR (rationale IS NULL AND changes IS NULL AND scan IS NOT NULL)),
  CHECK (status <> 'screened_out' OR (screen->>'verdict') IS NOT DISTINCT FROM 'skip'),
  CHECK (status NOT IN ('evaluating','evaluated','evaluation_failed')
         OR ((screen->>'verdict') IS NOT DISTINCT FROM 'evaluate'
             AND version_id IS NOT NULL AND evaluation_id IS NOT NULL)),
  CHECK ((status = 'evaluated') = (evolve_score IS NOT NULL))
);

CREATE TABLE learning_optimizer_calls (
  round_id     uuid NOT NULL REFERENCES learning_rounds(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('propose','screen','select')),
  sample       smallint NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  input_digest text NOT NULL,          -- set by advance_round when it creates the call
  output       jsonb,
  error_code   text CHECK (error_code IN
                 ('provider-failed','format-rejected','optimizer-context-too-large','scanner-rejected','cancelled')),
  error        text,                   -- free text for operators
  claimed_at   timestamptz,
  PRIMARY KEY (round_id, kind, sample),
  CHECK (CASE WHEN kind = 'propose' THEN sample BETWEEN 1 AND 5 ELSE sample = 0 END),
  CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CHECK (status <> 'succeeded' OR output IS NOT NULL),
  CHECK (status <> 'failed' OR ((output IS NOT NULL) = (error_code = 'scanner-rejected'))),
  CHECK (error_code IS DISTINCT FROM 'scanner-rejected' OR kind = 'propose'),
  CHECK (status <> 'running' OR claimed_at IS NOT NULL)
);
-- W3 in loop.md: at most one open call per round.
CREATE UNIQUE INDEX learning_optimizer_calls_one_open ON learning_optimizer_calls (round_id)
    WHERE status IN ('queued','running');

ALTER TABLE learning_rounds
    ADD FOREIGN KEY (id, adopted_sample) REFERENCES learning_candidates (round_id, sample);

CREATE TABLE learning_memory_problems (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    problem_id text NOT NULL CHECK (problem_id ~ '^P[1-9][0-9]{0,8}$'),
    root_cause text NOT NULL CHECK (octet_length(root_cause) BETWEEN 1 AND 1024),
    root_cause_key text NOT NULL CHECK (root_cause_key ~ '^[0-9a-f]{64}$'),
    opened_round integer NOT NULL CHECK (opened_round >= 1),
    opened_revision integer NOT NULL CHECK (opened_revision >= 1),
    PRIMARY KEY (project_id, bundle_id, problem_id),
    UNIQUE (project_id, bundle_id, root_cause_key),
    UNIQUE (project_id, bundle_id, opened_revision),          -- at most one problem per append
    FOREIGN KEY (project_id, bundle_id) REFERENCES learning_loops(project_id, bundle_id)
);

CREATE TABLE learning_memory_attempts (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    problem_id text NOT NULL,
    round_id uuid NOT NULL UNIQUE REFERENCES learning_rounds(id),
    round integer NOT NULL CHECK (round >= 1),
    sample smallint NOT NULL CHECK (sample BETWEEN 1 AND 5),
    backfilled boolean NOT NULL DEFAULT false CHECK (NOT backfilled),
    what jsonb NOT NULL CHECK (jsonb_typeof(what) = 'object'),
    files text[] NOT NULL,
    predicted text[] NOT NULL,
    fixed text[] NOT NULL,
    missed text[] NOT NULL,
    passed integer NOT NULL CHECK (passed >= 0),
    total integer NOT NULL CHECK (total >= 1 AND passed <= total),
    domain text NOT NULL CHECK (octet_length(domain) BETWEEN 1 AND 256),
    provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
    PRIMARY KEY (project_id, bundle_id, revision),
    FOREIGN KEY (project_id, bundle_id, problem_id)
        REFERENCES learning_memory_problems(project_id, bundle_id, problem_id),
    FOREIGN KEY (project_id, bundle_id, round)
        REFERENCES learning_rounds(project_id, bundle_id, number),
    FOREIGN KEY (round_id, sample) REFERENCES learning_candidates(round_id, sample),
    CHECK (fixed <@ predicted AND missed <@ predicted
           AND cardinality(fixed) + cardinality(missed) = cardinality(predicted))
);

CREATE INDEX learning_memory_attempts_problem
    ON learning_memory_attempts (project_id, bundle_id, problem_id, revision);

CREATE FUNCTION learning_memory_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'improvement memory is append-only';
END;
$$;

CREATE TRIGGER learning_memory_problems_append_only
    BEFORE UPDATE OR DELETE ON learning_memory_problems
    FOR EACH ROW EXECUTE FUNCTION learning_memory_append_only();
CREATE TRIGGER learning_memory_attempts_append_only
    BEFORE UPDATE OR DELETE ON learning_memory_attempts
    FOR EACH ROW EXECUTE FUNCTION learning_memory_append_only();
