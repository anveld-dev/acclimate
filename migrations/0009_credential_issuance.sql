-- Recover issuance identity without storing a replayable copy of a credential secret.
ALTER TABLE integration_credentials ADD COLUMN issued_by text;
ALTER TABLE integration_credentials ADD COLUMN operation_key text;
CREATE UNIQUE INDEX integration_credential_operation ON integration_credentials(project_id,integration_id,issued_by,operation_key);
