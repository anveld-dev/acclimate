ALTER TABLE connected_learning_enrollments
    ADD COLUMN max_corrections_per_round integer NOT NULL DEFAULT 5
    CHECK (max_corrections_per_round BETWEEN 1 AND 10);

CREATE TABLE connected_learning_round_corrections (
    round_id uuid NOT NULL REFERENCES connected_learning_rounds(id),
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 2),
    position integer NOT NULL CHECK (position > 0),
    PRIMARY KEY (round_id, correction_id),
    UNIQUE (round_id, position),
    FOREIGN KEY (project_id,integration_id,correction_id)
        REFERENCES connected_learning_corrections(project_id,integration_id,correction_id)
);

INSERT INTO connected_learning_round_corrections
SELECT id,project_id,integration_id,correction_id,attempt,1 FROM connected_learning_rounds;

ALTER TABLE connected_learning_replay_obligations ADD COLUMN incident_outcome_id uuid;
UPDATE connected_learning_replay_obligations o SET incident_outcome_id=r.outcome_id
FROM connected_learning_rounds r WHERE o.round_id=r.id;
ALTER TABLE connected_learning_replay_obligations
    DROP CONSTRAINT connected_learning_replay_obligations_round_id_key,
    ADD UNIQUE (round_id,incident_outcome_id),
    ADD CHECK ((round_id IS NULL) = (incident_outcome_id IS NULL));

CREATE OR REPLACE VIEW connected_learning_round_replays AS
SELECT r.id AS round_id, CASE
    WHEN bool_or(q.verdict='regression') THEN 'regression'
    WHEN bool_or(q.verdict='unavailable') THEN 'unavailable'
    WHEN bool_or(c.require_incident_replay AND q.verdict IS NULL) THEN 'pending'
    WHEN bool_or(c.require_incident_replay) THEN 'pass'
END AS incident_replay
FROM connected_learning_rounds r
JOIN connected_learning_round_corrections m ON m.round_id=r.id
JOIN connected_learning_corrections c ON (c.project_id,c.integration_id,c.correction_id)=(m.project_id,m.integration_id,m.correction_id)
LEFT JOIN connected_learning_replay_obligations o ON (o.round_id,o.incident_outcome_id)=(r.id,c.outcome_id) AND c.require_incident_replay
LEFT JOIN connected_learning_replay_results q ON q.id=o.id
GROUP BY r.id;

ALTER TABLE evaluation_requests ADD COLUMN parent_source_comparison_id uuid REFERENCES comparisons(id);
ALTER TABLE comparisons ADD COLUMN parent_source_comparison_id uuid REFERENCES comparisons(id);
CREATE INDEX comparisons_parent_source ON comparisons(parent_source_comparison_id)
    WHERE parent_source_comparison_id IS NOT NULL;

CREATE FUNCTION connected_learning_record_primary_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO connected_learning_round_corrections
    VALUES (NEW.id, NEW.project_id, NEW.integration_id, NEW.correction_id, NEW.attempt, 1);
    RETURN NEW;
END
$$;

CREATE TRIGGER connected_learning_primary_correction
AFTER INSERT ON connected_learning_rounds FOR EACH ROW EXECUTE FUNCTION connected_learning_record_primary_correction();

ALTER TABLE evaluation_requests
    ADD COLUMN parent_source_arm text CHECK (parent_source_arm IN ('parent','candidate')),
    ADD COLUMN parent_source_expires_at timestamptz,
    ADD CHECK (num_nonnulls(parent_source_comparison_id,parent_source_arm,parent_source_expires_at) IN (0,3));

CREATE UNIQUE INDEX comparisons_one_reuse_per_request ON comparisons ((body #>> '{evaluation,requestId}'))
    WHERE parent_source_comparison_id IS NOT NULL;
