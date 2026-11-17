# Developer acceptance by actual use — 2026-11-17

Seven independent agents returned to the original [developer personas](../../research/developer-experience-review/README.md), stated their acceptance criteria before execution, and used the updated service. These are simulated developer roles, not interviews or sign-off by seven humans.

**The core journeys ran successfully. Not every original developer requirement is satisfied or fully proven.** Individual reports retain partial/unmet criteria rather than converting working examples into blanket approval. The live coding-agent proof uses the Codex SDK, as requested.

## What each developer actually did

| Developer | Executed journey and observed result | Remaining qualification or need | Evidence |
| --- | --- | --- | --- |
| First-time adopter | Installed the release and adapted its own support-routing loop and grader. Its headless journey passed 24 assertions. A second continuous Chromium journey pasted that app’s descriptor into the console, downloaded its actual request, and ran the unchanged HTTPS handoff through the external installed app, quality check, export and read-only verification; 29 assertions passed. Reward improved 0.5 → 1.0 and the channel remained unreleased. | The continuous custom-app bridge is now proven. Browser authentication used a real protocol fixture and private trusted CA; real external identity providers and measured human usability remain unqualified. | [Report](first-time-adopter.md), [JSON](first-time-adopter.json), [continuous console JSON](first-time-adopter-console.json) |
| TypeScript integrator | Compiled a strict external TypeScript app against the installed release. Six pairs ran 12 execute and 12 grade callbacks; routing accuracy improved 2/3 → 1. All five committed-response-loss phases recovered the same IDs; replay added no callbacks. Isolation, file lifetime and descriptor mismatch checks passed. | Read-only export verification used a separate local reader and directory; transport to another physical machine was not tested. | [Report](typescript-integrator.md), [JSON](typescript-integrator.json) |
| Python integrator | Installed only the wheel in an isolated venv, ran with no Node in PATH and no SDK runtime dependencies, improved its task reward 0.5 → 1.0, recovered a lost committed submission with unchanged bytes/key/callback count, and distinguished infrastructure from grader failure. Two real-service asyncio cancellation modes kept inputs/locks alive until quiescence while the event loop stayed responsive. | Isolated mypy 1.18.2 accepted the public-submodule lifecycle/callback fixture and rejected four deliberate errors. The documented top-level `AcclimateClient` import fails strict `attr-defined` checking. The Python README still assumes the wheel is available instead of linking to the canonical obtaining/build path. | [Report](python-integrator.md), [JSON](python-integrator.json) |
| Evaluation researcher | Ran its own unequal-repetition dataset through installed Python callbacks against the service. Independent equal-case calculation matched policy: 0.70 → 0.40, a loss. The completed candidate correctly failed quality even though pooling rows yields 0.55 → 0.60. Unknown required cost and an actual missing grade were indeterminate; selected roles were independently verified. Sixteen assertions passed. | The console still displays row-weighted aggregates, unlike equal-case policy. Component metrics and task-aware statistical confidence are not implemented. Artifact-derived revision hashes remain an application convention; separate-machine and arbitrary midrun-loss research checks remain unproven. | [Report](evaluation-researcher.md), [JSON](evaluation-researcher.json) |
| CI/release engineer | Used the actual distributed CI archive. Tested pass, genuine regression, incomplete execution and required-export failure; verified that no case silently promoted. Exercised five lost committed responses, exact replay, explicit operator promotion, evaluator denial, stale revision rejection, immutable old pin and rollback. Verified a downloaded export after removing worker journals. | This is a local real service and archived shell job, not a hosted CI/container runner or production release. | [Report](ci-release-engineer.md), [JSON](ci-release-engineer.json) |
| Platform engineer | Provisioned separate content/evaluator/reader credentials, checked denied mutations against actual authorization, ran an installed Python evaluator, retained a sealed report through overlap rotation/revocation and two service restarts, recovered with unchanged identity/keys/root and four callbacks, interrupted owned uncertainty, and inspected aged/expired delivery observations. | A nonexistent request is diagnosed as `capabilities.unsupported`; bundle-only doctor can report ready without establishing bundle existence. Remote evaluator liveness remains unavailable; broad project write and coordinated static-grant restarts remain operational costs. | [Report](platform-engineer.md), [JSON](platform-engineer.json) |
| Coding-agent plugin author | Verified all five Acclimate package contents against release tarballs outside the checkout. All four plugin preparations ran owned repository tasks. A real installed Codex SDK session fetched service content, read resources, fixed code and passed unchanged tests. Patches survived cleanup, original source stayed unchanged, withheld memory stayed absent, and uncertain owned-child recovery required confirmed termination. | The native starter lacks its own package manifest, creating an npm workspace-resolution trap. Ambient Codex configuration produced warnings and substantial input context. One real Codex task does not establish model quality, forced provider termination, resumed sessions or other native providers. | [Report](plugin-author.md), [JSON](plugin-author.json) |

Partial dispositions are deliberate. Separate credentials/processes and copied review directories prove the tested local trust boundaries; they are not evidence of another machine or a real teammate completing the workflow.

## Live Codex SDK proof

The accepted session used an external consumer with installed `@openai/codex-sdk@0.169.0` and model `gpt-6-luna`. Its thread was `01a1e9da-fbdb-7551-9ca5-d90ffe0f43e1`.

Observed SDK tool events read `AGENTS.md`, the delivered skill and selected memory, source and test. The provider ran the repository test with exit **1**, wrote the source, then ran the unchanged test with exit **0**. Host verification independently confirmed exit 0, unchanged tests and preserved original source. Resource markers were absent from the prompt and matched the delivered files in the result. These are observed reads, not a claim of a separate automatic skill-discovery event.

The retained 219-byte patch SHA-256 is `5361282f51c440db403e50daed42a7d2239f73db95689168dd73d9ce7d3d447e`. Codex SDK implementation SHA-256 is `340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4`; native CLI binary SHA-256 is `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002`. All resolved inside the external consumer. The public plugin report records commands, exit codes, package hashes, job facts and cleanup; raw provider events and private prompts remain private.

An earlier paid in-checkout attempt was excluded when npm had resolved enclosing workspace packages. The fixture was corrected and the entire task repeated externally. Only the external run above is accepted as installed-release proof. Alternate-provider attempts are [recorded separately](other-native-live.md), excluded from acceptance, and were stopped after the user selected Codex.

## Shared console evidence

The coordinator additionally ran actual Chromium stories against the production console and real service:

- `UI-SETUP-01` / `UI-SETUP-02`: setup and scoped content journeys.
- `UI-EVAL-01`: explicit evaluator selection, public clipboard handoff and matching actual JSON download.
- `NATIVE-WALK-01`: browser draft/request, copied evaluator helper, outside-checkout installed app, deliberate release, pinned jobs and rollback.

The first-adopter additionally completed the same custom app’s continuous descriptor → console → downloaded request → installed execution → visible evidence path; see [its 29-assertion report](first-time-adopter-console.json).

**Six selected shared scenarios and 25 steps passed.** Other stories were intentionally skipped in this focused run; this is not a new full-inventory coverage claim. Coverage/results are retained under `artifacts/dx-personas-20261117/console/bdd/`.

## Reproduction and identity

Executable persona drivers and shared fixture are in `scripts/acceptance/dx_personas/`. Each report gives its exact command. Consumers use the checksummed release, not checkout SDK imports. Every persona uses an isolated owned PostgreSQL cluster and actual Rust HTTP service; generated credentials are private. Cleanup evidence records stopped services and removed database directories. Private consumer inputs, journals, logs and native job artifacts are retained only under ignored artifact directories or the reported `/private/tmp` work directories.

| Tested item | Identity |
| --- | --- |
| Product commit | `63eb588458732fbba53c0969c9b892cf08a572fe` |
| Release | `/private/tmp/acclimate-dx-release-20261117-review-1` |
| Verified release source inventory | `15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b` |
| Release manifest SHA-256 | `559c1dfe4e47158af21178742d0715500e6616b182ee89be1caf5ca844675153` |
| Tested service executable SHA-256 | `ed09e68c2c93497df582c57b5366b312f915dd2625bd5e053d0a7ebad2a8de8a` |
| Runtimes | Node 26.13.1, Python 3.11.7, PostgreSQL 16.15, macOS/POSIX |

The source inventory identifies release inputs; it does not attest the separately built service binary's source. No production deployment, real external identity provider, container remount or live cancellation guarantee is inferred. Six app/evaluation personas use application-owned deterministic behavior; the native-author report supplies the separately identified real model session. The exercise made no product-code changes, deployment or release promotion outside disposable fixtures.

The acceptance fixture itself caught and repaired private-directory permissions and npm install isolation mistakes. Those failed attempts were not counted as successful product acceptance. Public report JSON and its SHA-256 index are recorded in [evidence.json](evidence.json); private configuration, credentials and raw model output are excluded.
