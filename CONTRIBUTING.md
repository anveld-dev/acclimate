# Contributing to Acclimate

## Set up a development checkout

From the repository root, install Node dependencies with `npm ci --ignore-scripts`. Follow the [development checks in AGENTS.md](AGENTS.md) to install the lint tools and the [development guide](docs/development.md) to set up Rust, PostgreSQL and the console. Use a disposable database for tests that need PostgreSQL.

## Open a pull request

- Describe the issue or use case, what changed, and how you verified it. Link an existing issue when there is one.
- Keep the change focused. Update tests and documentation when behavior or configuration changes.
- Before opening a pull request, run `npm run lint`, `npm run typecheck`, `npm test` and the [checks relevant to your change](docs/development.md#checks). List any checks you could not run.
- When a source change affects the checked-in HTML export, install the docs build dependencies with `python3 -m pip install -r scripts/docs-requirements.txt` and run `python3 scripts/build_docs.py`. Include the updated export and verify it with `npm run lint:docs`.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the [security policy](SECURITY.md).

## Contribution license

By submitting a contribution, you agree to license it under the [Apache License 2.0](LICENSE), the same license Acclimate uses to distribute contributions. Contributions require no Developer Certificate of Origin (DCO) sign-off.

## Project records

- [Qualification records](docs/implementation/full-roadmap.md)
- [Connected-learning audit experiment](docs/research/real-app-learning-experiment/5-admission-rerun.md)
