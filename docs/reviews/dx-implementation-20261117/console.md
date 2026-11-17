# Console and onboarding implementation review

Reviewed 2026-11-17 against frozen `docs/design/developer-experience-council/PLAN.md` revision D2, especially sections 10/13 and gates G15/G16. Scope: the working implementation relative to HEAD `52c1ce1`, including preexisting uncommitted changes. This report distinguishes the repairs made during review from behavior already implemented.

## Findings repaired

1. **P2 — copied agent fixtures discarded their output.** In App setup → Connect your agent, both runnable recipes awaited the fixture and then removed prepared inputs, but JavaScript discarded `run.result` and Python retained it only in a local variable. No inspectable output survived the process. Both recipes now retain `acclimate-agent-result.json` in the private job directory, including result, version, digest and context policy. Files use exclusive creation and mode 0600; existing output is never replaced. Cleanup follows confirmed application termination and successful private retention. Rejected/uncertain work and failed retention preserve inputs. Setup text and getting-started instructions explain the retained file and new-directory-per-run requirement.
2. **P2 — requested status claimed readiness.** A newly created request displayed “Ready” although the console never runs evaluator preflight. Request labels now say “Requested”; existing app-owned execution and remote-progress guidance remains. A focused status-label test prevents reintroducing a readiness claim.
3. **P2 — native peer requirements were absent from App setup.** Native selection showed the matching Acclimate plugin artifact without the native SDK identity/version required by the actual-agent seam. The selected native peer and exact compatible version now come from shipped release metadata. The UI states that the deterministic fake-harness fixture requires no native peer, credentials or model call.

The coordinator was notified of these findings before their repairs.

## Behaviors inspected and preserved

- Explicit evaluator choice starts empty; authoring rejects missing configuration rather than selecting an example server-side. Custom descriptors use shared SDK validation. The known payment simulator requires candidate policy data before creating a request and is described as model-free orchestration evidence.
- Candidate/version/parent/revision bindings and existing frozen-operation recovery stay intact. Receipt lookup/replay happens before mutable channel checks; pending keys, bytes and storage format were not changed.
- Copy/download request JSON contains the closed public request envelope and projected descriptor; the download creates and revokes a Blob URL. Private evaluator configuration is separate.
- Delivery observations use current project-read authority without entering credential administration, project public fields only, preserve all fields of the selected receipt together, and show app occurrence/service receipt timestamps separately. Unknown/expired observations remain unknown. Reader/editor credential administration continues to be denied.
- Actor/service/selection scope was independently traced. An initial concern about mounted service identity was withdrawn: the current actor scope already includes the configured service URL, while `serviceIdentity` hashes that same URL. No speculative scope or legacy draft pending-key migration remains in this change.

## Validation

Passed:

```sh
npx tsx --tsconfig apps/console/tsconfig.json --test apps/console/tests/*.test.ts
```

244 tests passed, zero failed. This included the four new copied-recipe tests, delivery authorization/projection tests, handoff download tests, explicit evaluator authoring tests, and existing pending/recovery checks. After the final status-label helper change, the following targeted rerun passed 15 tests:

```sh
npx tsx --tsconfig apps/console/tsconfig.json --test apps/console/tests/agent-connection-recipes.test.ts apps/console/tests/evaluation-request-labels.test.ts apps/console/tests/sdk-basic-recipes.test.ts apps/console/tests/sdk-setup-recipes.test.ts apps/console/tests/sdk-setup.test.ts
```

The copied-recipe tests execute both generated programs against fake installed public SDK seams. They verify bound result content, mode 0600, cleanup after successful retention, input preservation on rejection/unknown termination/output collision, and nonreplacement of previous output. They use no service, provider or repository implementation imports.

```sh
npx tsc --project apps/console/tsconfig.json --noEmit
npx prettier --check apps/console/src/components/sdk-setup.tsx apps/console/src/components/sdk-setup-recipes.ts apps/console/src/components/improvement-workspace.tsx apps/console/src/lib/evaluation-request-labels.ts apps/console/tests/evaluation-request-labels.test.ts apps/console/tests/agent-connection-recipes.test.ts
```

Both passed, including a console typecheck rerun after the final status-label helper refactor. The coordinator owns final integrated checks.

## Limits and remaining issues

No unresolved defect found in the reviewed console/onboarding scope. This review does not establish browser interaction/visual usability, real identity-provider/service authorization, database receipt ordering/retention/index behavior, packaged release consumption or native/provider execution. Those need the coordinator's integrated gates. No preview browser, production console build, BDD run, model call, deployment or commit was performed.

## Files changed by this review

- `apps/console/src/components/sdk-setup-recipes.ts`
- `apps/console/src/components/sdk-setup.tsx`
- `apps/console/src/components/improvement-workspace.tsx`
- `apps/console/src/lib/evaluation-request-labels.ts`
- `apps/console/tests/agent-connection-recipes.test.ts`
- `apps/console/tests/evaluation-request-labels.test.ts`
- `docs/getting-started.md`
- This report.
