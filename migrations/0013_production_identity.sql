-- The production identity cutover requires fresh verified browser login once.
-- Business identities, memberships, content, credentials and receipt owners stay.
UPDATE browser_sessions SET revoked_at = now() WHERE revoked_at IS NULL;

CREATE TABLE workspace_adoptions (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    user_id UUID NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
