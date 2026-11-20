ALTER TABLE learning_rounds
    ADD COLUMN optimizer_reasoning_effort text
    CHECK (optimizer_reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max', 'ultra'));

CREATE INDEX learning_evolve_cases_page
    ON learning_evolve_cases (project_id, bundle_id, case_id COLLATE "C");
