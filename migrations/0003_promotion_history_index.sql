CREATE INDEX promotions_history ON promotions(project_id, bundle_id, channel, revision DESC);
