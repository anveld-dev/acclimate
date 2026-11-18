# Operator commands

Set `ACCLIMATE_URL`, `ACCLIMATE_TOKEN`, and `ACCLIMATE_SCOPE` in the environment. Use a scoped service principal and a trusted TLS endpoint. Each command needs `--project` and `--bundle`; commands involving a channel also need `--channel`. Run with `npm run operator -- COMMAND ...` (or `npx tsx tools/operator/cli.ts COMMAND ...`). All output is JSON: pretty by default, compact and stable in structure with `--json`. Errors go to stderr and return a nonzero exit status. Terminal controls in displayed strings are escaped.

```sh
npm run operator -- request-proposal --project PROJECT --bundle BUNDLE --parent VERSION --path skills/retry-review/SKILL.md --hypothesis 'Improve review' --evidence 'Observed failure'
npm run operator -- proposal --project PROJECT --bundle BUNDLE --id PROPOSAL
npm run operator -- review --project PROJECT --bundle BUNDLE --channel live --comparison COMPARISON --proposal PROPOSAL
npm run operator -- history --project PROJECT --bundle BUNDLE --channel live --limit 20
npm run operator -- history --project PROJECT --bundle BUNDLE --channel live --before REVISION
npm run operator -- promote --project PROJECT --bundle BUNDLE --channel live --version CANDIDATE --comparison COMPARISON --expected-revision REVISION
npm run operator -- rollback --project PROJECT --bundle BUNDLE --channel live --version PREVIOUS --reason 'Regression observed' --expected-revision REVISION
```

`--path` and `--evidence` may be repeated. A proposal is asynchronous; read its status until complete. Review fetches immutable parent and candidate payloads, verifies their SHA-256 digests, checks their relationship and comparison identity, and optionally checks the proposal identity. It shows current channel revision, bounded before/after text (up to 4096 characters per side per changed file), and comparison scores, failure and missingness counts, sample sizes, and known usage totals with unknown counts. Output references are displayed as untrusted text and never fetched. Scores are app assertions, not proof of improvement. Review is read-only and cannot promote.

Review output includes the evaluator verdicts recorded for the selected comparison and blocking policy receipts on the candidate. Review the failed or unknown checks before deciding. To record an authorized override on `promote`, supply `--override-reason "$REASON"` and repeat `--ack-policy "$COMPARISON_ID@$POLICY_DIGEST"` for each blocking receipt you reviewed. The service validates the set at publication time and records the decision in release history.

Promote and rollback are explicit mutations. Copy the current revision from a fresh review; the service enforces permissions, evidence eligibility, and compare-and-swap. Rollback requires an unevaluated reason. Supply `--key KEY` to mutations when retrying the same operation; otherwise a fresh random idempotency key is generated. A changed request must use a new key.

`--output PATH` writes the displayed JSON to a new file only. The containing directory must already exist, be owned by the current user and private (mode 0700 or stricter), and its path must contain no symlinks. Files are created exclusively with mode 0600; existing files are never overwritten. Treat reports as sensitive. No local cache or automatic artifact directory is created.

Offline tests: `npm run test:operator`.
