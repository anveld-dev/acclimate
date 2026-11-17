# Native repository integration proposal

Design proposal, 2026-11-16. Source-based design only; no provider session or runtime qualification was performed.

## Recommendation

Ship an installed-app **repository task recipe** using the existing native preparation interface. Do not add a general repository overlay or destination option to the plugins in this release. The app calls `prepare(bundle)`, copies an explicitly approved source-file inventory into the resulting owned workspace without overwriting anything, starts its native harness there, retains declared results outside the workspace, and cleans up only after the harness and its child work have stopped.

This is a real coding-task path: it reads and modifies selected source from an existing repository, rather than evaluating a pasted diff in a resource-only directory. The first recipe snapshots a clean, immutable app-selected source revision. It does not promise that every repository, submodule, symlink layout, dirty worktree, dependency setup, or native configuration can be composed automatically.

The seam remains the native plugin's prepared bundle. The recipe's local source-snapshot and result-collection helpers are application code shipped in the starter, not public SDK interfaces. That gives a common caller working integration while keeping filesystem/project policy with the application. The evaluator module invokes this same application executor for parent and candidate.

## Current-source anchors

- `packages/sdk/src/internal/native-files.ts:52`: native preparation creates its own temporary root; `:99` recursively removes it on cleanup.
- `packages/codex-plugin/src/index.ts:15`, `packages/claude-plugin/src/index.ts:18`, `packages/pi-plugin/src/index.ts:22`: preparation accepts a verified bundle and returns native resource locations and lifetime.
- `packages/cursor-plugin/src/index.ts:18`: Cursor additionally accepts explicit approved memory selection, defaulting to none.
- `packages/sdk/src/prepare.ts:51`: generic preparation accepts an app-owned destination but does not map native paths; only collision error is supported.
- `packages/claude-plugin/src/native.ts:4`, `packages/cursor-plugin/src/native.ts:5`, `packages/pi-plugin/src/native.ts:7`: existing optional native entry points supply actual SDK fields/loader behavior.
- `examples/native-integration.md:9`: current Codex recipe changes the session working directory to prepared content; source composition is not shown.
- `packages/pi-plugin/src/native.ts:33`: Pi deliberately disables implicit discovery and uses explicitly supplied resource locations.
- `packages/codex-plugin/QUALIFICATION.md`: dated live marker observations exist for Codex, with narrow claims.
- `packages/cursor-plugin/README.md`: Cursor's staging/type checks do not establish live discovery, invocation, or resumed reload.

## Concrete application recipe

The following is a design sketch of the starter's application module, not a claim that the three local helper functions already exist:

```ts
import { prepare } from '@acclimate/codex-plugin';
import type { VerifiedBundle } from '@acclimate/sdk';
import {
  stageSourceInventory,
  retainDeclaredResults,
  runMyCodingAgentUntilStopped,
} from './repository-task-support.js';

export async function executeRepositoryTask(bundle: VerifiedBundle, task: SavedTask) {
  const prepared = await prepare(bundle);
  let safeToCleanup = true;
  try {
    const baseline = await stageSourceInventory({
      sourceRoot: task.localSourceRoot, // installed application configuration, never request data
      sourceRevision: task.sourceRevision,
      inventory: task.sourceFiles,     // saved task data: explicit portable relative file paths
      destination: prepared.cwd,
    });
    safeToCleanup = false;             // a rejected callback is not proof of termination
    const run = await runMyCodingAgentUntilStopped({
      cwd: prepared.cwd,
      instructionPath: prepared.instructionPath,
      skillPaths: prepared.skillPaths,
      selectedMemory: [],              // explicit policy: no memory in first fixture
      task: task.prompt,
      // Existing application supplies SDK/auth/model/tools/permissions/budgets.
    });
    if (!run.stopped) throw new Error('native.execution_uncertain');
    safeToCleanup = true;
    const artifacts = await retainDeclaredResults({
      workspace: prepared.cwd,
      baseline,
      allowedResults: task.resultFiles,
      artifactRoot: task.privateArtifactRoot, // outside prepared.cwd, no request-controlled path
      versionId: bundle.version.id,
      digest: bundle.version.digest,
      contextPolicyRevision: 'repository-task-v1-no-memory',
    });
    return { output: { run: run.gradeableResult, artifacts }, outputRef: artifacts.manifestRef };
  } finally {
    if (safeToCleanup) await prepared.cleanup();
    // Otherwise retain privately for explicit termination/cleanup by the app operator.
  }
}
```

The actual starter must include the support implementation and a deterministic fake harness; it may not leave those helpers as unexplained exercises. Integrating an existing native agent replaces only `runMyCodingAgentUntilStopped`. The console links to this installed-package example and does not create, launch, or choose a source snapshot itself.

## Source ownership and snapshot rules

1. The source root is an explicit local application setting. Public evaluation requests cannot introduce a filesystem path, repository URL, Git ref, executable, or install command. Saved tasks are installed/trusted application data; private task contents remain there.
2. The first recipe consumes an application-supplied immutable/quiescent checkout and declared revision. It records a manifest of the actual source paths, byte digests, sizes, and executable bits. The declared revision is descriptive; actual bytes are what bind the task. Both sides use the same frozen source manifest.
3. Source inventory is a bounded explicit list, not recursive `cp` with guessed secret exclusions. Default starter limit: 1,000 regular files, 1 MiB per file, 16 MiB total source bytes, portable relative paths using the SDK's existing segment rules. These source limits are recipe limits, distinct from bundle limits. Apps with larger tasks must deliberately revise their recipe identity and limits.
4. Reject absolute paths, traversal, duplicate/case-colliding paths, file/directory prefix collisions, symlink roots/ancestors/files, sockets, devices, FIFOs, and Git submodule entries. Use `lstat` plus exclusive/no-follow reads/writes where available. The source checkout must not be concurrently modified by another process; this recipe is not a hostile same-user filesystem sandbox.
5. Reject every `.git` path segment. Do not copy repository Git metadata, hooks, remotes, credential files, dependency trees, or build artifacts implicitly. The first fixture has an explicit reviewed file inventory. If a production app needs additional native configuration or dependencies, it owns that preparation and includes its policy revision in runtime identity; the starter does not run package lifecycle scripts automatically.
6. Create destination files exclusively and fail on any existing destination. If source preparation fails, do not invoke the harness; remove the owned workspace through normal plugin cleanup. Never delete or replace the original source files.
7. No source path may overlap or prefix-conflict with staged bundle resources. A shipped per-harness control-path table rejects native instruction/configuration locations such as any `AGENTS.md`/`CLAUDE.md` basename and any `.agents`, `.claude`, `.cursor`, or `.pi` path segment, plus the harness's supported project hook/MCP configuration names. These checks apply at every inventory depth, not just root. The table also reserves every mapped bundle resource path and its ancestors/descendants, so native input files cannot be replaced or shadowed by source. This is an explicit **bundle-only native guidance policy** for the first recipe, not silent merging of the original repository's guidance.
8. If an app needs existing repository guidance, it must deliberately incorporate reviewed guidance into its bundle or own a separate composition policy and version it. The first release does not synthesize instruction text or guess precedence. Nested native guidance is also excluded by the starter policy, rather than accidentally overriding the selected bundle during repository traversal.

## Instruction, skills, and memory contract

The prepared bundle is pinned for the complete job. Refresh prepares a new workspace for a fresh native session; neither application execution nor evaluation silently modifies an active/resumed session.

The first repository fixture uses one instruction, one named skill, and no memory. A second deterministic fixture explicitly selects one of two approved memory paths. Application code computes a sorted selected-memory set, rejects unknown or duplicate paths, and records `contextPolicyRevision` plus a selected-memory-set digest in evaluator runtime identity. These identities describe the context the app arranged; they are not proof of consumption.

- **Codex/Claude:** existing plugins stage memory files, but application context selects which files are exposed. Listing selected files in the prompt does not enforce filesystem access to unselected staged memory. If exclusion is required, the recipe deletes unselected memory files only inside its disposable prepared workspace before native execution. Record this filtering policy. Do not present staged memory as a native SDK `memory` option.
- **Pi:** pass the approved source-path list to `createPiResourceLoader`; keep its explicit loader configuration. For filesystem exclusion, apply the same disposable-workspace pruning policy before the loader runs.
- **Cursor:** pass `approvedMemoryPaths` to `prepare`, then supply only those returned resources in application context. It already stages only approved memory.

This recipe makes all four harnesses follow the same explicit memory choice without changing their existing default preparation behavior. The library's version digest remains the original verified bundle digest; the application separately records its effective context selection. It must not describe a filtered file tree as byte-identical to the entire bundle.

## Results, cleanup, and cancellation

`resultFiles` is a bounded installed-task allowlist. Default starter limit: 100 result files, 1 MiB per file and 8 MiB total, portable relative regular files only. Exclude native staged resource paths and harness-private directories. Never archive the whole workspace or journal. Results may contain application data and are private unless the app explicitly shares them through the council's evidence-export design.

The collector opens only declared result paths without following symlinks and verifies ancestors still resolve inside the owned workspace. It records before/after hashes, explicit deletions, task identity, source-manifest digest, bundle version/digest, harness/runtime identity, and context policy. It copies reviewed result bytes into a separate owner-only artifact directory using exclusive atomic writes. It returns a reference/manifest consumed by the app's grader and artifact-export path. The recipe includes a unified patch for its small text fixture, generated from the retained before/after text via a pinned local helper. Binary/large/general repository patching is outside that first recipe.

Artifact root must be outside `prepared.cwd`; reject overlapping destinations. A failed export is an explicit artifact/infra failure, not success with an already-deleted output. The caller may retain selected diagnostics privately after failure, but this is a deliberate retention choice, not unrestricted workspace upload.

The application owns provider cancellation, child-process shutdown, and tool permissions. An abort signal is a request to stop, not proof of stopped execution. `runMyCodingAgentUntilStopped` returns an explicit `stopped` result; success requires its native work/owned child processes to have stopped. If termination cannot be confirmed, the app marks execution uncertain, keeps the private workspace quarantined, returns no success, and avoids cleanup/reuse until an operator confirms termination. A rejection without a trustworthy confirmed-stop result is also treated conservatively as uncertain. Do not use `Promise.race` with a timeout followed by unconditional cleanup.

Normal cleanup remains idempotent and recursively removes only the plugin-owned root. It never removes the source checkout or retained artifacts. There is no automatic copy-back, commit, push, promotion, or application to the original repository.

## Harness support and qualification

One canonical guide covers installed SDK/plugin artifacts, optional peers, native session creation fields, explicit memory selection, and the lifetime above for all four harnesses. The guide links an evidence ledger with separate rows for staging, option/loader type compatibility, fresh resource retrieval, explicit skill invocation, behavioral evaluation, resumed sessions, and in-place reload. Unknown/unrun stays explicit.

Current Codex live marker observations remain dated observations for their actual SDK/model and resource-only fixtures. They do not qualify the new repository recipe. Existing Claude/Pi/Cursor offline checks remain offline checks. Every new starter path gets deterministic fake-harness coverage first. Optional real-harness tests require explicit model-call opt-in and are recorded independently, with the project's current Luna-only development qualification policy preserved where applicable. An application's runtime model choice remains its own.

## Alternatives rejected

- **New native `destination` overlay option:** creates ambiguous ownership and cleanup in existing repositories, plus instruction and skill conflict policies across four plugins. It is unnecessary for the first representative task; defer until two real applications need the same destination semantics.
- **Copy an entire working tree into `prepared.cwd`:** implicitly includes credentials, symlinks, hook/MCP settings and colliding guidance. An explicit source inventory is a better first supported contract.
- **Git worktree/clone managed by the SDK:** introduces Git lifecycle, locks, hooks/submodules, network/auth, and mutation ownership to a content preparation module. An app may manage its own disposable checkout, but it is not the native SDK's job.
- **Merge existing and bundle instruction text:** hides precedence and changes effective content without a clear authoring decision. First recipe rejects overlapping guidance and records bundle-only policy.
- **Standardize all memory plugin defaults now:** potentially changes exposure for existing callers. A common application policy and conformance fixtures provide alignment without that breaking change.

## File-level implementation and migration

- Update `examples/native-integration.md` into the canonical installed-package guide, adding Cursor and links to per-harness evidence.
- Add an external-consumer repository starter with complete source inventory, support helpers, fixture repository, fake executor, harness-specific adapters, and result manifest/patch fixture. Package it as a release example artifact alongside exact SDK/plugin tarballs and compatible peer versions; it is application code rather than an SDK export.
- Add native recipe choices/links to `apps/console/src/components/sdk-setup.tsx` and the onboarding lane's generated-recipe source. Do not inline complex repository support code into the console.
- Extend `scripts/packaging/verify.mjs` to extract the starter into a clean external consumer, install only documented local release artifacts and pinned dependencies, and run the model-free source→native preparation→fake task→retention→cleanup scenario.
- Add a cross-harness deterministic memory/metadata/lifetime fixture to native package tests or the external-consumer harness. Do not claim fake consumption proves model discovery.
- No service schema/migration or public plugin signature change is required. Existing `prepare`, `prepareFiles`, native helpers and cleanup semantics stay compatible.

## Acceptance gates

1. A clean external consumer installs only documented release artifacts and runs a repository task that reads selected source and changes a retry implementation. The fake harness sees the same declared source bytes for parent and candidate, the appropriate mapped instructions/skill, the selected memory only, and the app-supplied runtime identity.
2. A retained patch/result survives workspace cleanup, matches its manifest hashes and bundle/source/task binding, and can be reviewed without the original worker. The original source tree's bytes and metadata remain unchanged.
3. Colliding root/nested guidance, source/bundle conflicts, case collisions, traversal, symlinks (source and agent-created outputs), nonregular files, exceeded limits, overlapping artifact roots and exclusive-create races fail before unsafe copying or export. No original repository files are changed.
4. Cancellation before start cleans up without executing. Confirmed termination after start retains declared partial diagnostics only and cleans safely. Unconfirmed termination retains/quarantines the workspace, never claims safe stopped execution, and never blindly reuses it.
5. Every native harness has installed imports/type/loader tests against its declared peer and the same memory-policy fixture. Live consumption/quality remains separately opt-in and never inferred from these tests.
6. A developer can find the repository recipe, exact packages, guidance policy, prerequisites and evidence limits from App setup without searching source or importing repository-private implementation.

## Integration decisions for the coordinator

- Adopt the recipe-first approach and keep public native signatures stable in this release.
- The evaluator's case identity must bind the frozen source-manifest digest and runtime context-policy/selected-memory identity; it must not permit request-provided local paths.
- Choose one common artifact manifest vocabulary with the CI/evidence lane; native result collection should be an input to that exporter rather than a parallel sharing protocol.
- Distinguish executor errors with confirmed termination from uncertain execution; runner cancellation cannot assume a callback rejection means the underlying harness stopped.
- The brief's primary acceptance includes an installed existing-repository recipe; support for arbitrary whole-worktree composition, mutable source snapshots, native destination overlays, and automatic instruction merging is explicitly deferred.
