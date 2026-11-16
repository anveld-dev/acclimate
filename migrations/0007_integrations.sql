CREATE TABLE integrations (
 id uuid PRIMARY KEY, project_id text NOT NULL, bundle_id uuid NOT NULL, channel text NOT NULL,
 display_name text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,id), UNIQUE(project_id,bundle_id,id),
 FOREIGN KEY(project_id,bundle_id,channel) REFERENCES channels(project_id,bundle_id,name)
);
CREATE TABLE integration_credentials (
 id uuid PRIMARY KEY, project_id text NOT NULL, integration_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('content-read','receipt-write')),
 secret_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 FOREIGN KEY(project_id,integration_id) REFERENCES integrations(project_id,id)
);
CREATE TABLE integration_receipts (
 integration_id uuid NOT NULL, event_id uuid NOT NULL, project_id text NOT NULL, bundle_id uuid NOT NULL, version_id uuid NOT NULL,
 body jsonb NOT NULL, fingerprint text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(integration_id,event_id),
 FOREIGN KEY(project_id,bundle_id,integration_id) REFERENCES integrations(project_id,bundle_id,id),
 FOREIGN KEY(project_id,bundle_id,version_id) REFERENCES versions(project_id,bundle_id,id)
);
CREATE INDEX integration_receipts_recent ON integration_receipts(project_id,integration_id,received_at DESC,event_id DESC);
CREATE INDEX integration_receipts_version ON integration_receipts(project_id,bundle_id,version_id,received_at DESC);
