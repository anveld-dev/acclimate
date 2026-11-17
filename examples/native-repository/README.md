# Existing-repository native starter

This complete application-owned starter combines a frozen source inventory with a pinned bundle in the private workspace created by an installed native plugin. It retains a text patch before cleanup. The runnable task uses a deterministic fake harness; it verifies wiring and resource/lifetime rules, not model quality or real SDK termination.

Install the matching `@acclimate/sdk` and selected plugin tarballs from one release. Node 22.22+ and POSIX are required. No TypeScript runner, provider credentials or paid calls are needed for the fixture. Run from the extracted starter directory, choosing a new absolute directory beneath an existing canonical parent:

```sh
node demo.mjs --state-root /absolute/private/new-native-run --harness codex
```

`claude`, `pi` and `cursor` use the same command. The fixture imports only public installed SDK/plugin entry points. It runs `node --test` on a tiny disposable source checkout, changes retry identity to remain request-scoped, retains `artifacts/<jobId>/result.patch`, and emits:

```json
{"harness":"codex","sourceManifestSha256":"...","retainedPatch":true,"cleaned":true,"evidence":"deterministic-wiring-only"}
```

The demo creates owner-only `workspaces`, `jobs` and `artifacts` directories, then starts its dedicated worker with OS `TMPDIR` set to the persistent `workspaces` parent. The helper refuses an implicit system-temp fallback. Reusing a demo state directory is rejected; retained output is never overwritten. For production, configure the dedicated worker's TMPDIR at launch to a fixed canonical private local volume outside automatic temp cleanup, and preserve that physical volume across worker restarts.

## Attach your existing agent

`repository-job.mjs` exports `freezeSourceInventory`, `runRepositoryJob`, `inspectNativeJob` and `cleanupQuarantinedJob`. `worker.mjs` is a complete runnable example. In an evaluator callback, pass the runner-provided `context`, `caseId`, `repetition` and verified `bundle` into the helper:

```js
execute: async ({ bundle, context, caseId, repetition, signal }) =>
  runRepositoryJob({
    bundle, context, caseId, repetition, signal,
    source: frozenSource, harness: installed.name, prepare: installed.prepare,
    workspaceParent, artifactRoot,
    selectedMemoryPaths: ['memory/approved.md'],
    resultFiles: ['src/retry.js'],
    runHarness: async ({ context: effective, signal, acknowledge }) => {
      const job = await startMyExistingAgent({ cwd: effective.cwd, signal,
        instructionPath: effective.instructionPath, skillPaths: effective.skillPaths,
        approvedMemory: effective.memoryFiles });
      await acknowledge({ kind: 'app-job', value: job.id });
      const result = await job.waitUntilStopped();
      return { stopped: result.confirmedStopped, output: result.gradeableOutput };
    },
  })
```

The last callback is the marked application seam; `startMyExistingAgent` is your installed application function, not an Acclimate helper. Your adapter owns SDK authentication, permissions, budgets, tools and actual process/provider shutdown. `harnesses.mjs` contains a closed installed-plugin allowlist and `freshSessionInputs` showing the supported native option/loader helpers. Its `memoryFiles` are application context, not an invented native SDK `memory` option. Pi's loader and native option tests require the corresponding declared optional peers; the ordinary fake fixture does not.

`runHarness` must return `stopped:true` only after its external work is quiescent. Returning false or rejecting conservatively throws the SDK's `ExecutionUncertainError`, leaves the native workspace quarantined, and lets the evaluator retain its ambiguous execution marker. An abort signal, timeout, missing handle or rejected SDK await is never treated as proof a job stopped. Do not race a timeout against a run and unconditionally clean up.

## Frozen source and context policy

Call `freezeSourceInventory` once before defining/requesting an evaluation, then reuse that same captured snapshot for parent and candidate. Its source manifest hashes actual bytes, sizes and source mode bits. Include its digest, context policy revision and selected-memory digest in your declared dataset/runtime revision convention before `describe`. Revision strings are app assertions; the helper does not create a new server hashing protocol.

`repository-source-policy-v1` accepts only an explicit list of regular portable paths. It rejects every dot-prefixed segment, `AGENTS.md`/`CLAUDE.md` at every depth and case variant, symlinks, device/socket/FIFO files, traversal, case/prefix collisions and existing native-file collisions. It copies no `.git`, `.env`, hooks, MCP settings, implicit dependencies or build outputs. Existing repository guidance must be deliberately reviewed into the bundle or handled by a separately versioned app recipe. The small text recipe does not sandbox ambient user/host SDK settings; record those application policies separately.

Limits are 1,000 source files, 1 MiB each/16 MiB total; 100 declared result files, 1 MiB each/8 MiB total; and 1 MiB retained unified text patch. Source must be quiescent while captured. Input/result files are bounded UTF-8 text; binary/general repository diff handling is deliberately outside this starter. Copying is exclusive; the original source checkout is never edited, committed, pushed or automatically copied back.

Approved memory is explicit. The helper removes unselected prepared memory files and supplies a fresh immutable effective context containing only selected memory metadata/text and Pi resources. Cursor's approved-memory preparation is honored. The original verified bundle/digest still identifies all original bundle bytes; a filtered effective context is a separate app choice, not a claim that the entire prepared tree equals that digest.

## Durable jobs and recovery

The evaluator creates `context.privateJobDirectory/binding.json`. Before launch, the helper verifies that binding, writes owner-only `job.json` outside the disposable workspace, records the canonical workspace and ownership marker, and fsyncs `launchIntent`. It updates acknowledged handle, confirmed stop, retained-result and cleaned facts only after each event. `job.json` contains private paths/handles; public diagnostic output should use only the opaque job ID.

The local operator can inspect `inspectNativeJob(privateJobDirectory)`. `cleanupQuarantinedJob` requires an explicit application termination-verification callback and validates the persistent parent and workspace ownership marker before deletion. The callback must actually establish original worker/external-job termination. PID reuse, age, an old heartbeat and a copied volume do not establish it. Recover against one authoritative physical volume; two restored copies with equal pathnames do not share kernel locks.

Cleanup saves a durable deletion intent before removing the owned tree. If the worker dies after deletion but before recording completion, explicit recovery can finish that record after termination verification. A missing workspace without that prior intent remains an ownership error.

Artifacts remain owner-only. `runRepositoryJob` returns a gradeable result, relative change/patch data and an opaque `native-job:<jobId>` reference. Deliberate shared review artifacts go through the evaluator's explicit selection/redactor exporter; never upload the job directory, entire workspace or private expected answers.

## Checks and evidence

```sh
node --test test/repository.test.mjs test/crash.test.mjs test/installed.test.mjs
```

These tests require the installed SDK/plugin artifacts. `test/native-helpers.test.mjs` additionally exercises installed native option/Pi loader interfaces with their declared optional peer dependencies. No test starts a model or native provider session. See [qualification ledger](QUALIFICATION.md) for precise evidence and unrun live gates.
