SELECT jsonb_build_object(
    'id',r.id,
    'policyEpoch',r.policy_epoch,
    'outcomeId',r.outcome_id,
    'correctionId',r.correction_id,
    'attempt',r.attempt,
    'includedCorrections',members.corrections,
    'batchSize',jsonb_array_length(members.corrections),
    'parentSourceComparisonId',development.parent_source_comparison_id,
    'incidentReplay',replay.incident_replay,
    'state',r.state,
    'reason',r.reason,
    'parentVersionId',r.parent_version_id,
    'developmentParentVersionId',COALESCE(r.development_parent_id,r.parent_version_id),
    'developmentCandidateVersionId',r.candidate_version_id,
    'candidateVersionId',COALESCE(r.release_candidate_id,r.candidate_version_id),
    'proposalId',r.proposal_id,
    'developmentRequestId',r.development_request_id,
    'developmentComparisonId',r.development_comparison_id,
    'cumulativeDevelopmentRequestId',r.cumulative_request_id,
    'cumulativeDevelopmentComparisonId',r.cumulative_comparison_id,
    'cumulativeDevelopmentEstimate',r.cumulative_estimate,
    'cumulativeDevelopmentLowerBound',r.cumulative_bound,
    'auditRequestId',r.audit_request_id,
    'auditComparisonId',r.audit_comparison_id,
    'promotionId',COALESCE(r.promotion_id,r.chain_promotion_id),
    'decision',r.decision,
    'fieldAudits',jsonb_build_object(
        'windowSize',COALESCE(decision.window_size,live.window_size),
        'regressions',COALESCE(decision.losses,live.losses),
        'rollbackPromotionId',release.rollback_promotion_id
    )
)
FROM connected_learning_rounds r
LEFT JOIN comparisons development ON development.id=r.development_comparison_id
CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('correctionId',m.correction_id,'outcomeId',c.outcome_id,
                              'attempt',m.attempt) ORDER BY m.position) AS corrections
    FROM connected_learning_round_corrections m
    JOIN connected_learning_corrections c USING (project_id,integration_id,correction_id)
    WHERE m.round_id=r.id
) members
LEFT JOIN connected_learning_round_replays replay ON replay.round_id=r.id
LEFT JOIN connected_learning_field_releases release ON release.promotion_id=r.promotion_id
LEFT JOIN LATERAL (
    SELECT d.window_size,d.losses FROM connected_learning_field_decisions d
    WHERE d.promotion_id=release.promotion_id
       AND (d.kind='rollback' OR d.control_version_id=release.control_version_id)
    ORDER BY CASE d.kind WHEN 'rollback' THEN 0 WHEN 'withdraw' THEN 1 ELSE 2 END, d.triggering_sequence DESC NULLS LAST
    LIMIT 1
) decision ON true
CROSS JOIN LATERAL (
    SELECT count(*) AS window_size,count(*) FILTER (WHERE v.grade='loss') AS losses
    FROM connected_learning_field_verdicts v
    WHERE v.promotion_id=release.promotion_id AND v.control_version_id=release.control_version_id
      AND v.grade IN ('win','loss','tie')
) live
WHERE (r.project_id,r.integration_id)=($1,$2)
ORDER BY r.created_at DESC,r.id DESC
LIMIT 100
