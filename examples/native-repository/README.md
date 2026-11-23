# Test a coding agent with versioned instructions

Use the native repository helpers to run an installed coding agent against a task and a frozen repository snapshot. This starter stages verified version content, retains the agent’s edits and lets your grader test the solution against the original repository inputs.

Node 22.22+, npm 10+ and Linux/macOS (POSIX) are required. Obtain the native starter, matching SDK/plugin tarballs, release manifest and checksums from your release operator; no registry publication or download URL is implied. Verify `SHA256SUMS` in that release directory before extraction. Keep the included private `package.json`: it establishes the application boundary even when extracted beneath another npm workspace. Its empty dependency list deliberately performs no implicit registry resolution.

Use absolute paths for both directories and the already verified artifacts. For release 0.1.0, install the SDK and whichever plugin you use together (substitute the same release version throughout):

```sh
release=/absolute/path/to/verified-release
app=/absolute/path/to/native-repository-starter
npm install --prefix "$app" --workspaces=false --offline --ignore-scripts --no-audit --no-fund --save-exact \
  "$release/acclimate-sdk-0.1.0.tgz" "$release/acclimate-codex-plugin-0.1.0.tgz"
node "$app/verify-install.mjs" codex
```

## Check the installed SDK

Run `node smoke.mjs` from the extracted starter. It stages a fixture payload, reads its instructions and cleans up the job directory.

## Run a repository job

Use the functions in `repository-job.mjs` and the adapters in `harnesses.mjs` from your application. Prepare the verified bundle for the native SDK, run the task in a private workspace and retain the result before cleanup. For job discovery, put the absolute `stateRoot` and `sourceRoot` in a private `native.json` beside `native.mjs`.

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
