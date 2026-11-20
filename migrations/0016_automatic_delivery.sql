-- Existing manual installations retain their delivery channel and history.
-- Only an administrator can authorize future automatic releases.
ALTER TABLE connected_learning_enrollments RENAME COLUMN automatic_rollout TO rollout_authorized;

CREATE OR REPLACE VIEW connected_learning_available_audits AS
SELECT e.project_id, e.integration_id, (a.ordinality - 1)::integer AS audit_index
FROM connected_learning_enrollments e
CROSS JOIN LATERAL jsonb_array_elements(e.audits) WITH ORDINALITY AS a(descriptor, ordinality)
WHERE a.descriptor->>'fixtureProtocol' = 'installed-v1'
  AND NOT EXISTS (
      SELECT 1 FROM connected_learning_rounds r
      WHERE (r.project_id, r.integration_id, r.audit_index)
          = (e.project_id, e.integration_id, (a.ordinality - 1)::integer)
        AND NOT r.audit_released
  );

-- Discard in-flight manual work, including earlier unpublished steps in its chain.
-- Passing a previous review deadline or upgrading must never release those bytes.
CREATE TEMP TABLE retired_learning_rounds ON COMMIT DROP AS
SELECT r.id FROM connected_learning_rounds r
JOIN connected_learning_enrollments e USING (project_id,integration_id)
WHERE r.state IN ('proposing','development','developed','audit','awaiting_review')
  AND (NOT e.rollout_authorized OR EXISTS (
    SELECT 1 FROM connected_learning_rounds waiting
    WHERE (waiting.project_id,waiting.integration_id,waiting.policy_epoch)
        = (r.project_id,r.integration_id,r.policy_epoch) AND waiting.state='awaiting_review'
  ));

UPDATE proposals p SET status='failed', error='Manual release workflow retired'
FROM connected_learning_rounds r JOIN retired_learning_rounds old USING (id)
WHERE p.id=r.proposal_id AND p.status IN ('queued','running');

UPDATE evaluation_requests q SET status='interrupted', error='Manual release workflow retired', updated_at=now()
FROM connected_learning_rounds r JOIN retired_learning_rounds old USING (id)
WHERE q.id IN (r.development_request_id,r.cumulative_request_id,r.audit_request_id)
  AND q.status IN ('requested','running');

INSERT INTO connected_learning_incumbent_events
  (project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,version_id,chain_length,reason)
SELECT project_id,integration_id,policy_epoch,baseline_version_id,baseline_revision,source_revision,baseline_version_id,0,'Manual release workflow retired'
FROM (
  SELECT DISTINCT ON (project_id,integration_id,policy_epoch) *
  FROM connected_learning_incumbent_events ORDER BY project_id,integration_id,policy_epoch,sequence DESC
) head JOIN retired_learning_rounds old ON old.id=head.round_id
WHERE head.chain_length>0;

UPDATE connected_learning_corrections c SET pending=true,queued_at=clock_timestamp()
WHERE c.attempts<2 AND EXISTS (
  SELECT 1 FROM connected_learning_round_corrections m JOIN retired_learning_rounds old ON old.id=m.round_id
  WHERE (m.project_id,m.integration_id,m.correction_id)=(c.project_id,c.integration_id,c.correction_id)
);

UPDATE connected_learning_rounds r SET state='rejected', decision='chain_discarded',
    reason=COALESCE(reason,'Manual release workflow retired'),updated_at=now(),
    audit_released=r.audit_index IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM comparisons c WHERE (c.project_id,c.bundle_id)=(r.project_id,r.bundle_id)
        AND c.complete AND (c.id=r.audit_comparison_id OR c.body->'evaluation'->>'requestId'=r.audit_request_id::text
          OR c.id=(SELECT q.comparison_id FROM evaluation_requests q WHERE q.id=r.audit_request_id))
    )
WHERE r.id IN (SELECT id FROM retired_learning_rounds);

ALTER TABLE connected_learning_rounds DROP CONSTRAINT connected_learning_rounds_state_check,
  ADD CHECK (state IN ('proposing','development','developed','audit','promoted','rejected'));
