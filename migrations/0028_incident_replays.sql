ALTER TABLE connected_learning_corrections
    ADD COLUMN require_incident_replay boolean NOT NULL DEFAULT false;

-- NULL preserves the release policy of existing rounds. A requested replay is
-- bound to one round, so verdicts cannot carry over to a new candidate.
ALTER TABLE connected_learning_rounds
    ADD COLUMN incident_replay text CHECK (incident_replay IN ('pending','pass','regression','unavailable')),
    ADD CHECK (state <> 'promoted' OR incident_replay IS NULL OR incident_replay = 'pass');

CREATE INDEX connected_learning_corrections_by_outcome
    ON connected_learning_corrections(project_id,integration_id,outcome_id,queued_at);
