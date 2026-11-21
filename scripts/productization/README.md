# Local product qualification

Both runners create a private PostgreSQL cluster with test-owned credentials on an ephemeral port, run the real Rust binary on another ephemeral port, and stop/delete both on exit. They never load dotenv files or use an existing `DATABASE_URL`. No provider is configured and no model call is made.

```sh
python3 scripts/productization/qualify.py --pg-bin /path/to/postgresql/bin
npm run build --workspace @acclimate/console
npm run test:bdd -- --lane browser --pg-bin /path/to/postgresql/bin
```

`qualify.py` checks workspace scope, immutable version uploads and channel releases. It recovers an upload by its original operation key after service restart and simulated expiration of the short-lived receipt. The same bytes replay, a different principal cannot recover the result, and changed bytes conflict.

It also packs the SDK for an external temporary consumer to resolve the release, fetch an immutable version and prepare content.

`rust_tests.py` runs the complete Rust test suite against a private cluster, setting all database test variables so new tests do not silently skip. `hosted_authority.py` checks configured Rust login/console authority, bootstrap, membership and revocation. It uses the trusted-adapter seam directly, not an external OIDC login; live provider/HTTPS validation remains required before hosted release.


`npm run qualify:local-recovery -- --pg-bin /path/to/postgresql/bin` starts a private PostgreSQL cluster, real Rust backend and built console. It stalls only that cluster's ownership backend, then separately terminates its connection. Both faults must produce backend-only recovery with the same console process and exact stored release; intentional shutdown must succeed. It never changes the user's running database. The same check is part of `npm run test:bdd -- --lane runtime`; process tests also cover exhausted retries, fatal errors, shutdown during backoff and budget reset after stable uptime.
