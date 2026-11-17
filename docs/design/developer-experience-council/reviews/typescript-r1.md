# Independent TypeScript installed-app review — round 1

Disposition: **BLOCKED** pending TS-1, TS-2 and TS-3 below.

Reviewed plan D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`, on 2026-11-16. This is a source/document review, not implementation or runtime qualification. The plan is a substantial improvement over checkout-only evaluator examples, but the remaining issues affect an external caller or the promised isolation/scheduling guarantees.

## TS-1 — Freeze the actual CLI-to-artifact integration interface

**Plan anchors:** section 3, lines 100–116; section 7, lines 239–253; section 9, lines 293–295.

The only shown command-helper call is `evaluationMain(app, argv)`. `EvaluationDefinition` has no review-mapper/selection field, while section 7 says the app statically binds an optional review mapper to `evaluationMain`. Section 9 names `selection?` and `toReviewArtifact?` without defining either caller type or how the `export` CLI receives that trusted selection. The advertised command accepts `--out` but no selection. A developer following the complete shown interface can export scalar metadata, but has no specified way to release an intentionally selected failed-case output through that same command.

**Concrete failure:** two implementation lanes independently choose a third CLI options argument versus fields in the opaque definition, or expose a command-line redactor module flag to fill the gap. The first creates incompatible starters; the latter violates the static installed-code rule. The feature central to teammate trace review is still application glue rather than a supported integration.

**Minimum fix:** declare `evaluationMain`'s callable interface including its trusted optional review configuration, and declare the artifact selector and mapper input/output types. Decide whether selections are static app configuration, an explicit local selection file parsed by a closed schema, or documented safe CLI flags. Bind those options to the displayed `export` command without dynamic executable resolution. Keep no mapper/default selection equal to scalar-only export.

**Acceptance:** a clean external `.mjs` starter statically supplies a mapper, deliberately selects one failed case/side/output, runs the documented export command, and produces a review artifact a second teammate can verify. The same starter without those options shares no raw content. Unknown selection and redactor failure have defined safe results.

## TS-2 — Include verified bundles in callback isolation

**Plan anchors:** section 3, line 89; section 5, lines 169–197; release gate G09.

The plan explicitly clones case inputs, expected answers and outputs, but omits the mutable `VerifiedBundle` passed to `execute`. The current runner resolves parent/candidate once into a map and passes `versions.get(version.version.id)!` to every callback (`examples/evaluation/runner.ts:115,125`). Those are mutable original objects. Although lower-level `compare` freezes its own cloned version context, the wrapper discards that context and hands the app its separately retained mutable bundle. A straightforward extraction preserves this problem.

**Concrete failure:** the first parent repetition modifies `bundle.payload.files[0].text` or empties `bundle.payload.files`. Later repetitions consume altered instructions under the unchanged original version ID/digest. This can occur accidentally in an app that filters resources in place. Input cloning alone does not preserve the plan's fixed, verified comparison inputs.

**Minimum fix:** explicitly require an independent verified-bundle view for each callback, with immutable version/digest metadata and no mutable payload shared across cases/sides/repetitions. A deep-frozen per-callback clone or equivalent isolation is sufficient. Native memory filtering must change only the owned prepared workspace, not the canonical verified bundle. Explain that this protects runner input isolation; it still cannot attest how app code used content.

**Acceptance:** an executor attempts to mutate its received bundle payload/version in the first repetition. The mutation either fails locally or affects only its private view; every later callback receives the original verified bytes and identity. Both Python and TypeScript fixtures cover this alongside ordinary task-input isolation.

## TS-3 — Specify callback order and the uncertainty escape path during extraction

**Plan anchors:** section 3, lines 93–96; section 5, line 195; G08/G09.

The plan promises serial parent-then-candidate execution but does not give the callback timeline. The existing `compare({concurrency:1})` still begins both sides with `Promise.all` (`packages/sdk/src/compare.ts:272`) and limits individual callbacks (`:167–175`), not complete sides. Its ordinary timeline is parent execute → candidate execute → parent grade → candidate grade, rather than parent execute → parent grade → candidate execute → candidate grade. Further, `compare` converts every execute exception except `TaskExecutionError` into an infrastructure outcome (`:205–214`) and catches every grader exception (`:251–260`). A new `ExecutionUncertainError` will be swallowed unless extraction deliberately changes or wraps that behavior.

**Concrete failure:** Python's sequential side loop differs from an unchanged TypeScript `compare` wrapper, or an uncertainty sentinel becomes an ordinary incomplete report that is submitted and finished. Both violate intended cross-language/cancellation semantics despite each implementation seeming to follow a serial runner design.

**Minimum fix:** freeze one exact timeline for the high-level runner and say how it differs from the unchanged low-level helper. Require uncertainty sentinels from either execution or grading to escape ordinary outcome classification, stop subsequent callbacks, retain the marker, and prevent report sealing/submission. The implementation may factor common internals or own a dedicated serial loop; it must not assume `concurrency:1` alone supplies these semantics.

**Acceptance:** cross-language callback-order fixtures assert the exact execute/grade sequence, and injected execute/grade uncertainty prevents every subsequent callback and every submit/finish. Existing lower-level compare behavior remains backward compatible.

## Nonblocking advice

- Replace the displayed `any` app parameters with existential/opaque captured types in the actual declarations. Give high-level grading its own named result type so its private explanation field cannot be confused with the existing root `GradeResult` export.
- Specify whether `app.descriptor` is a deep-frozen value or defensive getter. `Readonly<EvaluationDescriptor>` is shallow; a caller must not mutate descriptor runtime/inventory independently of the captured definition.
- Document the practical interaction of the 1,000-pair maximum and conservative 2 MiB report admission test. With maximum 1,024-byte output references per outcome, some otherwise valid large inventories will be rejected. The safe limit is reasonable, but users need an actionable preflight size category rather than a generic definition error.
- Keep the six implementation lanes' file ownership precise: the current work-package table overlaps Python policy/artifacts, TS evaluator/artifacts, shared transport, manifests and SDK types. Contract freeze and a single integration owner are good; assign concrete module ownership before implementation agents start.

## Strengths preserved

The chosen installed subpath, explicit config filename, static app definition, no module loading from requests, separate pure/browser modules, model opt-in, retained HTTP operations, conservative foreign-journal refusal, explicit CI semantics and same-milestone Python path are sound. The review does not object to serial execution, POSIX/Python lock prerequisites or retaining static evaluator grants as clearly stated first-release constraints.

## Verification limits

Read the plan, SDK package/export/build setup, validation/cache/client surfaces, current comparison scheduler and installed example runner. No dependencies were installed and no tests, builds, services, browsers, native providers or model calls were run. Findings concern specified behavior and current-source extraction hazards, not newly reproduced runtime defects. Approval requires an exact-hash recheck after these contracts are resolved.
