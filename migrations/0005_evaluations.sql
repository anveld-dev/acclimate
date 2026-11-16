CREATE TABLE evaluation_requests (
 id uuid PRIMARY KEY, project_id text NOT NULL, bundle_id uuid NOT NULL,
 body jsonb NOT NULL, requested_by text NOT NULL,
 status text NOT NULL CHECK(status IN ('requested','running','completed','failed','interrupted')),
 evaluator_principal text, attempt_id text, comparison_id uuid, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,bundle_id) REFERENCES bundles(project_id,id),
 FOREIGN KEY(project_id,bundle_id,comparison_id) REFERENCES comparisons(project_id,bundle_id,id)
);
CREATE INDEX evaluation_requests_scope ON evaluation_requests(project_id,bundle_id,id DESC);
