# App-owned improvement review

This example uses the official Codex SDK to revise one existing skill file with `gpt-6.2-sol` and create a child with `createVersion`. It resolves and verifies the channel parent, uses two saved application-selected snapshots, grades responses against the separately held trusted expectations in `grader.ts`, uploads the paired report, and stops for human review. The two cases demonstrate wiring only; their scores cannot establish statistical improvement and the candidate need not win.

Use a disposable workspace, bundle and channel, seeded with a parent containing a review skill. Set `ACCLIMATE_URL`, `ACCLIMATE_TOKEN`, `ACCLIMATE_SCOPE`, `ACCLIMATE_PROJECT`, `ACCLIMATE_BUNDLE`, `ACCLIMATE_CHANNEL`, and `ACCLIMATE_SKILL_PATH`. `ACCLIMATE_BASE_URL`, `ACCLIMATE_PROJECT_ID`, and `ACCLIMATE_BUNDLE_ID` are alternative names for URL, project, and bundle. Optionally set `ACCLIMATE_CODEX_MODEL` to `gpt-6-luna` (default) or `gpt-5.6-luna` for reviews, and `ACCLIMATE_OUTPUT_DIR` to a private directory. The SDK uses existing Codex app authentication; the script does not inspect credentials.

```sh
npx tsx --test scripts/improvement-tests/*.test.ts  # offline, fake callbacks
npx tsx examples/improve-review.ts run --live       # explicitly paid, at most five turns
```

Each turn uses a fresh private prepared workspace, a read-only native sandbox, disabled network and web search, and a 110-second timeout. One Sol turn drafts the skill and four Luna turns review the paired cases. The run stores private response evidence, verified cache and `summary.json` under the output directory (created with mode 0700; an existing directory must already be private). The directory also contains `parent-payload.json`, `candidate-payload.json`, and `skill-change.json` with the exact before/after text. The summary identifies versions and digests, channel revision, comparison, dataset and grader revisions, author model, review model, SDK version, sample count, per-case outcomes, and unknown cost. Evidence references are local file URIs: retain the directory for review; other machines cannot resolve these paths automatically. Failed executions and malformed answers remain visible as missing or failed grades, and may make the comparison incomplete.

Review the saved skill and every case response before deciding whether to release. Print the proposed action with:

```sh
npx tsx examples/improve-review.ts promote --summary /private/path/summary.json
```

After explicit review, releasing requires both `--apply` and `--expected-revision REV`. The service checks the revision, parent and complete matching comparison. A stale or incomplete report cannot promote. Example:

```sh
npx tsx examples/improve-review.ts promote --summary /private/path/summary.json --apply --expected-revision REV
```
