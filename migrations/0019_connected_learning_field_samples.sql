ALTER TABLE connected_learning_enrollments
    ADD COLUMN automatic_rollback boolean NOT NULL DEFAULT true;

ALTER TABLE connected_learning_outcomes
    ADD COLUMN started_receipt_id uuid,
    ADD COLUMN delivery_revision bigint CHECK (delivery_revision > 0),
    ADD COLUMN field_parent_version_id uuid,
    ADD CHECK ((started_receipt_id IS NULL) = (delivery_revision IS NULL)),
    ADD CHECK (field_parent_version_id IS NULL OR started_receipt_id IS NOT NULL),
    ADD FOREIGN KEY (project_id,bundle_id,field_parent_version_id) REFERENCES versions(project_id,bundle_id,id);

-- Delivery observations expire. Retain the binding after validating the active
-- receipt without imposing a foreign key that would extend receipt retention.
CREATE UNIQUE INDEX connected_learning_distinct_started_receipt
    ON connected_learning_outcomes(project_id,bundle_id,integration_id,started_receipt_id)
    WHERE started_receipt_id IS NOT NULL;
