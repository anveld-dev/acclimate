# Recurring application-owned learning

This installed starter executes a deterministic fictional payment-incident application through the public learner and real Rust service. It produces task outcomes and approved feedback, retains a losing candidate, audits two improving candidates, and verifies two deliberate releases in the same durable campaign. It makes no model calls and never contacts a payment processor.

The learner owns `submit`, `advance`, and `inspect`; the app supplies execution, grading and correction authority. A separate reviewer credential promotes only in the disposable qualification workspace. The learner credential cannot publish a channel. Ordinary delivery receipts are not used as task outcomes or learning feedback.

## Run the full qualification

Requires Node 22.22+, installed npm dependencies, Python 3.11+, Rust and PostgreSQL server binaries. The wrapper creates a private database/service deployment and generates disposable credentials. It reads no ambient database URL, runtime credentials or dotenv file.

```sh
npm ci --ignore-scripts
npm run qualify:learning -- \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output artifacts/continuous-learning/my-run
```

Use a new output directory for each run. Add `--skip-build` to use an already built `target/debug/acclimate-service`. PostgreSQL and the Rust process are stopped and their database removed after the run. Evidence remains owner-only in the selected output directory; the results are not added to an existing local workspace.

The wrapper creates an owner-only configuration file in its temporary directory and invokes `run.ts --config /absolute/private/config.json`. The config contains `schemaVersion: 1`, explicit loopback `serviceUrl`, `projectId`, separate `learnerToken` and `reviewerToken`, and `output`. These are qualification identities; do not point this runner at an existing deployment. Tokens and temporary evaluator/worker configuration are removed with the disposable deployment rather than copied into retained evidence.

## What executes

`domain.ts` defines a small installed application that reads `retry-policy` from the verified `skills/retry-review/SKILL.md`. It returns a concrete decision for clean completion, a lost response, or a transient failure. Its independent grader checks the action and original key against fixed domain rules. This is executable model-free behavior, not a grader populated with invented scores.

The campaign has three rounds:

1. A deliberately regressing fixed-file candidate completes its development comparison and is retained but rejected.
2. A candidate that preserves the original key improves lost-response handling. A protected audit passes, then the independent fixture reviewer explicitly releases it.
3. A second batch of ordinary task outcomes supplies a different approved correction. A candidate adds reconciliation, passes a separate fresh audit, and receives another explicit release.

Each comparison resolves a private experiment graph with both exact content/harness arms, fixed runner/tool/model/context artifacts, private input/expected-answer inventories, and invariant grader/collection controls. Public descriptors contain only explicitly approved digest commitments. Each actual trial retains a verified job/effective-context binding before executing the deterministic app.

Each comparison uses the seeded balanced collection protocol, six complete parent/candidate pairs, fresh SDK job directories, zero-cost deterministic execution and a frozen grader identity. The protected cohorts have distinct task inputs; audit answers never become teaching corrections. This narrowly synthetic qualification does not establish broad generalization or an indefinite statistical guarantee.

Only feedback references admitted by the fixture owner's trusted ingestion path can teach. A planted instruction is retained as an observation but excluded from the learner. Scope, retained artifact digests and the exact frozen definition are checked. Replaying the same observation command returns its original receipt; changed bytes under that ID conflict.

## Recovery and authority checks

The run also checks:

- A real fault-worker process completes a development evaluation against Rust/PostgreSQL, persists evidence, and exits with code 86 before returning its receipt. A reopened learner reconciles that existing operation. Exactly five evaluations and five comparisons remain; no replacement sample is launched.
- Stop/resume between rounds survives reopening and does not reset the paid-admission counter.
- Changed installed definition identity is refused.
- Learner promotion returns 403; the separate authorized reviewer makes the release. A stale revision is rejected.
- Two distinct audit digests are consumed, eight logical operation admissions remain recorded, and known/reserved cost stays zero for these deterministic adapters.
- A fresh consumer resolves each release through the SDK cache and improves on the relevant future task. Previously retained baseline/intermediate bundles keep their pinned bytes and still fail their original missing behavior.

The fault is a worker-process exit plus controller-handle reopen. It does not claim a killed remote provider, a hard spending cap for an opaque model adapter, distributed ownership, or safe replay of uncertain native work. Low-level lock, corruption, active-stop and budget semantics are also covered by the SDK's learning tests.

## Inspect retained evidence

- `summary.json`: asserted outcome, operation/sample counts and exact content version IDs.
- `campaign-views.json`: recurring controller state, decisions, budget and audit history.
- `*-outcome.json`: actual task attempts and references to immutable result, harness and feedback artifacts.
- `round-*-review-and-release.json`: exact audit/review target and observed authorized promotion.
- `service-records.json`: all five real bound evaluations and comparisons.
- `lost-report-acknowledgement.json`: failed worker identity and exit status.
- `campaign/`: authoritative checkpoint, inbox and verified immutable artifacts.
- `evaluation-journals/`: existing evaluator attempt journals, exact reports and private job bindings.

The saved controller/descriptor records are app-reported evidence, not remote execution attestation. The task runner here is deterministic; a later opt-in Codex SDK qualification should retain actual native events and independently grade observed task behavior before claiming model-backed learning.

## Code map

`application.ts` installs the real service/evaluator adapter. `run.ts` owns disposable setup, trusted fixture corrections, the recurring scenario and assertions. `execute-operation.ts` is the qualification-only fault worker. The Python wrapper owns the temporary database, service and credentials. None of the reusable learner implementation lives in this example.
