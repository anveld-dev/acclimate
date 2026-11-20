# Whole roadmap: implemented and locally checked

This record covers the service/SDK milestone. The [console productization plans](../architecture/productization/README.md) track remaining product work; this record is not a hosted-readiness claim.

All five stages of the [product roadmap](../design/roadmap.md) are implemented. Six parallel Terra paths built the missing pieces; a separate Terra review checked the result. This is a small content service: apps still own their agent execution, tools and isolation.

## What works

| Stage | Code and evidence |
| --- | --- |
| 1. Deliver a bundle | Rust/PostgreSQL service, scoped grants, immutable exact-byte payloads, private TS/Python caches and safe preparation. Shared fixtures, denial cases and isolated package consumers passed. |
| 2. Use a native SDK | Codex SDK with Luna read prepared resources. Earlier fresh-v1/fresh-v2/resumed-v1 checks passed. The full release flow checked that new jobs get the promoted skill, an existing workspace keeps its pinned bytes, and rollback restores the parent. |
| 3. Prove the plugin interface | Codex, Claude, Pi and Cursor preparation packages; native types/options and Pi resource-loader checks. Five npm tarballs and a Python wheel install in isolated consumers. Native peers stay optional for preparation-only imports. |
| 4. Improve one file | The Rust worker requested and saved a bounded skill edit through an authenticated local adapter backed by the official Codex SDK and Luna. The app then ran two cases against each version and saved a complete comparison with separate grading. Instruction and memory edits also have deterministic worker tests. |
| 5. Publish deliberately | Operator commands show before/after files and comparison evidence, promote with an expected revision, read scoped paginated history, and roll back. The real flow exercised these commands, rejected a stale revision, refreshed a new job and preserved a pinned job. Native release build, restart/ownership and PostgreSQL 16 restore checks passed. |

## The live check

On 2026-11-13, one Luna call drafted the candidate and four Luna calls evaluated it through Codex SDK `0.169.0`. The fixture reviewer then explicitly promoted and rolled back its disposable channel. Review, file refresh, pinned content, stale-revision rejection and all three history records passed.

The saved evidence includes the proposal, exact parent/candidate payloads, skill diff, per-case responses, comparison report, operator review and release checks. A private copy lives under `artifacts/full-roadmap-2026-11-13/`. These IDs belong to a disposable test service. Two cases show that the loop works; they do not establish a general quality gain. Unknown model cost stays unknown in the report.

The release binary also started against a restored copy of that database. Authenticated reads verified both payload digests, the completed proposal and comparison, all three history records, and the rolled-back channel.

## Checks and limits

Local checks passed: 14 Rust tests, 34 default TypeScript tests, 5 improvement tests, 4 operator tests, 4 full-flow fixture tests, 6 Python SDK tests and 2 operations connection tests. Format, Clippy, TypeScript, external package consumers, dependency audit, process-level delivery/restart tests and the deterministic full release flow also passed. Backup qualification checked matching PostgreSQL tools, exact restored data, populated-target refusal and transactional failure.

The HTML docs have local navigation, search and responsive diagrams. Static link checks and browser layout checks cover the generated pages in both themes.

The remaining qualification boundaries are explicit:

- Claude, Pi and Cursor provider sessions are unqualified. Their offline integration checks do not prove live file discovery or session refresh. All live model calls used Luna.
- The service proposer was tested through a local SDK-backed compatibility adapter. Direct vendor API credentials and remote TLS are deployment checks.
- The native release binary was built and exercised. The Docker recipe was not run because this machine has no working Docker daemon; systemd was not executed on macOS.
- Windows filesystem permissions, in-place hot reload and statistical improvement are not claimed. Nothing was published to a registry or deployed to production. Hosted CI is configured but has not run here.

## Where to go next

Use the [development guide](../development.md) to start locally, [operator commands](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/tools/operator/README.md) to review and release, [full qualification](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/scripts/full-roadmap/README.md) to repeat the flow, and [deployment/restore guide](../../deploy/README.md) to prepare a host.

## How the work split

| Parallel Terra path | Ownership |
| --- | --- |
| Server | Bounded proposals, history endpoint, migrations and Rust tests. |
| Operator | Review, promotion, history and rollback commands. |
| Native integration | Cursor SDK preparation, native options and example. |
| SDK/distribution | TS/Python parity, safe cache checks and isolated package consumers. |
| Operations | Single-process deployment recipe, private backup and restore qualification. |
| Full-flow qualification | Service-generated Luna candidate, app evaluation and explicit fixture release/rollback. |

The coordinator integrated contracts, CI and docs. An independent review found an inherited PostgreSQL environment routing issue; explicit connection settings now clear those inherited selectors, with regression tests.
