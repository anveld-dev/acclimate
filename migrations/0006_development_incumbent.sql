ALTER TABLE connected_learning_rounds
    DROP CONSTRAINT connected_learning_rounds_state_check,
    ADD CHECK (state IN ('proposing', 'development', 'developed', 'audit', 'awaiting_review', 'promoted', 'rejected')),
    ADD COLUMN development_parent_id uuid REFERENCES versions(id),
    ADD COLUMN cumulative_request_id uuid UNIQUE REFERENCES evaluation_requests(id),
    ADD COLUMN cumulative_comparison_id uuid REFERENCES comparisons(id),
    ADD COLUMN release_candidate_id uuid UNIQUE REFERENCES versions(id),
    ADD COLUMN cumulative_estimate double precision,
    ADD COLUMN cumulative_bound double precision,
    ADD CHECK ((cumulative_request_id IS NULL) = (release_candidate_id IS NULL)),
    ADD CHECK (cumulative_comparison_id IS NULL OR cumulative_request_id IS NOT NULL),
    ADD CHECK (state <> 'developed' OR development_comparison_id IS NOT NULL AND audit_request_id IS NULL);

-- Append-only history. An accepted round records the search edge even when an
-- audit uses a content-identical version rooted directly at the delivery baseline.
CREATE TABLE connected_learning_incumbent_events (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    policy_epoch bigint NOT NULL,
    baseline_version_id uuid NOT NULL REFERENCES versions(id),
    baseline_revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    version_id uuid NOT NULL REFERENCES versions(id),
    parent_version_id uuid REFERENCES versions(id),
    round_id uuid REFERENCES connected_learning_rounds(id),
    development_comparison_id uuid REFERENCES comparisons(id),
    indeterminate_cost boolean NOT NULL DEFAULT false,
    chain_length integer NOT NULL CHECK (chain_length >= 0),
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (chain_length = 0 AND version_id = baseline_version_id
            AND parent_version_id IS NULL AND development_comparison_id IS NULL)
        OR (chain_length > 0 AND parent_version_id IS NOT NULL AND round_id IS NOT NULL
            AND development_comparison_id IS NOT NULL)
    ),
    FOREIGN KEY (project_id, integration_id, policy_epoch)
        REFERENCES connected_learning_policy_epochs(project_id, integration_id, epoch)
);

CREATE INDEX connected_learning_incumbent_latest
    ON connected_learning_incumbent_events(project_id, integration_id, policy_epoch, sequence DESC);

CREATE UNIQUE INDEX connected_learning_incumbent_accepted_round
    ON connected_learning_incumbent_events(round_id) WHERE chain_length > 0;
