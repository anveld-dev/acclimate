-- Workspace identity and access

CREATE TABLE projects (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE TABLE users (
    id uuid NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    display_name text,
    email text,
    email_verified boolean NOT NULL DEFAULT false,
    PRIMARY KEY (id),
    UNIQUE (issuer, subject),
    CONSTRAINT users_display_name_length CHECK (display_name IS NULL OR length(display_name) >= 1 AND length(display_name) <= 200),
    CONSTRAINT verified_email_present CHECK (NOT email_verified OR email IS NOT NULL)
);

CREATE TABLE project_memberships (
    project_id text NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    CHECK (role IN ('viewer', 'editor', 'admin')),
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE browser_sessions (
    id uuid NOT NULL,
    secret_hash text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    PRIMARY KEY (id),
    UNIQUE (secret_hash),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE workspace_adoptions (
    project_id text NOT NULL,
    user_id uuid NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (length(btrim(reason)) > 0),
    PRIMARY KEY (project_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE workspace_invitations (
    id uuid NOT NULL,
    project_id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + '7 days'::interval,
    status text NOT NULL DEFAULT 'pending',
    accepted_by uuid,
    delivery_status text NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    CHECK (length(email) >= 3 AND length(email) <= 254),
    CHECK (role IN ('viewer', 'editor', 'admin')),
    CHECK (status IN ('pending', 'accepted', 'revoked')),
    CHECK (delivery_status IN ('queued', 'sending', 'sent', 'failed')),
    PRIMARY KEY (id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (accepted_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX one_pending_email_invitation ON workspace_invitations (project_id, email) WHERE (status = 'pending');

CREATE INDEX invitation_delivery_queue ON workspace_invitations (next_attempt_at) WHERE ((status = 'pending') AND (delivery_status = 'queued'));

-- Bundles, changes, and releases

CREATE TABLE bundles (
    id uuid NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    origin text NOT NULL DEFAULT 'unknown',
    source_label text,
    compatibility_target text NOT NULL DEFAULT 'generic',
    PRIMARY KEY (id),
    UNIQUE (project_id, id),
    CHECK (origin IN ('unknown', 'created', 'example', 'imported')),
    CONSTRAINT bundles_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
    CHECK (compatibility_target IN ('generic', 'codex', 'claude', 'pi', 'cursor'))
);

CREATE TABLE comparisons (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    body jsonb NOT NULL,
    complete boolean NOT NULL,
    submitter text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles(project_id, id)
);

CREATE INDEX comparisons_created_scope ON comparisons (project_id, bundle_id, created_at DESC, id DESC);

CREATE TABLE proposals (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    parent_version_id uuid NOT NULL,
    request jsonb NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    candidate_version_id uuid,
    rationale text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    requested_by text NOT NULL,
    skill_packages jsonb,
    PRIMARY KEY (id),
    UNIQUE (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles(project_id, id)
);

CREATE INDEX proposals_jobs ON proposals (status, created_at);

CREATE INDEX proposals_created_scope ON proposals (project_id, bundle_id, created_at DESC, id DESC);

CREATE TABLE versions (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    parent_version_id uuid,
    digest text NOT NULL,
    payload bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    proposal_id uuid,
    PRIMARY KEY (id),
    UNIQUE (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles(project_id, id),
    FOREIGN KEY (project_id, bundle_id, parent_version_id) REFERENCES versions(project_id, bundle_id, id),
    UNIQUE (proposal_id),
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);

CREATE INDEX versions_bundle_digest ON versions (project_id, bundle_id, digest);

CREATE TABLE channels (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    name text NOT NULL,
    revision bigint NOT NULL,
    version_id uuid NOT NULL,
    PRIMARY KEY (project_id, bundle_id, name),
    FOREIGN KEY (project_id, bundle_id, version_id) REFERENCES versions(project_id, bundle_id, id)
);

CREATE TABLE promotions (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    channel text NOT NULL,
    revision bigint NOT NULL,
    version_id uuid NOT NULL,
    previous_version_id uuid,
    comparison_id uuid,
    unevaluated_reason text,
    reviewer text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    policy_override jsonb,
    policy_approval_promotion_id uuid,
    PRIMARY KEY (id),
    CONSTRAINT promotions_scope_unique UNIQUE (project_id, bundle_id, channel, id),
    FOREIGN KEY (policy_approval_promotion_id) REFERENCES promotions(id)
);

CREATE INDEX promotions_history ON promotions (project_id, bundle_id, channel, revision DESC);

CREATE TABLE drafts (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    channel text NOT NULL,
    base_version_id uuid NOT NULL,
    base_revision bigint NOT NULL,
    snapshot_version_id uuid NOT NULL,
    generation bigint NOT NULL,
    status text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    promotion_id uuid,
    CHECK (base_revision > 0),
    CHECK (generation > 0),
    CHECK (status IN ('open', 'discarded', 'published')),
    PRIMARY KEY (id),
    UNIQUE (project_id, bundle_id, channel, id),
    FOREIGN KEY (project_id, bundle_id, channel) REFERENCES channels(project_id, bundle_id, name),
    FOREIGN KEY (project_id, bundle_id, base_version_id) REFERENCES versions(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, snapshot_version_id) REFERENCES versions(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, channel, promotion_id) REFERENCES promotions(project_id, bundle_id, channel, id)
);

CREATE INDEX drafts_open_scope ON drafts (project_id, bundle_id, channel, updated_at DESC) WHERE (status = 'open');

CREATE TABLE draft_snapshots (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    channel text NOT NULL,
    draft_id uuid NOT NULL,
    generation bigint NOT NULL,
    version_id uuid NOT NULL,
    CHECK (generation > 0),
    PRIMARY KEY (draft_id, generation),
    FOREIGN KEY (project_id, bundle_id, channel, draft_id) REFERENCES drafts(project_id, bundle_id, channel, id),
    FOREIGN KEY (project_id, bundle_id, version_id) REFERENCES versions(project_id, bundle_id, id)
);

-- Evaluation requests and evidence

CREATE TABLE evaluation_requests (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    body jsonb NOT NULL,
    requested_by text NOT NULL,
    status text NOT NULL,
    evaluator_principal text,
    attempt_id text,
    comparison_id uuid,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    progress_sequence bigint NOT NULL DEFAULT 0,
    progress_completed integer NOT NULL DEFAULT 0,
    progress_fingerprint text,
    CHECK (status IN ('requested', 'running', 'completed', 'failed', 'interrupted')),
    PRIMARY KEY (id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles(project_id, id),
    FOREIGN KEY (project_id, bundle_id, comparison_id) REFERENCES comparisons(project_id, bundle_id, id),
    CHECK (progress_sequence >= 0 AND progress_sequence <= '9007199254740991'::bigint),
    CHECK (progress_completed >= 0 AND progress_completed <= 2000),
    UNIQUE (project_id, bundle_id, id)
);

CREATE INDEX evaluation_requests_scope ON evaluation_requests (project_id, bundle_id, id DESC);

CREATE INDEX evaluation_requests_created_scope ON evaluation_requests (project_id, bundle_id, created_at DESC, id DESC);

CREATE TABLE evaluation_progress (
    request_id uuid NOT NULL,
    body jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + '24:00:00'::interval,
    PRIMARY KEY (request_id),
    FOREIGN KEY (request_id) REFERENCES evaluation_requests(id) ON DELETE CASCADE
);

CREATE INDEX evaluation_progress_expiry ON evaluation_progress (expires_at, request_id);

CREATE TABLE evaluation_policy_receipts (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    candidate_version_id uuid NOT NULL,
    comparison_id uuid NOT NULL,
    policy_digest text NOT NULL,
    body jsonb NOT NULL,
    reported_by text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comparison_id, policy_digest),
    FOREIGN KEY (project_id, bundle_id, comparison_id) REFERENCES comparisons(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, candidate_version_id) REFERENCES versions(project_id, bundle_id, id)
);

CREATE INDEX evaluation_policy_receipts_candidate ON evaluation_policy_receipts (project_id, bundle_id, candidate_version_id);

-- Connected applications and delivery

CREATE TABLE integrations (
    id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    channel text NOT NULL,
    display_name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (project_id, id),
    UNIQUE (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, channel) REFERENCES channels(project_id, bundle_id, name)
);

CREATE TABLE integration_credentials (
    id uuid NOT NULL,
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    kind text NOT NULL,
    secret_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    issued_by text,
    operation_key text,
    CHECK (kind IN ('content-read', 'receipt-write')),
    PRIMARY KEY (id),
    UNIQUE (secret_hash),
    FOREIGN KEY (project_id, integration_id) REFERENCES integrations(project_id, id)
);

CREATE UNIQUE INDEX integration_credential_operation ON integration_credentials (project_id, integration_id, issued_by, operation_key);

CREATE TABLE integration_receipts (
    integration_id uuid NOT NULL,
    event_id uuid NOT NULL,
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    version_id uuid NOT NULL,
    body jsonb NOT NULL,
    fingerprint text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (integration_id, event_id),
    FOREIGN KEY (project_id, bundle_id, integration_id) REFERENCES integrations(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, version_id) REFERENCES versions(project_id, bundle_id, id)
);

CREATE INDEX integration_receipts_recent ON integration_receipts (project_id, integration_id, received_at DESC, event_id DESC);

CREATE INDEX integration_receipts_version ON integration_receipts (project_id, bundle_id, version_id, received_at DESC);

-- Command idempotency and recovery

CREATE TABLE idempotency (
    principal_id text NOT NULL,
    project_id text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    key text NOT NULL,
    fingerprint bytea NOT NULL,
    response_status integer NOT NULL,
    response_body bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (principal_id, project_id, method, path, key)
);

CREATE TABLE mutation_audit (
    id bigserial,
    project_id text NOT NULL,
    actor_user_id uuid,
    service_principal text NOT NULL,
    principal_id text NOT NULL,
    path text NOT NULL,
    operation_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX mutation_audit_project ON mutation_audit (project_id, id DESC);

CREATE TABLE operation_records (
    principal_id text NOT NULL,
    project_id text NOT NULL,
    namespace text NOT NULL,
    key text NOT NULL,
    path text NOT NULL,
    status text NOT NULL,
    fingerprint bytea,
    response_status integer,
    response_body bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status IN ('committed', 'closed')),
    PRIMARY KEY (principal_id, project_id, namespace, key)
);

-- Connected learning

CREATE TABLE connected_learning_enrollments (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    source_channel text NOT NULL,
    source_revision bigint NOT NULL,
    delivery_channel text NOT NULL,
    installation_id text NOT NULL,
    permitted_paths text[] NOT NULL,
    max_proposal_admissions integer NOT NULL,
    proposal_admissions integer NOT NULL DEFAULT 0,
    development jsonb NOT NULL,
    audits jsonb NOT NULL,
    automatic_rollout boolean NOT NULL,
    outcome_principal text NOT NULL,
    evaluator_principal text NOT NULL,
    authorized_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    stopped_at timestamptz,
    renewal_revision bigint NOT NULL DEFAULT 0,
    automatic_rollback boolean NOT NULL DEFAULT true,
    policy_epoch bigint NOT NULL DEFAULT 0,
    selection_policies jsonb,
    skill_packages jsonb,
    CHECK (source_revision > 0),
    CHECK (cardinality(permitted_paths) >= 1 AND cardinality(permitted_paths) <= 32),
    CHECK (proposal_admissions >= 0 AND proposal_admissions <= max_proposal_admissions),
    CHECK (jsonb_typeof(development) = 'object'),
    CHECK (outcome_principal <> evaluator_principal),
    CHECK (source_channel <> delivery_channel),
    PRIMARY KEY (project_id, integration_id),
    UNIQUE (project_id, bundle_id, integration_id),
    UNIQUE (project_id, bundle_id, delivery_channel),
    FOREIGN KEY (project_id, bundle_id, integration_id) REFERENCES integrations(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, source_channel) REFERENCES channels(project_id, bundle_id, name),
    FOREIGN KEY (project_id, bundle_id, delivery_channel) REFERENCES channels(project_id, bundle_id, name),
    CHECK (renewal_revision >= 0),
    CHECK (max_proposal_admissions > 0),
    CHECK (jsonb_typeof(audits) = 'array' AND jsonb_array_length(audits) > 0),
    CHECK (NOT automatic_rollout OR NOT (development ->> 'fixtureProtocol') IS DISTINCT FROM 'installed-v1'),
    CHECK (policy_epoch >= 0)
);

CREATE TABLE connected_learning_outcomes (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    version_id uuid NOT NULL,
    digest text NOT NULL,
    status text NOT NULL,
    lesson jsonb,
    feedback jsonb,
    submitted_by text NOT NULL,
    fingerprint text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    started_receipt_id uuid,
    delivery_revision bigint,
    field_parent_version_id uuid,
    observed_revision bigint,
    CHECK (status IN ('completed', 'failed')),
    CHECK (jsonb_typeof(lesson) = 'object'),
    CHECK (jsonb_typeof(feedback) = 'object'),
    PRIMARY KEY (project_id, bundle_id, integration_id, outcome_id),
    FOREIGN KEY (project_id, bundle_id, integration_id) REFERENCES connected_learning_enrollments(project_id, bundle_id, integration_id),
    FOREIGN KEY (project_id, bundle_id, version_id) REFERENCES versions(project_id, bundle_id, id),
    CHECK (delivery_revision > 0),
    CHECK ((started_receipt_id IS NULL) = (delivery_revision IS NULL)),
    CHECK (field_parent_version_id IS NULL OR started_receipt_id IS NOT NULL),
    FOREIGN KEY (project_id, bundle_id, field_parent_version_id) REFERENCES versions(project_id, bundle_id, id),
    CHECK (observed_revision > 0)
);

CREATE INDEX connected_learning_outcomes_pending ON connected_learning_outcomes (project_id, integration_id, received_at, outcome_id) WHERE ((lesson IS NOT NULL) OR (feedback IS NOT NULL));

CREATE UNIQUE INDEX connected_learning_distinct_started_receipt ON connected_learning_outcomes (project_id, bundle_id, integration_id, started_receipt_id) WHERE (started_receipt_id IS NOT NULL);

CREATE TABLE connected_learning_renewals (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    renewal_id uuid NOT NULL,
    request jsonb NOT NULL,
    revision bigint NOT NULL,
    authorized_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (revision > 0),
    PRIMARY KEY (project_id, integration_id, renewal_id),
    UNIQUE (project_id, integration_id, revision),
    FOREIGN KEY (project_id, integration_id) REFERENCES connected_learning_enrollments(project_id, integration_id)
);

CREATE TABLE connected_learning_cohorts (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    kind text NOT NULL,
    identity text NOT NULL,
    integration_id uuid,
    audit_index integer,
    PRIMARY KEY (project_id, bundle_id, kind, identity),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles(project_id, id)
);

CREATE TABLE connected_learning_field_releases (
    promotion_id uuid NOT NULL,
    control_version_id uuid,
    validated boolean NOT NULL DEFAULT false,
    withdrawn boolean NOT NULL DEFAULT false,
    rollback_promotion_id uuid,
    PRIMARY KEY (promotion_id),
    UNIQUE (rollback_promotion_id),
    FOREIGN KEY (promotion_id) REFERENCES promotions(id),
    FOREIGN KEY (control_version_id) REFERENCES versions(id),
    FOREIGN KEY (rollback_promotion_id) REFERENCES promotions(id)
);

CREATE INDEX connected_learning_field_withdrawals ON connected_learning_field_releases (promotion_id) WHERE withdrawn;

CREATE TABLE connected_learning_corrections (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    lesson jsonb,
    feedback jsonb,
    submitted_by text NOT NULL,
    pending boolean NOT NULL DEFAULT true,
    attempts integer NOT NULL DEFAULT 0,
    queued_at timestamptz NOT NULL DEFAULT now(),
    require_incident_replay boolean NOT NULL DEFAULT false,
    CHECK (attempts >= 0 AND attempts <= 2),
    CHECK (lesson IS NOT NULL OR feedback IS NOT NULL),
    PRIMARY KEY (project_id, integration_id, correction_id),
    UNIQUE (project_id, integration_id, correction_id, outcome_id),
    FOREIGN KEY (project_id, bundle_id, integration_id, outcome_id) REFERENCES connected_learning_outcomes(project_id, bundle_id, integration_id, outcome_id)
);

CREATE INDEX connected_learning_corrections_pending ON connected_learning_corrections (project_id, integration_id, queued_at, correction_id) WHERE pending;

CREATE INDEX connected_learning_corrections_by_outcome ON connected_learning_corrections (project_id, integration_id, outcome_id, queued_at);

CREATE TABLE connected_learning_rechecks (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    version_id uuid NOT NULL,
    revision bigint NOT NULL,
    digest text NOT NULL,
    verdict text NOT NULL,
    evaluator text NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    CHECK (revision > 0),
    CHECK (verdict IN ('reproduced', 'resolved', 'unavailable')),
    PRIMARY KEY (project_id, integration_id, correction_id, revision),
    FOREIGN KEY (version_id) REFERENCES versions(id),
    FOREIGN KEY (project_id, integration_id, correction_id) REFERENCES connected_learning_corrections(project_id, integration_id, correction_id)
);

CREATE TABLE connected_learning_policy_epochs (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    epoch bigint NOT NULL,
    development jsonb NOT NULL,
    selection_policies jsonb,
    PRIMARY KEY (project_id, integration_id, epoch),
    FOREIGN KEY (project_id, integration_id) REFERENCES connected_learning_enrollments(project_id, integration_id)
);

CREATE TABLE connected_learning_rounds (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    id uuid NOT NULL,
    outcome_id uuid NOT NULL,
    parent_version_id uuid NOT NULL,
    parent_revision bigint NOT NULL,
    proposal_id uuid,
    candidate_version_id uuid,
    development_request_id uuid,
    development_comparison_id uuid,
    audit_index integer,
    audit_request_id uuid,
    audit_comparison_id uuid,
    promotion_id uuid,
    state text NOT NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    field_audit_window_size integer NOT NULL DEFAULT 0,
    field_audit_regressions integer NOT NULL DEFAULT 0,
    rollback_promotion_id uuid,
    correction_id uuid NOT NULL,
    attempt integer NOT NULL,
    policy_epoch bigint NOT NULL DEFAULT 0,
    incident_replay text,
    CHECK (parent_revision > 0),
    CHECK (state IN ('proposing', 'development', 'audit', 'awaiting_review', 'promoted', 'rejected')),
    CHECK (state = 'rejected' OR proposal_id IS NOT NULL),
    CHECK (development_request_id IS NULL OR candidate_version_id IS NOT NULL),
    CHECK (development_comparison_id IS NULL OR development_request_id IS NOT NULL),
    CHECK (audit_request_id IS NULL OR audit_index IS NOT NULL AND development_comparison_id IS NOT NULL),
    CHECK (audit_comparison_id IS NULL OR audit_request_id IS NOT NULL),
    CHECK (audit_request_id IS NULL OR audit_request_id <> development_request_id),
    CHECK (state <> 'development' OR development_request_id IS NOT NULL),
    CHECK (state <> 'audit' OR audit_request_id IS NOT NULL),
    CHECK (state <> 'awaiting_review' OR audit_comparison_id IS NOT NULL),
    CHECK (promotion_id IS NULL OR audit_comparison_id IS NOT NULL),
    CHECK ((state = 'promoted') = (promotion_id IS NOT NULL)),
    PRIMARY KEY (id),
    UNIQUE (proposal_id),
    UNIQUE (development_request_id),
    UNIQUE (development_comparison_id),
    UNIQUE (audit_request_id),
    UNIQUE (audit_comparison_id),
    UNIQUE (promotion_id),
    UNIQUE (project_id, integration_id, audit_index),
    FOREIGN KEY (promotion_id) REFERENCES promotions(id),
    FOREIGN KEY (project_id, bundle_id, integration_id, outcome_id) REFERENCES connected_learning_outcomes(project_id, bundle_id, integration_id, outcome_id),
    FOREIGN KEY (project_id, bundle_id, parent_version_id) REFERENCES versions(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, candidate_version_id) REFERENCES versions(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, proposal_id) REFERENCES proposals(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, development_request_id) REFERENCES evaluation_requests(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, audit_request_id) REFERENCES evaluation_requests(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, development_comparison_id) REFERENCES comparisons(project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, audit_comparison_id) REFERENCES comparisons(project_id, bundle_id, id),
    CHECK (audit_index >= 0),
    UNIQUE (rollback_promotion_id),
    CHECK (field_audit_window_size >= 0 AND field_audit_window_size <= 10),
    CHECK (field_audit_regressions >= 0 AND field_audit_regressions <= field_audit_window_size),
    FOREIGN KEY (rollback_promotion_id) REFERENCES promotions(id),
    CHECK (rollback_promotion_id IS NULL OR state = 'promoted' AND field_audit_regressions >= 3),
    UNIQUE (project_id, integration_id, correction_id, attempt),
    CHECK (attempt >= 0 AND attempt <= 2),
    FOREIGN KEY (project_id, integration_id, correction_id, outcome_id) REFERENCES connected_learning_corrections(project_id, integration_id, correction_id, outcome_id),
    FOREIGN KEY (project_id, integration_id, policy_epoch) REFERENCES connected_learning_policy_epochs(project_id, integration_id, epoch),
    CHECK (incident_replay IN ('pending', 'pass', 'regression', 'unavailable')),
    CHECK (state <> 'promoted' OR incident_replay IS NULL OR incident_replay = 'pass')
);

CREATE TABLE connected_learning_field_verdicts (
    sequence bigint GENERATED ALWAYS AS IDENTITY,
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    bundle_id uuid NOT NULL,
    round_id uuid,
    outcome_id uuid NOT NULL,
    started_receipt_id uuid NOT NULL,
    verdict text NOT NULL,
    evaluator_principal text NOT NULL,
    request jsonb NOT NULL,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    promotion_id uuid NOT NULL,
    CHECK (verdict IN ('pass', 'regression')),
    PRIMARY KEY (sequence),
    UNIQUE (project_id, bundle_id, integration_id, outcome_id),
    UNIQUE (project_id, bundle_id, integration_id, started_receipt_id),
    FOREIGN KEY (round_id) REFERENCES connected_learning_rounds(id),
    FOREIGN KEY (project_id, bundle_id, integration_id, outcome_id) REFERENCES connected_learning_outcomes(project_id, bundle_id, integration_id, outcome_id),
    FOREIGN KEY (promotion_id) REFERENCES connected_learning_field_releases(promotion_id)
);

CREATE INDEX connected_learning_field_verdicts_window ON connected_learning_field_verdicts (round_id, sequence DESC);

CREATE INDEX connected_learning_field_release_verdicts ON connected_learning_field_verdicts (promotion_id, ((request ->> 'parentVersionId')), sequence DESC);

CREATE TABLE connected_learning_field_requalifications (
    regression_sequence bigint NOT NULL,
    candidate_version_id uuid NOT NULL,
    baseline_revision bigint NOT NULL,
    verdict text NOT NULL,
    evaluator_principal text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (baseline_revision > 0),
    CHECK (verdict IN ('pass', 'regression')),
    PRIMARY KEY (regression_sequence, candidate_version_id, baseline_revision),
    FOREIGN KEY (regression_sequence) REFERENCES connected_learning_field_verdicts(sequence),
    FOREIGN KEY (candidate_version_id) REFERENCES versions(id)
);

CREATE TABLE connected_learning_restores (
    project_id text NOT NULL,
    integration_id uuid NOT NULL,
    restore_id uuid NOT NULL,
    reviewer text NOT NULL,
    request jsonb NOT NULL,
    promotion_id uuid NOT NULL,
    response jsonb NOT NULL,
    PRIMARY KEY (project_id, integration_id, restore_id),
    UNIQUE (promotion_id),
    FOREIGN KEY (promotion_id) REFERENCES promotions(id),
    FOREIGN KEY (project_id, integration_id) REFERENCES connected_learning_enrollments(project_id, integration_id)
);

-- Cohort registration, field validation, and policy history

CREATE FUNCTION connected_learning_identities(descriptor jsonb)
RETURNS TABLE(kind text, identity text) LANGUAGE sql IMMUTABLE AS $$
    SELECT 'dataset', btrim(descriptor->>'datasetRevision')
    UNION
    SELECT 'case', btrim(item->>'caseId')
    FROM jsonb_array_elements(descriptor->'expectedCases') AS item
    UNION
    SELECT 'dataset-digest', descriptor->>'datasetDigest'
    WHERE descriptor->>'datasetDigest' IS NOT NULL
    UNION
    SELECT 'case-digest', item
    FROM jsonb_array_elements_text(descriptor->'caseFingerprints') AS item
    UNION
    SELECT 'family-digest', item
    FROM jsonb_array_elements_text(descriptor->'familyFingerprints') AS item
$$;

CREATE FUNCTION connected_learning_register(identity_project text, identity_bundle uuid, owner uuid, slot integer, descriptor jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO connected_learning_cohorts(project_id,bundle_id,kind,identity,integration_id,audit_index)
    SELECT identity_project,identity_bundle,kind,identity,
           CASE WHEN slot IS NOT NULL THEN owner END,slot
    FROM connected_learning_identities(descriptor)
    ORDER BY kind,identity
    ON CONFLICT DO NOTHING;
    IF EXISTS (
        SELECT 1
        FROM connected_learning_identities(descriptor) AS input
        JOIN connected_learning_cohorts AS existing
          ON (existing.project_id,existing.bundle_id,existing.kind,existing.identity)
           = (identity_project,identity_bundle,input.kind,input.identity)
        WHERE existing.audit_index IS DISTINCT FROM slot
           OR (slot IS NOT NULL AND existing.integration_id IS DISTINCT FROM owner)
    ) THEN
        RAISE EXCEPTION 'Connected learning cohort identity collision'
            USING ERRCODE = '23505', CONSTRAINT = 'connected_learning_cohort_exclusive';
    END IF;
END;
$$;

CREATE FUNCTION connected_learning_register_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous_count integer := 0;
    item record;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        previous_count := jsonb_array_length(OLD.audits);
        IF jsonb_array_length(NEW.audits) < previous_count
           OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(OLD.audits) WITH ORDINALITY AS a(descriptor,n)
            WHERE a.descriptor IS DISTINCT FROM NEW.audits->((a.n-1)::integer)
           ) THEN
            RAISE EXCEPTION 'Connected learning cohorts are append only' USING ERRCODE = '23514';
        END IF;
        IF jsonb_array_length(NEW.audits) = previous_count AND NEW.development = OLD.development THEN
            RETURN NEW;
        END IF;
    END IF;
    -- Serialize registration across all campaigns of this bundle.
    PERFORM pg_advisory_xact_lock(hashtextextended('connected-learning-cohorts:' || NEW.project_id || ':' || NEW.bundle_id::text, 0));
    IF TG_OP = 'INSERT' OR NEW.development IS DISTINCT FROM OLD.development THEN
        PERFORM connected_learning_register(NEW.project_id,NEW.bundle_id,NEW.integration_id,NULL,NEW.development);
    END IF;
    FOR item IN
        SELECT descriptor,(n-1)::integer AS slot
        FROM jsonb_array_elements(NEW.audits) WITH ORDINALITY AS a(descriptor,n)
        WHERE n > previous_count
    LOOP
        PERFORM connected_learning_register(NEW.project_id,NEW.bundle_id,NEW.integration_id,item.slot,item.descriptor);
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE FUNCTION connected_learning_audit_registered(identity_project text, identity_bundle uuid, owner uuid, slot integer, descriptor jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT descriptor IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM connected_learning_identities(descriptor) AS input
        LEFT JOIN connected_learning_cohorts AS existing
          ON (existing.project_id,existing.bundle_id,existing.kind,existing.identity)
           = (identity_project,identity_bundle,input.kind,input.identity)
        WHERE existing.audit_index IS DISTINCT FROM slot OR existing.integration_id IS DISTINCT FROM owner
    )
$$;

CREATE FUNCTION connected_field_requirements(proj text, connection uuid, candidate uuid, base_revision bigint)
RETURNS TABLE(sequence bigint,outcome_id uuid,replay text) LANGUAGE sql STABLE AS $$
    SELECT f.sequence,f.outcome_id,q.verdict
    FROM connected_learning_enrollments e
    JOIN versions c ON (c.project_id,c.bundle_id,c.id)=(e.project_id,e.bundle_id,candidate)
    JOIN versions withdrawn ON (withdrawn.project_id,withdrawn.bundle_id,withdrawn.digest)=(e.project_id,e.bundle_id,c.digest)
    JOIN promotions p ON (p.project_id,p.bundle_id,p.channel,p.version_id)=(e.project_id,e.bundle_id,e.delivery_channel,withdrawn.id)
    JOIN connected_learning_field_releases r ON r.promotion_id=p.id AND r.withdrawn
    JOIN connected_learning_field_verdicts f ON f.promotion_id=p.id AND f.verdict='regression'
    LEFT JOIN connected_learning_field_requalifications q
      ON (q.regression_sequence,q.candidate_version_id,q.baseline_revision)=(f.sequence,candidate,base_revision)
    WHERE (e.project_id,e.integration_id)=(proj,connection)
$$;

CREATE FUNCTION connected_field_eligible(proj text, connection uuid, candidate uuid, base_revision bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (
        SELECT FROM connected_field_requirements(proj,connection,candidate,base_revision) WHERE replay IS DISTINCT FROM 'pass'
    )
$$;

CREATE FUNCTION connected_field_seed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO connected_learning_field_releases(promotion_id,validated)
    SELECT id,true FROM promotions
    WHERE (project_id,bundle_id,channel,revision)=(NEW.project_id,NEW.bundle_id,NEW.delivery_channel,1);
    RETURN NEW;
END;
$$;

CREATE FUNCTION connected_field_checkpoint(proj text, connection uuid, before_revision bigint, served uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT p.version_id FROM connected_learning_enrollments e
    JOIN promotions p ON (p.project_id,p.bundle_id,p.channel)=(e.project_id,e.bundle_id,e.delivery_channel)
    JOIN connected_learning_field_releases r ON r.promotion_id=p.id
    WHERE (e.project_id,e.integration_id)=(proj,connection)
      AND p.revision<before_revision AND p.version_id<>served AND r.validated AND NOT r.withdrawn
      -- The historical control qualified against its own authorization baseline.
      -- Any later withdrawal adds fresh replay obligations for that same digest.
      AND connected_field_eligible(proj,connection,p.version_id,GREATEST(1,p.revision-1))
    ORDER BY p.revision DESC LIMIT 1
$$;

CREATE FUNCTION connected_field_register_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    connection uuid;
    control uuid;
BEGIN
    SELECT integration_id INTO connection FROM connected_learning_enrollments
    WHERE (project_id,bundle_id,delivery_channel)=(NEW.project_id,NEW.bundle_id,NEW.channel);
    IF NOT FOUND THEN RETURN NEW; END IF;
    control := connected_field_checkpoint(NEW.project_id,connection,NEW.revision,NEW.version_id);
    INSERT INTO connected_learning_field_releases(promotion_id,control_version_id) VALUES (NEW.id,control);
    RETURN NEW;
END;
$$;

CREATE FUNCTION connected_learning_save_policy_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.policy_epoch = OLD.policy_epoch THEN
        RETURN NEW;
    END IF;
    INSERT INTO connected_learning_policy_epochs(project_id,integration_id,epoch,development,selection_policies)
    VALUES(NEW.project_id,NEW.integration_id,NEW.policy_epoch,NEW.development,NEW.selection_policies);
    RETURN NEW;
END;
$$;

CREATE FUNCTION connected_learning_pin_policy_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT e.policy_epoch INTO STRICT NEW.policy_epoch FROM connected_learning_enrollments e
    WHERE e.project_id=NEW.project_id AND e.integration_id=NEW.integration_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER connected_learning_register_enrollment
AFTER INSERT OR UPDATE OF development,audits ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_learning_register_enrollment();

CREATE TRIGGER connected_field_seed AFTER INSERT ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_field_seed();

CREATE TRIGGER connected_field_register_release AFTER INSERT ON promotions
FOR EACH ROW EXECUTE FUNCTION connected_field_register_release();

CREATE TRIGGER connected_learning_save_policy_epoch
AFTER INSERT OR UPDATE OF policy_epoch ON connected_learning_enrollments
FOR EACH ROW EXECUTE FUNCTION connected_learning_save_policy_epoch();

CREATE TRIGGER connected_learning_pin_policy_epoch BEFORE INSERT ON connected_learning_rounds
FOR EACH ROW EXECUTE FUNCTION connected_learning_pin_policy_epoch();

CREATE VIEW connected_learning_correction_work AS
SELECT f.project_id,f.bundle_id,f.integration_id,f.correction_id,f.outcome_id,f.lesson,
       f.feedback,f.submitted_by,f.pending,f.attempts,f.queued_at,
       o.version_id AS observed_version,o.observed_revision,o.digest AS observed_digest,o.status,
       c.version_id AS version_id,c.revision,v.digest,
       CASE WHEN (o.version_id,o.observed_revision)=(c.version_id,c.revision) OR k.verdict='reproduced'
            THEN 'ready' WHEN k.verdict IS NULL THEN 'recheck' ELSE 'held' END AS action
FROM connected_learning_corrections f
JOIN connected_learning_outcomes o USING(project_id,bundle_id,integration_id,outcome_id)
JOIN connected_learning_enrollments e USING(project_id,bundle_id,integration_id)
JOIN channels c ON (c.project_id,c.bundle_id,c.name)=(e.project_id,e.bundle_id,e.delivery_channel)
JOIN versions v ON (v.project_id,v.bundle_id,v.id)=(c.project_id,c.bundle_id,c.version_id)
LEFT JOIN connected_learning_rechecks k
  ON (k.project_id,k.integration_id,k.correction_id,k.version_id,k.revision)
     =(f.project_id,f.integration_id,f.correction_id,c.version_id,c.revision)
WHERE f.pending AND f.attempts<2;

CREATE VIEW connected_learning_available_audits AS
SELECT e.project_id, e.integration_id, (a.ordinality - 1)::integer AS audit_index
FROM connected_learning_enrollments e
CROSS JOIN LATERAL jsonb_array_elements(e.audits) WITH ORDINALITY AS a(descriptor, ordinality)
WHERE (NOT e.automatic_rollout OR a.descriptor->>'fixtureProtocol' = 'installed-v1')
  AND NOT EXISTS (
      SELECT 1 FROM connected_learning_rounds r
      WHERE (r.project_id, r.integration_id, r.audit_index)
          = (e.project_id, e.integration_id, (a.ordinality - 1)::integer)
  )
  AND connected_learning_audit_registered(
      e.project_id, e.bundle_id, e.integration_id, (a.ordinality - 1)::integer, a.descriptor
  );
