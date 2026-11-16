ALTER TABLE bundles ADD COLUMN compatibility_target text NOT NULL DEFAULT 'generic' CHECK (compatibility_target IN ('generic','codex','claude','pi','cursor'));
