-- NULL records the historical strict per-pair rule for pre-policy enrollments.
ALTER TABLE connected_learning_enrollments
    ADD COLUMN policy_epoch bigint NOT NULL DEFAULT 0 CHECK (policy_epoch >= 0),
    ADD COLUMN selection_policies jsonb;
ALTER TABLE connected_learning_rounds ADD COLUMN policy_epoch bigint NOT NULL DEFAULT 0;

CREATE TABLE connected_learning_policy_epochs (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    epoch bigint NOT NULL,
    development jsonb NOT NULL,
    selection_policies jsonb,
    PRIMARY KEY (project_id, integration_id, epoch),
    FOREIGN KEY (project_id, integration_id) REFERENCES connected_learning_enrollments
);
INSERT INTO connected_learning_policy_epochs(project_id,integration_id,epoch,development,selection_policies)
SELECT project_id,integration_id,policy_epoch,development,selection_policies FROM connected_learning_enrollments;

CREATE FUNCTION connected_learning_save_policy_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.policy_epoch = OLD.policy_epoch THEN
        RETURN NEW;
    END IF;
    INSERT INTO connected_learning_policy_epochs(project_id,integration_id,epoch,development,selection_policies)
    VALUES(NEW.project_id,NEW.integration_id,NEW.policy_epoch,NEW.development,NEW.selection_policies);
    RETURN NEW;
END;
$$;
CREATE TRIGGER connected_learning_save_policy_epoch
AFTER INSERT OR UPDATE OF policy_epoch ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_learning_save_policy_epoch();

CREATE FUNCTION connected_learning_pin_policy_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT e.policy_epoch INTO STRICT NEW.policy_epoch FROM connected_learning_enrollments e
    WHERE e.project_id=NEW.project_id AND e.integration_id=NEW.integration_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER connected_learning_pin_policy_epoch BEFORE INSERT ON connected_learning_rounds
FOR EACH ROW EXECUTE FUNCTION connected_learning_pin_policy_epoch();
ALTER TABLE connected_learning_rounds ADD FOREIGN KEY (project_id,integration_id,policy_epoch)
    REFERENCES connected_learning_policy_epochs(project_id,integration_id,epoch);

-- A new development cohort is another development exposure. Its prior identities
-- remain registered forever, so neither history nor held-out exclusion is reset.
CREATE OR REPLACE FUNCTION connected_learning_register_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous_count integer := 0;
    item record;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        previous_count := jsonb_array_length(OLD.audits);
        IF jsonb_array_length(NEW.audits) < previous_count
           OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(OLD.audits) WITH ORDINALITY AS a(descriptor,n)
            WHERE a.descriptor IS DISTINCT FROM NEW.audits->((a.n-1)::integer)
           ) THEN
            RAISE EXCEPTION 'Connected learning cohorts are append only' USING ERRCODE = '23514';
        END IF;
        IF jsonb_array_length(NEW.audits) = previous_count AND NEW.development = OLD.development THEN
            RETURN NEW;
        END IF;
    END IF;
    -- Serialize registration across all campaigns of this bundle.
    PERFORM pg_advisory_xact_lock(hashtextextended('connected-learning-cohorts:' || NEW.project_id || ':' || NEW.bundle_id::text, 0));
    IF TG_OP = 'INSERT' OR NEW.development IS DISTINCT FROM OLD.development THEN
        PERFORM connected_learning_register(NEW.project_id,NEW.bundle_id,NEW.integration_id,NULL,NEW.development);
    END IF;
    FOR item IN
        SELECT descriptor,(n-1)::integer AS slot
        FROM jsonb_array_elements(NEW.audits) WITH ORDINALITY AS a(descriptor,n)
        WHERE n > previous_count
    LOOP
        PERFORM connected_learning_register(NEW.project_id,NEW.bundle_id,NEW.integration_id,item.slot,item.descriptor);
    END LOOP;
    RETURN NEW;
END;
$$;
