-- Imports are listed newest first. An outcome whose expected answer needs criteria is
-- converted through a one-row import that records the outcome it came from.
ALTER TABLE learning_task_imports
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN outcome jsonb;
CREATE INDEX learning_task_imports_recent ON learning_task_imports(project_id,bundle_id,created_at DESC) WHERE outcome IS NULL;
