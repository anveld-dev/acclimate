# Implementation coordination

Implementation authorized 2026-11-16. PLAN.md D2 remains frozen design; do not edit it to accommodate implementation shortcuts. All agents work in the shared checkout, without commits, paid/live models, deployment, secret inspection, external mutations or child agents. Run focused deterministic tests and report exact results. Root installs dependencies and integrates broad checks. Preserve existing uncommitted review/design documents and unrelated work.

## Ownership

| Owner/task | Exclusive editing scope |
| --- | --- |
| root | packages/sdk/src/{types,index,validation,client}.ts, SDK internal HTTP bridge/evaluation transport, root/SDK manifests and lockfiles, shared contract docs, integration fixes and acceptance ledger |
| implement_server | Rust src/{commands,evaluations,integrations,lib,auth}.rs as needed, own Rust tests; capability/retained operations/observation routes |
| implement_ts_core | packages/sdk/src/evaluation/{index,types,definition,config,journal,runner,errors,private-state}.ts and needed core-only internal modules/tests; existing examples/evaluation/{adapter,runner,journal}.ts compatibility wrappers; scripts/evaluate-app.ts and scripts/evaluator-config.ts |
| implement_python_core | python/acclimate/{client,types,__init__,evaluation}.py and _evaluation_* core helpers; core-owned Python tests |
| implement_policy | packages/sdk/src/evaluation/policy.ts, python/acclimate/evaluation_policy.py, own policy tests and shared policy fixtures |
| implement_artifacts | packages/sdk/src/evaluation/artifacts.ts, python/acclimate/evaluation_artifacts.py, own artifact tests |
| implement_cli | packages/sdk/src/evaluation/cli.ts and command intent helpers, python/acclimate/evaluation_cli.py and CLI intent helpers; own CLI tests |
| implement_console | apps/console setup/evaluation/observation UI/server files and own tests, README.md, docs/getting-started.md, operator/development documentation |
| implement_native | examples/native-repository/** and tests, examples/native-integration.md; native guide/qualification records |
| implement_packaging | scripts/build-packages.mjs, scripts/packaging/**, examples/evaluation-starter/**, examples/ci/**, DX qualification harness and own packaging/consumer tests |

Request changes to another owner's files through messages; do not edit them concurrently. Root owns shared public DTOs and export maps. Each core owner must promptly send sibling CLI/artifact owners exact internal helper/state contracts; agree before coding those joins. Helpers may be exported from source-internal modules for sibling implementation, not added to public package export maps.

## Shared starting contracts

- Public function/type names and wire fields follow PLAN.md exactly. Root adds EvaluationDescriptor, EvaluationHandoff, EvaluationCapabilities, IntegrationObservation DTOs in SDK types and pure descriptor/handoff/target validators in SDK validation. Python core mirrors DTOs.
- Root supplies `packages/sdk/src/internal/evaluation-transport.ts`: `createEvaluationTransport(config)` returns `{client, mutate(operation, scope, body, key)}`. `operation` is closed `start|submit|finish|interrupt|createRequest|createDraft`; scope contains projectId/bundleId plus requestId or channel as needed; body is exact serialized UTF-8 string. It uses the existing client's single internal HTTP implementation, adds retained-operation header and validates a typed allowlisted route. No public raw HTTP export. `config` has serviceUrl/projectId/evaluatorToken/evaluatorPrincipalId; optional reader use constructs regular AcclimateClient for GETs only. Core and CLI must agree exact helper signature with root before final integration.
- New guided scopes use canonical project/UUID grammar, 4 MiB bounded JSON responses, persisted exact mutation bodies and retained operations. Read-only policy/verifier paths do not require a journal or write preflight.
- Runner privately indexes output/explanation role values and bindings; artifact owner and both core owners must freeze one shared index contract before independent implementation. No role mapper receives private expected answers/config/envelopes.
- CLI consumes the three core operations, pure policy and explicit artifacts through statically bound app code. CLI's headless request/interrupt intents use separate short-held locks and exact bytes, not the long execution lock.
- Root exports Node-only subpaths /evaluation, /evaluation/cli, /evaluation/policy, /evaluation/artifacts. Root/browser validation imports must stay pure.
- All native runtime live checks remain opt-in and unrun during default implementation. No one may claim all G01–G22 gates pass merely from focused tests.

Send discovered contract conflicts and design deviations immediately; resolve them explicitly rather than silently weakening the approved behavior.

## Final disposition

Implementation and independent audit repairs are complete. See [implementation evidence](IMPLEMENTATION-RESULTS.md) for exact release fingerprints, validation results, G01–G22 coverage and unrun external qualification. The normative D2 plan remains unchanged.
