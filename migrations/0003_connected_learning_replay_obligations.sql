CREATE TABLE connected_learning_replay_obligations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    version_id uuid NOT NULL,
    baseline_revision bigint NOT NULL CHECK (baseline_revision > 0),
    correction_id uuid,
    regression_sequence bigint REFERENCES connected_learning_field_verdicts(sequence),
    round_id uuid REFERENCES connected_learning_rounds(id),
    verdict text CHECK (verdict IN ('pass', 'regression', 'unavailable')),
    evaluator text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(correction_id, regression_sequence, round_id) = 1),
    CHECK ((verdict IS NULL) = (evaluator IS NULL)),
    FOREIGN KEY (project_id,bundle_id,integration_id)
        REFERENCES connected_learning_enrollments(project_id,bundle_id,integration_id),
    FOREIGN KEY (project_id,bundle_id,version_id) REFERENCES versions(project_id,bundle_id,id),
    FOREIGN KEY (project_id,integration_id,correction_id)
        REFERENCES connected_learning_corrections(project_id,integration_id,correction_id),
    UNIQUE (project_id,integration_id,correction_id,baseline_revision),
    UNIQUE (regression_sequence,version_id,baseline_revision),
    UNIQUE (round_id)
);

CREATE VIEW connected_learning_replay_results AS
SELECT o.id,o.project_id,o.integration_id,o.bundle_id,o.version_id,o.baseline_revision,
       o.correction_id,o.regression_sequence,o.round_id,
       CASE WHEN o.verdict IS NULL AND o.created_at <= now()-interval '24 hours'
            THEN 'unavailable' ELSE o.verdict END AS verdict
FROM connected_learning_replay_obligations o;

-- A correction gate passes when the correction still applies to the baseline.
INSERT INTO connected_learning_replay_obligations(project_id,integration_id,bundle_id,version_id,
    baseline_revision,correction_id,verdict,evaluator,created_at)
SELECT k.project_id,k.integration_id,e.bundle_id,k.version_id,k.revision,k.correction_id,
    CASE k.verdict WHEN 'reproduced' THEN 'pass' WHEN 'resolved' THEN 'regression' ELSE k.verdict END,
    k.evaluator,k.checked_at
FROM connected_learning_rechecks k
JOIN connected_learning_enrollments e USING (project_id,integration_id);

INSERT INTO connected_learning_replay_obligations(project_id,integration_id,bundle_id,version_id,
    baseline_revision,regression_sequence,verdict,evaluator,created_at)
SELECT f.project_id,f.integration_id,f.bundle_id,q.candidate_version_id,q.baseline_revision,
    q.regression_sequence,q.verdict,q.evaluator_principal,q.created_at
FROM connected_learning_field_requalifications q
JOIN connected_learning_field_verdicts f ON f.sequence=q.regression_sequence;

INSERT INTO connected_learning_replay_obligations(project_id,integration_id,bundle_id,version_id,
    baseline_revision,round_id,verdict,evaluator,created_at)
SELECT r.project_id,r.integration_id,r.bundle_id,r.candidate_version_id,r.parent_revision,r.id,
    NULLIF(r.incident_replay,'pending'),
    CASE WHEN r.incident_replay<>'pending' THEN e.evaluator_principal END,r.updated_at
FROM connected_learning_rounds r
JOIN connected_learning_enrollments e USING (project_id,integration_id)
WHERE r.incident_replay IS NOT NULL AND r.candidate_version_id IS NOT NULL;

CREATE OR REPLACE VIEW connected_learning_correction_work AS
SELECT f.project_id,f.bundle_id,f.integration_id,f.correction_id,f.outcome_id,f.lesson,
       f.feedback,f.submitted_by,f.pending,f.attempts,f.queued_at,
       o.version_id AS observed_version,o.observed_revision,o.digest AS observed_digest,o.status,
       c.version_id AS version_id,c.revision,v.digest,
       CASE WHEN (o.version_id,o.observed_revision)=(c.version_id,c.revision) OR k.verdict='pass'
            THEN 'ready' WHEN k.verdict IS NULL THEN 'recheck' ELSE 'held' END AS action
FROM connected_learning_corrections f
JOIN connected_learning_outcomes o USING(project_id,bundle_id,integration_id,outcome_id)
JOIN connected_learning_enrollments e USING(project_id,bundle_id,integration_id)
JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(c.project_id,c.bundle_id,c.version_id)
LEFT JOIN connected_learning_replay_results k
  ON (k.project_id,k.integration_id,k.correction_id,k.version_id,k.baseline_revision)
     =(f.project_id,f.integration_id,f.correction_id,c.version_id,c.revision)
WHERE f.pending AND f.attempts<2;

CREATE OR REPLACE FUNCTION connected_field_requirements(proj text, connection uuid, candidate uuid, base_revision bigint)
RETURNS TABLE(sequence bigint,outcome_id uuid,replay text) LANGUAGE sql STABLE AS $$
    SELECT f.sequence,f.outcome_id,q.verdict
    FROM connected_learning_enrollments e
    JOIN versions c ON (c.project_id,c.bundle_id,c.id)=(e.project_id,e.bundle_id,candidate)
    JOIN versions withdrawn ON (withdrawn.project_id,withdrawn.bundle_id,withdrawn.digest)=(e.project_id,e.bundle_id,c.digest)
    JOIN promotions p ON (p.project_id,p.bundle_id,p.channel,p.version_id)=(e.project_id,e.bundle_id,e.delivery_channel,withdrawn.id)
    JOIN connected_learning_field_releases r ON r.promotion_id=p.id AND r.withdrawn
    JOIN connected_learning_field_verdicts f ON f.promotion_id=p.id AND f.verdict='regression'
    LEFT JOIN connected_learning_replay_results q
      ON (q.regression_sequence,q.version_id,q.baseline_revision)=(f.sequence,candidate,base_revision)
    WHERE (e.project_id,e.integration_id)=(proj,connection)
$$;

CREATE VIEW connected_learning_round_replays AS
SELECT r.id AS round_id, CASE WHEN c.require_incident_replay THEN COALESCE(q.verdict,'pending') END AS incident_replay
FROM connected_learning_rounds r
JOIN connected_learning_corrections c USING (project_id,integration_id,correction_id)
LEFT JOIN connected_learning_replay_results q ON q.round_id=r.id;

DROP TABLE connected_learning_rechecks;
DROP TABLE connected_learning_field_requalifications;
ALTER TABLE connected_learning_rounds DROP COLUMN incident_replay;
