SELECT e.project_id,e.integration_id
FROM connected_learning_enrollments e
LEFT JOIN LATERAL (
    SELECT next_tick_at
    FROM connected_learning_rounds r
    WHERE (r.project_id,r.integration_id)=(e.project_id,e.integration_id)
      AND r.state IN ('proposing','development','audit')
    ORDER BY r.created_at,r.id
    LIMIT 1
) active_round ON true
WHERE active_round.next_tick_at <= now()
   OR (
    active_round.next_tick_at IS NULL
    AND (
        EXISTS (
            SELECT 1 FROM channels delivery
            JOIN channels source ON (source.project_id,source.bundle_id,source.name)=(e.project_id,e.bundle_id,e.source_channel)
            JOIN LATERAL (
                SELECT baseline_version_id,baseline_revision,source_revision
                FROM connected_learning_incumbent_events h
                WHERE (h.project_id,h.integration_id,h.policy_epoch)=(e.project_id,e.integration_id,e.policy_epoch)
                ORDER BY h.sequence DESC LIMIT 1
            ) head ON true
            WHERE (delivery.project_id,delivery.bundle_id,delivery.name)=(e.project_id,e.bundle_id,e.delivery_channel)
              AND (delivery.version_id,delivery.revision,source.revision)
                  IS DISTINCT FROM (head.baseline_version_id,head.baseline_revision,head.source_revision)
        )
        OR (
            e.stopped_at IS NULL AND e.rollout_authorized
            AND EXISTS (
                SELECT 1 FROM integrations i
                WHERE (i.project_id,i.id)=(e.project_id,e.integration_id) AND i.enabled
            )
            AND (
                NOT EXISTS (
                    SELECT 1 FROM connected_learning_incumbent_events h
                    WHERE (h.project_id,h.integration_id,h.policy_epoch)=(e.project_id,e.integration_id,e.policy_epoch)
                )
                OR EXISTS (
                    SELECT 1 FROM connected_learning_incumbent_events h
                    JOIN connected_learning_rounds r ON r.id=h.round_id
                    WHERE h.sequence=(SELECT max(sequence) FROM connected_learning_incumbent_events
                        WHERE (project_id,integration_id,policy_epoch)=(e.project_id,e.integration_id,e.policy_epoch))
                    AND h.chain_length>0 AND r.state='developed' AND r.next_tick_at<=now()
                )
                OR EXISTS (
                    SELECT 1 FROM connected_learning_policy_epochs p
                    WHERE (p.project_id,p.integration_id,p.epoch)=(e.project_id,e.integration_id,e.policy_epoch)
                      AND (p.noise_calibration IS NULL OR p.repetition_plan IS NULL) AND p.calibration_stopped_reason IS NULL
                )
                OR (
                    e.proposal_admissions < e.max_proposal_admissions
                    AND EXISTS (
                        SELECT 1 FROM connected_learning_policy_epochs p
                        WHERE (p.project_id,p.integration_id,p.epoch)=(e.project_id,e.integration_id,e.policy_epoch)
                        AND p.noise_calibration IS NOT NULL AND p.repetition_plan IS NOT NULL AND p.calibration_stopped_reason IS NULL
                    )
                    AND EXISTS (
                        SELECT 1 FROM connected_learning_correction_work f
                        WHERE (f.project_id,f.integration_id)=(e.project_id,e.integration_id) AND f.action='ready'
                    )
                    AND EXISTS (
                        SELECT 1 FROM connected_learning_available_audits a
                        WHERE (a.project_id,a.integration_id)=(e.project_id,e.integration_id)
                    )
                )
            )
        )
    )
)
ORDER BY e.project_id,e.integration_id
