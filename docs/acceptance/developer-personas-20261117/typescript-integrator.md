# TypeScript integrator: executed acceptance, 2026-11-17

I replayed the original [TypeScript integrator review](../../research/developer-experience-review/typescript-integrator.md) against the obtained release and the updated service. The integration now delivers the installed durable API that was missing in that review. My own compiled application completed a real descriptor-bound paired evaluation, consumed verified versioned instructions, and recovered committed response loss without repeating application callbacks.

This is an executed deterministic adoption exercise, not observed customer research or model-quality evidence. The service was an isolated PostgreSQL 16/Rust fixture. The source inventory and actual service-binary hashes are recorded separately; their correspondence was not independently build-attested. No model, native harness, deployment, commit, or production mutation ran.

## My acceptance criteria, set before execution

As the maintainer of an existing TypeScript service, I need to keep my executor and grader, import supported installed APIs, and obtain reviewable results without maintaining Acclimate's recovery protocol. I set these criteria before consumer execution; the script writes that list before invoking npm or Node.

| Criterion | Expected | Observed | Decision |
| --- | --- | --- | --- |
| Installed TypeScript | Strict compile; public installed SDK imports only | TypeScript 5.9.3 compiled my own app; Node executed its emitted JS | Accepted |
| Meaningful pair | Saved tasks and independent grader measure a content change | Correct routing increased from 2/3 to 1 across three cases and two repetitions | Accepted |
| Bound request | Public descriptor becomes immutable real request | Six inventory keys completed under one request/attempt/comparison | Accepted |
| Callback lifetime | Isolate task, expected answer, output and bundle copies; retain prepared files through async execution | Twelve executions and twelve grades passed mutation probes; prepared policy remained readable after await and was removed after each execution | Accepted |
| Durable retry | Retry actual committed response loss with stable identity and no repeated callbacks | Five committed response phases dropped; comparison submission recovered; later process replay after transient dedup expiry added zero callbacks | Accepted |
| Diagnostics | Identify dataset mismatch before executing | Exit 1, `descriptor.mismatch`, `datasetRevision`, `not_started`; callback file absent | Accepted within tested scope |
| Review handoff | Intentionally share failed output and grading context with a reader | Redacted failed-parent output and grader explanation exported; separate read-only principal verified online scalar binding | Partial: authenticated transfer to a second machine was not exercised |

## What I actually integrated

I followed [getting started](../../getting-started.md), using the checksummed operator-managed release. The distributed evaluation starter supplied the offline package installation path; I removed its application files and wrote my own `app.ts`, saved JSON cases, candidate content, and quality policy. TypeScript 5.9.3 and its existing Node declaration dependencies were copied as development tooling. SDK imports came exclusively from the installed release's `@acclimate/sdk`, `@acclimate/sdk/evaluation`, and `@acclimate/sdk/evaluation/cli` exports. No checkout SDK or evaluator implementation was imported by the app.

The task routes support tickets. Baseline instructions route any ticket containing “urgent” to high priority. Candidate instructions respect “not urgent.” Saved outage, negated-urgency, and routine cases contain private expected priorities used only by the independent grader. Each repeats twice. The executor reads `routing/policy.md` through `prepareFiles` after an asynchronous wait, applies the pinned instruction, retains version/digest beside its result, and cleans prepared inputs. This deliberately simple application measures deterministic instruction interpretation; it does not claim a model obeyed prose.

The application deliberately mutates its input and bundle; the grader mutates its expected answer and output. Later callbacks still received clean data, and retained output artifacts kept the executor's original priorities. The executor also checked that it had no expected-answer argument and that its context was frozen. This establishes the exercised copy and lifetime boundaries; it does not qualify cancellation or an uncooperative external executor.

The command sequence was offline install, strict compilation, `describe`, `doctor`, `request`, mismatched `run` (expected exit 1), normal `run`, `check`, a second-process `run`, selected `export`, and `verify-export`. The policy required improvement of at least 0.3, no case regression, candidate score 1, no task failures, and known zero candidate cost. It passed with a descriptive improvement of 1/3 and all six pairs comparable.

## Recovery and sharing evidence

The explicitly labelled `ResponseLossProxy` fault fixture forwarded actual HTTP to the Rust service, consumed successful committed responses, expired transient idempotency rows by 25 hours, and dropped the first response for draft, request, start, comparison submit, and finish. This was not a canned successful response or an SDK transport mock. The comparison ID observed in the dropped committed response equalled the final comparison ID. Callback audit records all bound to the final attempt. The separate terminal replay preserved request, attempt and comparison IDs and left the callback file byte-for-byte unchanged.

The app-owned review mapper released only priority/version/digest for output and observed/expected/matched grading context for one failed parent case. Verification used a separately granted project reader and reported `online_scalar_binding` with `executionAttested: false`. The private local export was retrieved and verified; approved authenticated remote artifact distribution remains an application/operator responsibility and was not tested here.

## Remaining friction and original findings

The original TS1 packaging gap is resolved for this executed path: the installed package supplied definition, lifecycle, CLI and review APIs; I supplied callbacks and application-owned files. TS5's undeclared `tsx` fetch is avoided by emitted JavaScript and explicitly existing TypeScript development tooling. I did not qualify a pristine machine's compiler installation or the minimum supported Node release.

TS2 improved materially: the actual dataset mismatch returned the precise safe field before callbacks. Unauthorized, not-found and transport diagnostic distinctions were not exercised, so the full original diagnostic criterion remains unqualified. TS3 now has a documented content-to-app bridge and the app consumed pinned content through completion; model/native consumption is outside this run. TS4 has an exercised mapper/export/reader-verification path, with cross-machine delivery still partial.

Adoption still requires operator-managed release and evaluator provisioning. Durable JavaScript evaluation additionally requires POSIX and `python3` with `fcntl`, plus stable private persistent journal storage. These are documented operational prerequisites. The compiled-app path itself required no new package download at execution time.

The sanitized [machine report](typescript-integrator.json) contains criterion observations, exact IDs, exit codes, scalar policy results, and hashes. The reproducible [acceptance driver](../../../scripts/acceptance/dx_personas/typescript_integrator.py) embeds the app source and stages it into an isolated installed consumer directory. Private credentials, callback artifacts and command streams remain outside this public report. Successful fixture cleanup stopped the service and removed the disposable database.

```sh
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  scripts/acceptance/dx_personas/typescript_integrator.py \
  --output /private/tmp/acclimate-dx-typescript-20261117
```
