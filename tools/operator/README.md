# Acclimate operator CLI

Use `acclimate-operator` from the TypeScript SDK to inspect comparisons and release history or request a standalone proposal. Set `ACCLIMATE_URL`, `ACCLIMATE_TOKEN`, and `ACCLIMATE_SCOPE` for the workspace.

```sh
acclimate-operator review --workspace WORKSPACE --bundle BUNDLE --channel stable --comparison COMPARISON
acclimate-operator history --workspace WORKSPACE --bundle BUNDLE --channel stable
```

Review verifies the parent and candidate digests and displays file changes, paired scores and recorded quality checks. Connected learning controls delivery after the initial release. [Connected learning](../../contracts/learning.md)

Use `--help` for options and `npm run test:operator` to run the CLI tests.
