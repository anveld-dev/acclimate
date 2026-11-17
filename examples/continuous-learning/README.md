# Recurring application-owned learning

This installed starter executes a fictional payment-incident application through the public learner and the Rust service backed by PostgreSQL. Two campaigns start from the same immutable bundle version on separate channels. The default qualification runs deterministically with zero model calls. Both qualification modes make zero payment requests.

The learner owns `submit`, `advance`, and `inspect`. The application supplies execution, grading, correction authority, and a mutation callback. A separate reviewer credential promotes in the disposable qualification workspace.

## Run the full qualification

Requires Node 22.22+, installed npm dependencies, Python 3.11+, Rust and PostgreSQL server binaries. The wrapper creates a private database and service deployment with disposable credentials.

```sh
npm ci --ignore-scripts
npm run qualify:learning -- \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output artifacts/continuous-learning/my-run
```

Use a new output directory for each run. Add `--skip-build` to use an already built `target/debug/acclimate-service`. The wrapper stops PostgreSQL and the Rust process and removes their disposable database. Evidence remains owner-only in the selected output directory.

The wrapper passes `run.ts` an explicit, owner-only configuration containing the loopback URL, project, separate learner and reviewer tokens, and the output directory. The evaluator and fault worker receive similarly private configurations. The wrapper removes those configurations with the disposable deployment. The run reads no ambient database URL, runtime credentials, or dotenv file.

## Run the live qualification

Install the Codex CLI on `PATH` and sign in with an account that can use `gpt-6.2-sol` and `gpt-6-luna`. Add `--live` to opt in to real Codex CLI turns, and use a fresh output directory for the run. Sol authors proposed changes. Luna runs the original observation, both arms of development and audit comparisons, and the pinned and fresh consumer probes.

```sh
npm run qualify:learning -- \
  --live \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output artifacts/continuous-learning/my-live-run
```

The live runner reserves at most 39 Codex turns in a durable ledger shared by all calls under the run's output directory. It can recover an identical completed call from the ledger and holds an ambiguous call for reconciliation. The limit counts local Codex invocations. Provider request counts and dollar cost are unavailable. Completed turns retain the token usage reported by the CLI.

Each model turn starts in a dedicated fixture directory with shell, web search, MCP, plugins, and subagent tools disabled. A proposal sees the verified baseline files, one admitted correction, and any applicable development aggregate. A job sees the delivered bundle files and one fictional incident. The independent local grader holds the expected answer and checks the model's selected action and request key. The application binds paired baseline and candidate jobs to frozen evaluation controls. A separate reviewer credential can release an audited candidate. Fresh and pinned consumer jobs then execute the same probe through their separately resolved bundle versions.

The live output includes `summary.json` with the two pinned role models, channel-specific campaign views and consumer results, and `service-records.json` with evaluation and comparison records. Both model assignments are bound to the campaign definition. The private `model-turns/inputs/` directory retains the submitted prompts and their model roles. The `model-turns/model-calls/` ledger retains pre-invocation slots, request digests, role and model names, response schemas, and completed responses with thread IDs and usage. Inspect `run.log` and the retained evidence if the run holds or fails.

In the earlier Luna-only live qualification, 35 Codex turns completed. Both protected audits tied at 1 correct case out of 3 for the parent and candidate. Neither campaign released a candidate, so the live consumer comparisons did not run.

Summarize retained evidence offline by passing the output directory selected for the live run.

```sh
python3 scripts/testing/summarize_continuous_learning_live.py artifacts/continuous-learning/my-live-run
```

## Grounded payment repair qualification

A delivered live bundle opts into grounded execution by including an instruction named `instructions/grounded-payment-policy.md`. The file contains a JSON object with `version: 1`, an `evidenceGuide`, and an `actions` map covering `completed`, `processor-outcome-unknown`, and `confirmed-before-processor`. The live executor validates the artifact before it asks Luna to interpret the incident. Bundles without this artifact follow the historical live execution path.

Luna receives the raw incident signal and the evidence guide. The established interfaces also supply their versioned field documentation. Luna cites evidence of completion, delivery, or a stop before dispatch. The executor checks each excerpt against the serialized signal, accepting one pair of surrounding double quotes when the interior matches exactly. This check establishes text provenance. The semantic interpretation still depends on Luna. Missing, conflicting, or malformed evidence produces a recorded abstention. Supported evidence selects the configured action. The executor derives the key from the original request key and appends `-new` once for `fresh-key`.

The [repair qualification runner](repair-generalization.ts) uses Sol to author scoped policy drafts and uses the same [live executor](live-domain.ts) for both historical and grounded bundles. Its `repair-qualification-v1` profile reserves at most 112 turns in one ledger. The ordinary live learning proposer explicitly rejects grounded bundles. This qualification operates on fictional incidents and local candidate artifacts, with zero payment or publication writes.

After development, generate the offline regrade in the original run directory. The runner verifies the retained prompt and response schema for each example, reapplies the excerpt check to the retained Luna response, and writes a separate `development-replay.json`. It makes zero model calls and preserves the original scores. If the report already exists, read the retained report.

```sh
./node_modules/.bin/tsx examples/continuous-learning/repair-generalization.ts replay \
  artifacts/continuous-learning/my-repair-run
```

## What executes in the default qualification

The installed application decodes incident inputs from four sources. Checkout supplies HTTP status codes, mobile receipt handling supplies reply codes, batch import supplies settlement codes, and the operator console supplies confirmation state. The delivered root instructions and skills determine the retry action. An independent grader checks the chosen action and key against the fixture's known outcome.

1. In the primary campaign, approved lost-response feedback supplies the original-key rule. The first candidate applies that rule too broadly and regresses clean jobs. The controller retains the development comparison and supplies its bounded aggregate on retry. With the same correction and baseline, the next candidate narrows the rule to lost responses, passes a mobile-receipt audit, and receives reviewer approval.
2. Ordinary pre-charge feedback then starts a new primary round from the released version. The mutation adds a reconciliation skill and updates the root reference. The installed reference preflight checks both changes. The candidate passes a batch-import audit and receives reviewer approval.
3. The alternate campaign starts from the original version and gets only the pre-charge correction. Its first audit roster entry contains fresh cases from the already exposed mobile-receipt family. The shared lineage ledger skips it and consumes the operator-console audit. The reviewer releases the structural reconciliation change.

Both first releases are fetched through the SDK cache and applied to the same fresh incidents. The baseline handles clean jobs, the primary first release also handles lost responses, and the alternate first release also handles pre-charge failures. The second primary release handles all three. The fixture tests causality inside this deterministic application.

Each comparison resolves a private experiment graph for both exact content and harness arms, a frozen dataset and grader, and seeded balanced collection controls. The SDK retains six parent/candidate pairs with fresh job directories per comparison and binds each job to its verified effective context. Public descriptors include approved digest commitments. Proposal inputs contain admitted teaching and the applicable development aggregate. The audit cases and answers remain in the evaluation controls.

## Recovery and authority checks

- A fault worker completes the narrowed development comparison against Rust and PostgreSQL, retains its evidence, and exits with code 86 before acknowledging the controller. The reopened learner reconciles the original operation. Seven evaluations and seven comparisons cover both campaigns.
- Stop and resume survive reopening between development attempts and retain the existing admission count. A changed installed definition is rejected.
- A planted instruction is excluded from teaching. Replaying an identical observation command returns the original receipt, and changed bytes under the same ID conflict.
- Learner promotion receives 403, and a reviewer promotion using a stale revision receives 409. The separate reviewer credential publishes the audited candidates.
- Three distinct audit families are exposed, eleven logical admissions are retained, and known and reserved cost stay at zero.

The worker failure exercises local process exit and controller reopen after real service work. The retained records are application-reported execution evidence. The qualification's result applies to the installed deterministic runner and synthetic task families.

## Retained evidence

- `summary.json` records shared baseline identity, first-release scores, service counts, and authority checks.
- `development-retry.json` records the rejected development aggregate and resulting retry candidate.
- `audit-registrations.json` and `alternate/audit-registrations.json` record each roster and actual exposures.
- `campaign-views.json` and `alternate/campaign-views.json` record controller decisions, state, and budgets.
- `*-outcome.json` files retain real fixture outcomes and references to immutable harness and feedback artifacts.
- `round-*-review-and-release.json` files bind audited candidates to reviewer promotions.
- `service-records.json` retains all seven comparisons and evaluations.
- `lost-report-acknowledgement.json` records the fault-worker operation and exit status.
- `campaign/`, `alternate/campaign/`, and `audit-lineage/` retain private checkpoints and artifacts. Each campaign's `evaluation-journals/` retains evaluator attempts, reports, and job evidence.

`application.ts` installs the application and service adapter. `run.ts` runs the campaigns and assertions. `execute-operation.ts` implements fault injection. The Python wrapper owns the temporary database, service, and credentials.
