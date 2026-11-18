CREATE TABLE evaluation_policy_receipts (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    candidate_version_id uuid NOT NULL,
    comparison_id uuid NOT NULL,
    policy_digest text NOT NULL,
    body jsonb NOT NULL,
    reported_by text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comparison_id, policy_digest),
    FOREIGN KEY (project_id, bundle_id, comparison_id) REFERENCES comparisons(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, candidate_version_id) REFERENCES versions(project_id, bundle_id, id)
);
CREATE INDEX evaluation_policy_receipts_candidate
    ON evaluation_policy_receipts(project_id, bundle_id, candidate_version_id);
