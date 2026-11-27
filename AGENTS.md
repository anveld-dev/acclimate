# Acclimate development checks

Install Node dependencies with `npm ci --ignore-scripts`. For the full lint suite, install Ruff with `python3 -m pip install -r scripts/lint-requirements.txt`, install ShellCheck and actionlint on `PATH`, and install the Rust `rustfmt` and `clippy` components. CI uses actionlint v1.7.12, which you can install with `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`.

Run `npm run lint` from the repository root before handing off a change. Use a focused command while working.

| Command | Checks |
| --- | --- |
| `npm run lint:js` | JavaScript, TypeScript, React and JSX accessibility, including unhandled promises, focused tests and package import boundaries |
| `npm run lint:python` | Python syntax, undefined names, duplicate definitions and common control-flow bugs |
| `npm run lint:workflows` | GitHub Actions workflows and repository shell scripts |
| `npm run lint:format` | JSON configuration, workspace manifests and workflow formatting |
| `npm run lint:docs` | Built documentation links and generated source freshness |
| `npm run lint:rust` | Rust formatting and Clippy across all targets |

Run `npm run typecheck` and the relevant behavior tests for your change. See [development checks](docs/development.md#checks) for the integration suites.

- Await or return promises that affect request completion, storage, or cleanup. When starting intentional background work, handle rejection where the work starts.
- Use public `@anveld` entries in the console and installable starters. Keep optional provider SDKs behind the plugin's native entry and use the installed-consumer checks when changing package exports.
- Review React hook dependency warnings in the files you change. Existing warnings are advisory because those effects control request and recovery lifecycles.
- Regenerate checked-in site exports when the docs check reports drift. Run `python3 scripts/build_docs.py` with the dependencies in `scripts/docs-requirements.txt` installed.
