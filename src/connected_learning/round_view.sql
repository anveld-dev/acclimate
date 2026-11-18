SELECT jsonb_build_object(
    'id',r.id,
    'policyEpoch',r.policy_epoch,
    'outcomeId',r.outcome_id,
    'correctionId',r.correction_id,
    'attempt',r.attempt,
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
    'promotionId',r.promotion_id,
    'fieldAudits',jsonb_build_object(
        'windowSize',r.field_audit_window_size,
        'regressions',r.field_audit_regressions,
        'rollbackPromotionId',release.rollback_promotion_id
    )
)
FROM connected_learning_rounds r
LEFT JOIN connected_learning_round_replays replay ON replay.round_id=r.id
LEFT JOIN connected_learning_field_releases release ON release.promotion_id=r.promotion_id
WHERE (r.project_id,r.integration_id)=($1,$2)
ORDER BY r.created_at DESC,r.id DESC
LIMIT 100
