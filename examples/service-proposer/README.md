# Service proposer example

`workflow.ts` asks the service to generate and persist a bounded proposal, resolves and prepares both immutable versions with the SDK and native plugin, then independently grades the same two saved snapshots. Responses and reports are private files. `promote.ts --summary FILE` prints a review plan; add `--apply --expected-revision REV` only after review. See `scripts/full-roadmap/README.md` for the disposable fixture harness and the optional paid Codex SDK adapter.

`evaluation-adapter.ts` exposes these same installed snapshots and grader through the durable evaluation-request runner. The local helper selects it with `--adapter codex-luna-review --live`, using `nativeReviewDescriptor` and at most four bounded Luna turns. See [installed evaluation](../evaluation/README.md) for the public configuration and recovery rules. The model-free native seam test is labeled wiring-only and does not qualify native quality improvement.
