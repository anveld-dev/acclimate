ALTER TABLE connected_learning_enrollments
    DROP CONSTRAINT connected_learning_enrollments_max_proposal_admissions_check,
    DROP CONSTRAINT connected_learning_enrollments_audits_check,
    ADD CHECK (max_proposal_admissions > 0),
    ADD CHECK (jsonb_typeof(audits) = 'array' AND jsonb_array_length(audits) > 0),
    ADD COLUMN renewal_revision bigint NOT NULL DEFAULT 0 CHECK (renewal_revision >= 0);

ALTER TABLE connected_learning_rounds
    DROP CONSTRAINT connected_learning_rounds_audit_index_check,
    ADD CHECK (audit_index >= 0);

CREATE TABLE connected_learning_renewals (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    renewal_id uuid NOT NULL,
    request jsonb NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    authorized_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, integration_id, renewal_id),
    UNIQUE (project_id, integration_id, revision),
    FOREIGN KEY (project_id, integration_id) REFERENCES connected_learning_enrollments(project_id,integration_id)
);

-- A NULL index marks development exposure. A NULL owner with a non-NULL
-- index marks ambiguous legacy exposure. Neither grants audit eligibility.
CREATE TABLE connected_learning_cohorts (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    kind text NOT NULL,
    identity text NOT NULL,
    integration_id uuid,
    audit_index integer,
    PRIMARY KEY (project_id, bundle_id, kind, identity),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles(project_id,id)
);

CREATE FUNCTION connected_learning_identities(descriptor jsonb)
RETURNS TABLE(kind text, identity text) LANGUAGE sql IMMUTABLE AS $$
    SELECT 'dataset', btrim(descriptor->>'datasetRevision')
    UNION
    SELECT 'case', btrim(item->>'caseId')
    FROM jsonb_array_elements(descriptor->'expectedCases') AS item
    UNION
    SELECT 'dataset-digest', descriptor->>'datasetDigest'
    WHERE descriptor->>'datasetDigest' IS NOT NULL
    UNION
    SELECT 'case-digest', item
    FROM jsonb_array_elements_text(descriptor->'caseFingerprints') AS item
    UNION
    SELECT 'family-digest', item
    FROM jsonb_array_elements_text(descriptor->'familyFingerprints') AS item
$$;

-- All legacy descriptors participate, even if their audit was never opened.
-- If multiple legacy slots advertised an identity, none may acquire it.
WITH descriptors AS (
    SELECT project_id,bundle_id,integration_id,NULL::integer AS audit_index,development AS descriptor
    FROM connected_learning_enrollments
    UNION ALL
    SELECT project_id,bundle_id,integration_id,(ordinality-1)::integer,audit
    FROM connected_learning_enrollments
    CROSS JOIN LATERAL jsonb_array_elements(audits) WITH ORDINALITY AS a(audit,ordinality)
)
INSERT INTO connected_learning_cohorts(project_id,bundle_id,kind,identity,integration_id,audit_index)
SELECT project_id,bundle_id,kind,identity,
       CASE WHEN count(*)=1 AND min(audit_index) IS NOT NULL THEN min(integration_id::text)::uuid END,
       min(audit_index)
FROM descriptors
CROSS JOIN LATERAL connected_learning_identities(descriptor)
GROUP BY project_id,bundle_id,kind,identity;

CREATE FUNCTION connected_learning_register(identity_project text, identity_bundle uuid, owner uuid, slot integer, descriptor jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO connected_learning_cohorts(project_id,bundle_id,kind,identity,integration_id,audit_index)
    SELECT identity_project,identity_bundle,kind,identity,
           CASE WHEN slot IS NOT NULL THEN owner END,slot
    FROM connected_learning_identities(descriptor)
    ORDER BY kind,identity
    ON CONFLICT DO NOTHING;
    IF EXISTS (
        SELECT 1
        FROM connected_learning_identities(descriptor) AS input
        JOIN connected_learning_cohorts AS existing
          ON (existing.project_id,existing.bundle_id,existing.kind,existing.identity)
           = (identity_project,identity_bundle,input.kind,input.identity)
        WHERE existing.audit_index IS DISTINCT FROM slot
           OR (slot IS NOT NULL AND existing.integration_id IS DISTINCT FROM owner)
    ) THEN
        RAISE EXCEPTION 'Connected learning cohort identity collision'
            USING ERRCODE = '23505', CONSTRAINT = 'connected_learning_cohort_exclusive';
    END IF;
END;
$$;

CREATE FUNCTION connected_learning_register_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous_count integer := 0;
    item record;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        previous_count := jsonb_array_length(OLD.audits);
        IF NEW.development IS DISTINCT FROM OLD.development
           OR jsonb_array_length(NEW.audits) < previous_count
           OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(OLD.audits) WITH ORDINALITY AS a(descriptor,n)
            WHERE a.descriptor IS DISTINCT FROM NEW.audits->((a.n-1)::integer)
           ) THEN
            RAISE EXCEPTION 'Connected learning cohorts are append only' USING ERRCODE = '23514';
        END IF;
        IF jsonb_array_length(NEW.audits) = previous_count THEN
            RETURN NEW;
        END IF;
    END IF;
    -- Serialize registration across all campaigns of this bundle.
    PERFORM pg_advisory_xact_lock(hashtextextended('connected-learning-cohorts:' || NEW.project_id || ':' || NEW.bundle_id::text, 0));
    IF TG_OP = 'INSERT' THEN
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

CREATE TRIGGER connected_learning_register_enrollment
AFTER INSERT OR UPDATE OF development,audits ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_learning_register_enrollment();

CREATE FUNCTION connected_learning_audit_registered(identity_project text, identity_bundle uuid, owner uuid, slot integer, descriptor jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT descriptor IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM connected_learning_identities(descriptor) AS input
        LEFT JOIN connected_learning_cohorts AS existing
          ON (existing.project_id,existing.bundle_id,existing.kind,existing.identity)
           = (identity_project,identity_bundle,input.kind,input.identity)
        WHERE existing.audit_index IS DISTINCT FROM slot OR existing.integration_id IS DISTINCT FROM owner
    )
$$;
