# Evaluate a change with your coding agent

Use the same installed agent, task and repository snapshot for each side of an evaluation. This starter stages verified version content, retains the agent’s edits and lets your grader test the solution against the original repository inputs.

Node 22.22+, npm 10+ and Linux/macOS (POSIX) are required. Obtain the native starter, matching SDK/plugin tarballs, release manifest and checksums from your release operator; no registry publication or download URL is implied. Verify `SHA256SUMS` in that release directory before extraction. Keep the included private `package.json`: it establishes the application boundary even when extracted beneath another npm workspace. Its empty dependency list deliberately performs no implicit registry resolution.

Use absolute paths for both directories and the already verified artifacts. For release 0.2.0, install the SDK and whichever plugin you use together (substitute the same release version throughout):

```sh
release=/absolute/path/to/verified-release
app=/absolute/path/to/native-repository-starter
npm install --prefix "$app" --workspaces=false --offline --ignore-scripts --no-audit --no-fund --save-exact \
  "$release/acclimate-sdk-0.2.0.tgz" "$release/acclimate-codex-plugin-0.2.0.tgz"
node "$app/verify-install.mjs" codex
```

## Try it offline first

The starter ships a fake `replay` harness, a small fixture repository and its tests. It needs only the SDK tarball: no provider SDK, credentials or model calls.

```sh
cd "$app"
node smoke.mjs
```

`smoke.mjs` runs two versions through `application.mjs` with `native.replay.json`: the replay harness applies the edits recorded in `fixture/replay.json`, and the real grader runs `fixture/tests/retry.test.mjs`. The parent scores 0 and reports an undeclared `docs/retry-notes.md`; the candidate scores 1. To use the same harness with the evaluator CLI, copy `native.replay.json` to `native.json` and create its private state directory (`mkdir -p -m 700 state/workspaces state/artifacts`).

## Choose a harness

Set `harness` in `native.json` to `codex` (the default), `claude`, `pi`, `cursor` or `replay`. Each built-in adapter starts a fresh session in the prepared workspace with explicit sandbox defaults, which are part of the runtime identity:

| Harness | Adapter | Defaults | Model value |
| --- | --- | --- | --- |
| `codex` | `runCodexTask` | `workspace-write` sandbox, approval `never`, no network or web search | a Codex model |
| `claude` | `runClaudeTask` | `permissionMode: 'dontAsk'`, tools Read/Edit/Write/Glob/Grep/Bash, WebFetch/WebSearch disallowed, sandbox on, no session persistence | a Claude model |
| `cursor` | `runCursorTask` | local agent with `sandboxOptions.enabled`; needs `CURSOR_API_KEY` | any Cursor model ID |
| `pi` | `runPiTask` | tools read/edit/write/bash/grep/find/ls, in-memory session and settings | `provider/model-id` |
| `replay` | `runReplayTask` | applies `replay` file edits, no model | none |

To compare harnesses, list them: `"harnesses": ["codex", "claude"]`. Every case then runs once per harness and the harness becomes part of the case key, for example `request-scoped-retry@claude`, with `input.harness` set. Each pair still compares parent and candidate on the same harness. To aggregate per harness, group the comparison's pairs by the `@<harness>` suffix of their case IDs. Use `models` (for example `{"codex": "…", "claude": "…"}`) when the harnesses need different model values.

### Add your own harness

Copy `harness-template.mjs`, implement `run()`, and select it with `"harness": { "name": "my-agent", "module": "./my-agent-harness.mjs" }` (or add the object to `harnesses`). The contract is `defineHarness({ name, prepare, run, identity })`:

- `prepare(version, { approvedMemoryPaths })` stages the version in a new private directory directly under `TMPDIR`. Use `prepareNativeFiles` from `@acclimate/sdk/native-files` with your agent's layout.
- `run({ context, prompt, policy, signal, acknowledge, progress })` runs one fresh turn in `context.cwd` and resolves `{ stopped: true, output, usage? }`, `{ stopped: true, executionStatus: 'task_failed', … }`, `{ stopped: true, infrastructureFailure: true, error: { code, message } }`, or `{ stopped: false }` when it cannot confirm a remote job stopped.
- `identity` is JSON describing versions and flags; it is hashed into the runtime identity, and so is the module file.

## Install a provider SDK

The packaged `application.mjs` grades the retained solution with your original Node tests. For Codex, install the matching provider SDK and platform executable from your approved npm cache:

```sh
npm install --prefix "$app" --workspaces=false --offline --include=optional --ignore-scripts --no-audit --no-fund \
  --save-exact @openai/codex-sdk@0.169.0
node "$app/verify-install.mjs" codex --codex-sdk
```

The provider check constructs the installed SDK, runs the local CLI’s `--version` and prints `cliVersion`. It needs no credentials. If it reports `install.codex_cli_unavailable`, include the matching optional platform package for the evaluator host in your cache and retry the install above.

For Claude, Cursor or Pi, install the plugin tarball and the tested peer instead: `@anthropic-ai/claude-agent-sdk@^0.3.325`, `@cursor/sdk@^1.3.1` or `@earendil-works/pi-coding-agent@^1.5.2`. Every plugin declares `@acclimate/sdk` as a peer, so install the SDK and plugin tarballs from the same release.

## Configure your repository

Create a private `native.json` beside the extracted `application.mjs`. Use your own paths, a model your account can run, and a coding task whose behavior your frozen tests exercise. The case’s expected behavior lives in those tests, so the SDK case can use `expected: null`.

```json
{
  "harness": "codex",
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

Relative paths for `sourceRoot`, `stateRoot` and `replay` resolve from the starter directory, and both roots are resolved with `realpath`, so a macOS `/tmp/...` path works. Include every file your tests need. Declare writable solution paths in `resultFiles`; it also accepts globs such as `src/**` or `lib/*.js`. Each `testFiles` entry must be an original protected input. Keep `stateRoot` on persistent local storage outside both the repository and evaluator journal. Set `ACCLIMATE_NATIVE_CONFIG` to use a config file other than `native.json`.

| Field | Meaning |
| --- | --- |
| `harness` / `harnesses` / `models` | Harness selection, described above. |
| `sourceFiles` | Explicit list of source paths. |
| `sourceInventory` | Instead of `sourceFiles`: `{ "include": ["src/**", "tests/**", "package.json"], "exclude": ["**/*.snap"] }` lists files with `git ls-files` (tracked and untracked, honoring `.gitignore`). Rejected paths are skipped; `node native.mjs inventory` prints both lists. |
| `allowDotPaths` | Exact dot-prefixed paths to copy anyway, such as `.eslintrc` or `.npmrc`. `.git`, `.agents`, `.claude`, `.cursor`, `.codex`, `.pi`, `.acclimate`, `AGENTS.md` and `CLAUDE.md` stay rejected. |
| `resultFiles` | Paths or globs whose final contents are retained and graded. |
| `testFiles` | Protected tests the grader runs. |
| `reward` | `"binary"` (default: 1 only if every test passes) or `"fraction"` (passed ÷ total). Any protected-file change scores 0. |
| `turnTimeoutMs`, `testTimeoutMs` | Agent turn and test run limits (defaults 110000 and 30000). |
| `approvedMemoryPaths` | Memory files the agent may receive. |
| `environmentNames` | Extra environment variable names passed to the agent. Credential variables for the selected harness pass automatically. |
| `inheritHome` | `true` keeps your real HOME and harness config instead of an isolated one (not recommended). |
| `deploymentRevision` | A nonsecret label for model or host changes outside these files. |

Each case may set `repetitions` (default 1) to run the pair several times; the evaluator stores each repetition as its own pair, which the uncertainty and quality policies use.

Check a candidate payload against your harnesses before a live run: `node native.mjs check-bundle payload.json` prints each compatibility issue with its rule.

Run the following from the extracted starter:

```sh
cd "$app"
state=/absolute/private/native-evaluator
mkdir -p -m 700 "$state" "$state/workspaces" "$state/artifacts"
export TMPDIR="$state/workspaces"

./node_modules/.bin/acclimate-eval describe
./node_modules/.bin/acclimate-eval doctor --config "$EVALUATOR_CONFIG" --handoff handoff.json
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff handoff.json --live
```

Use the public `describe` output in the console to create the evaluation request before running `doctor` or `compare`. The installed CLI loads the named `cases`, `execute` and `grade` exports. Only the live comparison launches Codex. Supply your application’s approved authentication and run the worker in the sandbox you use for executing candidate code.

Every CLI invocation freezes the listed files. The descriptor binds their captured bytes and mode bits, the model, harness implementation, application module, lockfile, Node runtime, file policies and timeouts. The grader identity includes the frozen inputs, test selection and grading implementation. Changing these inputs requires a fresh evaluation request. If model deployment or host configuration changes independently of these files, give that deployment a new nonsecret `deploymentRevision` in `native.json`. Credential values stay out of the descriptor. Optional `approvedMemoryPaths`, `turnTimeoutMs` and `testTimeoutMs` configure the effective job and are included in its revision.

The default grader reconstructs a fresh tree from frozen inputs and digest-verified solution files. It reruns `node --test` and returns zero if any test fails or a protected file changed. For projects with additional dependencies, customize `grade` in `application.mjs` to run the same isolated test environment you use in CI and bind its dependency lock or image digest. Regrading reads the retained solution and original snapshot for that request.

The grader runs `node --test --test-reporter=tap` in its own process group with an empty environment, and kills the group when `testTimeoutMs` expires or the evaluator cancels. Its explanation reports `outcome` (`passed`, `failed` or `test_timeout`), per-test counts (`tests.total`, `passed`, `failed`, `cancelled`, `skipped`, `todo`), `protectedChanges`, `undeclaredChanges` and the path of the retained TAP log. Up to 256 KiB of TAP output is kept privately under `artifacts/<jobId>/grading/`. To grade in a container, use `containerTestRunner` from `container-grader.mjs` and pin the image digest.

## Isolation and timeouts

Each job gets its own `HOME` inside the workspace (`.acclimate/home`). For Codex, `CODEX_HOME` points there and contains only a copy of `auth.json`, so your global `config.toml`, MCP servers and `AGENTS.md` do not reach either arm; Claude gets an isolated `CLAUDE_CONFIG_DIR` with only `.credentials.json`, and Pi only `auth.json`. API-key variables for the selected harness pass through. System-level configuration that isolation cannot remove (for example `/etc/codex/config.toml` or Claude's managed settings) is hashed into the runtime identity as `ambientConfig`.

Each agent turn runs in its own process group. When `turnTimeoutMs` expires the starter asks the adapter to stop, waits briefly, then kills the whole group, including tools the agent started. Once the group is gone, the case is a `task_failed` result with `reason: 'timeout'`, and its partial edits are retained and graded. An unexpected exit is `reason: 'crash'`. A provider error (for example Codex `turn.failed`) retains results, writes a private, redacted `failure.json` beside the job's artifacts and fails that arm with `native.harness_failed`, naming the file. Only a process group that survives SIGKILL, or an adapter that cannot confirm a remote job stopped, is quarantined as uncertain, and then only that arm fails; the rest of the comparison continues.

Files the agent creates outside `resultFiles` are not graded, but each job reports them in `undeclaredChanges` (count and up to 50 paths; `node_modules` and native control directories are ignored).

## Frozen source and context policy

The packaged application captures the source once per invocation and uses the same snapshot for both sides. Keep the checkout fixed until the request finishes or is regraded.

`repository-source-policy-v1` accepts only an explicit or generated list of regular portable paths. It rejects dot-prefixed segments not listed in `allowDotPaths`, `AGENTS.md`/`CLAUDE.md` at every depth and case variant, symlinks, device/socket/FIFO files, traversal, case/prefix collisions and existing native-file collisions. Each error names the path and the rule, for example `native.control_path: ".gitignore" (dot-prefixed segment)`. It copies no `.git`, `.env`, hooks, MCP settings, implicit dependencies or build outputs. Existing repository guidance must be deliberately reviewed into the bundle or handled by a separately versioned app recipe. Ambient user configuration is isolated as described above; record any other host policy in `deploymentRevision`.

Limits are 1,000 source files, 1 MiB each/16 MiB total; 100 declared result files, 1 MiB each/8 MiB total; and 1 MiB retained unified text patch. Source must be quiescent while captured. Input/result files are bounded UTF-8 text; binary/general repository diff handling is deliberately outside this starter. Copying is exclusive; the original source checkout is never edited, committed, pushed or automatically copied back.

Approved memory is explicit. The helper removes unselected prepared memory files and supplies a fresh immutable effective context containing only selected memory metadata/text and Pi resources. Cursor's approved-memory preparation is honored. The original verified bundle/digest still identifies all original bundle bytes; a filtered effective context is a separate app choice, not a claim that the entire prepared tree equals that digest.

## Durable jobs and recovery

The evaluator creates `context.privateJobDirectory/binding.json`. Before launch, the helper verifies that binding, writes owner-only `job.json` outside the disposable workspace, records the canonical workspace and ownership marker, and fsyncs `launchIntent`. It updates acknowledged handle, confirmed stop, retained-result and cleaned facts only after each event. `job.json` contains private paths/handles; public diagnostic output should use only the opaque job ID.

Use the local `jobs` commands to find and recover jobs. Their output contains private paths and handles:

```sh
node native.mjs jobs list                        # every job: state, harness, case, failure.json
node native.mjs jobs inspect JOB_ID              # the job record, process group status and failure.json
node native.mjs jobs cleanup JOB_ID --confirm-stopped
```

`cleanup` refuses while the job's recorded process group still exists, and `--confirm-stopped` is your statement that any external provider job also stopped. The library functions remain available: `inspectNativeJob(privateJobDirectory)` and `cleanupQuarantinedJob`, which requires an explicit termination-verification callback and validates the persistent parent and workspace ownership marker before deletion. The callback must actually establish original worker/external-job termination. PID reuse, age, an old heartbeat and a copied volume do not establish it. Recover against one authoritative physical volume; two restored copies with equal pathnames do not share kernel locks.

Cleanup saves a durable deletion intent before removing the owned tree. If the worker dies after deletion but before recording completion, explicit recovery can finish that record after termination verification. A missing workspace without that prior intent remains an ownership error.

The owner-only artifact directory stores the complete `result.patch`, `output.json`, retained solution files and their manifest. The evaluator receives hashes, sizes, declared-file changes, a protected-change count, undeclared changes, a failure summary (reason, code and the private `failure.json` path) when there was one, an opaque job reference and up to 64 KiB of agent output. Larger outputs stay private and the inline `result` becomes null. The private output limit is 8 MiB. Review exports can select and redact the bounded evidence using the installed evaluator’s export workflow.
