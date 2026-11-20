SELECT kind, payload
FROM (
    SELECT 'correction' AS kind, row_number() OVER (ORDER BY queued_at,correction_id) AS position,
           jsonb_strip_nulls(jsonb_build_object('correctionId',correction_id,'outcomeId',outcome_id,
             'versionId',version_id,'revision',revision::text,'digest',digest,'lesson',lesson,'feedback',feedback)) AS payload
    FROM connected_learning_correction_work
    WHERE (project_id,integration_id)=($1,$2) AND action='recheck'
    ORDER BY position LIMIT 100
) corrections
UNION ALL (
    SELECT 'incident',jsonb_build_object('roundId',r.id,'outcomeId',o.incident_outcome_id,'versionId',v.id,
               'digest',v.digest,'baselineRevision',r.parent_revision::text)
    FROM connected_learning_rounds r
    JOIN connected_learning_replay_obligations o ON o.round_id=r.id
    JOIN connected_learning_replay_results replay ON replay.id=o.id
    JOIN versions v ON v.id=replay.version_id
    JOIN connected_learning_enrollments e ON (e.project_id,e.integration_id,e.bundle_id)=(r.project_id,r.integration_id,r.bundle_id)
    JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
    WHERE (r.project_id,r.integration_id)=($1,$2) AND r.state='development' AND replay.verdict IS NULL
      AND (c.version_id,c.revision)=(r.parent_version_id,r.parent_revision)
) UNION ALL (
    SELECT 'field',jsonb_build_object('versionId',v.id,'digest',v.digest,
               'baselineRevision',r.parent_revision::text,'outcomeId',required.outcome_id)
    FROM connected_learning_rounds r
    JOIN versions v ON v.id=COALESCE(r.release_candidate_id,r.candidate_version_id)
    CROSS JOIN LATERAL connected_field_requirements(r.project_id,r.integration_id,v.id,r.parent_revision) required
    WHERE (r.project_id,r.integration_id)=($1,$2) AND r.state IN ('development','audit')
      AND required.replay IS NULL
    ORDER BY required.sequence LIMIT 50
)
