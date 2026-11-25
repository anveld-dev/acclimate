# Overview and ownership

Acclimate stores versioned harness files and resolves a named channel for each job. The service owns immutable versions, credentials, releases and optional delivery receipts. The SDK verifies the exact payload bytes and prepares job-local files. The application owns the agent process, tasks, model credentials and result handling.

<!-- diagram:service-delivery -->

Publish content in a workspace and grant read access through a connection. New jobs receive the current release. An older version can be released again while active jobs keep their pinned files.

## Self-improvement

The [self-improvement design](improvement.md) describes the service-managed learning loop and its executor.
