# Evaluate a change with your coding agent

Use the same installed agent, task and repository snapshot for each side of an evaluation. This starter stages verified bundle content, retains the agent’s edits and lets your grader test the solution against the original repository inputs.

Node 22.22+, npm 10+ and Linux/macOS (POSIX) are required. Obtain the native starter, matching SDK/plugin tarballs, release manifest and checksums from your release operator; no registry publication or download URL is implied. Verify `SHA256SUMS` in that release directory before extraction. Keep the included private `package.json`: it establishes the application boundary even when extracted beneath another npm workspace. Its empty dependency list deliberately performs no implicit registry resolution.

Use absolute paths for both directories and the already verified artifacts. For release 0.1.0, install the SDK and whichever plugin you use together (substitute the same release version throughout):

```sh
release=/absolute/path/to/verified-release
app=/absolute/path/to/native-repository-starter
npm install --prefix "$app" --workspaces=false --offline --ignore-scripts --no-audit --no-fund --save-exact \
  "$release/acclimate-sdk-0.1.0.tgz" "$release/acclimate-codex-plugin-0.1.0.tgz"
node "$app/verify-install.mjs" codex
```

The packaged `application.mjs` runs a real Codex turn and grades the retained solution with your original Node tests. Install the matching provider SDK and platform executable from your approved npm cache:

```sh
npm install --prefix "$app" --workspaces=false --offline --include=optional --ignore-scripts --no-audit --no-fund \
  --save-exact @openai/codex-sdk@0.169.0
node "$app/verify-install.mjs" codex --codex-sdk
```

The provider check constructs the installed SDK, runs the local CLI’s `--version` and prints `cliVersion`. It needs no credentials. If it reports `install.codex_cli_unavailable`, include the matching optional platform package for the evaluator host in your cache and retry the install above.

## Configure your repository

Create a private `native.json` beside the extracted `application.mjs`. Use your own paths, a model your account can run, and a coding task whose behavior your frozen tests exercise. The case’s expected behavior lives in those tests, so the SDK case can use `expected: null`.

```json
{
  "sourceRoot": "/absolute/path/to/your/repository",
  "stateRoot": "/absolute/private/native-evaluator",
  "sourceFiles": ["package.json", "src/retry.js", "tests/retry.test.mjs"],
  "resultFiles": ["src/retry.js"],
  "testFiles": ["tests/retry.test.mjs"],
  "model": "YOUR_CODEX_MODEL",
  "cases": [{
    "caseId": "request-scoped-retry",
    "input": {"prompt": "Preserve a request’s retry identity across attempts."},
    "expected": null
  }]
}
```

Relative paths for `sourceRoot` and `stateRoot` resolve from the starter directory. Include every file your tests need. Declare writable solution paths in `resultFiles`. Each `testFiles` entry must be an original protected input. Keep `stateRoot` on persistent local storage outside both the repository and evaluator journal. Run the following from the extracted starter:

```sh
cd "$app"
state=/absolute/private/native-evaluator
mkdir -p -m 700 "$state" "$state/workspaces" "$state/artifacts"
export TMPDIR="$state/workspaces"

./node_modules/.bin/acclimate-eval describe
./node_modules/.bin/acclimate-eval doctor --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live
```

Use the public `describe` output in the console to create the evaluation request before running `doctor` or `compare`. The installed CLI loads the named `cases`, `execute` and `grade` exports. Only the live comparison launches Codex. Supply your application’s approved authentication and run the worker in the sandbox you use for executing candidate code.

Every CLI invocation freezes the listed files. The descriptor binds their captured bytes and mode bits, the model, harness implementation, application module, lockfile, Node runtime, file policies and timeouts. The grader identity includes the frozen inputs, test selection and grading implementation. Changing these inputs requires a fresh evaluation request. If model deployment or host configuration changes independently of these files, give that deployment a new nonsecret `deploymentRevision` in `native.json`. Credential values stay out of the descriptor. Optional `approvedMemoryPaths`, `turnTimeoutMs` and `testTimeoutMs` configure the effective job and are included in its revision.

The default grader reconstructs a fresh tree from frozen inputs and digest-verified solution files. It reruns `node --test` and returns zero if any test fails or a protected file changed. For projects with additional dependencies, customize `grade` in `application.mjs` to run the same isolated test environment you use in CI and bind its dependency lock or image digest. Regrading reads the retained solution and original snapshot for that request.

For Claude, Pi or Cursor, replace the Codex call in the application's named `execute` function with your installed native SDK. `installedHarness` and `freshSessionInputs` expose the supported preparation helpers. Record that SDK and its settings in the runtime identity. In your adapter, acknowledge the real job handle, keep the inputs alive until termination, and return its gradeable output, task status and measured usage.

## Frozen source and context policy

The packaged application captures the source once per invocation and uses the same snapshot for both sides. Keep the checkout fixed until the request finishes or is regraded.

`repository-source-policy-v1` accepts only an explicit list of regular portable paths. It rejects every dot-prefixed segment, `AGENTS.md`/`CLAUDE.md` at every depth and case variant, symlinks, device/socket/FIFO files, traversal, case/prefix collisions and existing native-file collisions. It copies no `.git`, `.env`, hooks, MCP settings, implicit dependencies or build outputs. Existing repository guidance must be deliberately reviewed into the bundle or handled by a separately versioned app recipe. The small text recipe does not sandbox ambient user/host SDK settings; record those application policies separately.

Limits are 1,000 source files, 1 MiB each/16 MiB total; 100 declared result files, 1 MiB each/8 MiB total; and 1 MiB retained unified text patch. Source must be quiescent while captured. Input/result files are bounded UTF-8 text; binary/general repository diff handling is deliberately outside this starter. Copying is exclusive; the original source checkout is never edited, committed, pushed or automatically copied back.

Approved memory is explicit. The helper removes unselected prepared memory files and supplies a fresh immutable effective context containing only selected memory metadata/text and Pi resources. Cursor's approved-memory preparation is honored. The original verified bundle/digest still identifies all original bundle bytes; a filtered effective context is a separate app choice, not a claim that the entire prepared tree equals that digest.

## Durable jobs and recovery

The evaluator creates `context.privateJobDirectory/binding.json`. Before launch, the helper verifies that binding, writes owner-only `job.json` outside the disposable workspace, records the canonical workspace and ownership marker, and fsyncs `launchIntent`. It updates acknowledged handle, confirmed stop, retained-result and cleaned facts only after each event. `job.json` contains private paths/handles; public diagnostic output should use only the opaque job ID.

The local operator can inspect `inspectNativeJob(privateJobDirectory)`. `cleanupQuarantinedJob` requires an explicit application termination-verification callback and validates the persistent parent and workspace ownership marker before deletion. The callback must actually establish original worker/external-job termination. PID reuse, age, an old heartbeat and a copied volume do not establish it. Recover against one authoritative physical volume; two restored copies with equal pathnames do not share kernel locks.

Cleanup saves a durable deletion intent before removing the owned tree. If the worker dies after deletion but before recording completion, explicit recovery can finish that record after termination verification. A missing workspace without that prior intent remains an ownership error.

The owner-only artifact directory stores the complete `result.patch`, `output.json`, retained solution files and their manifest. The evaluator receives hashes, sizes, declared-file changes, a protected-change count, an opaque job reference and up to 64 KiB of agent output. Larger outputs stay private and the inline `result` becomes null. The private output limit is 8 MiB. Review exports can select and redact the bounded evidence using the installed evaluator’s export workflow.
