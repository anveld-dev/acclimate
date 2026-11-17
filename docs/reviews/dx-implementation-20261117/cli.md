# App-owned evaluator CLI review — 2026-11-17

Scope: TypeScript/Python command adapters and private command intents in the shared uncommitted tree, reviewed against frozen D2 `docs/design/developer-experience-council/PLAN.md`, relative to HEAD `52c1ce1`. No paid/provider calls, deployments, builds, or commits.

## Confirmed findings and fixes

1. **P2 — Denied headless creation returned the doctor's exit category.** With evaluation write access denied, `request` exited 2 although no creation had been attempted. D2 requires request exit 1 for invalid/denied input; exit 2 is reserved for other commands. Both adapters now return 1 for blocked creation preflight. The regression also confirms that the same denied check remains doctor exit 2 and creates no draft/request.
2. **P2 — Interrupt mutated before checking the authoritative descriptor.** Create a request, edit its public handoff to another valid grader revision, and run interrupt: the original request was interrupted successfully. Both helpers now fetch and verify request ID, bound-evidence requirement, and descriptor before the POST. They also verify the retained response and authoritative current read, including the exact intended reason, before reporting success. The TypeScript helper checks lock ownership immediately before mutation. Existing coverage proves interruption still works while the long-lived evaluation scope lock is held.
3. **P2 — Policy success omitted guided request/version authority checks.** A complete passing comparison still passed `check` after changing `requireBoundEvidence` to false, or after the authoritative candidate metadata no longer had the declared direct parent. Both adapters now validate request bound-evidence, canonical version IDs and digests. Before checking terminal comparison quality, they fetch parent/candidate metadata and verify exact IDs, same bundle, digests, and direct parentage. Regressions confirm exit 1 for both inconsistencies. Read-only configuration still supplies all credentials/target authority.
4. **P2 — Doctor misclassified local input errors as unverified capability.** A missing explicit private config in Python, or unsafe journal configuration in TypeScript, returned exit 3 because preflight's default authorization was unverified. Both adapters now prioritize local config/authoring/internal failure codes as exit 1 before capability classification. Real missing-config and unsafe-storage regressions verify this behavior without executing callbacks.

All four findings were repaired in the owned files. Initial TypeScript regressions demonstrated the original request-denial (2 vs 1), altered-handoff interruption (0 vs 1), and unbound quality gate (0 vs 1) failures before fixes.

## Validation

- `./node_modules/.bin/tsx --test packages/sdk/tests/evaluation/cli.test.ts` — PASS, 16 tests.
- `PYTHONPATH=python:python/tests /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 -m unittest test_evaluation_cli -v` — PASS, 17 tests.
- `./node_modules/.bin/tsc --noEmit` — PASS (exit 0).
- Prettier applied only to the owned TypeScript files.

The suites cover installed request → run → read-only check → export → online verification; lost creation replies recovered before channel drift; immutable payload refusal; lost candidate refusal after channel drift; missing-originating-intent refusal; same-principal token rotation without persisting credentials; exact comparison retry without callbacks; selected mapper integration; incomplete/losing/interrupted exit categories; and separate interrupt locking.

## Files changed by this review

- `packages/sdk/src/evaluation/cli.ts`
- `packages/sdk/src/evaluation/cli-intents.ts`
- `packages/sdk/tests/evaluation/cli.test.ts`
- `python/acclimate/evaluation_cli.py`
- `python/acclimate/_evaluation_cli_intents.py`
- `python/tests/test_evaluation_cli.py`
- This review report.

## Limits and unresolved issues

No unresolved confirmed defect remains in the reviewed owned scope. The reported core diagnostic issue is also resolved: the TypeScript recovery reviewer repaired missing-file classification centrally and verified evaluator/reader configurations return `config.missing`, while unsafe permissions remain distinct. Deterministic localhost fixtures exercise protocol and filesystem behavior; they do not establish live provider correctness or real-service retained-operation authorization. Core execution, policy mathematics, artifact integrity, packaging, and server behavior are independently owned/reviewed. No qualification claim is made for those areas here.
