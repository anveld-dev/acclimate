-- Legacy records do not distinguish a browser administrator from a grant
-- with a reserved principal ID. Require fresh authorization after upgrade.
UPDATE connected_learning_enrollments
SET automatic_rollout = false
WHERE automatic_rollout;
