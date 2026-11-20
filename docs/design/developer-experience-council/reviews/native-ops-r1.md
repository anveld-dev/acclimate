# Independent native integration and worker lifecycle review

Disposition: **BLOCKED** on two material design gaps.

Reviewed normative PLAN.md revision D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`. This is source/design review only. No implementation, native process, provider, deployment, or runtime qualification was exercised.

## Scope and current-source evidence

Reviewed plan sections 3–6 and 11–15 against the actual native plugins, shared preparation, native helpers, application examples, and deployment runbook.

- `packages/sdk/src/native-files.ts:52` chooses an unrecorded random temporary workspace; `:99–102` recursively deletes that owned workspace.
- `packages/codex-plugin/src/index.ts:19–21`, `packages/claude-plugin/src/index.ts:22–24`, and `packages/pi-plugin/src/index.ts:26–28` stage resources in harness paths and `.acclimate/memory`.
- `packages/pi-plugin/src/native.ts:29–41` additionally uses `.acclimate/pi-agent`, disables ambient loader sources, and explicitly selects memory paths.
- `packages/cursor-plugin/src/index.ts:23–38` filters memory before staging, unlike the other plugin defaults.
- `packages/codex-plugin/src/index.ts:30–32`, `packages/claude-plugin/src/index.ts:35–36`, and `packages/pi-plugin/src/index.ts:43–45` return memory text/resource metadata that can retain unselected content independently of on-disk pruning.
- `examples/codex-agent.ts:43–65` starts a native run in prepared.cwd and uses a timeout signal; `:91–94` cleans up in finally. The new design correctly refuses to treat these historical patterns as sufficient confirmed-stop evidence.
- `deploy/README.md:40–50` defines one control-plane process, coordinated restart, readiness limitations and retained identities. The proposed fixed-root worker and same-principal token-overlap model fit those constraints.

## Blocking objections

### NO-1 — Uncertain native jobs lack a durable locator and execution binding

**Plan locations:** D1 lines 55–62, 96, 195, 293–295, 351–359; acceptance G08/G14/G18.

The plan requires a native workspace to be quarantined after uncertain termination and inspected before replacement work. However, prepared.cwd is created inside the app callback, while the runner's described artifact index records saved outputs/explanations. An uncertain callback returns no output; a forced process loss returns nothing at all. No contract durably registers the random workspace and external job before launch, or links it to the request/attempt/case/repetition/version. The execution callback also receives no request/attempt binding from which to create that record without rediscovering CLI state.

**Failure scenario:** the plugin creates `/private/tmp/acclimate-codex-RANDOM`; the app launches a native worker; the evaluator dies before the callback returns. The runner correctly retains its execution marker and refuses replay. Nevertheless, its journal contains no locator for that worker's prepared inputs or any external job handle. The operator cannot follow the promised quarantine/inspection workflow from the request, and ordinary temporary-directory cleanup can remove inputs of a still-running job.

**Minimum remedy:** define a private native job record, written and fsynced outside prepared.cwd before native launch, containing a generated job ID, read-only evaluation binding, case/repetition/version and source/context identities, the canonical owned workspace path, and monotonic prepared/launch-intent/confirmed-stopped/results-retained/cleaned facts. Persist an external job handle when available, without treating missing acknowledgment as proof no launch occurred. Make the execution binding available through a narrowly scoped callback context or module-owned registration helper; the app must not reconstruct attempt ownership. Specify who reads the private record for recovery and who may remove quarantined files only after termination is established. Never include private paths in public diagnostic output.

**Acceptance:** inject process loss after launch intent, after provider acceptance, during result retention, and after confirmed termination. From the original private request state, the operator can locate each recorded workspace/job, distinguish unknown termination from confirmed stop, and avoid cleanup/replay of a potentially live job. Confirmed-stopped jobs can retain outputs and clean safely; unacknowledged launch is conservative unknown. These checks use fake owned processes first and do not assert model termination from a timeout.

### NO-2 — The bundle-only control-path and memory policy is not closed

**Plan locations:** D1 lines 353–357 and G14.

The plan rejects native staged-file collisions and several control paths, but does not reserve the entire `.acclimate` root used by all plugins for memory and by Pi for private agent state. A source path can be non-colliding with the currently staged files while still introducing content into a native-owned/internal tree. The phrase “documented per-harness hook/MCP controls” also leaves the normative control policy to an unstated future table. A plan claiming bundle-only guidance needs a closed, versioned inventory rule rather than open-ended names implementers must discover.

Deleting unselected memory files alone also leaves their text in prepared.memoryFiles and Pi resource descriptors. Existing app examples commonly derive prompts from these returned objects. The recipe needs an explicit filtered context object as well as filesystem pruning to avoid teaching a misleading selected-memory contract.

**Failure scenario:** an inventory includes `.acclimate/memory/extra.md` or `.acclimate/pi-agent/...` that does not overlap an already prepared resource. It passes the listed path exclusions and may become visible inside the owned native context. Separately, a Codex/Claude adapter receives prepared.memoryFiles after pruning and inadvertently supplies an unselected file's retained `text` to the model. The source bytes and selected-memory digest then fail to describe the effective context the recipe arranged.

**Minimum remedy:** freeze a versioned, case-insensitive starter control-path policy that reserves all generated/internal roots, including `.acclimate`, and either provides the literal supported harness-control table or conservatively excludes dot-prefixed source path segments by default with separately reviewed exceptions. Apply it before copying and before startup; reserve staged resource ancestors/descendants. Derive an immutable effective-context view containing only approved memory/resource entries after pruning; pass that view to the harness adapter. The original VerifiedBundle may remain app-owned, but must not be presented as the selected harness context. Include the control-policy version in contextPolicyRevision.

**Acceptance:** across fake harnesses, root/nested/case-variant internal/control paths are rejected before launch; non-colliding `.acclimate` additions cannot enter the job; unselected memory is absent from the effective file tree, adapter metadata, Pi resources and prompt inputs. Selected resources still load, and the original source/prepared-plugin compatibility behavior remains unchanged outside this recipe.

## Nonblocking advice

1. Explicitly scope the first unified-patch fixture to bounded UTF-8 text and declared additions/modifications/deletions; binary/general repository diff support should remain an app-owned extension rather than an implied universal patch engine.
2. Describe same-path restore as requiring one physical authoritative storage instance and confirmed original-worker termination. Restoring a copy into a second filesystem with the same pathname does not share a kernel lock; existing “no distributed execution/network filesystem” language is a good starting limit.
3. Keep each harness's import/option/loader/fake-resource checks separate from live job termination/consumption evidence. G14's fake tests cannot establish that a real SDK's error or disposal primitive guarantees quiescence.

## Positive assessment

The recipe-first choice preserves current plugin ownership and avoids risky destination overlays. Explicit source inventories, no original-repository mutation, independent source/context identity, result extraction before cleanup, no implicit package lifecycle scripts, read-versus-consumption distinctions, and conservative ExecutionUncertainError behavior are appropriate. Fixed local durable volumes and same-principal overlap rotation are coherent with the current service. I can approve after NO-1 and NO-2 are resolved in the normative final revision with corresponding gates.
