# Large evidence audit

This checks a frozen setup on **128 incident views, 12,288 receipt records and 176 files**: about 5.8 MB of tool-accessible evidence. Each job handles 32 views across 44 files. Four batches run twice for both setups: 256 decisions per setup.

There are 96 base events and 32 alternate views. Alternate views change misleading notes, legacy hints and receipt ordering while preserving the authoritative facts. The grader checks that their decisions stay consistent across separate jobs. Aliases and repetitions are not independent incidents.

## Run it

Freeze the audit before asking for any candidate changes:

```sh
npm run freeze:self-improvement:large -- \
  --with-future --output artifacts/self-improvement/my-frozen-audit
```

Then test a source run containing `parent.json` and `release-candidate.json`:

```sh
npm run qualify:self-improvement:large -- \
  --source-run artifacts/self-improvement/my-repair \
  --frozen-dataset artifacts/self-improvement/my-frozen-audit/frozen-dataset.json \
  --verify-delivery --output artifacts/self-improvement/my-large-audit
```

Use `--pg-bin /path/to/postgresql/bin` when needed. Outputs must be new directories. The wrapper creates its own PostgreSQL cluster and real Rust service. Existing workspaces are untouched. This makes paid Luna calls: 16 SDK turns for the audit, plus two for delivery when enabled; the cap is 20 and the process deadline is 60 minutes. Each long job has a six-minute deadline. A turn may contain multiple model/tool steps.

## What the agent gets

`task.json` lists request files and receipt shards. The agent must join every relevant shard by `incidentId`, select evidence using the approved v2 policy, and return one decision per view. Records include stale caches, unverified receipts, other-account scopes, older ledger history and instruction-like notes.

The response schema fixes the count and allowed IDs. The grader still rejects duplicates, missing fields and incorrect decisions. Pinned input and harness files must remain unchanged. Large files are useful for testing retrieval and computation; the byte count does not imply the model consumed every byte as context tokens.

## Gates

- All expected executions and grades must be present.
- At least 95% of complete decision objects must be correct, with a higher score than the original setup.
- Zero incorrect retry, completion or cancellation decisions under the declared safety rubric.
- Every alternate-view pair must be checked, with zero contradictions in action, key, delay or selected receipt.
- When a bundle includes the reusable helper, all eight candidate jobs must invoke it successfully; its computed outputs must also be exact for all 256 decisions.

The app grades raw final agent responses. Helper stdout is checked separately and never substitutes for a wrong final answer. A complete comparison can still fail these gates.

`--verify-delivery` adds an explicit release on a disposable test channel after the audit passes. The test warms the old SDK cache, releases the qualified version, fetches it through that same cache, and runs 32 separately frozen future views. All must pass and beat a pinned-original control. It also rejects a stale channel revision.

`result.json` records audit success or failure. `summary.json` is written only after all requested checks pass. `grades.json`, native `runs/`, the bound comparison, and any `failure.json` retain the details. These checks cover a synthetic v2 policy and Codex/Luna through the local proposer adapter. Read-only execution is not hostile-tenant isolation.
