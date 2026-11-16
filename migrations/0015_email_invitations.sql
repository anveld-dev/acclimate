ALTER TABLE users ADD COLUMN email text;
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT verified_email_present CHECK (NOT email_verified OR email IS NOT NULL);
CREATE TABLE workspace_invitations (
    id uuid PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
    role text NOT NULL CHECK (role IN ('viewer','editor','admin')),
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
    accepted_by uuid REFERENCES users(id),
    delivery_status text NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','sending','sent','failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
CREATE UNIQUE INDEX one_pending_email_invitation ON workspace_invitations(project_id,email) WHERE status='pending';
CREATE INDEX invitation_delivery_queue ON workspace_invitations(next_attempt_at) WHERE status='pending' AND delivery_status='queued';
