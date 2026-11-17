# Doctor target verification

The platform engineer acceptance run at source commit `63eb588458732fbba53c0969c9b892cf08a572fe` found two concrete gaps: a nonexistent request became `capabilities.unsupported` with `retry_same_command` in Python, and bundle-only doctor reported ready for a nonexistent canonical UUID. The original persona reports remain unchanged in `docs/acceptance/developer-personas-20261117/`.

## Implemented contract

Both SDKs now verify the bundle against the authenticated bundle collection before checking an optional request. An empty evaluation-request or channel collection cannot establish bundle existence, so neither is used for that purpose. These are authorized GETs; doctor still creates only its temporary private local storage/lock/cache probe and removes it afterward.

| Observation | Failed check | Safe code | Next action |
| --- | --- | --- | --- |
| Bundle inventory exhausted without the requested bundle | `targetBundle` | `bundle.missing` | `fix_config` |
| Request GET returns 404 after bundle verification | `targetRequest` | `request.missing` | `fix_config` |
| Bound version metadata/payload GET returns 404 | `versions` | `version.missing` | `fix_config` |
| Capability endpoint returns 404, or advertises an unsupported capability schema | `evaluatorAccess` | `capabilities.unsupported` | `upgrade_service` |
| Evaluator read/write authority denied | `evaluatorAccess` | `auth.denied` | `ask_operator` |

Missing resources block doctor and produce command exit 2. Capability support remains unverified when unavailable, producing command exit 3. Local invalid configuration remains exit 1. Resource codes contain no identifiers, URLs, private paths, tokens, or remote error prose.

Bundle collection traversal validates each response and detects repeated cursors. It reads at most 100 pages of at most 100 bundles. A malformed page or cursor loop blocks with `evidence.malformed`; exhausting the page budget blocks with `evidence.incomplete` and `ask_operator`. Reaching that budget never asserts missing or ready. Finding the bundle on a later valid page is supported. These checks are a point-in-time observation, not a guarantee that resources remain present after doctor finishes.

The TypeScript run/claim/callback/submission paths were not changed. Python already invokes preflight before entering its journal; it now performs the same extra read-only bundle verification there. The runner's mutation keys, recovery behavior, report bodies, and callback scheduling were not changed.

## Verification on 2026-11-17

Focused checks passed: 44 TypeScript core/CLI tests, 46 Python core/CLI tests, and `npm run typecheck:packages`. Regression coverage checks known and nonexistent bundles, missing requests and versions, capability-endpoint absence, read-only authority denial, pagination, malformed/cyclic pages, page-budget exhaustion, safe output, shell categories, zero callbacks, and zero doctor mutations. Existing paired execution and durable-recovery tests continue to pass.

The broader evaluation suites also passed: 109 TypeScript tests under `packages/sdk/tests/evaluation/*.test.ts` and 75 Python tests selected by `test_evaluation*.py`. A final package typecheck and `git diff --check` passed after formatting.

An additional source-SDK check used a fresh owned PostgreSQL 16 cluster and the existing Rust service binary. Both Python and TypeScript reported ready for a real bundle and request, `bundle.missing` for an absent UUID, `request.missing` for an absent request, and `auth.denied` for the actual reader credential. Doctor made zero callbacks. SQL counts were identical before and afterward: one request, zero attempts, zero comparisons, one bundle, two versions; the request remained `requested` with no attempt. The service was stopped and its database directory removed.

Safe source-service evidence is retained in ignored `artifacts/dx-gap-closure-20261117/doctor/source-service-check.json`. The tested bundle ID was `4a2243a1-9fe5-430b-8157-6b338af7484a`; request ID was `cf54725d-5b9f-4f4f-b6c0-efdd5551bc74`. The existing service binary SHA256 was `ed09e68c2c93497df582c57b5366b312f915dd2625bd5e053d0a7ebad2a8de8a`. Its relationship to source is not independently attested. No source/package build, model/provider execution, production resource, commit, or push was used for this check. Fresh installed-release acceptance remains a separate subsequent gate.

Reproduce focused automated checks from the repository root:

```sh
node_modules/.bin/tsx --test packages/sdk/tests/evaluation/core.test.ts packages/sdk/tests/evaluation/cli.test.ts
PYTHONPATH=python /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 -m unittest python.tests.test_evaluation_core python.tests.test_evaluation_cli
npm run typecheck:packages
```
