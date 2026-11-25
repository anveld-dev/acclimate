-- A fixed value sealed under ACCLIMATE_PROVIDER_ENCRYPTION_KEY the first time the service starts
-- with a key. Later starts refuse a key that cannot open it, rather than failing every lease.
CREATE TABLE provider_key_check (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    check_value bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
