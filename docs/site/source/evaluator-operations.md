# Evaluator operations

The self-improvement loop and its app principal ship in a later phase. This release includes local evaluator tooling for application authors.

From the installed application module's directory, use `acclimate-eval describe` to print its public descriptor, `coverage` to inspect the inputs it fingerprints, and `try --payload PATH` to run one case against a local payload. For Python use `python -m acclimate` with the same commands. Keep cases, expected results and provider credentials in the application environment.

`pull` downloads a released payload, and `doctor` checks application setup and access. These commands take a private `--config` file. For example:

```json
{
  "schemaVersion": 1,
  "serviceUrl": "https://api.example",
  "workspaceId": "my-workspace",
  "evaluatorPrincipalId": "machine:app-tools",
  "evaluatorTokenFile": "/private/acclimate-token",
  "journalRoot": "/private/acclimate-journal"
}
```

Keep the config and token file readable only by their owner. Use a machine token scoped to the workspace. See the [CLI reference](../apps/docs/content/docs/reference/evaluator-cli.mdx) for commands and the [loop design](architecture/self-improvement-memory/evaluator-and-contracts.md) for the future evaluator contract.
