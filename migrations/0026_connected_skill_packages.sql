-- Existing connections and queued proposals keep fixed-file authority.
ALTER TABLE connected_learning_enrollments ADD COLUMN skill_packages jsonb;
ALTER TABLE proposals ADD COLUMN skill_packages jsonb;

-- An older proposer could create a child with identical bytes. Close only
-- pending managed work; completed comparisons and release history stay intact.
WITH closed AS (
    UPDATE connected_learning_rounds r
       SET state='rejected', reason='Proposal did not change any file', updated_at=now()
      FROM proposals p JOIN versions candidate ON candidate.id=p.candidate_version_id
                       JOIN versions parent ON parent.id=p.parent_version_id
     WHERE r.proposal_id=p.id AND candidate.digest=parent.digest
       AND r.state IN ('proposing','development','audit','awaiting_review')
    RETURNING r.project_id,r.integration_id,r.correction_id,r.development_request_id,r.audit_request_id
), interrupted AS (
    UPDATE evaluation_requests e
       SET status='interrupted',error='Proposal did not change any file',updated_at=now()
      FROM closed
     WHERE e.id IN (closed.development_request_id,closed.audit_request_id)
       AND e.status IN ('requested','running')
)
UPDATE connected_learning_corrections f SET pending=true,queued_at=now()
FROM closed WHERE (f.project_id,f.integration_id,f.correction_id)
               =(closed.project_id,closed.integration_id,closed.correction_id) AND f.attempts<2;
