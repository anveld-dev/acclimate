# Compare release-feed instructions on real Git merges

The connected application turns repository merges into JSON entries. Release engineers can request a change-range entry that includes the Git range from the first parent to the merge. Standard entries keep the three-field format. A local grader checks the actual merge number, SHA and second-parent title from Git, plus the exact range when requested.

Run from the repository root with Node, installed npm packages, a signed-in Codex CLI and a running Acclimate deployment. The operator JSON provides `baseUrl`, `workspaceId`, `scope` and `token` for a machine grant with read, write and promote permission. The connection JSON provides separate `content-read` and `receipt-write` tokens issued to the release-feed connection. Both credential files need owner-only permissions. The prior run summary supplies `project`, `bundle`, `integration` and `freshVersion`. The delivered bundle must contain `instructions/release-feed.md`.

```sh
./node_modules/.bin/tsx examples/release-feed/compare-range.ts \
  .local/live/operator.json \
  artifacts/live-release-feed/connection.private.json \
  artifacts/live-release-range-complete/summary.json \
  artifacts/live-release-range-next \
  TEACHING_SHA AUDIT_SHA_1 AUDIT_SHA_2 FRESH_PROBE_SHA
```

Replace the four SHA arguments with distinct GitHub PR merge commits present in the local Git repository. Select unseen commits for an independent result. Choose a new output directory for each run. The app freezes the inputs before it calls either model. Sol sees only the teaching outcome and correction. Luna executes both content versions on the two held-out PRs in both feed formats. The request URL appears as soon as the candidate exists. The evaluator sends progress before each execution, after grading, and before submitting the comparison. Each run uses up to eleven paid model calls. A timed-out run retains its evidence.

The app releases only a complete, strictly improved candidate that passes all four held-out cases. The release checks the current revision. A fresh consumer then resolves the same connection and scores the fourth PR using the released instructions. A tie keeps the current release. The output directory retains the frozen Git data, native call evidence, service progress observations, comparison and final summary. Subsequent runs can read that summary as their prior run.
