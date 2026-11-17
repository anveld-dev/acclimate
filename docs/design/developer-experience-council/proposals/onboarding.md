# Proposal: one first-comparison journey

Design council workstream: onboarding and product journey. Proposed 2026-11-16 from current source; no product implementation or live user study is claimed. The coordinator must align the named local commands with the selected evaluator interface before freezing the plan.

## Decision

Keep the existing App setup and evaluation workspace, and connect them through a documented **Connect → Compare → Review** journey. Add a visible next step after the delivery check and place the evaluator prerequisites before request creation. The app exports its public descriptor; the console validates and freezes that descriptor; the app consumes the resulting request handoff through a supported installed evaluator module.

Do not create a second onboarding dashboard, global integration registry, persistent wizard, browser-to-local bridge, or executable configuration format. Treat setup instructions and local diagnostic output as instructions/evidence with explicitly limited claims, rather than inventing automatic readiness detection.

## Current source anchors

- `README.md:16` begins with contributor build/test commands. `docs/development.md:7` requires the production identity path; the adopter and operator entry points are currently interleaved.
- `apps/console/src/components/sdk-setup.tsx:35–41` uses package-path placeholders and an implicit `npx tsx` runner; `:69–183` covers installation and delivery access; `:186–229` stops at file-read verification.
- `apps/console/src/components/sdk-setup-recipes.ts:1–67` generates generic content preparation, file reads, and cleanup. The recipe is sound delivery evidence, not proof of agent consumption.
- `examples/native-integration.md:3–21` supplies the separate native handoff and preparation lifetime. `examples/codex-agent.ts:43–65` illustrates actual execution with repository-relative imports.
- `apps/console/src/components/improvement-workspace.tsx:171–178` selects payment-retry by default; `:873–897` asks custom users to supply an already-described installed evaluator; `:1362–1410` exposes the second credential/journal prerequisite after a request exists.
- `apps/console/src/lib/evaluation-config.ts:17–47` validates the public descriptor. `:50–63` creates the existing schemaVersion 1 handoff; `:66–77` only recognizes built-in checkout commands.
- `apps/console/src/server/improvement.ts:218–243` validates current channel revision/candidate parentage, but `:232` silently defaults a missing configuration to the payment descriptor.
- `apps/console/src/components/improvement-workspace.tsx:164–170` retains actor/service/selection-scoped pending operations; `:181–199` only accepts a saved evaluation form if the recovered request matches it. Those protections remain.
- `apps/console/src/components/improvement-workspace.tsx:1429–1431` correctly says interruption does not stop the external app or charges. Preserve that distinction.

## Entry points

The top README task links become:

1. **Connect an existing agent** — requires an existing workspace and explicit app access. Leads to `docs/getting-started.md` and the console's existing App setup route.
2. **Try a model-free comparison** — runs a shipped deterministic fixture entirely locally; no service, OIDC, or model credential is required. Its output is marked simulated and cannot be promoted.
3. **Operate a deployment** — leads to the existing production deployment/identity instructions.
4. **Develop Acclimate** — repository build/test instructions move here, with historical cutover/qualification links below.

Use the same task names in the console and docs. Avoid implying that a simulated fixture demonstrates improvement of the developer's own agent.

## App setup screen

Retain the TypeScript/Python selector. Add a runtime selector scoped to the recipe only: **Custom app**, **Codex**, **Claude**, **Pi**, **Cursor**. Display only supported language/runtime combinations. Python initially offers Custom app; it must not suggest Python native harness parity without a Python-specific recipe.

The screen has four sections, all visible through headings rather than gating a user through a wizard:

### 1. Install the release

Show the selected SDK and, for native harnesses, its matching plugin artifact from the same release. The canonical release manifest supplies exact filenames, checksums, package versions, and minimum runtime requirements. The user chooses an already obtained release directory; the console never claims files exist locally or offers an invented download endpoint.

Copyable command examples use actual manifest filenames once a release is selected, or label unresolved paths explicitly as **Replace with your release directory**. A local-repository build disclosure remains for contributors. Prefer plain `.mjs` starter/recipe execution with Node for the JavaScript path; TypeScript users can use their existing toolchain or install a documented pinned development runner. Do not retain implicit `npx` downloads.

Before release metadata integration is implemented, a canonical release-package page may provide the same exact filename/version/checksum information. The initial implementation need not add an administrator settings panel or registry publishing.

### 2. Configure app access

Keep the current delivery setup and scope/cache explanations. Add a short capability summary before the check:

| Task | Required identity | Where it comes from |
| --- | --- | --- |
| Fetch a released channel | Bundle/channel content-read credential | Workspace admin, Connections |
| Report optional delivery observations | Separate receipt-write credential | Workspace admin, Connections |
| Evaluate an unpublished candidate | Project evaluator principal with read/write | Service operator provisioning workflow |
| Release a candidate | Human/session or machine release authority | Workspace role / explicit operator policy |

The eval row links directly to a public operator request template containing only service origin, workspace/project ID, bundle ID, required rights, and purpose. It contains no credential, private path, human cookie, or executable locator. Copy: **“Delivery credentials cannot evaluate unpublished candidates. Ask your operator for evaluator access before your first comparison.”** Current static-grant restart/rotation requirements are documented in the linked operator runbook; the screen must not claim self-service evaluator issuance exists.

### 3. Verify delivery

Keep the model-free read-all-files check. Label expected success **“Verified content delivered”**, followed by **“This checks the bytes and file preparation. Connect your app below to use them in an agent run.”** Do not mark the overall agent integration complete automatically.

No upload of local result JSON is needed. Optional delivery receipts continue to be observations only, with absent history meaning unknown.

### 4. Connect your agent

Show one installed-package recipe matching the selected runtime, immediately after the check. For Custom app, the recipe has a small explicit seam:

```javascript
const bundle = await resolveAndCache(client, selection, { cacheDir });
const prepared = await prepareFiles(bundle, jobDirectory);
try {
  const result = await runExistingAgent({
    instruction: /* read the explicitly selected instruction file */,
    skillFiles: /* expose prepared skill/reference paths through app tools */,
    approvedMemory: /* select approved memory explicitly */,
    task,
  });
  await retainResult(result, { versionId: bundle.version.id, digest: bundle.version.digest });
} finally {
  await prepared.cleanup();
}
```

The final shipped recipe must contain runnable fixture functions and a clearly marked replacement point for the application's existing function. It must not give the impression the SDK implements `runExistingAgent` or a native memory option. Native variants use their public plugin imports and the repository-composition recipe chosen by that lane, retain outputs before cleanup, and await the actual session. Existing-session reload remains app-owned and separately documented.

End with a link **“Compare a change using this app”** that navigates to the existing saved-draft/evaluation journey. It preserves workspace/bundle/channel selection but does not make a candidate, run a model, or create a request.

## Define the first evaluator locally

The installed-app starter supplies one application-owned entrypoint. Its commands are ordinary local application code; service data never selects a script/module/adapter to load. Illustrative names, to be bound to the chosen evaluator module:

```sh
node acclimate-eval.mjs describe
node acclimate-eval.mjs check --config /absolute/private/evaluator.json --project PROJECT --bundle BUNDLE
node acclimate-eval.mjs run --config /absolute/private/evaluator.json --request ./evaluation-request.json
```

The Python starter uses `python acclimate_eval.py` with equivalent meanings when the Python design reaches that capability. `describe` emits only the public descriptor and no task contents, expected answers, credentials, private paths, or callback locators. The entrypoint imports an app-local definition selected by its author, not by the handoff or command-line module path.

`check` validates configuration structure, local runtime prerequisites and private-directory policy, then exercises safe authenticated reads against the explicitly configured service/project/bundle. It never executes or grades a case, starts an attempt, submits a report, or invokes a model. Permission/liveness results are observations at check time, not locks or future guarantees. Any local filesystem probe must be described precisely by the evaluator lane; it must not leave an attempt journal or claim a future write is guaranteed.

**Write-authorization rule:** successful metadata reads alone do not establish evaluator write authority. The platform lane proposes `GET /v1/projects/{p}/evaluation-capabilities`, machine-principal/read-authorized, returning `schemaVersion`, `projectId`, `principalId`, `checkedAt`, `readUnpublished`, and `writeEvaluation` derived from current authorization. That supports **“Evaluator authority checked at TIME”**, separate from runtime or provider readiness. If the endpoint is unsupported on an older service, report **“Read access checked; evaluator write authority is unverified. Ask your operator to confirm access or upgrade the service.”** Do not fake a mutation, issue a token, or start-and-interrupt an evaluation merely to test permissions. The coordinator owns the final capability envelope; onboarding must consume that shared contract rather than fork it.

## Eval configuration and request creation

### Before a request exists

Replace the current initial `payment-retry` state with an empty explicit choice. Choices:

- **Use my app's evaluator** — primary path. Instruction: **“Run your app's describe command, then paste its public configuration.”** Link to the installed-app starter with current language/runtime selection.
- **Try an included example** — secondary disclosure, with simulator/file-presence/native-review descriptions and their prerequisites. No example is selected automatically.

After a valid descriptor is pasted, render a compact summary: app config ID/revision, dataset revision, grader revision, runtime label/model if deliberately public, unique task count, repetition-pair count. Keep an expandable JSON view. All rendering escapes app strings. Any future metric semantics belong to the evaluator contract, not a console heuristic.

Show a prerequisite block before **Create evaluation request**: installed app starter, explicit evaluator credential, private durable journal, matching public descriptor, and optional model authorization in the app. This is instruction, not a required checkbox claiming success. A developer with existing working setup can create the request without replaying the setup guide.

The action is enabled only when there is an explicit evaluator choice, structurally valid configuration, a saved candidate based on the current channel parent, current editing permission, and no pending/related blocked mutation. Remove the server's `input.configuration ?? localEvaluationDescriptor` fallback: omitted configuration is a safe validation error on new authoring. A syntactically valid custom descriptor proves neither availability nor runtime access.

For known examples, verify inexpensive content prerequisites against the already-loaded candidate payload and show a contextual warning. For payment-retry, missing `payment-policy.json` blocks that example's request action with **“This example needs payment-policy.json. Choose your app's evaluator to measure instruction changes.”** This is example-specific validation, not a general claim to inspect custom adapter requirements.

### Draft and version identity

Compare only a saved draft generation or proposal candidate with immutable version ID/digest; unsaved text must be saved first. Display **“Evaluating saved generation G”** when the draft route supplies a generation. The request binds the saved candidate and parent; later draft edits create other snapshots and cannot rewrite that request.

Keep current parentage/channel-revision checks in server preparation and preserve the pending operation's exact command body and key. If the channel changes before creation, show **“The channel changed. Refresh the base before creating this request.”** Do not automatically rebase, replace the descriptor, or attach a recovered result to a different candidate.

## Run and review handoff

Reuse the existing public schemaVersion 1 envelope exactly:

```json
{
  "schemaVersion": 1,
  "serviceUrl": "https://api.example.com",
  "projectId": "PROJECT",
  "bundleId": "BUNDLE",
  "requestId": "REQUEST_UUID",
  "configuration": {
    "datasetRevision": "app-cases-v1",
    "graderRevision": "app-grader-v1",
    "runtime": { "configId": "my-app", "configRevision": "1" },
    "expectedCases": [{ "caseId": "saved-task-1", "repetition": 0 }]
  }
}
```

The console offers **Download request JSON** and **Copy request JSON** plus the generic app-owned run command. The copied shell command contains only fixed text, a placeholder private config path, and a fixed request-file basename; it never interpolates arbitrary runtime strings, IDs into code, or caller-controlled executable paths. The app validates closed envelope shape, URL policy and selected service/project/bundle, fetches the service request and compares the descriptor/versions through the evaluator module. A handoff is not authority and never overrides the explicit private configuration.

Keep public API URL, request ID, frozen descriptor, immutable version identities, and timestamps visible in request details. Replace **“Ready to run in your app”** with **“Request created · run in your app”** so existence is not mistaken for installed readiness.

Request states:

| State | Primary copy | Action |
| --- | --- | --- |
| requested | Request created; your app has not reported starting | Copy/download handoff; run locally |
| running | App reported execution started | Show activity observations if supported; otherwise state progress unknown and link diagnostic instructions |
| completed | Paired evidence recorded | Inspect cases, coverage, reward, and app policy result separately |
| failed | App reported incomplete/failed evidence | Inspect retained outcomes and the safe diagnostic code |
| interrupted | Interruption recorded | Explain this does not stop an external job; inspect app before starting another request |

Completed is not a passed quality policy. A policy pass is not release authorization. Keep deliberate release and existing revision checks. Missing shared artifact availability must appear as unavailable/unknown, not empty output or a successful trace check.

## Validation and storage rules

- Keep current descriptor bounds: nonempty bounded dataset/grader revisions; 1–64 bounded public runtime entries including configId/configRevision; 1–1000 unique case/repetition pairs; bounded case IDs and nonnegative integer repetition. Normalize key order only for structural comparison, not to rewrite an already frozen legacy request.
- Use one browser-safe descriptor validator from the selected evaluator/contracts module; the console must not import filesystem/lock runner code through a barrel export. Remove production console imports from `examples/` as part of packaging.
- Do not paste private evaluator configuration into the console. Reject obvious private-config envelope fields through the closed descriptor shape and display a fixed safe error without echoing their values. Runtime values remain explicitly public by contract; heuristic secret detection cannot guarantee sanitization.
- Keep form contents ephemeral to the mounted workflow, scoped by actor/service/workspace/bundle. Successful request creation may remember the matching public descriptor in current workflow state; do not introduce localStorage persistence for arbitrary descriptor values in this phase. Preserve form-versus-recovered-request mismatch behavior.
- Pending operations remain actor/service/selection scoped and use exact frozen command bodies. Changing evaluator choice while a command is pending does not modify it; recover or close the original operation using existing controls before another command.
- Do not store or upload local preflight output in a way that implies a server attestation. If a future product stores observations, include observer/time/identity provenance explicitly.

## File-level implementation scope

1. `README.md`: route adopter, offline trial, operator, and contributor tasks. Keep qualification limits available through links.
2. New `docs/getting-started.md`: one installed-release walkthrough with a deterministic task followed by the real app replacement seam; source-build is an appendix.
3. `docs/development.md`, `python/README.md`, `examples/native-integration.md`: link canonical adopter/recipe instructions; distinguish synchronous Python behavior and native qualification limits.
4. `apps/console/src/components/sdk-setup.tsx` and `sdk-setup-recipes.ts`: visible connect-agent step, runtime-aware installed imports, exact prereqs, plain Node execution or explicitly installed tooling, early evaluator capability summary.
5. `apps/console/src/lib/evaluation-config.ts`: import browser-safe public contract, model explicit empty/custom/example choice, shared validation, safe handoff formatting, download filename; retain historical handoff reading.
6. `apps/console/src/components/improvement-workspace.tsx`: explicit selection, concise descriptor summary, early prerequisites, example-specific checks, request state copy, handoff download and existing operation guards.
7. `apps/console/src/server/improvement.ts`: require explicit new-request configuration; preserve verified candidate/parent/revision logic and exact durable command preparation.
8. Packaging lane: release manifest and installed-app starters are dependencies, not a second independent onboarding implementation. No new settings/registry or hosted artifact endpoint in this lane.
9. Tests: extend `sdk-setup.test.ts`, `sdk-setup-recipes.test.ts`, `evaluation-config.test.ts`, `improvement.test.ts`, `improvement-recovery.test.ts`; use existing user-flow/focus fixtures for real behavior. Add clean installed-consumer acceptance to packaging checks rather than tests that mirror rendered strings alone.

## Acceptance scenarios

1. An existing-workspace adopter starts at README, obtains the documented release, installs in an empty external app, executes delivery, and finds the real-agent replacement seam without deployment instructions or repository-relative imports.
2. The shipped deterministic starter describes one task, creates a matching request through the console, consumes its JSON handoff with public imports, records parent/candidate evidence, and reaches case inspection. No paid call runs by default.
3. Switching to the app's actual execution callback retains the same task/grade/lifecycle interface; the documentation marks where provider credentials, authorization, tool policy, and native preparation lifetime are owned.
4. Untouched evaluation setup cannot create a payment eval. Explicitly choosing payment-retry without the required policy file explains the prerequisite before request creation. A valid custom descriptor remains allowed without arbitrary custom-content heuristics.
5. A delivery-only credential can complete delivery; eval instructions already explain why a separate evaluator identity is needed. Preflight read success alone never renders “write access verified.”
6. A fresh or stale channel/candidate combination takes the correct current-base/stale-base path. Saving another draft generation leaves the existing request frozen to its prior candidate.
7. Lost request-creation responses recover the original pending operation and exact descriptor. Editing another form during recovery does not retarget or overwrite the recovered request.
8. A descriptor with unknown private-config fields fails safely without echoed values. A downloaded handoff contains only approved public fields and no credential/private path. A handoff selecting another service/project is rejected locally before callbacks.
9. UI distinguishes request creation, app start observation, complete evidence, quality-policy result, and deliberate release. Stale or absent activity never authorizes replay, and interruption never claims to stop external execution.
10. Legacy requests missing configId/configRevision still render their original frozen descriptor and historical handoff. New authored requests require the current contract. Existing known example setup commands remain available only in the examples disclosure.
11. A simulated offline comparison is clearly labeled and needs no runtime credentials. Its output cannot be submitted/promoted as an actual app run by the default trial command.
12. The user can complete the critical path with keyboard navigation, labelled controls, predictable focus after create/recovery, no required hover disclosure, and a narrow viewport. Browser verification is an implementation acceptance task, not performed in this design work.

## Alternatives and tradeoffs

- **Persistent setup wizard:** rejected for this phase. It introduces stored progress that cannot attest a developer's local runtime and adds navigation/state without joining the actual seams.
- **Console executes or discovers local adapters:** rejected. It would change execution ownership and require a new remote execution system.
- **Require pasted “preflight success” receipts:** rejected. Without authenticated observation provenance they imply a guarantee, and they add work for already-configured users.
- **Default custom JSON seeded from a sample:** rejected. It can silently claim inventory/configuration the app does not implement. An explicit example is acceptable.
- **Publish everything to a registry immediately:** unnecessary to fix onboarding. Exact obtainable release artifacts and matching instructions suffice; registry publication can be a later distribution choice.
- **One custom app recipe only:** cheap, but insufficient for native repository users. Provide a small supported runtime selector with shared generation and explicit qualification limits rather than many disconnected samples.

## Migration and unresolved integration decisions

No service schema migration is required for this onboarding proposal. New request authoring becomes stricter by removing the implicit default, while old requests, pending exact command bodies, descriptors and setup commands remain readable/recoverable. The implementation must not reinterpret a recovered legacy request as the currently selected form.

The coordinator must freeze these cross-lane choices before implementation:

1. Names and exported locations for app definition, descriptor generation, preflight and run commands; this document's command examples are illustrative local starter conventions.
2. Final capability endpoint shape and unsupported-service classification, aligned with the platform proposal; the agreed fallback must remain write-unverified rather than “ready.”
3. Canonical release artifact manifest location and how console instructions obtain version metadata without inventing local availability or a hosting service.
4. Python orchestration capability in the first shipped milestone; do not advertise parity before its installed-consumer acceptance passes.
5. Native repository composition/cleanup recipe and approved-memory selection rules.
6. Whether progress observations and shareable artifacts are in this release or documented follow-ups; absent features must still have honest copy and actionable local diagnostics.

These are integration decisions, not permission requests to the user. The root council should choose one coherent interface and update the final plan accordingly.
