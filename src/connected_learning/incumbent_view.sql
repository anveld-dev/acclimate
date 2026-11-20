SELECT COALESCE(head.version_id,delivery.version_id),COALESCE(head.chain_length,0),
       r.cumulative_estimate,r.cumulative_bound,
       CASE WHEN r.state='audit' THEN 'auditPending'
            WHEN r.cumulative_request_id IS NOT NULL AND r.state='development' THEN 'checkingCumulative'
            WHEN NOT e.rollout_authorized OR e.stopped_at IS NOT NULL OR NOT i.enabled
                 OR e.proposal_admissions >= e.max_proposal_admissions
                 OR NOT EXISTS (SELECT FROM connected_learning_available_audits a
                     WHERE (a.project_id,a.integration_id)=(e.project_id,e.integration_id))
                THEN 'unavailable'
            ELSE 'awaitingSteps' END
FROM connected_learning_enrollments e
JOIN integrations i ON (i.project_id,i.id)=(e.project_id,e.integration_id)
JOIN channels delivery
  ON (delivery.project_id,delivery.bundle_id,delivery.name)=(e.project_id,e.bundle_id,e.delivery_channel)
JOIN channels source
  ON (source.project_id,source.bundle_id,source.name)=(e.project_id,e.bundle_id,e.source_channel)
LEFT JOIN LATERAL (
    SELECT * FROM connected_learning_incumbent_events h
    WHERE (h.project_id,h.integration_id,h.policy_epoch)=(e.project_id,e.integration_id,e.policy_epoch)
    ORDER BY h.sequence DESC LIMIT 1
) head ON (head.baseline_version_id,head.baseline_revision,head.source_revision)
        = (delivery.version_id,delivery.revision,source.revision)
LEFT JOIN connected_learning_rounds r ON r.id=head.round_id AND head.chain_length>0
WHERE (e.project_id,e.integration_id)=($1,$2)
