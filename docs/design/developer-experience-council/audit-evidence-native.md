# Evidence and native implementation audit

Reviewed 2026-11-16 against the approved D2 `PLAN.md`, current changes relative to HEAD, and untracked evaluator/native implementation. This is an implementation audit, not qualification of live providers or resistance to a hostile same-user application. Source references below identify the initially reviewed implementation; concurrent fixes can move line numbers.

Recheck disposition: **all five findings below are resolved in the inspected sources**. The independent recheck found no remaining material bug in this review scope. Historical findings and reproductions are retained to explain what was checked; current fix locations and validation are recorded below.

## Findings

### P1 — An index association swap releases an unselected role

Sources: `packages/sdk/src/evaluation/artifacts.ts:567` (`indexEntries`) and `:764` (selected file read/mapper); `packages/sdk/src/evaluation/journal.ts:237` (`writeArtifact`); `python/acclimate/evaluation_artifacts.py:317` (`_index_entries`) and selected-file mapper path; `python/acclimate/_evaluation_journal.py:136` (`write_artifact`).

Private artifact files initially contain only the raw role value. Export independently validates the index's declared case/side/role/version against the comparison, then validates the referenced file's size/hash, but nothing independently binds those file bytes to the declared identity. Swapping only `file`, `sha256`, and `bytes` between legitimate output and grader-explanation index rows therefore passes every check without changing the sealed report or its hash. Selecting only output invokes the output mapper with the unselected explanation. The same construction works across sides/cases. This defeats the explicit per-role privacy selection even for an accidental file/index association error; it does not require an execution-authenticity guarantee.

Reproduced with the Python `ArtifactTests` fixture: create ordinary output and explanation entries with `Journal.write_artifact`, exchange their three file-reference fields, save the otherwise unchanged index, then export the required output selection. Actual result: `status='exported'`, mapper `identity.role='output'`, mapper value `{'graderOnly':'synthetic-explanation-canary'}`. The TypeScript code has the same association gap.

Minimum fix: persist a private envelope with the original request/attempt/case/repetition/side/version/digest/role identity and the role value; hash the entire envelope. Before invoking the mapper, compare its identity independently with the selected/index/authoritative identity and unwrap only `value`. Keep the public mapper input role-only. A sealed, independently validated immutable index binding would also be sufficient. Test swapping valid file/hash/size triples between roles and sides: reject before any mapper call or complete manifest. Preserve explicit `executionAttested:false` semantics.

Resolved: both core writers now persist the identity/value envelope, and both export readers independently compare its closed identity before unwrapping the role value. Current locations: `packages/sdk/src/evaluation/journal.ts:256`, `packages/sdk/src/evaluation/artifacts.ts:820`, `python/acclimate/_evaluation_journal.py:138`, and `python/acclimate/evaluation_artifacts.py:522`. The exact original role-swap reproduction now returns `artifact.integrity`, invokes the mapper zero times, and creates no manifest. Private values remain bounded to 1 MiB; the envelope has a separate 16 KiB metadata allowance, consistently applied by writers and readers.

### P1 — Python lexical paths bypass forbidden export roots

Source: `python/acclimate/evaluation_artifacts.py:208` (`_destination`, initial implementation).

`Path` preserves `..`, but `_destination` initially checks overlap against its lexical `.parents` without normalizing it. With an existing private `outside` directory beside `journals`, `/root/outside/../journals/new-export` passes the overlap check and creates the export inside the forbidden journal root. The same alias bypass applies to config and discovered prepared roots. TypeScript resolves the destination before overlap checks.

Minimum fix: inspect the supplied ancestor path for symlinks before normalizing it, normalize destination and forbidden roots to canonical lexical absolute paths, and compare those paths before creating anything. Tests must cover `outside/../config/new`, `outside/../journals/new`, and a symlink followed by `..`, with no output created.

Resolved: `_destination` at `python/acclimate/evaluation_artifacts.py:269` checks the supplied ancestry, then compares normalized absolute destination/roots. The original journal alias is rejected with `artifact.integrity` before directory creation. The config, journal, and symlink-plus-`..` regressions pass.

### P2 — Python commits JSON artifacts that its verifier rejects

Source: `python/acclimate/evaluation_artifacts.py:442` (initial mapper encoding; subsequently moved near `:513`); `python/acclimate/_evaluation_shared.py:134` (`json_bytes`).

The mapper JSON encoding calls `json_bytes`, whose `portable=False` mode intentionally supports wire-report scalar numbers outside the private JSON integer range. Artifact verification instead calls `validate_json` with its default portable range. A mapper returning `{'mediaType':'application/json','value':2**53}` produces a complete export, then `verify_review_export` rejects that same export with `config.schema`. TypeScript rejects this mapper value before committing.

Reproduced using the existing Python artifact fixture and immediate verification of the resulting manifest.

Minimum fix: validate the mapped artifact as portable private JSON before encoding, and map failure to `artifact.mapper_failed`. Test the integer boundary and assert no complete manifest is committed; keep finite wide wire rewards supported in the scalar projection.

Resolved: `python/acclimate/evaluation_artifacts.py:548` validates mapped JSON with the portable private JSON rules before encoding. The original `2**53` reproduction now returns `artifact.mapper_failed` and creates no manifest. The independent Python suite also passes its cross-language export/verification case with the legal wide wire reward `1e16`, confirming that scalar wire evidence was not narrowed by the mapper fix.

### P2 — A missing sealed report is treated as a configuration failure

Sources: `packages/sdk/src/evaluation/artifacts.ts:705` (`journal.readBody`); `python/acclimate/evaluation_artifacts.py:395` (initial `journal.read_body`, subsequently moved near `:454`).

When the originating journal exists but its sealed submit-body file has been lost, export calls the journal reader unconditionally. Python raises `config.missing`; TypeScript raises a private-file/config error. Thus an optional content selection cannot produce the required explicit `unavailable` disposition. D2 section 9 says a missing local sealed report/index means content unavailable, while corruption or mismatch remains an integrity error. Required unavailable content must return the content-missing/exit-3 result without committing a complete manifest.

Reproduced by deleting only `submit-body.json` after `ArtifactTests.local_evidence()` and exporting an optional output selection: actual error `config.missing`.

Minimum fix: distinguish missing report references/files from malformed, inaccessible, or hash-mismatched reports. Missing report means unavailable local inspection and no mapper calls; preserve errors for corruption. Test optional missing body/index (complete manifest with unavailable role) and required missing body/index (no manifest, `artifact.missing`).

Resolved: `packages/sdk/src/evaluation/artifacts.ts:729` and `python/acclimate/evaluation_artifacts.py:472` distinguish absent sealed bytes from corrupt ones. Deleting only the saved submit-body file now produces an optional export with both `localInspection` and the selected role set to `unavailable`, no mapper call, and successful local manifest verification. The required selection returns `artifact.missing`. Missing-index and corrupt-body regressions pass in both runtimes.

### P2 — Scalar exports can be created inside a marked native workspace

Sources: `packages/sdk/src/evaluation/artifacts.ts:687` (prepared-root discovery only for content selection), `:328` (`safeOutputDirectory`); `python/acclimate/evaluation_artifacts.py:381` (initial content-selection branch), `_destination`.

Prepared roots are added to the forbidden list only when a nonempty selection opens the originating journal. Scalar-only export therefore accepts an output path inside an existing native prepared tree even when that tree has the fixed owner marker. This violates the requirement that every export live outside prepared roots and can expose deliberately released comparison evidence to another active native workspace. No hostile filesystem race is necessary.

Reproduced with the Python fixture: create private `prepared/.acclimate/native-job-owner.json` containing `{'schemaVersion':1,'jobId':'a'*64}`, then default scalar export to `prepared/shared`. It returns `status='exported'`, `localInspection='not_requested'`, and creates its manifest inside the prepared tree. TypeScript uses the same conditional discovery.

Minimum fix: inspect the canonical existing destination ancestors for the fixed native owner marker before creating the export, and reject a marked workspace ancestor. This check needs no journal creation, journal lock, or originating worker. Test default scalar exports with evaluator and reader configs against a marked prepared ancestor, and assert no export directory is created and no journal access occurs.

Resolved: `packages/sdk/src/evaluation/artifacts.ts:341` and `python/acclimate/evaluation_artifacts.py:284` reject fixed owner markers in existing destination ancestors. The original scalar-reader reproduction now returns `artifact.integrity`, creates no export directory, and still rejects correctly when journal construction is patched to fail if called. Evaluator-config and reader-config regressions both pass.

## Independent recheck evidence

Commands run against the resolved implementation:

```sh
./node_modules/.bin/tsx --test packages/sdk/tests/evaluation/artifacts.test.ts
PYTHONPATH=python python3.12 -m unittest discover -s python/tests -p test_evaluation_artifacts.py -v
```

Results: TypeScript **10/10 passed**, Python **13/13 passed**. In addition, a direct temporary-fixture Python script reran the original five failure scenarios independently of their new test methods and checked the precise safe errors, role dispositions, mapper-call count, absent output files, and optional-export verification described above. It performed no provider call or external mutation. The recheck also inspected the new core writer/reader identity envelopes and size budgets; no new material regression was found.

SHA-256 of the inspected source bytes:

| Source | SHA-256 |
| --- | --- |
| `packages/sdk/src/evaluation/artifacts.ts` | `69742744d015567da1f8eb2a1aecf4f697e75b919dc6ed330ecf91c4b9907175` |
| `packages/sdk/src/evaluation/journal.ts` | `436bbf490c055f3e80ee8343f13467deba2299be9d5ced6a1a4ad86f8c7c9ce7` |
| `packages/sdk/src/evaluation/runner.ts` | `46b10d0c2f5654361cf9ab96430e0e71d67a9584b0f5c4f8cd56a66bc8b1aa44` |
| `python/acclimate/evaluation_artifacts.py` | `68351d71ece10f63f54afcc5f2ba537bf9427bad09a9336e728c8b677152fc13` |
| `python/acclimate/_evaluation_journal.py` | `95459e1aa22884cab0770e706e42da1916ee4c6866636d29a9acce39fc8ab52a` |
| `examples/native-repository/repository-job.mjs` | `8d8a42770146454c45038916e38db5e62d24388224c9ca848a1f50319d07335a` |

## Native and verifier scope reviewed

No additional concrete native lifetime, source-preservation, or memory-exclusion defect was established within the declared cooperating-app and quiescent-source model. Reviewed frozen/exclusive source copying, persistent TMPDIR validation, effective metadata filtering as well as memory-file removal, launch intent/acknowledgment/stop/retention records, bounded text patch collection, cleanup conditions, and explicit post-stop quarantine recovery. The code retains workspaces when termination is uncertain or result retention fails.

Reviewed local manifest consistency versus online scalar binding: online verification receives an independently supplied handoff and read config, compares the recomputed authoritative projection, and reports `executionAttested:false`. A self-consistent rewritten manifest alone does not select its own trusted target or gain execution authenticity.

The initial artifact unit tests passed the ordinary paths but did not cover the five reproductions above. Fixes were communicated directly to integration and the artifact/core owners, then independently rechecked as recorded above. No source implementation, credentials, provider calls, external state, or commits were changed by this audit; only this audit document was written.
