-- Prefer the latest fresh measurement of this digest from the same development cohort.
SELECT c.id, CASE WHEN measured.incumbent THEN 'candidate' ELSE 'parent' END AS source_arm
FROM connected_learning_rounds r
JOIN comparisons c ON (c.project_id,c.bundle_id,c.id)=(r.project_id,r.bundle_id,r.development_comparison_id)
CROSS JOIN LATERAL (
    SELECT c.body->>'candidateDigest'=$5 AND EXISTS (
        SELECT 1 FROM connected_learning_incumbent_events h
        WHERE h.round_id=r.id AND h.version_id=r.candidate_version_id
    ) AS incumbent
) measured
WHERE (r.project_id,r.integration_id,r.bundle_id,r.policy_epoch)=($1,$2,$3,$4)
  AND c.complete AND c.submitter=$6
  AND c.body #>> '{evaluation,requestId}'=r.development_request_id::text
  AND c.body->>'datasetRevision'=$7 AND c.body->>'graderRevision'=$8 AND c.body->'runtime'=$9
  AND (c.body->'expectedCases') @> $10::jsonb AND $10::jsonb @> (c.body->'expectedCases')
  AND jsonb_array_length(c.body->'results')=jsonb_array_length($10)
  AND c.created_at <= now() AND c.created_at > now()-make_interval(secs => $11)
  AND (measured.incumbent OR (c.body->>'parentDigest'=$5 AND c.parent_source_comparison_id IS NULL))
ORDER BY c.created_at DESC,c.id DESC LIMIT 1
