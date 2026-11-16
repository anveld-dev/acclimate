-- Compact successful outcomes for the durable content workflow; no payload copies.
CREATE TABLE command_results (
  principal_id text NOT NULL,
  project_id text NOT NULL,
  key text NOT NULL,
  path text NOT NULL,
  required_right text NOT NULL,
  fingerprint bytea NOT NULL,
  response_status integer NOT NULL,
  response_body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, project_id, key)
);
CREATE TABLE mutation_audit (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  actor_user_id uuid,
  service_principal text NOT NULL,
  principal_id text NOT NULL,
  path text NOT NULL,
  operation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mutation_audit_project ON mutation_audit(project_id,id DESC);
