# Parallel implementation paths

> Earlier implementation record. Production startup, identity and evaluator setup now follow the [production-only plan](../../production-only/plan.md). Old local-launcher commands below are retired.

[Reviewed plan](plan.md) · [Review decisions](review.md) · [Audit](../current-audit.md)

Eight lanes: one coordinator and seven implementation agents. Most work starts together; shared contracts and final acceptance are short gates. Use this shared checkout: implementation is largely untracked, so a new checkout would omit it. Do not create worktrees or commit the whole tree just to parallelize.

## Ownership

Each existing file has one writer. Others send the owner a requested interface/call-site change. Each lane owns its new domain-specific tests; do not funnel all regression work through the coordinator. Inputs below are planning notes, not alternate authority.

| Lane | Sole ownership | Audit rows |
| --- | --- | --- |
| C0 · integration/contracts | `src/lib.rs`, `src/types.rs`, all migrations, `contracts/**`, SDK `types.ts`, `client.ts`, `index.ts`, root/package manifests and lockfiles; existing shared Rust contract/productization tests; generated docs and final integration records | Cross-cutting |
| N · native content/proposals | Rust `bundles.rs`, `drafts.rs`, `channels.rs`; new compatibility/patch modules; SDK pure compatibility validator and `internal/native-files.ts`; native plugin code/tests; `scripts/bdd/provider.py`, full-roadmap provider fixtures; new content/patch regression files | A01, A10; fixtures for A11/A13 |
| R · durable console writes | Rust `commands.rs`; internal frozen transport/session-storage helpers; console server `drafts`, `content-actions`, `setup`, `setup-actions`, `channel`, `read-console`, `edit-channel`, `version-workflows`; components `draft-workspace`, `bundle-library`, `import-content`, `bundle-releases`; their focused tests | A04, A12, A13; UI of A01 |
| E · evaluation service/UI | Rust `evaluations.rs`, `improvement.rs`, new pagination module; SDK `compare.ts`; console server `improvement`, `improvement-actions`; components `improvement-workspace`, `bundle-changes`; evaluator/compare/service tests; `scripts/bdd/world.py`, evaluation steps and strict comparison fixture changes in `scripts/productization/qualify.py` | A07–A09, A11; N worker-validation hook, R pending-hook consumer |
| A · access/connections | Rust `auth.rs`, `workspaces.rs`, `integrations.rs`; console access/integration actions/cores, `identity.ts`; components `workspace-members`, `workspace-connections`, `workspace-create`, `account-menu`; access/integration tests | A03, A14, A15; logout cleanup consumer |
| D · delivery/reporting | SDK `cache.ts`, `reporting.ts`, `prepare.ts` and their tests; `python/**`; TS/Python model-free delivery recipes; `examples/codex-agent.ts`, `cursor-agent.ts`; console `sdk-setup.tsx` | A02, A16, A17 |
| H · app evaluator/helper | `scripts/evaluate-local.ts`; new installed adapter, public descriptor, journal and runner modules; `examples/evaluate-request*`, `examples/service-proposer/**`, evaluation-specific examples/tests | A05, A06; app side of A07/A08/A20 |
| S · setup/shipping/acceptance | `scripts/dev-console.ts`, local process/config/diagnostic helpers; packaging/operations/qualification scripts not otherwise assigned; CI/deploy/Compose; BDD runner/environment/coverage/inventory and shared console/navigation/browser steps; shipping docs and evidence ledger | A18–A22; integrated acceptance |

Existing console `diff-content.tsx`, shared primitives, shell and navigation remain unchanged unless their owner is explicitly assigned. E reuses the existing diff. R can add a small pure unique-name helper within its owned area. N supplies pure validation to R/E; it does not edit their UI files. E alone installs the worker compatibility check in `improvement.rs`. A alone wires logout cleanup using R's exported helper. C0 alone wires new modules/provider delegation in `lib.rs` and SDK surfaces. D supplies recipe hooks; no agent independently rewrites the evaluator or launcher.

Shared feature files stay with S unless explicitly assigned: E owns evaluation feature/steps, A access/identity/console-access feature/steps, D SDK/Python feature/steps, N proposal provider fixture/steps. R/H supply focused new step modules and scenario requests. S deliberately updates inventory once all owners agree; never regenerate it silently during tests. No two agents edit `tests/productization_regressions.rs`; use separate domain test files and ask C0 for shared fixture changes.

## Contract gate: freeze before callers integrate

C0 writes these choices into the wire contract and typed DTOs, with the affected owners checking them. Pure modules, tests and fixtures can already proceed. No fake success endpoints or placeholder qualification records.

| Seam | Frozen decision |
| --- | --- |
| Bundle target | Immutable `compatibilityTarget`, default `generic`; closed enum. Migration 0010. No revision/change-policy command. Targeted initial publication, provider candidates and fresh release/rollback must pass; generic draft saves remain possible. |
| Diagnostics | Stable path/package/code/message issues without file contents. Generic payload validity remains unchanged. New console bundle creation visibly chooses a target. |
| Provider edits | Version 1 exact original-text anchors, disjoint same-file ranges, 32 KiB content / 128 edits / 4 KiB rationale / 256 KiB outer envelope; accept only a complete successful finish reason. N supplies pure reconstruction; C0 delegates the existing adapter. |
| Durable marker | `X-Acclimate-Durable-Operation: true`, only on the audited allowlist. Existing unmarked behavior stays compatible unless a matching retained receipt/fence already exists. |
| Command namespaces | Existing setup/draft lock stays `content:{principal}:{project}:{key}`. Added actions keep existing `{principal}:{project}:POST:{canonicalRoute}:{key}` lock and route-scoped identity. Every marked/unmarked route checks its matching fence under that same lock. Never conflate unrelated legacy routes. |
| Lookup/close | Existing operation lookup remains valid. Optional `operationPath` selects an allowlisted canonical audited route; close takes that path explicitly. Derive/validate project/action/IDs and current effective rights. Existing legacy commits are returned before a tombstone can be inserted. Migration 0011 owns receipts/tombstones without rewriting old namespaces. |
| Browser record | Versioned exact JSON body plus action, key, explicit resource scope, actorScope, service identity and creation time. Session text only; metadata-only uncertainty survives forgetting/expiry. Scope checks, bounded storage and current auth on every use. Internal transport only; no public raw SDK API. |
| Issuance | Existing 409/code retained; additive typed error details identify `credentialId`, kind and revocation state, never secret. Confirm scoped revocation before a distinct replacement key. C0 supplies optional error-detail plumbing; A implements/consumes it. |
| Evidence | Optional all-or-none `{requestId,attemptId}` on comparison. Request `requireBoundEvidence` defaults false for old/omitted legacy inputs; new console requests set true. Bound create/finish lock and validate the same request row as interrupt. Direct promotion retains its existing independent evidence/revision policy. |
| Evaluator configuration | Existing dataset/runtime/grader/inventory fields. Runtime includes `configId`, `configRevision`, app/model/settings/write policy and limits. Structural installed-config match; no service canonical hash, source loader or retry-lineage field. |
| Pagination | Versioned collection/project/bundle/UTC-microsecond/UUID cursor, chronological `(created_at,id)` order, scoped old-UUID resolution. Never round cursor timestamps through JS Date. Migration 0012 adds covering indexes. |
| Helper/private state | One `evaluate:local` command, `scripts/evaluate-local.ts`, explicit `--bundleID`/`--requestID`, dedicated read/write evaluator principal. S owns atomic private state helpers and provisioning; H owns exclusive journal execution and recovery. Test-owned state root is mandatory for fixtures. |
| Member access | 409 `last_admin`; admin-only bounded member page; identity lookup adds nullable current role. Current browser authority remains decisive. No new machine-admin bypass. |

Only C0 allocates migration numbers and edits common DTOs/exports/manifests. If a signature needs changing, update its contract and callers together; do not create a second helper/descriptor/authorization rule. Legacy binding, cursor and replay behavior need explicit fixtures alongside strict new paths.

## Waves and dependencies

| Wave | Work that runs together | Exit gate |
| --- | --- | --- |
| 0 · independent start | N pure validator/patch fixtures; R pending storage/namespace tests; E binding/cursor fixtures; A admin/list/issuance tests; D timeout/Python worker; H adapters/journal; S diagnostics/artifact retention; C0 shared contracts/defaults | Owners accept the seam table and shared DTOs/migrations are available. |
| 1 · service and clients | N publication; R receipts/fences; E binding/pagination; A access; D delivery; H local runner; S private config/bridge | N/R/E/A targeted isolated service tests pass. C0 exposes stable SDK fields/helpers. |
| 2 · UI and handoff | R wires editor/release recovery; E wires evaluation/polling/diff with R hook and H public specs; A wires members/credential recovery/logout cleanup; D recipes; H/S copied helper | Browser and helper consume real service contracts, with test-owned configuration. |
| 3 · integrate and retain | All owners fix their failures; S runs complete isolated acceptance and retained-package consumers; C0 updates status/docs | All local audit rows have passing evidence. External gates retain honest status. |

Critical seams: `N validator → E worker + R editor`; `R pending helper → E release/evaluation + A logout`; `E strict DTO → H runner`; `H public spec → E UI`; `S private config → H helper`; `D Python repair → D recipes`; all lanes → retained artifact/whole-flow gate. These are interface dependencies, not permission for shared file edits. UI owners can build against frozen fixtures while services land.

## Evidence and completion

Each lane records actual commands, results and remaining blockers. Use disposable resources. Default checks call no models; optional live checks use bounded Luna only. Never fault the user's database, read private credentials into reports, replace local config, publish packages or deploy merely to qualify code.

- **N/R:** targeted native publication, incomplete save/reload/repair, malformed proposals, unique skills, full review diff, exact replay/close races and dropped-response reload cases.
- **E/H:** strict and legacy completion/release, cross-request/attempt/principal rejection, interrupted evidence, 25+ records/ties/old cursors, later-page polling, concurrent helper and journal crash boundaries. Invoke the actual copied helper for a nonseeded bundle. Payment simulation proves orchestration; fake native adapter proves wiring; only actual provider evidence qualifies native improvement.
- **A/D:** crossed final-admin races, current member roles/pages/denial, lost issuance and confirmed revoke/replacement, real header/body timeout fallback with denial/integrity controls, Python fresh-arrival barriers and stuck-client interpreter exit, optional-report failure isolation.
- **S/C0:** typecheck/build, package/console/evaluator/operator tests, isolated Rust runner exercising all three DB variables, Python tests, complete BDD with reviewed inventory, docs links, installable retained tarballs/wheel/checksums and outside-checkout consumers. Update full-payload HTTP fixtures and executor-private tests; old test doubles remain valid only for the unchanged public provider trait.

The final local walkthrough is native-target creation → incomplete save/reload/repair → lost-response recovery → strict evaluation request → copied app helper → per-case bound evidence → explicit release → installed preparation → optional receipt → compatible rollback, while an older prepared workspace stays pinned. A losing complete evaluation must stay complete rather than being mislabeled infrastructure failure.

External A20/A22 provider/OIDC/HTTPS/container evidence and A21 public availability have separate `passed | blocked | not run` entries with exact reasons. Harnesses and local artifacts can finish without inventing that evidence. Never label an unrun live gate passed or the whole service hosted-ready.

## Planning inputs

[Core ownership](../../../research/archive/remediation-planning/parallel-core-input.md) · [Console ownership](../../../research/archive/remediation-planning/parallel-console-input.md) · [Qualification ownership](../../../research/archive/remediation-planning/parallel-qualification-input.md). The ownership table above resolves their competing allocations; it is the implementation authority.
