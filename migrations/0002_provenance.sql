-- Keep authorship after idempotency replay records expire.
ALTER TABLE versions ADD COLUMN created_by text NOT NULL DEFAULT 'legacy-unattributed';
ALTER TABLE proposals ADD COLUMN requested_by text NOT NULL DEFAULT 'legacy-unattributed';
-- Each proposal can publish only one candidate, including across process restarts.
ALTER TABLE versions ADD COLUMN proposal_id uuid UNIQUE REFERENCES proposals(id);
UPDATE versions v SET proposal_id = p.id FROM proposals p WHERE p.candidate_version_id = v.id;
