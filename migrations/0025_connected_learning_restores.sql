-- Retain the exact reviewed target and response for retries after delivery advances.
CREATE TABLE connected_learning_restores (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    restore_id uuid NOT NULL,
    reviewer text NOT NULL,
    request jsonb NOT NULL,
    promotion_id uuid NOT NULL UNIQUE REFERENCES promotions(id),
    response jsonb NOT NULL,
    PRIMARY KEY (project_id, integration_id, restore_id),
    FOREIGN KEY (project_id, integration_id)
        REFERENCES connected_learning_enrollments(project_id, integration_id)
);
