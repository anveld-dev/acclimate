# Productization audit · 2026-11-14

Five reviewers checked the console, Rust service, SDKs, native plugins and operations on **2026-11-14**. The findings below record the failures and missing workflows at that point; source line references and suggested fixes describe that reviewed snapshot.

The A01–A22 local implementation has since landed, including native compatibility, durable write recovery, app-owned evaluation handoff, access safeguards and delivery/packaging tooling. Focused checks and earlier integrated runs are recorded in the [acceptance matrix](remediation/README.md); final acceptance of **132 behaviors / 171 scenarios is pending**. See [shipping evidence](remediation/shipping-evidence.md) for exact results and the separate blocked or unrun external gates. Local artifacts do not imply public distribution or hosted readiness.

In the original audit, **P1** meant a core path could break or lock out an operator; **P2** meant an ordinary workflow needed repair or completion. The target remains a small content service: applications keep their agents, tools, execution and grading.

## Fix these first

| Priority | Gap | What happens | Smallest useful fix |
| --- | --- | --- | --- |
| P1 | Published content can fail native preparation | Import accepts missing skill metadata; generated proposals can remove it; the editor allows multiple instructions. Native mappings reject these releases. Presence-only fixture scores can still pass. | Share compatibility checks across import, proposals, review and delivery. Show the selected plugin’s constraints before release. Keep generic bundle support where it is intentional. |
| P1 | Explicit offline policy fails on real timeouts | The TS client raises `TimeoutError`, while both cache fallback branches recognize only `AbortError`, `TypeError` and service 503. A worker with a permitted, verified cached version still fails. | Classify actual transport timeouts consistently. Preserve hard denial and integrity failures. |
| P1 | The final admin can remove their own access | A sole workspace admin can demote or remove themselves. No supported administrator recovery path remains. | Reject removing/demoting the last admin inside the existing serialized membership transaction. |
| P2 | An uncertain draft save can block future saves after reload | Only the operation key survives reload. If the service reports `not_observed`, the exact retry body is gone and the pending state keeps Save disabled. | Restore an exact pending command through an explicit private browser-storage policy; provide safe recovery without treating an unknown outcome as failure. |

Evidence:

- **Compatibility:** [import validation](../../../apps/console/src/server/setup.ts), [proposal validation](../../../src/improvement.rs), [draft validation](../../../apps/console/src/server/drafts.ts), [native instruction and skill rules](../../../packages/sdk/src/internal/native-files.ts). Key locations: setup:144, improvement:350, drafts:55, native-files:35 and :61. Reviewers reproduced malformed-skill acceptance followed by native rejection without model calls.
- **Offline timeout:** [cache.ts:269 and :312](../../../packages/sdk/src/cache.ts), [client.ts:173](../../../packages/sdk/src/client.ts). Reproduced with a primed temporary cache and a disposable stalled HTTP server for both channel and exact-version selection.
- **Last admin:** [workspaces.rs:399](../../../src/workspaces.rs), [Members actions](../../../apps/console/src/components/workspace-members.tsx). Source-traced; no real memberships were changed.
- **Draft recovery:** [draft-workspace.tsx:170, :223 and :522](../../../apps/console/src/components/draft-workspace.tsx), [operation lookup](../../../src/commands.rs). Source-traced; committed-result recovery already works.

## Finish the improvement workflow

| Kind | Gap | What is missing | Smallest useful completion |
| --- | --- | --- | --- |
| Capability | Behavioral evaluation | The console freezes two instruction/skill presence checks. Its supplied evaluator refuses other configurations. This is honestly labeled, but it cannot tell a team whether its agent improved. | Accept an app-supplied evaluator configuration with pinned cases/settings/grader. Give the app a usable handoff; keep execution in the app. |
| Capability | Local evaluator access | The launcher creates a private author credential, but the displayed evaluator command requires an environment the local setup never supplies. Connection credentials cannot perform evaluator writes. | A launcher helper runs the evaluator with private workspace configuration and a suitable principal. Do not print tokens into the UI or command. |
| P2 | Evaluation retry | Identical clicks keep the same in-memory idempotency key even after the prior evaluation is terminal, returning the old request. | Separate uncertain replay from an explicit new evaluation. |
| P2 | Evidence attribution | A report has versions/settings/submitter but no request/attempt association. An old matching report can finish another request, contrary to the documented contract. | Require matching request/attempt identity when finishing; keep historical unbound reports inspectable. This does not make externally reported results independently trustworthy. |
| P2 | Request visibility | Lists sort random UUIDs; polling refreshes the first 20. New requests can land on later pages, and known later-page records stop updating. | Use chronological cursors and directly refresh known active IDs. |
| P1 | Larger bundle proposals | The provider must echo the full bundle, but its content limit is 32 KiB. A valid bundle with an untouched 40,000-character memory file cannot produce any compliant candidate. | Return bounded edits reconstructed against the parent, or reject/disclose a consistent eligibility limit before making a model call. |
| P2 | Final review diff | Final review compares text only. Kind-only changes and deletion of an empty file disappear, despite changing what is released. | Reuse the existing draft diff, which already handles kind/add/remove changes. |
| P2 | Lost suggestion/release responses | Pending operation keys live only in a ref. Reload can duplicate a proposal; release retries can be stopped by stale preflight checks before service replay. | Persist/reconcile pending operations, and allow authorized replay to reach the service before applying fresh-write checks. |

Source pointers: [fixture identity and request creation](../../../apps/console/src/server/improvement.ts), [evaluator restrictions and grading](../../../examples/evaluate-request.ts), [review UI keys, polling and diff](../../../apps/console/src/components/improvement-workspace.tsx), [evaluation finish checks](../../../src/evaluations.rs), [comparison schema](../../../src/types.rs), [request association contract](improvement-and-evaluation.md), [provider response limits](../../../src/lib.rs), [restore preflight](../../../apps/console/src/server/edit-channel.ts), [local launcher](../../../scripts/dev-console.ts).

The larger-bundle failure was reproduced with a valid synthetic payload requiring 40,217 bytes of provider content. The other failure sequences here are source-traced, not newly browser-reproduced. The service already enforces evaluator ownership, versions, digests, declared settings and release revision; those checks should remain.

## Other ordinary-use gaps

| Priority | Gap | Trigger and completion |
| --- | --- | --- |
| P2 | New skill names collide | [Add skill](../../../apps/console/src/components/draft-workspace.tsx) always starts with `new-skill` (:260). Add twice and duplicate paths make saving impossible; rename/removal targets both copies. Choose a unique name before insertion. |
| P2 | Credential replacement replays a revoked issuance | After a lost issuance response, the [Connections key map](../../../apps/console/src/components/workspace-connections.tsx) (:163) retains the original operation. Following the revoke-before-replacement instruction still reuses that key. Distinguish a definitive already-issued outcome and permit an explicit replacement after revocation. |
| P2 | Members lacks existing-access visibility | [Members](../../../apps/console/src/components/workspace-members.tsx) only looks up opaque user IDs. [Lookup](../../../src/workspaces.rs) (:468) returns identity without current role. Add current membership to lookup and a small paginated member list; invitations are separate. |
| P2 | Python receipts can stall or hold up exit | [The reporter](../../../python/acclimate/receipts.py) (:39) leaves events arriving during a flush queued without a new worker. Its executor also keeps process exit waiting on active requests despite `close()` returning. Drain new arrivals, bound reporting time and define shutdown behavior without endlessly retrying failures. Both issues were reproduced with disposable fake clients/processes. |
| P2 | Connections has no complete reporting recipe | The [delivery recipe](../../../apps/console/src/components/sdk-setup.tsx) and [Codex example](../../../examples/codex-agent.ts) never attach the existing reporter. A successful user stays at unknown delivery unless they write that glue. Provide one model-free check using separate read/receipt clients, with explicit prepared/started reporting. Reporting remains optional. |
| P2 | Setup errors lose their explanation | The [launcher catch](../../../scripts/dev-console.ts) (:227) hides useful occupied-port, permission and configuration-conflict messages behind a generic database message. Print allowlisted safe diagnostics. |

The Compose database runs at 55432 with its own role; the convenience launcher requires native PostgreSQL at 5432 under the OS user. The manual Compose service path is valid. A documented manual console bridge or explicit connection setting would make those two onboarding paths easier to use together; this is not a broken database implementation.

## Disclosed shipping limits

These are unfinished qualification/distribution work, not concealed mocks:

- **Claude, Pi and Cursor:** preparation/options/loading checks exist, but live provider sessions remain unqualified. Add opt-in fresh-session checks and runnable examples per claimed provider. No hot-reload platform is needed.
- **Distribution:** SDK tarballs and the Python wheel work in isolated consumers, but users still need checkout-built artifacts. Publish versioned packages or downloadable release artifacts when shipping is authorized.
- **Hosted operation:** sessions and membership authority are implemented. Real OIDC/HTTPS, container and deployment qualification remain explicit gates. Do those before a hosted-readiness claim.

See [the existing qualification record](../../implementation/full-roadmap.md) for the narrower Codex/Luna evidence. A two-case improvement run establishes that the loop works, not general quality improvement.

## What already works

Bundles, exact-byte digest verification, saved draft generations, conflict checks, comparison storage, release/rollback history, scoped credentials and receipts all use real PostgreSQL state. Native plugins create actual private files. The package-consumer tests exercise installed artifacts. Applications owning their own execution is the intended design.

## Suggested order

1. Fix compatibility, timeout fallback, admin lockout and ambiguous-write recovery.
2. Make one real app-owned behavioral evaluator easy to run; repair retries, attribution, polling and proposal limits.
3. Finish access/reporting examples and setup diagnostics, then qualify and distribute the supported integrations.

No feature code was changed during this audit. Reviewers ran 31 access/navigation/integration/identity tests, 21 draft/improvement/version/release tests, 8 Rust unit tests and 2 evaluator tests; all passed. The targeted probes above exposed gaps outside that passing coverage. No paid models, live identities, user database faults or private configuration reads were used.
