-- Existing descriptors were registered without verifying the installed fixture values.
-- In-flight work can finish under manual review; a subsequent policy rotation installs
-- content-bound development and audit fixtures before automatic release is authorized again.
UPDATE connected_learning_enrollments SET automatic_rollout = false WHERE automatic_rollout;

ALTER TABLE connected_learning_enrollments
    ADD CHECK (NOT automatic_rollout OR (development->>'fixtureProtocol') IS NOT DISTINCT FROM 'installed-v1');
