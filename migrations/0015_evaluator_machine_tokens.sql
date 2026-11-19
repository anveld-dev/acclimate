-- Workspace-issued machine tokens. Only a SHA-256 digest of each secret is stored.
CREATE TABLE machine_tokens (
    id uuid NOT NULL,
    project_id text NOT NULL REFERENCES projects(id),
    principal_id text NOT NULL,
    name text NOT NULL,
    secret_hash text NOT NULL,
    secret_prefix text NOT NULL,
    rights text[] NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    revoked_by text,
    revoke_reason text,
    rotated_from uuid,
    PRIMARY KEY (id),
    UNIQUE (secret_hash),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, rotated_from) REFERENCES machine_tokens(project_id, id),
    CHECK (principal_id LIKE 'machine:%' AND length(principal_id) <= 72),
    CHECK (length(name) BETWEEN 1 AND 64),
    CHECK (cardinality(rights) BETWEEN 1 AND 5
        AND rights <@ ARRAY['read', 'evaluate', 'write', 'propose', 'promote']::text[]),
    CHECK (expires_at > created_at),
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX machine_tokens_project ON machine_tokens (project_id, created_at DESC, id DESC);

-- Append-only audit of issue, rotation and revocation. Secrets never appear here.
CREATE TABLE machine_token_events (
    id bigserial,
    project_id text NOT NULL,
    token_id uuid NOT NULL,
    action text NOT NULL,
    actor_principal text NOT NULL,
    reason text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    FOREIGN KEY (project_id, token_id) REFERENCES machine_tokens(project_id, id),
    CHECK (action IN ('issued', 'rotated', 'revoked'))
);

CREATE INDEX machine_token_events_project ON machine_token_events (project_id, id DESC);

CREATE FUNCTION machine_token_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'machine token audit is append-only';
END;
$$;

CREATE TRIGGER machine_token_events_append_only
    BEFORE UPDATE OR DELETE ON machine_token_events
    FOR EACH ROW EXECUTE FUNCTION machine_token_events_append_only();

-- A server-side terminal state for an attempt whose outcome is unknown. It never
-- claims the original worker stopped; it only refuses that attempt's evidence.
ALTER TABLE evaluation_requests DROP CONSTRAINT evaluation_requests_status_check;
ALTER TABLE evaluation_requests
    ADD CONSTRAINT evaluation_requests_status_check
    CHECK (status IN ('requested', 'running', 'completed', 'failed', 'interrupted', 'abandoned')),
    ADD COLUMN last_activity_at timestamptz,
    ADD COLUMN abandoned_at timestamptz,
    ADD COLUMN abandoned_by text,
    ADD CONSTRAINT evaluation_requests_abandonment
    CHECK ((status = 'abandoned') = (abandoned_at IS NOT NULL AND abandoned_by IS NOT NULL));

UPDATE evaluation_requests SET last_activity_at = started_at WHERE status = 'running';

CREATE INDEX evaluation_requests_abandonment_scan
    ON evaluation_requests (last_activity_at)
    WHERE status = 'running';
