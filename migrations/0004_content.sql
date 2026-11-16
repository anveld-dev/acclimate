ALTER TABLE bundles ADD COLUMN origin text NOT NULL DEFAULT 'unknown' CHECK (origin IN ('unknown','created','example','imported'));
ALTER TABLE bundles ADD COLUMN source_label text;
ALTER TABLE promotions ADD CONSTRAINT promotions_scope_unique UNIQUE(project_id,bundle_id,channel,id);
CREATE TABLE drafts (
 id uuid PRIMARY KEY, project_id text NOT NULL, bundle_id uuid NOT NULL, channel text NOT NULL,
 base_version_id uuid NOT NULL, base_revision bigint NOT NULL CHECK(base_revision>0), snapshot_version_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0), status text NOT NULL CHECK(status IN ('open','discarded','published')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), promotion_id uuid,
 UNIQUE(project_id,bundle_id,channel,id),
 FOREIGN KEY(project_id,bundle_id,channel) REFERENCES channels(project_id,bundle_id,name),
 FOREIGN KEY(project_id,bundle_id,base_version_id) REFERENCES versions(project_id,bundle_id,id),
 FOREIGN KEY(project_id,bundle_id,snapshot_version_id) REFERENCES versions(project_id,bundle_id,id),
 FOREIGN KEY(project_id,bundle_id,channel,promotion_id) REFERENCES promotions(project_id,bundle_id,channel,id)
);
CREATE INDEX drafts_open_scope ON drafts(project_id,bundle_id,channel,updated_at DESC) WHERE status='open';
CREATE TABLE draft_snapshots (
 project_id text NOT NULL,bundle_id uuid NOT NULL,channel text NOT NULL,draft_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),version_id uuid NOT NULL,
 PRIMARY KEY(draft_id,generation),
 FOREIGN KEY(project_id,bundle_id,channel,draft_id) REFERENCES drafts(project_id,bundle_id,channel,id),
 FOREIGN KEY(project_id,bundle_id,version_id) REFERENCES versions(project_id,bundle_id,id)
);
