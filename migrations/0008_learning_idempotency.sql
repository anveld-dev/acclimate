CREATE TABLE durable_commands (
    project_id text NOT NULL REFERENCES projects(id),
    scope text NOT NULL,
    principal_id text NOT NULL,
    key text NOT NULL,
    request jsonb,
    legacy_fingerprint text,
    legacy_normalized boolean NOT NULL DEFAULT false,
    response jsonb NOT NULL,
    PRIMARY KEY (project_id, scope, principal_id, key),
    CHECK (num_nonnulls(request, legacy_fingerprint) = 1)
);

-- Learning job IDs historically belonged to the connection, even if its
-- administrator changed. Optional enrollment keys belong to their caller.
CREATE UNIQUE INDEX durable_learning_domain_keys ON durable_commands(project_id, scope, key)
WHERE scope NOT LIKE '%/enrollment' AND scope NOT LIKE '%/stop';

ALTER TABLE integrations ADD UNIQUE (project_id,id,bundle_id,channel);
ALTER TABLE connected_learning_enrollments ADD FOREIGN KEY (project_id,integration_id,bundle_id,source_channel)
    REFERENCES integrations(project_id,id,bundle_id,channel);

INSERT INTO durable_commands(project_id,scope,principal_id,key,legacy_fingerprint,response)
SELECT o.project_id,'learning/'||o.integration_id||'/outcome',o.submitted_by,o.outcome_id::text,o.fingerprint,
    jsonb_build_object('outcomeId',o.outcome_id,'accepted',true,'eligible',o.lesson IS NOT NULL OR o.feedback IS NOT NULL)
    || CASE WHEN v.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
        'fieldAudit',jsonb_build_object('parentVersionId',v.id,'parentDigest',v.digest)) END
FROM connected_learning_outcomes o LEFT JOIN versions v ON v.id=o.field_parent_version_id;
ALTER TABLE connected_learning_outcomes DROP COLUMN fingerprint;

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
SELECT project_id,'learning/'||integration_id||'/correction',submitted_by,correction_id::text,
    jsonb_build_object('correctionId',correction_id,'outcomeId',outcome_id,'lesson',lesson,
        'feedback',feedback,'requireIncidentReplay',require_incident_replay),
    jsonb_build_object('correctionId',correction_id,'outcomeId',outcome_id,'accepted',true)
FROM connected_learning_corrections;

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
SELECT project_id,'learning/'||integration_id||'/restore',reviewer,restore_id::text,request,response
FROM connected_learning_restores;
DROP TABLE connected_learning_restores;

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
SELECT project_id,'learning/'||integration_id||'/field',evaluator_principal,outcome_id::text,request,response
FROM connected_learning_field_verdicts WHERE response IS NOT NULL;

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
SELECT o.project_id,'learning/'||o.integration_id||'/recheck',o.evaluator,o.correction_id||':'||o.baseline_revision,
    jsonb_build_object('correctionId',o.correction_id,'versionId',o.version_id,'digest',v.digest,
        'revision',o.baseline_revision::text,'verdict',q.verdict),
    jsonb_build_object('correctionId',o.correction_id,'revision',o.baseline_revision::text,'verdict',q.verdict,'accepted',true)
FROM connected_learning_replay_obligations o JOIN versions v ON v.id=o.version_id
CROSS JOIN LATERAL (SELECT CASE o.verdict WHEN 'pass' THEN 'reproduced' WHEN 'regression' THEN 'resolved' ELSE o.verdict END) q(verdict)
WHERE o.correction_id IS NOT NULL AND o.verdict IS NOT NULL;

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
SELECT o.project_id,'learning/'||o.integration_id||'/incident',o.evaluator,o.round_id||':'||o.incident_outcome_id,
    jsonb_build_object('roundId',o.round_id,'outcomeId',o.incident_outcome_id,'versionId',o.version_id,
        'digest',v.digest,'baselineRevision',o.baseline_revision::text,
        'verdict',o.verdict,'attempts',COALESCE(o.attempts,'{}'::text[])), '{"accepted":true}'
FROM connected_learning_replay_obligations o JOIN versions v ON v.id=o.version_id
WHERE o.round_id IS NOT NULL AND o.verdict IS NOT NULL;

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
SELECT o.project_id,'learning/'||o.integration_id||'/field-replay',o.evaluator,
    o.version_id||':'||o.baseline_revision||':'||f.outcome_id,
    jsonb_build_object('outcomeId',f.outcome_id,'versionId',o.version_id,
        'digest',v.digest,'baselineRevision',o.baseline_revision::text,
        'verdict',o.verdict,'attempts',COALESCE(o.attempts,'{}'::text[])), '{"accepted":true}'
FROM connected_learning_replay_obligations o JOIN versions v ON v.id=o.version_id
JOIN connected_learning_field_verdicts f ON f.sequence=o.regression_sequence
WHERE o.verdict IS NOT NULL;

ALTER TABLE connected_learning_rounds ADD COLUMN reviewer_principal text;
UPDATE connected_learning_rounds r SET reviewer_principal=(
    SELECT a.principal_id FROM mutation_audit a WHERE a.project_id=r.project_id
        AND a.operation_key=r.id::text AND a.path='/v1/workspaces/'||r.project_id||
            '/connections/'||r.integration_id||'/learning/rounds/'||r.id||'/review'
    ORDER BY a.id DESC LIMIT 1)
WHERE r.decision='review_declined';

INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response,legacy_normalized)
SELECT r.project_id,'learning/'||r.integration_id||'/review',r.reviewer_principal,r.id::text,
    '{"approve":false,"policyOverride":null}',jsonb_build_object('roundId',r.id,'state','rejected'),false
FROM connected_learning_rounds r WHERE r.reviewer_principal IS NOT NULL
UNION ALL
SELECT r.project_id,'learning/'||r.integration_id||'/review',p.reviewer,r.id::text,
    jsonb_build_object('approve',true,'policyOverride',p.policy_override),
    jsonb_build_object('roundId',r.id,'state','promoted','promotionId',p.id),true
FROM connected_learning_rounds r JOIN promotions p ON p.id=r.promotion_id
WHERE r.state='promoted' AND r.decision IS DISTINCT FROM 'automatic_rollout';

CREATE TABLE connected_learning_field_decisions (
    promotion_id uuid NOT NULL REFERENCES connected_learning_field_releases(promotion_id),
    kind text NOT NULL CHECK (kind IN ('validate','withdraw','rollback')),
    control_version_id uuid REFERENCES versions(id),
    verdict_sequences bigint[] NOT NULL,
    triggering_sequence bigint REFERENCES connected_learning_field_verdicts(sequence),
    window_size bigint NOT NULL CHECK (window_size >= 0),
    losses bigint NOT NULL CHECK (losses BETWEEN 0 AND window_size),
    wins bigint CHECK (wins BETWEEN 0 AND window_size - losses),
    log_likelihood double precision,
    PRIMARY KEY (promotion_id,kind)
);

-- Older counters are the authoritative basis where historical verdicts did
-- not distinguish wins from ties or did not retain the contemporary control.
INSERT INTO connected_learning_field_decisions
    (promotion_id,kind,control_version_id,verdict_sequences,triggering_sequence,window_size,losses)
SELECT f.promotion_id,'rollback',COALESCE((triggering.request->>'parentVersionId')::uuid,f.control_version_id),ARRAY(
    SELECT v.sequence FROM connected_learning_field_verdicts v
    WHERE v.promotion_id=f.promotion_id
      AND v.request->>'parentVersionId'=COALESCE(triggering.request->>'parentVersionId',f.control_version_id::text)
      AND (triggering.sequence IS NULL OR v.sequence<=triggering.sequence)
    ORDER BY v.sequence LIMIT r.field_audit_window_size
),triggering.sequence,r.field_audit_window_size,r.field_audit_regressions
FROM connected_learning_field_releases f JOIN connected_learning_rounds r ON r.promotion_id=f.promotion_id
LEFT JOIN LATERAL (
    SELECT v.sequence,v.request FROM connected_learning_field_verdicts v
    WHERE v.promotion_id=f.promotion_id AND v.response ? 'rollbackPromotionId'
    ORDER BY v.sequence LIMIT 1
) triggering ON true
WHERE f.rollback_promotion_id IS NOT NULL;

ALTER TABLE connected_learning_rounds DROP COLUMN field_audit_window_size,
    DROP COLUMN field_audit_regressions;
ALTER TABLE connected_learning_field_verdicts DROP COLUMN response;

ALTER TABLE connected_learning_field_verdicts
    ADD COLUMN control_version_id uuid REFERENCES versions(id),
    ADD COLUMN grade text CHECK (grade IN ('pass','regression','win','loss','tie'));
UPDATE connected_learning_field_verdicts
SET control_version_id=(request->>'parentVersionId')::uuid,grade=COALESCE(request->>'verdict',verdict);
ALTER TABLE connected_learning_field_verdicts
    ALTER COLUMN grade SET NOT NULL,
    DROP COLUMN request;
CREATE INDEX connected_learning_field_release_controls
    ON connected_learning_field_verdicts (promotion_id,control_version_id,sequence);
