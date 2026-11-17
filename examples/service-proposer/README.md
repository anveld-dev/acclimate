# Service proposer example

`workflow.ts` asks the service to generate and persist a bounded proposal, resolves and prepares both immutable versions with the SDK and native plugin, then independently grades the same two saved snapshots. Responses and reports are private files. `promote.ts --summary FILE` prints a review plan; add `--apply --expected-revision REV` only after review. See `scripts/full-roadmap/README.md` for the disposable fixture harness and the optional paid Codex SDK adapter.

With the [improvement example's connection settings](../improvement/README.md), run `npm run example:improve -- run-service --live` to authorize a proposal through the configured service provider and up to four Codex reviews. Configure `ACCLIMATE_MODEL=gpt-6.2-sol` on the service for Sol drafting. The reviews default to `gpt-6-luna` and read their override from `ACCLIMATE_CODEX_MODEL` on the app.

`evaluation-adapter.ts` exposes these same installed snapshots and grader through the durable evaluation-request runner. The local helper selects it with `--adapter codex-luna-review --live`, using `nativeReviewDescriptor` and at most four bounded Luna turns. See [installed evaluation](../evaluation/README.md) for the public configuration and recovery rules. The model-free native seam test is labeled wiring-only and does not qualify native quality improvement.
