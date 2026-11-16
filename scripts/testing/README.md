# Disposable production fixtures

`production.service_env()` supplies mandatory production access configuration and
removes ambient service, console and database settings. Its JSON-stdin CLI supports
Node test runners without embedding secrets in command arguments. The caller must
supply the owned database URL and distinct authority credentials. Empty machine
grants are valid; browser identity still requires every production access field.

`productization.qualify.Harness` owns one private PostgreSQL cluster and real Rust
process. Existing fields (`env`, `tokens`, `dir`, `base`, `pg_port`, `project`) remain
available. It waits for `/ready`, never an existing or ambient database. `identity()`
adds a disposable TLS issuer, pins that issuer in the service, and restarts if the
pin changed. Machine tests never need a browser, issuer process or console.

`identity.IdentityFixture(directory)` exposes `issuer`, `client_id`,
`client_secret`, `ca_path`, `cert_path`, `key_path`, `register_client(origin)` and
`close()`. Optional `host`/`bind` support container gates. Its HTTPS discovery,
code exchange, PKCE proof, single-use codes and RS256 JWKS use disposable keys and
subjects that exist only in test code. `TLSProxy(directory, target, api_target)`
exposes `base`/`origin` and TLS paths; it strips forwarding headers and preserves
Host so the real console must reject noncanonical requests.

`bdd.browser.BrowserFixture` uses that issuer and TLS proxy for built or Vite
console startup, trusts the private issuer certificate through
`NODE_EXTRA_CA_CERTS`, and drives normal `/auth/login` browser authorization.
Disposable Chromium contexts use Playwright's context-wide `ignore_https_errors`
exception while visiting the generated test issuer and proxy. This is not
certificate pinning. Node still verifies HTTPS using the explicit fixture CA; no
production configuration disables TLS verification. `sign_in(context, subject)`
also supports native persistent Chrome contexts. It never injects session cookies.
Operator fixtures explicitly adopt their registered disposable project through the
production audited adoption route; ordinary roles use real memberships.

Run:

```sh
python3 -m unittest scripts.testing.test_identity
python3 scripts/testing/console_protocol.py --pg-bin /path/to/postgresql/bin
python3 scripts/productization/rust_tests.py --pg-bin /path/to/postgresql/bin
```

The protocol gate requires current Rust and console builds plus the BDD Playwright
environment. It exercises built and Vite entrypoints with actual discovery,
authorization code, token exchange, JWKS, signatures, state, nonce, replay,
rotation, logout and proxy Host checks. Console process fail-before-listen checks
are owned by `apps/console/tests/console-entrypoints.integration.ts` (the actual production
entrypoint and Vite command, not a wrapper). Test issuer success is protocol
regression evidence, never qualification of a live provider or public deployment.
