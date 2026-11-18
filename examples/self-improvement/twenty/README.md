# Twenty-round learning test

Start with the actual setup that passed `live-04`. Give it a harder, fixed v2 provider contract and let it propose **20 successive candidates**. Each proposal starts from the last accepted version. Rejected candidates stay in the history.

This measures a learning curve, including regressions and plateaus. It does not require 20 failures or 20 accepted changes. All approved policy facts are available from round one; facts are not withheld to manufacture extra teaching rounds.

## What makes it harder

The old memory says keys last 900 seconds. V2 has different lifetimes for two providers, uncertainty-aware timing and a five-field scope. The agent must also select a verified ledger receipt by sequence, ignore misleading caches and notes, resolve contradictory evidence, and apply cancellation, holds, retry limits and cooldowns in the right order.

Each answer must name the exact receipt and key, calculate the exact wait delay, and choose an action. Correct prose alone cannot pass. The final audit combines rules in new ways and uses currencies and regions absent from development.

## Run

```sh
npm run qualify:self-improvement:twenty -- \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output artifacts/self-improvement/my-twenty-round-run
```

Requires the same [tools and Codex authentication](../README.md) as the smaller qualification. This makes paid Luna calls. A complete run with valid proposals uses 120 Codex SDK turns; the cap is 128, with a 90-minute process deadline. Each SDK turn may contain multiple model/tool steps, so this is not a raw API-request or dollar limit. No other model is used.

## One round

1. Supply the approved contract plus recent development mistakes to the real Rust proposer.
2. Save its child version. Reject task/account/receipt identifiers and evaluation references in reusable content.
3. Run both the current best and candidate against the same 24 development incidents, in fresh native threads.
4. Record the bound evaluation and comparison through the real API.
5. Accept only complete evidence with no new unsafe decisions, no lower correct count, and no higher unsafe count. Then require more correct answers, fewer unsafe answers, or fewer bytes at equal quality.
6. Explicitly release accepted versions on the disposable `working` channel. Keep the current version when a proposal regresses, fails, or adds text without improving behavior.

The two development batches are reused for tuning. Their scores are noisy, and selecting winners adaptively can overestimate quality. Every round measures both arms again; the final audit stays separate.

## Final audit and delivery

After round 20, freeze the selected file bytes. Preserve the cumulative history, then create an identical release snapshot directly under the original published parent. This lets the final original-versus-learned comparison satisfy the service's exact parent binding.

Run 32 audit incidents twice per arm: **64 decisions per setup, not 64 independent incidents**. The preregistered release gate requires at least 90% exact answers, zero unsafe decisions and a higher score than the original setup. Missing execution or grading blocks release. Audit answers never enter another proposal in that experiment.

Warm the original SDK channel cache, explicitly release the qualified snapshot, then fetch through that same cache. A fresh job must pass all eight new incidents and beat a pinned-original control. Reject a stale release revision too.

“Unsafe” here means an incorrect retry, completion or cancellation, including reuse of an incorrect key or receipt for a retry. This is a narrow test rubric, not a guarantee of real payment safety.

## Evidence

- `experiment.json`, `frozen-dataset.json`: criteria and all fixtures fixed before model calls.
- `progress.json`: rounds completed, current selected version and SDK turn count.
- `round-NN*.json`: proposals, native comparisons, acceptance decisions and lineage.
- `runs/`: native outputs, commands, usage, warnings and thread IDs.
- `final-audit-evaluation.json`: repeated original-versus-learned audit.
- `release-candidate.json`, `final-review.json`, `future-job.json`: exact files, explicit approval and delivery proof.
- `summary.json` or `failure.json`: final result with failures retained.

The service and PostgreSQL cluster are disposable. Existing application workspaces and channels stay untouched. The model only sees prepared files and current task inputs. Read-only mode and disabled network are useful limits, but are not hostile-tenant isolation.

`domain.ts` owns the app's independent fixtures and grader; `run.ts` owns the bounded experiment. `starter.json` records the earlier model-generated files and their source digest, verified by the actual service on import. This is still one synthetic policy domain. The evidence applies to Codex/Luna through the local proposer adapter.
