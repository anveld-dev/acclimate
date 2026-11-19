SELECT jsonb_build_object(
    'requestId', p.calibration_request_id,
    'status', CASE
        WHEN p.calibration_stopped_reason IS NOT NULL THEN 'stopped'
        WHEN p.noise_calibration IS NOT NULL AND p.repetition_plan IS NOT NULL THEN 'completed'
        WHEN e.status = 'completed' THEN 'evaluated'
        ELSE COALESCE(e.status, 'queued')
    END,
    'failedAttempts', p.calibration_failures,
    'stoppedReason', p.calibration_stopped_reason
) || CASE WHEN p.noise_calibration IS NOT NULL AND p.repetition_plan IS NOT NULL THEN
    p.noise_calibration || (p.repetition_plan #- '{plan,uniformAuditFrom}')
    ELSE '{}'::jsonb
END
FROM connected_learning_policy_epochs p
LEFT JOIN evaluation_requests e ON e.id = p.calibration_request_id
WHERE (p.project_id, p.integration_id, p.epoch) = ($1, $2, $3)
