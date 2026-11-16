CREATE INDEX evaluation_requests_created_scope ON evaluation_requests(project_id,bundle_id,created_at DESC,id DESC);
CREATE INDEX proposals_created_scope ON proposals(project_id,bundle_id,created_at DESC,id DESC);
CREATE INDEX comparisons_created_scope ON comparisons(project_id,bundle_id,created_at DESC,id DESC);
