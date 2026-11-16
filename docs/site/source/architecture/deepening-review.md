# Architecture deepening review

Reviewed from merged commit `cbeae86` on 2026-11-16. The review covered Rust mutation ownership, SDK delivery and native preparation, console content reads and listing traversal, and their existing test surfaces. There was no earlier domain glossary or ADR directory; `CONTEXT.md` now records the existing product vocabulary.

## Committee decisions

Each change received two independent idea approvals before implementation. The reviewers below are automated agents. Final implementations were also cross-reviewed by agents who did not implement the respective changes.

| Change | Strength | Independent idea approvals | Result |
| --- | --- | --- | --- |
| Exclusive replay or execution at mutation start | Strong | Skeptic, Testability | The mutation module owns replay completion and returns a writable transaction only for new execution. |
| Shared exact-byte bundle verification | Strong | Inventory, Skeptic | Cache, console, and operator reads share digest-first decoding and validation. |
| Shared native preparation classification | Worth exploring | Inventory, Skeptic | Four native adapters use projections owned by existing preparation. |
| Shared internal cursor traversal | Worth exploring | Inventory, Testability | Listing state, cycle detection, and budgets live in one module. |

All three reviewers accepted the final implementations and recommended no further material refactors in the reviewed areas, subject to integration validation. Broader storage consolidation, transport frameworks, and plugin registries had uncertain payoff and were not added.

## Preserved behavior

- [Mutation start](../../src/commands.rs) completes retained replay adoption before returning a response. Nonretained replay still drops its transaction. Authorization, request fingerprints, namespaces, locks, exact response bytes, and retention remain intact.
- [Integration creation](../../src/integrations.rs) retains its machine write/promote gates and its live administrator check. A concrete administrator-authorized mutation start preserves the original conflict-before-administrator-check order; no generic authorization callback was introduced.
- [Bundle verification](../../packages/sdk/src/verification.ts) checks the digest before strict UTF-8 decoding, JSON parsing, and schema validation. Callers retain metadata checks, byte limits, cache repair, offline policy, and their existing error messages. The browser-safe validation entry remains separate.
- [Native preparation](../../packages/sdk/src/internal/native-files.ts) preserves file order and original memory paths. Cursor memory approval, Claude/Cursor settings, Pi resources, public plugin result shapes, and cleanup remain with their existing owners. The original `NativePreparation` type remains compatible.
- [Listing traversal](../../apps/console/src/server/listing.ts) preserves opaque cursors and bounded reads. Setup permits 1,000 pages; access and integration reads retain their terminal 1,001st page. Access still validates each page and returns only safe project fields.

## Test surfaces

- [PostgreSQL recovery tests](../../tests/operation_recovery.rs) cover replay adoption, closure races, retention, namespaces, and current rights. [The integration replay regression](../../tests/productization_regressions.rs) checks demotion, changed-byte conflicts, exact replay bytes, and duplicate prevention through HTTP.
- [Verification tests](../../packages/sdk/tests/delivery/verification.test.ts) cover exact serialization, Unicode and line endings, digest-before-decoding precedence, invalid authenticated bytes, byte limits, and cache repair. Console and operator tests retain their caller-specific error checks.
- [Native preparation tests](../../packages/codex-plugin/tests/unit/prepare.test.ts) exercise public result fields, ordering, absent instructions, and cleanup, alongside the existing Claude, Cursor, and Pi checks.
- [Listing tests](../../apps/console/tests/listing.test.ts) exercise opaque and cyclic cursors, exact page budgets, safe field projection, and malformed later pages through the actual listing callers.

The deletion test supports each shared module: removing it would redistribute existing invariant knowledge across multiple callers. These changes add depth at existing seams; they do not introduce speculative adapters or new deployables.

## Executed validation

- All 105 package/script tests and 223 console tests passed with two test workers. The initial unrestricted run hit existing process and HTTP fixture deadlines during heavy host contention; no test assertions or timeouts were weakened.
- Package and console typechecking passed. `npm run build` passed for SDK/plugin distributions and the production console.
- `cargo clippy --jobs 2 --all-targets -- -D warnings` passed. All 59 Rust tests passed with two Cargo build jobs and one test thread, using an owned disposable PostgreSQL cluster with explicit test database variables.
- External SDK/plugin tarball installation, standalone console verification, and isolated Python wheel preparation passed through `npm run pack:verify -- --skip-build --console-runtime` with a fresh output directory.
- Model-free service end-to-end and full-roadmap qualification passed against disposable PostgreSQL. No paid model or public deployment was used.
- Generated documentation was rebuilt and its link, fingerprint, and export checks passed.

Final acceptance: Inventory, Skeptic, and Testability are satisfied with the reviewed architecture. All material objections were resolved; no further refactor was recommended in these areas.
