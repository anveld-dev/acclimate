# Make the console a product

This is the historical console productization plan. It records earlier implementation and acceptance decisions. Use the [console guide](../../../apps/console/README.md) for this release and the [learning loop design](../self-improvement-memory/README.md) for later phases.

The product stays a Rust content service, a TanStack console and SDKs. Applications own agent execution, credentials, fixtures, limits and grading. A release changes a channel pointer; delivery reports describe what an app says it observed.

## Read by problem

| Plan | Concrete result |
| --- | --- |
| [Drafts and content](drafts-and-content.md) | Save, close, reopen and revise a draft; import and manage entries; publish the reviewed snapshot. |
| [Improvement and evaluation](improvement-and-evaluation.md) | Request a proposal, hand exact versions to an app evaluator, inspect honest evidence and deliberately release. |
| [Workspaces and access](workspaces-and-access.md) | Select real scoped bundles/channels; add person-specific access before hosted use. |
| [Integrations and delivery](integrations-and-delivery.md) | Install an SDK, prepare native content and see optional app-reported delivery facts. |
| [Onboarding and status](onboarding-and-status.md) | Start empty, publish team content, retain provenance and show observed status. |
| [Implementation work](remediation/README.md) | Reviewed fixes, independent objections and eight parallel implementation paths. |
| [Current product audit](current-audit.md) | Five reviewers separate real defects, unfinished workflows and disclosed shipping limits. |
| [Review findings](review.md) | Four Sol reviewers checked the Terra findings against code and trimmed unnecessary scope. |
| [Navigation review](navigation.md) | Four competing reviews recommend clear workspace/bundle ownership and a smaller sidebar. Implemented with scoped routes and regression coverage. |
| [UI improvement plan](ui-improvements.md) | Implemented creation/release clarity, compact readable layouts and focused app setup, with browser acceptance evidence. |
| [Acceptance](acceptance.md) | Prove the useful workflows on real PostgreSQL and a browser, with clear local/hosted claim limits. |

## Implemented slices and deployment gates

<!-- diagram:productization-paths -->

1. **Settle shared contracts.** One coordinator owns migrations, shared DTOs/errors, authorization helpers, transaction seams and fixture versions. Feature implementation starts after those affected interfaces agree; avoid a weeks-long global design freeze.
2. **Keep the content workflow durable.** Saved drafts and exact-snapshot releases survive browser/service restart. Example/import setup is explicit; optional receipts do not gate ordinary SDK delivery.
3. **Connect a real application.** An installed SDK resolves, verifies and prepares the released version using existing credentials. Optional delivery reports ship as a later slice; they do not block this check.
4. **Use verified identity everywhere.** The [production-only plan](../production-only/plan.md) removes local operator mode. Rust sessions, current memberships and separate machine grants are mandatory.

The first implementation target is **saved draft → browser/service restart → reopen → evaluate that snapshot against its published base → review → release**. A separate proposal starts from the published base; it does not silently branch from an unpublished draft. An operator-run application evaluator is enough to make the handoff real. Do not label a request “running” merely because someone clicked a console button.

## Shared decisions

| Interface | Decision |
| --- | --- |
| Scope | A workspace is an existing project. Every operation carries and revalidates `{workspaceId, bundleId, channel}`. No new organization layer. |
| Identity | Rust owns membership and session authority in the same PostgreSQL database as domain records. Browser identity and SDK machine grants remain separate. There is no local-operator mode. |
| Draft | A mutable working record points to an immutable version. `generation` protects saves; the bound base and channel revision protect release. Snapshots under one base are siblings; a small snapshot association table retains their generations. |
| Evidence | Parent/candidate IDs and digests, frozen declared settings and case identities describe the comparison; outputs remain app-owned. Unpublished-draft ancestry cannot silently bypass the channel-parent release rule. |
| First content | One atomic bundle-setup command creates origin, initial payload/version, channel and unevaluated decision. Existing low-level SDK operations remain compatible. |
| Evaluation | The app owns execution. The first request has one explicitly registered evaluator attempt, conditional status updates and an interrupted state; no leases or automatic reassignment. |
| Delivery | Receipts are optional app-reported facts. A session-start report is not proof of model consumption; no report means unknown. |
| Ambiguous writes | Persist operation metadata and reconcile durable command outcomes across restart/cache expiry. See [recovery](drafts-and-content.md#recover-uncertain-writes). A timeout is not proof that nothing committed. |

## Code ownership

The coordinator registers routes and applies shared changes; owners implement feature modules and matching tests. Shared files are not a free-for-all.

| Path | Owns | Can begin with |
| --- | --- | --- |
| C0 · contracts/integration | `src/types.rs`, migration numbering, `src/lib.rs`, shared auth/transaction seams, SDK DTOs/exports, manifests, CI and fixture contracts | The shared decisions above and the current tested baseline |
| D1 · durable content | New `src/drafts.rs`, bundle setup/content commands, draft PostgreSQL tests | Frozen draft and setup contract; existing immutable version persistence |
| E1 · improvement | `src/improvement.rs`, evaluation-request module/tests, app evaluator example | Existing proposal/comparison contract; frozen request envelope; make bundle-level provider disclosure explicit before exposing proposals |
| A1 · access | Rust session/membership module and scope tests; auth helper changes through C0 | Session/role contract and existing project grants |
| T1 · TypeScript delivery | Client/receipt implementation and delivery fixtures | Existing SDK delivery first; optional receipt contract later |
| P1 · Python delivery | Python client/receipt implementation and matching fixtures | The same language-neutral contract; Python reporting is a separate support claim |
| U1 · drafts UI | Draft list/editor/import routes and components | D1 fixtures; chosen workspace tuple |
| U2 · improvement UI | Proposal, evaluation handoff, comparison review and release views | E1 fixtures; immutable IDs and completeness rules |
| U3 · setup/access/delivery UI | Selection, onboarding, hosted sessions and integration reports | A1/T1 fixtures and stored provenance |
| Q1 · qualification | Cross-stream PostgreSQL/browser walkthrough, clean consumers and evidence record | Each slice's incoming implementations |

`src/bundles.rs`, `src/channels.rs`, `src/auth.rs`, `src/commands.rs` and shared console server modules need coordinated edits. C0 extracts reusable transaction operations once; draft publication must not duplicate promotion policy or nest HTTP-level commands. Each feature owner requests shared changes with the DTO, invariant and failing case.

The current checkout contains uncommitted/untracked implementation files. Use a shared checkout with explicit ownership for now. A later isolated worktree needs a committed baseline when that is authorized; do not assume these files exist in a new checkout. These plans do not authorize publishing or production deployment.

## Definition of done

Use the [acceptance matrix](acceptance.md) per slice. Require real persistence, conflict handling and failure states before claiming the UI works. Keep deterministic fixture results, actual PostgreSQL/browser checks and optional Luna/native-provider results distinct. Keep deployment/provider qualification separate from implemented code. Rust authority and actual built/dev OIDC flows have isolated PostgreSQL/TLS checks; these are not live-provider readiness claims.

Deferred: hosted execution, a sandbox fleet, provider interception, automatic release, multi-candidate optimization, enterprise IAM, raw-trace collection, billing and an observability platform.

## Verification and remaining work

The deterministic local flow is checked against real Rust/PostgreSQL and Chrome, including restart, ambiguous-write lookup, exact-snapshot evidence and a clean packed SDK consumer. SDK, console, Python and Rust tests cover the new contracts. Hosted Rust authority also has a disposable integration runner.

Before deployment: exercise the configured real OIDC provider and public HTTPS endpoints and rehearse backup/recovery. This release supports one Rust service and one console instance. Native content discovery and quality experiments remain separately qualified; no model was called for this implementation. Automatic proposal dispatch, directories/invites, telemetry dashboards and legacy provenance adoption UI remain outside the checked local slice.
