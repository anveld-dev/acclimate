-- Observations never change lifecycle state or confer execution authority.
-- Keep the small ordering watermark after observation expiry to reject old writes.
ALTER TABLE evaluation_requests
 ADD COLUMN progress_sequence bigint NOT NULL DEFAULT 0 CHECK (progress_sequence BETWEEN 0 AND 9007199254740991),
 ADD COLUMN progress_completed integer NOT NULL DEFAULT 0 CHECK (progress_completed BETWEEN 0 AND 2000),
 ADD COLUMN progress_fingerprint text;

CREATE TABLE evaluation_progress (
 request_id uuid PRIMARY KEY REFERENCES evaluation_requests(id) ON DELETE CASCADE,
 body jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX evaluation_progress_expiry ON evaluation_progress(expires_at, request_id);
