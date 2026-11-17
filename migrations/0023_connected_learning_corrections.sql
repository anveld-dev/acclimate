-- The unreceipted job revision is provenance for teaching only. Field sampling
-- continues to require the existing receipt + delivery_revision binding.
ALTER TABLE connected_learning_outcomes
    ADD COLUMN observed_revision bigint CHECK (observed_revision > 0);
UPDATE connected_learning_outcomes SET observed_revision=delivery_revision
WHERE delivery_revision IS NOT NULL;

CREATE TABLE connected_learning_corrections (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    lesson jsonb,
    feedback jsonb,
    submitted_by text NOT NULL,
    pending boolean NOT NULL DEFAULT true,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
    queued_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id,integration_id,correction_id),
    UNIQUE (project_id,integration_id,correction_id,outcome_id),
    CHECK (lesson IS NOT NULL OR feedback IS NOT NULL),
    FOREIGN KEY (project_id,bundle_id,integration_id,outcome_id)
      REFERENCES connected_learning_outcomes(project_id,bundle_id,integration_id,outcome_id)
);
CREATE INDEX connected_learning_corrections_pending
    ON connected_learning_corrections(project_id,integration_id,queued_at,correction_id) WHERE pending;

INSERT INTO connected_learning_corrections
    (project_id,bundle_id,integration_id,correction_id,outcome_id,lesson,feedback,submitted_by,pending,attempts,queued_at)
SELECT o.project_id,o.bundle_id,o.integration_id,o.outcome_id,o.outcome_id,o.lesson,o.feedback,o.submitted_by,
       r.id IS NULL
         OR (r.reason IS NOT DISTINCT FROM 'Outcome baseline is stale' AND r.proposal_id IS NULL)
         OR (r.reason IS NOT DISTINCT FROM 'No strict improvement without a case regression'
             AND r.state='rejected' AND r.development_comparison_id IS NOT NULL AND r.audit_request_id IS NULL),
       CASE WHEN r.proposal_id IS NULL THEN 0 ELSE 1 END, o.received_at
FROM connected_learning_outcomes o LEFT JOIN connected_learning_rounds r
  USING (project_id,bundle_id,integration_id,outcome_id)
WHERE o.lesson IS NOT NULL OR o.feedback IS NOT NULL;

DO $$
DECLARE old_key name;
BEGIN
    SELECT conname INTO STRICT old_key FROM pg_constraint
    WHERE conrelid='connected_learning_rounds'::regclass
      AND pg_get_constraintdef(oid)='UNIQUE (project_id, bundle_id, integration_id, outcome_id)';
    EXECUTE format('ALTER TABLE connected_learning_rounds DROP CONSTRAINT %I',old_key);
END $$;

ALTER TABLE connected_learning_rounds ADD COLUMN correction_id uuid, ADD COLUMN attempt integer;
UPDATE connected_learning_rounds SET correction_id=outcome_id,
       attempt=CASE WHEN proposal_id IS NULL THEN 0 ELSE 1 END;
ALTER TABLE connected_learning_rounds ALTER COLUMN correction_id SET NOT NULL,
    ALTER COLUMN attempt SET NOT NULL,
    ADD CHECK (attempt BETWEEN 0 AND 2),
    ADD UNIQUE(project_id,integration_id,correction_id,attempt),
    ADD FOREIGN KEY (project_id,integration_id,correction_id,outcome_id)
        REFERENCES connected_learning_corrections(project_id,integration_id,correction_id,outcome_id);

CREATE TABLE connected_learning_rechecks (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    version_id uuid NOT NULL REFERENCES versions(id),
    revision bigint NOT NULL CHECK(revision>0),
    digest text NOT NULL,
    verdict text NOT NULL CHECK(verdict IN ('reproduced','resolved','unavailable')),
    evaluator text NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,integration_id,correction_id,revision),
    FOREIGN KEY(project_id,integration_id,correction_id)
      REFERENCES connected_learning_corrections(project_id,integration_id,correction_id)
);

-- Every queue reader makes the same decision against the exact active delivery.
CREATE VIEW connected_learning_correction_work AS
SELECT f.*,o.version_id AS observed_version,o.observed_revision,o.digest AS observed_digest,o.status,
       c.version_id AS version_id,c.revision,v.digest,
       CASE WHEN (o.version_id,o.observed_revision)=(c.version_id,c.revision) OR k.verdict='reproduced'
            THEN 'ready' WHEN k.verdict IS NULL THEN 'recheck' ELSE 'held' END AS action
FROM connected_learning_corrections f
JOIN connected_learning_outcomes o USING(project_id,bundle_id,integration_id,outcome_id)
JOIN connected_learning_enrollments e USING(project_id,bundle_id,integration_id)
JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(c.project_id,c.bundle_id,c.version_id)
LEFT JOIN connected_learning_rechecks k
  ON (k.project_id,k.integration_id,k.correction_id,k.version_id,k.revision)
     =(f.project_id,f.integration_id,f.correction_id,c.version_id,c.revision)
WHERE f.pending AND f.attempts<2;
