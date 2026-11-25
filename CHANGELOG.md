# Changelog

All notable changes to Acclimate will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-11-25

The first release, open source under Apache-2.0, with documentation at [acclimate.anveld.dev](https://acclimate.anveld.dev). The service, console, executor and runner images, `@acclimate/sdk`, the four plugin packages, the `acclimate-sdk` Python package and the starter archives are all versioned `0.1.0`; the plugins peer-depend on `@acclimate/sdk` `^0.1.0`.

### Added

- Enrolled bundles run five-sample optimization rounds with screening, evaluation, automatic release on adoption, and private held-out monitoring. The service owns the tasks and the `acclimate-executor` container runs each rollout in a sandbox. The console's **Learning** tab covers setup, task import and review, Try, round history, usage, rollback and revisioned improvement memory.
- An adopted version is reverted automatically when the held-out pass rate falls by at least 10 percentage points or half the previous version's pass rate, whichever is smaller, and at least two tasks go from passing to failing.
- Both SDKs deliver immutable bundles with verified caching. Channel preparation confirms the release online for each job. Exact-version reads can opt into verified cached content after transport failures or HTTP 502, 503 or 504. `systemPrompt(payload)` / `system_prompt(payload)` render a bundle exactly as a learning rollout's system message.
- Applications can pin a job to a verified version and feed back a known answer with `createAcclimate().job(...).expect(...)` in TypeScript or `Acclimate().job(...).expect(...)` in Python. Both SDKs publish and move releases with `release()` and `rollback()`.
- The `acclimate` command in `@acclimate/sdk` has `pull`, `publish`, `release` and `rollback`. It reads `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` and `ACCLIMATE_TOKEN` and accepts bundle names. Python has `python -m acclimate pull`.
- Native plugins prepare bundles for Codex, Claude, Pi and Cursor. The native repository starter retains partial diffs when an agent task fails.
- Delivery receipts need only `eventId`, `versionId`, `stage`, `source` and `occurredAt`; the service fills in the rest from the path, the credential and the version.
- Self-hosting is `deploy/init.sh --domain <domain> --email <email>` and `docker compose up -d --build --wait`. `init.sh` writes the secrets to a private directory and the settings to `.env`, and Keycloak's realm import creates the first person. Learning runs under the Compose profile `learning`.
- [OpenAPI](contracts/openapi.json) documents the workspace HTTP API. The [learning contract](contracts/learning.md) covers enrollment, tasks, trials, round history, improvement memory and the [codes a script reads](contracts/learning.md#codes-a-script-reads).
- `npm run local:up` picks free ports, prepares the `local-demo` workspace with one model provider, and writes `env.sh` and `ca-bundle.pem`. `npm run local:trust` trusts the local certificate.
- Two runnable examples in TypeScript and Python: `examples/support-agent/` answers with the released bundle and reports a correction with `job.expect()`, and `examples/ticket-triage/` publishes a bundle, imports 64 labelled tickets and runs the learning loop from one script. [Examples](examples/README.md)
- CI builds the Compose stack and runs the documented backup, restore, upgrade and rollback commands word for word.
