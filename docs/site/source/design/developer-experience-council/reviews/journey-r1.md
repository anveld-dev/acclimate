# Independent adoption and product-scope review

Disposition: **BLOCKED** pending UX-1.

Reviewed revision D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`, on 2026-11-16. This is an independent source/document design review, not a usability study or runtime qualification. PLAN.md is normative; I did not treat design proposals as hidden additional requirements.

## Journey assessment

The plan substantially closes the interactive adopter's discontinuities. It separates adopter/deployment entry points, makes artifact/runtime requirements explicit, attaches an actual agent after file verification, defines tasks and grading in one local definition, derives the public inventory, surfaces operator credentials before request creation, removes the unrelated default simulator on both client and server, and preserves saved candidate and operation recovery semantics. The core app-owned definition and three-operation module are coherent enough to teach. Expected answers stay local, and completed evidence, a quality verdict, and release authority remain distinct.

Deferring dynamic credentials, remote progress, cross-language takeover, and statistical inference is acceptable for this release. The plan explicitly preserves the associated operational limitations and provides a useful supported path without claiming those limitations disappeared. Python parity and native repository recipes have acceptance gates rather than relying on the TypeScript path's existence.

One major adoption scenario remains incomplete: an automated pull request job can consume a handoff, but the normative plan does not specify how that job obtains its candidate and creates its own bound request.

## Blocking finding

### UX-1 — High: the CI journey still starts with a manually created console handoff

**Plan evidence:** The outcome at PLAN.md:9 is expressly a console-created request. The closed command inventory at :239–253 supplies describe/doctor/run/check/status/interrupt/export/verify-export, but no request preparation/creation operation. The CI gate at :267 accepts only an online bound request. The only concrete candidate/request authoring journey at :335–339 is console-based. Work package D promises CI starters at :390, while G01 at :400 only tests consumption of a console handoff. None of the 19 gates establishes headless creation of the bound request.

**Original requirement and actual source:** The CI persona's main job is a skill change becoming a pull request check; its high-priority installed CI acceptance explicitly says the external app "creates and completes a request" (`docs/research/developer-experience-review/ci-release-engineer.md`, finding 2). The capabilities exist: `packages/sdk/src/client.ts:246` creates an immutable version, `:408` exposes draft creation, and `:517` creates an evaluation request. Those are lower-level pieces. The console currently assembles a request's parent/candidate IDs/digests and requires bound evidence in `apps/console/src/server/improvement.ts:218–241`; a headless adopter needs a documented equivalent rather than reconstructing it from console implementation.

**Concrete failure scenario:** A developer changes `skills/retry/SKILL.md` in a pull request. The CI worker installs the new SDK and app starter and can describe its cases. Every documented run/check command needs `evaluation-request.json`, but the worker has no request ID or handoff yet. An engineer must manually create the candidate/request in the console for each commit, supply previously generated artifacts from an unmentioned process, or implement candidate/request preparation and its response-loss handling. Thus the plan supports automating execution after interactive authoring, not the complete pull request check that motivated the CI critique.

**Minimum remedy:** Add one complete headless preparation recipe or a closed app-owned `request`/`prepare` command; a global executable registry or a public session object is unnecessary. Specify the source of the immutable candidate (a concrete installed-SDK authoring recipe, or explicitly selected already-created candidate), how the baseline/parent and candidate metadata/digests are verified, how the local app descriptor is used, `requireBoundEvidence:true`, durable creation intent/key/body storage, lost-response recovery, handoff persistence, and channel-drift handling. Keep candidate authoring, request creation, execution, quality policy, and release as separately visible actions. If a PR starter relies on another system to create the candidate, that dependency must be explicit and its documented concrete recipe part of the same adopter path.

**Acceptance:** A clean external TypeScript consumer and Python wheel consumer start from a fixture baseline plus a local proposed skill change (or a documented immutable candidate handoff), create a request without browser or console action, retain/recover its creation intent after response loss, emit the normal public handoff, run/check/export it, and leave the channel unchanged. A changed PR commit does not reuse an old candidate/request intent. This must be an explicit release gate, not an implication of G01.

## Nonblocking advice

### UX-N1 — Teach a small default command path

The closed command inventory is reasonable, but the first-run documentation should foreground `describe → doctor → run → inspect`, then expose check/export/interrupt as the next tasks. Giving a new developer all nine commands at once would reintroduce a smaller version of the information-scattering problem. This is presentation advice; the plan's existing visible sections and starter requirement can implement it without a new interface decision.

### UX-N2 — Make the release acquisition handoff concrete in shipped docs

PLAN.md:375 specifies filenames/checksums and correctly declines to invent a download endpoint. The release documentation should put the administrator-provided release directory and source-build alternative on one canonical page, with an exact example directory listing. A manifest identifies a compatible artifact but is not itself an acquisition channel. An artifact registry is not necessary to satisfy this advice.

### UX-N3 — Keep implementation increments usable without changing the final release bar

The full milestone includes two language runners, retained service writes, evidence/policy modules, console changes, observation access, and four harness starters. The A–F dependency order is sensible. Internally qualify an installed TS deterministic end-to-end slice early, then Python and surrounding product paths, while preserving the final all-language gate. This reduces integration risk without advertising partial parity or weakening the scope already promised.

## Strengths to retain

- The app keeps execution, tools, provider credentials and grading; the console never selects executable code.
- Nonexecuting preflight honestly distinguishes read/write observations from runtime readiness and admits local probe writes.
- The evaluator credential and fixed journal requirement are visible before request creation; static-grant restart overhead is not hidden.
- Explicit evaluator choice and server-side fallback removal protect instruction edits from accidentally using a payment-policy score.
- The plan treats local consistency, online scalar binding, trace truth and release authority as different claims.
- Saved draft generations, channel drift, pending operations and historical descriptors remain stable.
- Native resource cleanup waits for actual app quiescence; uncertain external work is retained rather than claimed stopped.

## Verification and disposition

Read the complete D1 plan, the original synthesis and CI persona report, current README, console setup source, eval request preparation, and installed SDK authoring/evaluation methods. No application code was changed, tests run, browser opened, external system mutated, or model invoked. My concern is a missing designed journey, not a reproduced runtime defect.

I can approve after UX-1 is resolved in the normative plan and acceptance matrix. I will re-read the exact revised document and return an explicit hash-bound disposition; this report is not advance approval of unspecified changes.
