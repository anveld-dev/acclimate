# Local product qualification

Both runners create a private PostgreSQL cluster with test-owned credentials on an ephemeral port, run the real Rust binary on another ephemeral port, and stop/delete both on exit. They never load dotenv files or use an existing `DATABASE_URL`. No provider is configured and no model call is made.

```sh
python3 scripts/productization/qualify.py --pg-bin /path/to/postgresql/bin
npm run build --workspace @acclimate/console
python3 scripts/test_productization_browser.py --pg-bin /path/to/postgresql/bin
```

`qualify.py` checks the HTTP contract, restart persistence, exact snapshots, draft history, generation/revision conflicts, app-owned deterministic comparison execution, partial/failed evidence, evaluator ownership, interruption and reviewed publication. To reproduce a lost-response recovery, it intentionally discards a successful save response, expires the old idempotency row using SQL in its own cluster, restarts the service and looks up the saved operation ID. The same request must replay without creating a third draft generation, and different bytes must conflict. Another principal cannot obtain its result. The expired-cache clock is simulated; persistence and lookup are actual PostgreSQL/HTTP operations.

It also packs the SDK, installs the tarball in an external temporary consumer, then resolves the actual reviewed release, resolves an immutable pin and prepares its actual content on disk. Its private consumer configuration is deleted with the cluster.

`test_productization_browser.py` now forwards to the current browser BDD lane. It preserves `--pg-bin` and uses the isolated Behave/Playwright setup in the [behavior guide](../../features/README.md). This keeps the older command working with scoped routes, the new bundle tabs and the single change editor. The lane uses a real console, Rust service and disposable PostgreSQL; it makes no model calls.

These checks establish deterministic local contract behavior. They do not establish model quality, native agent content discovery, hosted identity/revocation, recovery from a production backup, or statistical improvement. The copied browser evaluator runs the installed model-free payment-policy adapter against frozen requests, reports per-case bound evidence and zero model cost, and requires explicit reviewer publication. The combined native walkthrough also installs packed SDK/native-plugin artifacts into an outside-checkout app, checks prepared bytes and optional receipts, and preserves earlier workspaces through rollback. This is deterministic orchestration evidence, not native model-quality evidence.

`rust_tests.py` runs the complete Rust test suite against a private cluster, setting all database test variables so new tests do not silently skip. `hosted_authority.py` checks configured Rust login/console authority, bootstrap, membership and revocation. It uses the trusted-adapter seam directly, not an external OIDC login; live provider/HTTPS validation remains required before hosted release.


`npm run qualify:local-recovery -- --pg-bin /path/to/postgresql/bin` starts a private PostgreSQL cluster, real Rust backend and built console. It stalls only that cluster's ownership backend, then separately terminates its connection. Both faults must produce backend-only recovery with the same console process and exact stored release; intentional shutdown must succeed. It never changes the user's running database. The same check is part of `npm run test:bdd -- --lane runtime`; process tests also cover exhausted retries, fatal errors, shutdown during backoff and budget reset after stable uptime.
