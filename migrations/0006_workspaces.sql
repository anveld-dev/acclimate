CREATE TABLE projects(id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO projects(id,name) SELECT DISTINCT project_id,project_id FROM bundles ON CONFLICT DO NOTHING;
CREATE TABLE users(id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL, UNIQUE(issuer,subject));
CREATE TABLE project_memberships(project_id text NOT NULL REFERENCES projects(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('viewer','editor','admin')), PRIMARY KEY(project_id,user_id));
CREATE TABLE browser_sessions(id uuid PRIMARY KEY, secret_hash text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, revoked_at timestamptz);
ALTER TABLE bundles ADD CONSTRAINT bundles_project_fk FOREIGN KEY(project_id) REFERENCES projects(id);
