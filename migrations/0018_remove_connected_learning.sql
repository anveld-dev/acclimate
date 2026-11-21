-- Phase 2: remove connected learning and the comparison machinery (D7, D8).
DROP VIEW connected_learning_round_replays;
DROP VIEW connected_learning_correction_work;
DROP VIEW connected_learning_replay_results;
-- Drop the view recreated in 0016 before dropping its enrollment and round tables.
DROP VIEW connected_learning_available_audits;

DROP TABLE
    connected_learning_round_corrections,
    connected_learning_incumbent_events,
    connected_learning_field_decisions,
    connected_learning_field_verdicts,
    connected_learning_field_releases,
    connected_learning_automatic_promotions,
    connected_learning_authorizations,
    connected_learning_replay_obligations,
    connected_learning_corrections,
    connected_learning_rounds,
    connected_learning_outcomes,
    connected_learning_renewals,
    connected_learning_policy_epochs,
    connected_learning_cohorts,
    connected_learning_enrollments;

DROP FUNCTION connected_field_checkpoint(text, uuid, bigint, uuid);
DROP FUNCTION connected_field_eligible(text, uuid, uuid, bigint);
DROP FUNCTION connected_field_requirements(text, uuid, uuid, bigint);
DROP FUNCTION connected_learning_identities(jsonb);
DROP FUNCTION connected_learning_register(text, uuid, uuid, integer, jsonb);
DROP FUNCTION connected_learning_preserve_audits();
DROP FUNCTION connected_learning_record_primary_correction();

ALTER TABLE versions DROP COLUMN proposal_id;
DROP TABLE evaluation_progress;
DROP TABLE evaluation_requests;
ALTER TABLE promotions DROP COLUMN comparison_id;
DROP TABLE comparisons;
DROP TABLE proposals;

-- Connected-learning receipts can never be replayed. The table stays for the loop routes.
DELETE FROM durable_commands WHERE scope LIKE 'learning/%';

DELETE FROM operation_records WHERE path ~ '^/v1/workspaces/[^/]+/(bundles/[^/]+/(proposals|comparisons|evaluation-requests)|connections/[^/]+/learning)(/|$)';
DELETE FROM idempotency WHERE path ~ '^/v1/workspaces/[^/]+/(bundles/[^/]+/(proposals|comparisons|evaluation-requests)|connections/[^/]+/learning)(/|$)';
