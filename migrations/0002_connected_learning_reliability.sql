ALTER TABLE evaluation_requests ADD COLUMN started_at timestamptz;
UPDATE evaluation_requests SET started_at=updated_at WHERE status='running';

ALTER TABLE connected_learning_rounds
    ADD COLUMN audit_released boolean NOT NULL DEFAULT false,
    ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    ADD COLUMN last_error text,
    ADD COLUMN next_tick_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN review_started_at timestamptz,
    ADD COLUMN decision text CHECK (decision IN ('policy_review', 'automatic_rollout', 'review_declined', 'expired_review')),
    ADD CHECK (NOT audit_released OR (audit_index IS NOT NULL AND state='rejected'));

UPDATE connected_learning_rounds SET
    review_started_at=CASE WHEN state='awaiting_review' THEN updated_at END,
    decision=CASE reason
        WHEN 'Application policy requires explicit review' THEN 'policy_review'
        WHEN 'Automatic rollout after a passing audit' THEN 'automatic_rollout'
        WHEN 'Reviewer declined promotion' THEN 'review_declined'
    END;

ALTER TABLE connected_learning_rounds
    DROP CONSTRAINT connected_learning_rounds_project_id_integration_id_audit_i_key;
CREATE UNIQUE INDEX connected_learning_rounds_reserved_audit ON connected_learning_rounds
    (project_id,integration_id,audit_index) WHERE NOT audit_released;

UPDATE connected_learning_rounds r SET audit_released=true
WHERE r.state='rejected' AND r.audit_index IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evaluation_requests e JOIN comparisons c
        ON (c.project_id,c.bundle_id,c.id)=(e.project_id,e.bundle_id,e.comparison_id)
    WHERE (e.project_id,e.bundle_id,e.id)=(r.project_id,r.bundle_id,r.audit_request_id) AND c.complete
) AND NOT EXISTS (
    SELECT 1 FROM comparisons c WHERE c.complete AND (c.project_id,c.bundle_id)=(r.project_id,r.bundle_id)
        AND (c.id=r.audit_comparison_id OR c.body->'evaluation'->>'requestId'=r.audit_request_id::text)
);

CREATE OR REPLACE VIEW connected_learning_available_audits AS
SELECT e.project_id, e.integration_id, (a.ordinality - 1)::integer AS audit_index
FROM connected_learning_enrollments e
CROSS JOIN LATERAL jsonb_array_elements(e.audits) WITH ORDINALITY AS a(descriptor, ordinality)
WHERE (NOT e.automatic_rollout OR a.descriptor->>'fixtureProtocol' = 'installed-v1')
  AND NOT EXISTS (
      SELECT 1 FROM connected_learning_rounds r
      WHERE (r.project_id, r.integration_id, r.audit_index)
          = (e.project_id, e.integration_id, (a.ordinality - 1)::integer)
        AND NOT r.audit_released
  );

CREATE TABLE connected_learning_authorizations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    principal text NOT NULL,
    authorized_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,integration_id) REFERENCES connected_learning_enrollments(project_id,integration_id)
);
-- Existing rows preserve their current authority. Its original authorization
-- timestamp cannot be recovered from the enrollment.
INSERT INTO connected_learning_authorizations(project_id,integration_id,principal)
SELECT project_id,integration_id,authorized_by FROM connected_learning_enrollments;

CREATE TABLE connected_learning_automatic_promotions (
    promotion_id uuid PRIMARY KEY REFERENCES promotions(id),
    authorization_id bigint NOT NULL REFERENCES connected_learning_authorizations(id)
);

DROP TRIGGER connected_field_seed ON connected_learning_enrollments;
DROP FUNCTION connected_field_seed();
DROP TRIGGER connected_field_register_release ON promotions;
DROP FUNCTION connected_field_register_release();
DROP FUNCTION connected_learning_audit_registered(text, uuid, uuid, integer, jsonb);
DROP INDEX connected_learning_outcomes_pending;

ALTER TABLE connected_learning_enrollments ALTER COLUMN selection_policies SET DEFAULT
    '{"development":{"schemaVersion":1,"id":"connected-development","revision":"1","metric":{"name":"reward","unit":"reward","direction":"higher"},"aggregation":"equal-case-means","minimumMeanImprovement":2.220446049250313e-16,"maximumCaseRegression":0,"requiredCases":[],"maximumCandidateTaskFailures":0},"audit":{"schemaVersion":1,"id":"connected-audit","revision":"1","metric":{"name":"reward","unit":"reward","direction":"higher"},"aggregation":"equal-case-means","minimumMeanImprovement":0,"maximumCaseRegression":0,"requiredCases":[],"maximumCandidateTaskFailures":0}}'::jsonb;
UPDATE connected_learning_enrollments SET selection_policies=DEFAULT WHERE selection_policies IS NULL;
ALTER TABLE connected_learning_enrollments ALTER COLUMN selection_policies SET NOT NULL;

ALTER TABLE connected_learning_policy_epochs ALTER COLUMN selection_policies SET DEFAULT
    '{"development":{"schemaVersion":1,"id":"connected-development","revision":"1","metric":{"name":"reward","unit":"reward","direction":"higher"},"aggregation":"equal-case-means","minimumMeanImprovement":2.220446049250313e-16,"maximumCaseRegression":0,"requiredCases":[],"maximumCandidateTaskFailures":0},"audit":{"schemaVersion":1,"id":"connected-audit","revision":"1","metric":{"name":"reward","unit":"reward","direction":"higher"},"aggregation":"equal-case-means","minimumMeanImprovement":0,"maximumCaseRegression":0,"requiredCases":[],"maximumCandidateTaskFailures":0}}'::jsonb;
UPDATE connected_learning_policy_epochs SET selection_policies=DEFAULT WHERE selection_policies IS NULL;
ALTER TABLE connected_learning_policy_epochs ALTER COLUMN selection_policies SET NOT NULL;

UPDATE connected_learning_outcomes SET observed_revision=delivery_revision
WHERE delivery_revision IS NOT NULL;
ALTER TABLE connected_learning_outcomes
    ADD CHECK (started_receipt_id IS NULL OR observed_revision IS NOT NULL),
    DROP COLUMN delivery_revision;

CREATE INDEX connected_learning_complete_evaluation_comparison
    ON comparisons (project_id,bundle_id,(body->'evaluation'->>'requestId')) WHERE complete;

-- Keep the append-only check at the storage boundary. The enrollment and
-- renewal transactions now register the descriptors explicitly.
DROP TRIGGER connected_learning_register_enrollment ON connected_learning_enrollments;
DROP FUNCTION connected_learning_register_enrollment();

CREATE FUNCTION connected_learning_preserve_audits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF jsonb_array_length(NEW.audits) < jsonb_array_length(OLD.audits)
       OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(OLD.audits) WITH ORDINALITY AS a(descriptor,n)
           WHERE a.descriptor IS DISTINCT FROM NEW.audits->((a.n-1)::integer)
       ) THEN
        RAISE EXCEPTION 'Connected learning cohorts are append only' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER connected_learning_preserve_audits
BEFORE UPDATE OF audits ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_learning_preserve_audits();

DROP TRIGGER connected_learning_save_policy_epoch ON connected_learning_enrollments;
DROP FUNCTION connected_learning_save_policy_epoch();
DROP TRIGGER connected_learning_pin_policy_epoch ON connected_learning_rounds;
DROP FUNCTION connected_learning_pin_policy_epoch();

-- The release is the authoritative owner of its rollback promotion.
UPDATE connected_learning_field_releases f SET rollback_promotion_id=r.rollback_promotion_id
FROM connected_learning_rounds r
WHERE f.promotion_id=r.promotion_id AND f.rollback_promotion_id IS NULL
  AND r.rollback_promotion_id IS NOT NULL;
ALTER TABLE connected_learning_rounds DROP COLUMN rollback_promotion_id;
