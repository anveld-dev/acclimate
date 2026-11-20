BEGIN READ ONLY;
WITH rounds AS (
  SELECT * FROM learning_rounds
  WHERE project_id = :'project' AND bundle_id = :'bundle'::uuid
    AND number BETWEEN :first AND :last
)
SELECT 'round-pins' WHERE (
  SELECT count(DISTINCT setting) <> 1 OR count(DISTINCT evolve_revision) <> 1
      OR bool_or(optimizer_model IS DISTINCT FROM :'optimizer_model'
                  OR optimizer_reasoning_effort IS DISTINCT FROM :'optimizer_effort') FROM rounds
)
UNION ALL
SELECT 'memory:' || r.number FROM rounds r
WHERE r.memory_revision <> (
  SELECT count(*) FROM learning_rounds p WHERE (p.project_id, p.bundle_id) = (r.project_id, r.bundle_id)
    AND p.number < r.number AND p.decision = 'adopted'
) OR r.memory_revision <> (
  SELECT count(*) FROM learning_memory_attempts a WHERE (a.project_id, a.bundle_id) = (r.project_id, r.bundle_id)
    AND a.revision <= r.memory_revision
)
UNION ALL
SELECT 'retained:' || r.number FROM rounds r
WHERE r.state = 'completed' AND NOT EXISTS (
  SELECT 1 FROM learning_evaluations e WHERE e.round_id = r.id AND e.role = 'retained'
    AND e.split = 'held_out' AND e.version_id = coalesce(r.adopted_version_id, r.parent_version_id)
)
UNION ALL
SELECT 'held-out-fields:' || r.number FROM rounds r JOIN learning_evaluations e ON e.round_id = r.id
WHERE e.split = 'held_out'
  AND jsonb_path_exists(e.report, '$.cases[*].rollouts[*] ? (exists(@.trace) || exists(@.error))')
UNION ALL
SELECT 'diagnosis:' || r.number FROM rounds r
JOIN learning_evaluations e ON e.round_id = r.id AND e.role = 'candidate'
LEFT JOIN learning_candidates c ON c.round_id = r.id AND c.sample = e.sample
WHERE c.diagnosis IS NULL
UNION ALL
SELECT 'prediction:' || r.number FROM rounds r
LEFT JOIN learning_candidates c ON c.round_id = r.id AND c.sample = r.adopted_sample
LEFT JOIN learning_memory_attempts a ON a.round_id = r.id
WHERE r.decision = 'adopted' AND (a.round_id IS NULL OR to_jsonb(a.predicted) IS DISTINCT FROM c.diagnosis -> 'predicted');
COMMIT;
