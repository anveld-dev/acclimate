# Test a coding agent with versioned instructions

Use the native repository helpers to run an installed coding agent against a task and a frozen repository snapshot. This starter stages verified version content, retains the agent’s edits and lets your grader test the solution against the original repository inputs.

Node 22.22+, npm 10+ and Linux/macOS (POSIX) are required. Download the starter archive, the SDK and plugin tarballs, the release manifest and `SHA256SUMS` from a GitHub Release, or build them from a source checkout with `npm run pack:verify`, which writes them to `artifacts/releases/<version>/`. Verify `SHA256SUMS` in that release directory before extraction. Keep the included private `package.json` and `.npmrc`: the manifest establishes the application boundary even when extracted beneath another npm workspace, and `.npmrc` turns off install scripts, audit and fund messages, saves exact versions and installs optional platform packages. Its empty dependency list deliberately performs no implicit registry resolution.

Use absolute paths for both directories and the already verified artifacts. Install the SDK and whichever plugin you use together, from the same release directory. The commands use version 0.2.0, which a source checkout builds today:

```sh
release=/absolute/path/to/verified-release
app=/absolute/path/to/native-repository-starter
npm install --prefix "$app" --offline "$release/anveld-sdk-0.2.0.tgz" "$release/anveld-codex-plugin-0.2.0.tgz"
node "$app/verify-install.mjs" codex
```

## Check the installed SDK

Run `node smoke.mjs` from the extracted starter. It stages a fixed one-file payload with the SDK's `prepareFiles`, reads it back and cleans up. It does not load a plugin or your bundle. `node verify-install.mjs claude` (or `codex`, `pi`, `cursor`, `--all`) checks that the SDK and that plugin are installed inside the starter from one release. To check a plugin's layout against your real channel, run the plugin delivery check from **App setup** in the console.

## Run a repository job

The starter is a library: your application calls it. Freeze the source with `freezeSourceInventory`, then call `runRepositoryJob` from `repository-job.mjs` with the plugin's `prepare` from `installedHarness(name)` in `harnesses.mjs` and a `runHarness` that runs the matching adapter (`runCodexTask`, `runClaudeTask`, `runPiTask` or `runCursorTask`), for example in its own process group with `runInProcessGroup` from `harness-process.mjs`. Grade the retained result with `gradeRepositoryTests`.

The `jobs`, `check-bundle` and `inventory` commands in `native.mjs` read a private `native.json` beside it. Put the absolute `stateRoot` and `sourceRoot` there. `check-bundle` checks a payload against the agent SDK named by `"harness"` (or each one in `"harnesses"`), Codex by default.

## Durable jobs and recovery

The calling application creates `context.privateJobDirectory/binding.json`. Before launch, the helper verifies that binding, writes owner-only `job.json` outside the disposable workspace, records the canonical workspace and ownership marker, and fsyncs `launchIntent`. It updates acknowledged handle, confirmed stop, retained-result and cleaned facts only after each event. `job.json` contains private paths/handles; public diagnostic output should use only the opaque job ID.

Use the local `jobs` commands to find and recover jobs. Their output contains private paths and handles:

```sh
node native.mjs jobs list                        # every job: state, harness, case, failure.json
node native.mjs jobs inspect JOB_ID              # the job record, process group status and failure.json
node native.mjs jobs cleanup JOB_ID --confirm-stopped
```

`cleanup` refuses while the job's recorded process group still exists, and `--confirm-stopped` is your statement that any external provider job also stopped. The library functions remain available: `inspectNativeJob(privateJobDirectory)` and `cleanupQuarantinedJob`, which requires an explicit termination-verification callback and validates the persistent parent and workspace ownership marker before deletion. The callback must actually establish original worker/external-job termination. PID reuse, age, an old heartbeat and a copied volume do not establish it. Recover against one authoritative physical volume; two restored copies with equal pathnames do not share kernel locks.

Cleanup saves a durable deletion intent before removing the owned tree. If the worker dies after deletion but before recording completion, explicit recovery can finish that record after termination verification. A missing workspace without that prior intent remains an ownership error.

The owner-only artifact directory stores the complete `result.patch`, `output.json`, retained solution files and their manifest. The calling application receives hashes, sizes, declared-file changes, a protected-change count, undeclared changes, a failure summary (reason, code and the private `failure.json` path) when there was one, an opaque job reference and up to 64 KiB of agent output. Larger outputs stay private and the inline `result` becomes null. The private output limit is 8 MiB. Review retained evidence in the private state directory.
