# Independent evidence and operational handoff review — round 1

Disposition: **BLOCKED** pending EV-1 through EV-3.

Reviewed PLAN.md D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`, on 2026-11-16. This is a source/design review, not runtime or privacy qualification. The findings below request explicit contract decisions; they do not establish an exploit in existing product code.

## Scope and source checks

Inspected the normative plan, existing private journal and runner, comparison DTOs, case-detail rendering, integration receipt validation/listing, and current project-read authorization. Current runner outputs contain a private execution envelope and are referenced through local file URLs (`examples/evaluation/runner.ts:123–127`, `examples/evaluation/journal.ts:113–118`); the UI currently renders refs as text (`apps/console/src/components/evaluation-pair-row.tsx:40–42`). Receipt bodies carry both application occurrence and server receipt times, with a 30-day retention window and received-time ordering (`src/integrations.rs:296–310`, `:377–411`). Those details matter when designing the new sharing/projection contracts.

## Blocking findings

### EV-1 — The manifest cannot describe availability separately for output and grader explanation

**Plan references:** §9, lines 305–317; export exit semantics §7, lines 260–261; G13.

Each case/side entry has one `availability` field and an array of zero to two files, while the two roles (`output`, `grader-explanation`) may independently be exported, deliberately withheld, absent, or required by a selection. There is no defined rule for a mixed case. For example, a model output is deliberately shared but its requested grader explanation was lost during worker cleanup. An implementation can mark the entry exported and omit the explanation, presenting apparently complete requested evidence; another can fail the whole export. The plan also promises labels of local-artifact unavailability while its enum has no role-level representation of that fact.

**Minimum fix:** make the manifest role-oriented, or otherwise define a complete per-role status table. Every role must have an unambiguous selected/not-selected and available/missing/exported representation; `not_shared` must not hide whether a required selected file was missing. State precisely when a missing role prevents committing a manifest versus permits an intentionally scalar-only export. No file row can be present without an exported status, and absent roles cannot be silently interpreted as successful evidence.

**Acceptance:** cover output exported + explanation deliberately not shared; output exported + selected explanation missing; no mapper/default scalar projection; missing journal; and one selected artifact missing. TypeScript and Python must emit the same statuses and exit/result disposition, with required selections never yielding a complete-success manifest after omission.

### EV-2 — The public command contract does not expose the explicit selection and read-only verification workflow it promises

**Plan references:** §7, lines 239–253; §9, lines 295, 317–323; package surfaces §2.

`exportReviewEvidence` has an unspecified `selection?` and mapper shape; the command has no selection argument and no declared static-registration option shape for `evaluationMain`. Similarly, the only `verify-export` command shown accepts `--manifest`, while online verification is described as using an explicit config and expected selection. A teammate has a project-read credential, not the original worker's evaluator identity/journal. The plan does not specify how that reader supplies trust/configuration or whether the helper reuses write-requiring evaluator preflight. The scalar-only fallback also says the journal can be unavailable, but the exporter is specified to lock/read the originating journal unconditionally.

**Failure scenario:** a reviewer follows the supported command after downloading the CI artifact and can perform self-consistency checks, but cannot ask the installed helper to compare it with the expected authoritative request. An implementer may either add undocumented flags, require broad evaluator write access/private-journal configuration for a reader, or silently derive expected identity from the manifest it is supposed to verify. A first adopter likewise cannot select the failed-case output without inventing a wrapper.

**Minimum fix:** freeze a data-only artifact-selection schema and mapper input/output contract, and explicitly bind them through the CLI registration/options or documented flags. Add the exact online-verification invocation and trusted expected-target inputs, with project-read-only authorization and no requirement for journal storage, evaluator write permission, live opt-in, or originating principal. Specify that scalar-only export bypasses absent local journals; when local files are selected, acquire the originating lock and validate their index. Never derive the trusted service endpoint or expected request solely from the manifest.

**Acceptance:** a clean installed app selects one failed-case output through the documented interface; a second user with only project read can verify the downloaded projection against an independently selected expected request; a wrong service/project/request or changed scalar fails; missing journal still allows explicit scalar-only export; reader verification starts no attempt, writes no journal, and requires no evaluator write access.

### EV-3 — Binding the local artifact index to the authoritative comparison needs an explicit validation rule

**Plan references:** §9, lines 293–295 and 321; §5 terminal binding rules; G13.

The index is described as request/attempt/version/case/repetition/side plus bytes/hash. The exporter fetches a bound comparison and reads the originating journal, but the plan does not require comparing that journal's sealed report and confirmed comparison ID with the fetched authoritative terminal comparison before calling a mapper. It also does not explicitly say that the current indexed file bytes must match the digest recorded when the runner retained them. Labels alone can bind artifacts to a different comparison from the same request/attempt if multiple comparison rows or manually submitted app assertions exist; the service permits comparison submission separately from finishing an evaluation. An accidentally replaced local artifact could otherwise receive a fresh export hash while being associated with the old run.

This is distinct from execution attestation: an app-controlled redactor can intentionally transform content and remains an assertion. The fix prevents ordinary local mixing/corruption from being presented as the selected retained artifact.

**Minimum fix:** under the originating lock, validate the journal's exact request/attempt/principal/root and confirmed comparison binding; compare the sealed report with the authoritative report's relevant complete fields, ignoring only transport/object-key serialization differences and server-added metadata. Bind index entries to that sealed report identity, check original registered length/hash against the actual file before mapper invocation, and expose to the mapper only the selected role payload and safe immutable identity metadata, not the entire config/journal/callback envelope. A missing local report/index makes content export unavailable rather than authorizing a labels-only join. Keep online scalar verification's limits explicit: it does not authenticate the redacted artifact bytes or prove execution.

**Acceptance:** reject a same-request/same-attempt index linked to a different confirmed comparison, a different sealed report, changed file bytes, a path alias/symlink, and a role binding pointing at another case/side. Verify that expected answers/private callback envelopes are not passed to a simple output mapper. Normal redaction creates new hashes without modifying the original report or original indexed files.

## Nonblocking operational advice

### EV-N1 — Freeze one receipt-summary identity and timestamp convention

§13 line 369 currently says “latest safe delivery stages/version/digest/reportedAt.” Define the projected DTO so all latest fields come from one retained receipt, selected by server `(receivedAt,eventId)` ordering, or clearly define an alternative per-stage summary whose rows each retain their own version identity. Keep app occurrence and server receipt time separate, preserve delayed/unknown semantics, and apply the existing 30-day retention window. Otherwise a delayed `started` observation for version A could be displayed beside newer version B metadata. Add out-of-order/multiple-version tests and retain current read authorization/credential exclusion. This is a bounded operational-contract refinement, not a reason to add remote execution heartbeats to this release.

## Strengths retained

- Shared review exports are separate from private attempt recovery and never rewrite sealed reports.
- Default projection omits raw errors, runtime strings, original refs, private paths and outputs.
- Output release is intentional application code, not automatic secret detection or arbitrary URL retrieval.
- Local consistency, online scalar binding and execution truth are explicitly different claims.
- Project-read delivery observations are separated from admin credential actions.
- Export directories, entries and byte limits are bounded, private, non-overwriting and manifest-last.

## Verification limits

No product files were changed, no dependencies installed, and no tests, model calls, browsers or external service mutations ran. The reviewed plan digest was checked before source reading. Approval is withheld on D1 until the role/status, supported handoff interface and local binding contracts above are explicit. A revised exact digest requires recheck; resolving these points does not authorize implementation or publication.
