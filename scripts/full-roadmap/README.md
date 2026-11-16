# Full roadmap qualification

Install workspace dependencies first. The public commands create their own private PostgreSQL cluster on an ephemeral port, set all service database configuration explicitly, and delete only that cluster on exit. They do not use an ambient `DATABASE_URL`:

```sh
npx tsx --test scripts/full-roadmap/fixture.test.ts
npm run qualify:full-roadmap -- --output /new/private/model-free-evidence
```

Pass `--pg-bin /path/to/postgresql/bin` if server binaries are not autodetected. `--output` must be a new directory; successful evidence and the run log remain there with owner-only parent permissions. The wrapper builds the Rust binary unless `--skip-build` is supplied.

The default uses only a deterministic fake model. Each run creates a fresh project, bundle and `fixture` channel. It checks the persisted service proposal, paired app-owned comparison, explicit fixture review and promotion, next-job refresh, old workspace pin, stale revision denial, promotion history and rollback. The printed private directory contains before/after payloads, the changed text, individual responses and the complete report. Retain or delete it deliberately.

Use `npm run qualify:full-roadmap:live -- --output /new/private/luna-evidence` to authorize **up to five paid gpt-6-luna turns**: one draft and four executions over two saved snapshots. There is no model fallback. The local authenticated loopback adapter translates the Rust service's OpenAI-compatible request to the official Codex SDK using existing application authentication. It is a qualification adapter, not a production gateway, a native CLI supervisor, or a direct vendor API qualification. Each draft has a 55-second deadline, each evaluation 110 seconds, and the entire process has a nine-minute limit. The native sessions are read-only, with approval disabled and network access disabled. Errors and missing grades remain in the report; an incomplete comparison is never promoted. Cost remains unknown. The fixture experiment is too small to establish a quality improvement.

The explicit `fixture-reviewer` acts only on the fresh disposable fixture channel. For real operator use, inspect the saved review artifacts and use `examples/service-proposer/promote.ts --summary FILE` to print a plan; promotion requires `--apply --expected-revision REV` and scoped environment credentials. No existing user channel is promoted by this qualification.


The fixture drives the actual operator CLI for verified review, explicit promotion, history paging and rollback. It checks the changed skill bytes in the next workspace and proves the original workspace still contains its original skill. The process deadline aborts SDK calls and cleans up the service; normal exit also waits for service shutdown. `proposal.json`, `operator-review.json` and `release-checks.json` preserve the service and operator records alongside the comparison artifacts.
