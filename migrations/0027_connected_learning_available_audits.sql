-- An audit slot is consumed as soon as a round queues its audit, regardless of the result.
CREATE VIEW connected_learning_available_audits AS
SELECT e.project_id, e.integration_id, (a.ordinality - 1)::integer AS audit_index
FROM connected_learning_enrollments e
CROSS JOIN LATERAL jsonb_array_elements(e.audits) WITH ORDINALITY AS a(descriptor, ordinality)
WHERE (NOT e.automatic_rollout OR a.descriptor->>'fixtureProtocol' = 'installed-v1')
  AND NOT EXISTS (
      SELECT 1 FROM connected_learning_rounds r
      WHERE (r.project_id, r.integration_id, r.audit_index)
          = (e.project_id, e.integration_id, (a.ordinality - 1)::integer)
  )
  AND connected_learning_audit_registered(
      e.project_id, e.bundle_id, e.integration_id, (a.ordinality - 1)::integer, a.descriptor
  );
