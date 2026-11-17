-- One field observation window per delivery revision, including operator restores.
CREATE TABLE connected_learning_field_releases (
    promotion_id uuid PRIMARY KEY REFERENCES promotions(id),
    control_version_id uuid REFERENCES versions(id),
    validated boolean NOT NULL DEFAULT false,
    withdrawn boolean NOT NULL DEFAULT false,
    rollback_promotion_id uuid UNIQUE REFERENCES promotions(id)
);

INSERT INTO connected_learning_field_releases(promotion_id,control_version_id,validated,withdrawn,rollback_promotion_id)
SELECT p.id,
       CASE WHEN r.id IS NOT NULL THEN p.previous_version_id
            WHEN p.version_id <> seed.version_id THEN seed.version_id END,
       p.revision = 1 OR (r.field_audit_window_size = 10 AND r.field_audit_regressions = 0) IS TRUE,
       r.rollback_promotion_id IS NOT NULL,
       r.rollback_promotion_id
FROM connected_learning_enrollments e
JOIN promotions p ON (p.project_id,p.bundle_id,p.channel)=(e.project_id,e.bundle_id,e.delivery_channel)
JOIN promotions seed ON (seed.project_id,seed.bundle_id,seed.channel,seed.revision)=(p.project_id,p.bundle_id,p.channel,1)
LEFT JOIN connected_learning_rounds r ON r.promotion_id=p.id;

ALTER TABLE connected_learning_field_verdicts ADD COLUMN promotion_id uuid REFERENCES connected_learning_field_releases(promotion_id);
UPDATE connected_learning_field_verdicts v SET promotion_id=r.promotion_id FROM connected_learning_rounds r WHERE r.id=v.round_id;
ALTER TABLE connected_learning_field_verdicts ALTER COLUMN promotion_id SET NOT NULL, ALTER COLUMN round_id DROP NOT NULL;
CREATE INDEX connected_learning_field_release_verdicts ON connected_learning_field_verdicts(promotion_id,(request->>'parentVersionId'),sequence DESC);
CREATE INDEX versions_bundle_digest ON versions(project_id,bundle_id,digest);
CREATE INDEX connected_learning_field_withdrawals ON connected_learning_field_releases(promotion_id) WHERE withdrawn;

CREATE TABLE connected_learning_field_requalifications (
    regression_sequence bigint NOT NULL REFERENCES connected_learning_field_verdicts(sequence),
    candidate_version_id uuid NOT NULL REFERENCES versions(id),
    baseline_revision bigint NOT NULL CHECK (baseline_revision > 0),
    verdict text NOT NULL CHECK (verdict IN ('pass','regression')),
    evaluator_principal text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(regression_sequence,candidate_version_id,baseline_revision)
);

-- A withdrawal applies to the bytes on this connection even if they are proposed again
-- under a new version ID. Evidence refers to private outcomes, never their contents.
CREATE FUNCTION connected_field_requirements(proj text, connection uuid, candidate uuid, base_revision bigint)
RETURNS TABLE(sequence bigint,outcome_id uuid,replay text) LANGUAGE sql STABLE AS $$
    SELECT f.sequence,f.outcome_id,q.verdict
    FROM connected_learning_enrollments e
    JOIN versions c ON (c.project_id,c.bundle_id,c.id)=(e.project_id,e.bundle_id,candidate)
    JOIN versions withdrawn ON (withdrawn.project_id,withdrawn.bundle_id,withdrawn.digest)=(e.project_id,e.bundle_id,c.digest)
    JOIN promotions p ON (p.project_id,p.bundle_id,p.channel,p.version_id)=(e.project_id,e.bundle_id,e.delivery_channel,withdrawn.id)
    JOIN connected_learning_field_releases r ON r.promotion_id=p.id AND r.withdrawn
    JOIN connected_learning_field_verdicts f ON f.promotion_id=p.id AND f.verdict='regression'
    LEFT JOIN connected_learning_field_requalifications q
      ON (q.regression_sequence,q.candidate_version_id,q.baseline_revision)=(f.sequence,candidate,base_revision)
    WHERE (e.project_id,e.integration_id)=(proj,connection)
$$;

CREATE FUNCTION connected_field_eligible(proj text, connection uuid, candidate uuid, base_revision bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (
        SELECT FROM connected_field_requirements(proj,connection,candidate,base_revision) WHERE replay IS DISTINCT FROM 'pass'
    )
$$;

-- Enrollment creates its seed promotion before inserting the enrollment itself.
CREATE FUNCTION connected_field_seed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO connected_learning_field_releases(promotion_id,validated)
    SELECT id,true FROM promotions
    WHERE (project_id,bundle_id,channel,revision)=(NEW.project_id,NEW.bundle_id,NEW.delivery_channel,1);
    RETURN NEW;
END;
$$;
CREATE TRIGGER connected_field_seed AFTER INSERT ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_field_seed();

CREATE FUNCTION connected_field_checkpoint(proj text, connection uuid, before_revision bigint, served uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT p.version_id FROM connected_learning_enrollments e
    JOIN promotions p ON (p.project_id,p.bundle_id,p.channel)=(e.project_id,e.bundle_id,e.delivery_channel)
    JOIN connected_learning_field_releases r ON r.promotion_id=p.id
    WHERE (e.project_id,e.integration_id)=(proj,connection)
      AND p.revision<before_revision AND p.version_id<>served AND r.validated AND NOT r.withdrawn
      -- The historical control qualified against its own authorization baseline.
      -- Any later withdrawal adds fresh replay obligations for that same digest.
      AND connected_field_eligible(proj,connection,p.version_id,GREATEST(1,p.revision-1))
    ORDER BY p.revision DESC LIMIT 1
$$;

CREATE FUNCTION connected_field_register_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    connection uuid;
    control uuid;
BEGIN
    SELECT integration_id INTO connection FROM connected_learning_enrollments
    WHERE (project_id,bundle_id,delivery_channel)=(NEW.project_id,NEW.bundle_id,NEW.channel);
    IF NOT FOUND THEN RETURN NEW; END IF;
    control := connected_field_checkpoint(NEW.project_id,connection,NEW.revision,NEW.version_id);
    INSERT INTO connected_learning_field_releases(promotion_id,control_version_id) VALUES (NEW.id,control);
    RETURN NEW;
END;
$$;
CREATE TRIGGER connected_field_register_release AFTER INSERT ON promotions
FOR EACH ROW EXECUTE FUNCTION connected_field_register_release();
