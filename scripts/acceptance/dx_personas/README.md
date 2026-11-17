Developer persona acceptance uses `support.PersonaFixture` with an existing verified
release and real PostgreSQL/Rust service. Run acceptance with Python 3.11 or newer.
No build, model call, deployment, or SDK import from checkout is performed here.

```python
with PersonaFixture('example', output) as fixture:
    setup = fixture.bootstrap()
    app = fixture.install_js(plugin='codex')  # optional local release plugin
    descriptor = fixture.run(['node', 'acclimate-eval.mjs', 'describe'], cwd=app)
```

`install_js(name='app', starter='evaluation', plugin=None)` returns the extracted
starter app directory and installs the release SDK offline with an explicit npm
package boundary and `--prefix`. Missing package manifests are created in the app.
SDK resolution must stay inside the consumer node_modules, and all installed SDK
and selected plugin files are hashed against the release archive. Sanitized proof
is available at `installation_proofs[name]` (and retained privately).
Plugin accepts `codex`,
`codex-plugin`, or `@acclimate/codex-plugin` (likewise claude/pi/cursor).
`install_python(name='app', starter='evaluation')` returns `(app, venv_python)` and
installs the release wheel with no index or dependencies. Both starter selectors
also accept `ci` and `native-repository`.

For a fresh release use `PersonaFixture(..., release=Path(...),
source_sha256='<expected inventory SHA256>')`. Arguments override
`ACCLIMATE_PERSONA_RELEASE` and `ACCLIMATE_PERSONA_SOURCE_SHA256`; unset values retain
the historical review release and fingerprint. Selection happens before application
environment cleanup. Set both environment variables for existing drivers. The
manifest, checksums, and every release artifact are verified on construction,
before startup, and before installation; manifest/checksum hashes must stay fixed.
`release_manifest_sha256` and `release_checksums_sha256` expose those identities.

All npm installs require the app's own package.json, matching `--prefix`, and
`--workspaces=false` (the fixture adds the last flag). `consumer_root` is a physical
external directory, allocated separately when `output` is within the checkout.
Never reconstruct the app path from `root`; retain the returned app path or use
`consumerDirectory` from private/fixture.json. Consumer directories are retained.
The Python proof verifies isolated import resolution and every wheel file's bytes
except RECORD, which pip rewrites. Its proof also appears in installation_proofs.

`root` is a newly allocated canonical owner-only directory beneath `output`;
consumer files, configs, command stdout/stderr, and service output stay there after
context exit. `h` is the existing productization Harness with its own disposable
PostgreSQL database; `h.close()` removes that database. `private/cleanup.json`
records removal and stopped-service evidence. `h.call`, `h.sql`, `h.env`, `h.tokens`,
and `h.restart()` are available for explicitly owned operator scenarios.
`base_url`, `project`, `release`, `manifest`, `clean_env`, `service_sha256`,
`evaluator_config`, and `reader_config` are stable fixture properties. Evaluator
principal is `evaluator`; reader is a separate project principal with read rights.

`bootstrap(payload=None, name=...)` uses the distributed evaluation baseline by
default and returns bundle setup JSON. `write_json(path, value)` writes a new
private JSON file inside `root` with mode 0600. `run(command, cwd, expected=0)`
returns parsed JSON stdout, or None for empty output; stdout/stderr are private.
Its safe summary stores executable name, argument count, and exit codes only.
Environment removes ambient Acclimate/console configuration, Node injection,
Python paths, database settings, and ambient API key/token/secret/password variables.
`sdk_env` retains Codex/OpenAI API key and CODEX_HOME overrides plus basic
HOME/PATH/temp/locale/shell settings for an explicitly authorized live Codex SDK's
`env` option. Keep them in private config and pass them
only to that SDK, never the service or ordinary subprocess environment. Do not pass
secrets on command arguments.

Release checksums and source inventory are verified. The actual existing service
binary is hashed and checked again before startup. This records the tested binary;
it does not claim that the release source inventory attests its compilation.
Persona reports must sanitize private fixture data before sharing results.
