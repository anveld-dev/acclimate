CREATE TABLE operation_records (
 principal_id text NOT NULL, project_id text NOT NULL, namespace text NOT NULL,
 key text NOT NULL, path text NOT NULL,
 status text NOT NULL CHECK(status IN ('committed','closed')),
 fingerprint bytea, response_status integer, response_body bytea,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(principal_id,project_id,namespace,key)
);
