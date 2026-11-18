WITH job AS (
    SELECT o.*, e.source_channel, e.delivery_channel, e.stopped_at,
           e.proposal_admissions, e.max_proposal_admissions, i.enabled,
           current.version_id AS current_version, current.revision AS current_revision
    FROM connected_learning_outcomes o
    JOIN connected_learning_enrollments e USING (project_id, bundle_id, integration_id)
    JOIN integrations i ON (i.project_id, i.id) = (e.project_id, e.integration_id)
    JOIN channels current ON (current.project_id, current.bundle_id, current.name)
        = (e.project_id, e.bundle_id, e.delivery_channel)
    WHERE (e.project_id, e.integration_id, o.outcome_id) = ($1, $2, $3)
), corrections AS (
    SELECT f.correction_id, f.queued_at, r.id AS round_id, r.incident_replay, r.reason,
           r.promotion_id, r.candidate_version_id, r.development_request_id, r.audit_request_id,
           CASE WHEN NOT f.pending AND k.verdict='resolved' THEN 'resolved'
                WHEN NOT f.pending THEN COALESCE(r.state,'closed')
                WHEN NOT j.enabled OR j.stopped_at IS NOT NULL THEN 'admission_closed'
                WHEN w.action='recheck' THEN 'awaiting_baseline_recheck'
                WHEN w.action='held' THEN 'private_evidence_unavailable'
                WHEN j.proposal_admissions >= j.max_proposal_admissions THEN 'admissions_exhausted'
                WHEN $4::bigint=0 THEN 'audits_exhausted'
                ELSE 'queued' END AS state
    FROM job j JOIN connected_learning_corrections f USING (project_id,bundle_id,integration_id,outcome_id)
    LEFT JOIN connected_learning_correction_work w ON (w.project_id,w.integration_id,w.correction_id)
        = (f.project_id,f.integration_id,f.correction_id)
    LEFT JOIN LATERAL (SELECT id,state,reason,incident_replay,promotion_id,candidate_version_id,
                         development_request_id,audit_request_id FROM connected_learning_rounds
        WHERE (project_id,integration_id,correction_id)=(f.project_id,f.integration_id,f.correction_id)
        ORDER BY attempt DESC LIMIT 1) r ON true
    LEFT JOIN LATERAL (SELECT verdict FROM connected_learning_rechecks
        WHERE (project_id,integration_id,correction_id)=(f.project_id,f.integration_id,f.correction_id)
        ORDER BY revision DESC LIMIT 1) k ON true
), served AS (
    SELECT p.id FROM job j JOIN promotions p ON (p.project_id,p.bundle_id,p.channel,p.version_id,p.revision)
        = (j.project_id,j.bundle_id,j.delivery_channel,j.version_id,j.observed_revision)
), releases AS (
    SELECT p.id, jsonb_build_object('promotionId',p.id,'versionId',p.version_id,'revision',p.revision::text,
        'withdrawn',f.withdrawn,'rollback',CASE WHEN rb.id IS NOT NULL THEN
            jsonb_build_object('promotionId',rb.id,'versionId',rb.version_id,'revision',rb.revision::text) END,
        'developmentRequestId',r.development_request_id,'auditRequestId',r.audit_request_id) AS details
    FROM promotions p JOIN connected_learning_field_releases f ON f.promotion_id=p.id
    LEFT JOIN promotions rb ON rb.id=f.rollback_promotion_id
    LEFT JOIN connected_learning_rounds r ON r.promotion_id=p.id
    WHERE p.id IN (SELECT id FROM served UNION SELECT promotion_id FROM corrections)
)
SELECT jsonb_build_object(
    'outcomeId',j.outcome_id,'status',j.status,'versionId',j.version_id,
    'deliveryRevision',j.observed_revision::text,'receivedAt',j.received_at,
    'bundleId',j.bundle_id,'channel',j.source_channel,
    'currentDelivery',jsonb_build_object('versionId',j.current_version,'revision',j.current_revision::text),
    'servedRelease',(SELECT releases.details FROM releases JOIN served USING (id)),
    'fieldAudit',CASE WHEN v.verdict IS NOT NULL THEN jsonb_build_object('verdict',v.verdict,
        'controlVersionId',v.request->>'parentVersionId','triggeredRollback',v.response ? 'rollbackPromotionId') END,
    'corrections',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'correctionId',c.correction_id,'roundId',c.round_id,'reason',c.reason,'state',c.state,
        'incidentReplay',c.incident_replay,'release',releases.details,'candidateVersionId',c.candidate_version_id,
        'developmentRequestId',c.development_request_id,'auditRequestId',c.audit_request_id)
        ORDER BY c.queued_at DESC,c.correction_id)
        FROM corrections c LEFT JOIN releases ON releases.id=c.promotion_id),'[]'::jsonb))
FROM job j LEFT JOIN connected_learning_field_verdicts v USING (project_id,bundle_id,integration_id,outcome_id)
