# Connect an existing agent and compare a change

Your application keeps its agent loop, tools, model credentials and grader. Acclimate delivers versioned content and records paired evidence; the console never starts your agent. This guide assumes an existing deployed workspace. To operate the service instead, use [deployment](../deploy/README.md).

## 1. Obtain a release and choose a language

Ask your workspace administrator for the versioned SDK release, starter archives, release manifest and SHA256SUMS. Verify the obtained files against those checksums. Distribution is currently operator-managed; no public registry or download endpoint is implied. [Release metadata](../scripts/packaging/release-metadata.json) names exact files and requirements.

Extract `acclimate-evaluation-starter-0.1.0.tgz` and enter its `evaluation-starter` directory. Install the matching package from your obtained release:

```sh
npm install --offline --ignore-scripts /absolute/path/to/release/acclimate-sdk-0.1.0.tgz
node trial.mjs
node acclimate-eval.mjs describe
```

Or use Python 3.11+:

```sh
python3.11 -m pip install --no-index --no-deps /absolute/path/to/release/acclimate_sdk-0.1.0-py3-none-any.whl
python3.11 trial.py
python3.11 acclimate_eval.py describe
```

The trial makes no service, OIDC or provider call. It compares deterministic in-memory task behavior and prints simulated observations, not release evidence. JavaScript runs directly without a TypeScript runner or implicit `npx` download. Durable TypeScript evaluation needs Node 22.22+, POSIX and `python3` with `fcntl`; the Python evaluator has no Node or third-party runtime dependency. Both need private local persistent storage.

Building from source is a contributor alternative, documented in [development](development.md#publish-and-consume-content). For ongoing improvement from TypeScript, export the installed development and audit apps with `connectedEvaluationDescriptor`, attach the terminal-outcome hook, and enroll the connection. The setup guide covers the evaluator process, receipts and release policies. [Connected learning setup](../deploy/README.md#operate-connected-learning).

## 2. Verify delivery, then attach the real agent

In the console, select your workspace/bundle/channel and open **App setup**. Copy its selection-specific delivery check and run it with the content-read credential from your workspace administrator. The check pins a version, verifies content, reads prepared files and cleans up. It does not prove that a model consumed instructions or invoked a skill.

App setup's adjacent **Connect your agent** step shows a runnable context fixture. Replace its application function with your existing agent call: pass the selected instructions, expose skill/reference files through your own tools, explicitly choose approved memory, and await completion while file references remain alive. Retain results before cleanup; avoid logging private agent outputs. Record the pinned version/digest beside the job.

The fixture writes an owner-only `acclimate-agent-result.json` in `ACCLIMATE_JOB_DIR`, including the result and pinned version/digest, before removing prepared inputs. Use a new empty job directory for each run. An unresolved application lifetime or failed result retention preserves the inputs for inspection.

For Codex, Claude, Pi or Cursor, install the matching plugin artifact from the same release and use the [native repository starter](../examples/native-repository/README.md). It demonstrates an explicit source inventory, effective memory/context policy, persistent private job records, and output retention before cleanup. It preserves the original repository. Generic file delivery is available to Python applications; Python native harness adapters are not implied.

## 3. Obtain evaluator access before creating a request

| Task | Required access | Provisioned by |
| --- | --- | --- |
| Fetch a published bundle/channel | Content-read credential | Workspace admin in Connections |
| Optional delivery observations | Separate receipt-write credential | Workspace admin in Connections |
| Read unpublished candidates and run evaluations | Dedicated project evaluator with read/write | Service operator |
| Release a candidate | Separate release authority | Authorized reviewer/operator policy |

Delivery credentials cannot run evaluations or read unpublished candidates. Your operator follows the [evaluator provisioning and recovery guide](evaluator-operations.md); current static-grant changes require a coordinated restart. Evaluator `write` is broad project write, not a new narrowly scoped evaluation permission. Propose/promote rights are unnecessary for evaluation.

Receive the evaluator's private configuration through your secret channel. Keep its JSON file owner-only (0600) in a private canonical directory (0700), outside version control. It has exactly:

```json
{
  "schemaVersion": 1,
  "serviceUrl": "https://api.example.com",
  "projectId": "YOUR_PROJECT_ID",
  "evaluatorPrincipalId": "YOUR_STABLE_EVALUATOR_PRINCIPAL",
  "evaluatorToken": "RECEIVE_PRIVATELY_FROM_YOUR_OPERATOR",
  "journalRoot": "/absolute/private/evaluator-journals"
}
```

Do not paste this private file into the console, command arguments or logs. The evaluator reads only the explicitly selected filename. Keep the exact service URL, principal, project and canonical journal root stable across retries and worker replacements. Public API URLs use HTTPS; loopback HTTP is only an explicitly configured private same-host hop.

## 4. Define one meaningful task and independent grader

The [installed-app starter](../examples/evaluation-starter/README.md) supplies complete local entry points and task fixtures. Its default simulator is wiring evidence. To evaluate your real application, replace `runExistingAgent` in `agent.mjs` or `agent.py`, define saved task inputs and private expected answers, and use an independent behavior grader. Change config/build, dataset and grader revisions to identify that implementation. Mark model-backed execution as `live` and apply your own model/tool budgets.

`defineEvaluation` / `define_evaluation` derives the case/repetition inventory; do not maintain another handwritten list. Each paired callback receives isolated task data and verified bundle content. Expected answers go only to grading. Your installed entry point emits a public descriptor:

```sh
node acclimate-eval.mjs describe
node acclimate-eval.mjs doctor --config /absolute/private/evaluator.json --bundle YOUR_BUNDLE_UUID --policy quality-policy.json
```

Python uses the same arguments with `python3.11 acclimate_eval.py`. `doctor` checks local configuration/storage and point-in-time evaluator authority without running a task, modifying service data or probing a model. It may write/remove a private local probe. A successful check does not reserve access or prove provider readiness.

## 5. Create and execute an immutable request

Save a draft or select a proposal candidate, then continue to evaluation. Choose **My app's installed evaluator** and paste only its public `describe` output. No simulator is selected by default. The checkout examples state their purpose: payment-policy orchestration, file-presence contract, or explicitly live native review. An ordinary instruction edit cannot be measured by leaving an unrelated payment simulator selected.

The request freezes a saved candidate and parent, exact digests, evaluator configuration and case inventory. Unsaved edits are not evaluated. Later draft changes do not rewrite its request. Copy/download its public JSON as `evaluation-request.json`, then run your app:

```sh
node acclimate-eval.mjs doctor --config /absolute/private/evaluator.json --handoff evaluation-request.json
node acclimate-eval.mjs run --config /absolute/private/evaluator.json --handoff evaluation-request.json
node acclimate-eval.mjs check --config /absolute/private/evaluator.json --handoff evaluation-request.json --policy quality-policy.json
```

Add `--live` only for an installed definition marked live. The handoff identifies public service/project/request configuration; it never selects code, an executable, a credential source or a local path. The app uses its statically installed callbacks.

For CI without manual console authoring, the same entry point creates a durable candidate and bound request from your local payload:

```sh
node acclimate-eval.mjs request --config /absolute/private/evaluator.json --bundle YOUR_BUNDLE_UUID --channel stable --payload candidate.json --intent /absolute/private/ci-intent.json --out evaluation-request.json
```

It freezes the baseline, payload, descriptor and operation keys before writes. Retry the same command with the same private intent; changed content/configuration or a new baseline requires explicit new intent. There is no silent rebase or automatic release. See the [CI recipe](../examples/ci/README.md) for the complete request/run/check/export sequence.

## 6. Review evidence and decide deliberately

`run` success means complete paired evidence, including a fully graded losing candidate. It does not mean quality improved. `check` applies your explicit scalar metric direction, equal weighting across distinct cases, regression limits and optional known-cost bounds. Missing evidence or required unknown cost is indeterminate, never zero or a pass. The policy result is descriptive, not statistical confidence.

| Result | Run exit | Policy-check exit |
| --- | --- | --- |
| Complete, policy-passing evidence | 0 | 0 |
| Complete candidate violating the policy | 0 | 2 |
| Failed/incomplete evidence | 2 | 3 |
| Interrupted/uncertain execution | 3 | 3 when evidence is unavailable |
| Invalid configuration/policy/access | 1 | 1 |

Inspect case coverage and failures in the console, then make a separate release decision using current channel revision checks. A stale baseline can still be inspected but cannot silently replace a newer channel.

Detailed outputs stay private/local unless explicitly exported through your installed mapper and role selection. The [sharing recipe](../examples/evaluation-starter/README.md#review-and-share-one-failed-case) retains deliberately redacted outputs and grader explanations. Upload only its completed export directory through approved authenticated artifact storage. A teammate with project-read authority can verify hashes and match scalar evidence against an independently selected request; that does not attest the truth of redacted model traces.

Workspace **Delivery** shows read-authorized app observations separately from admin **Connections**. App occurrence and service receipt times remain separate; a delayed latest receipt may refer to an older version. Missing/expired observations mean unknown and never prove model consumption or evaluator progress.

If a worker stops responding, use the [recovery guide](evaluator-operations.md). Do not delete journals, relocate unfinished attempts, switch languages, or repeat execution because a request is old. An interruption records intent; it does not stop external work or charges.
