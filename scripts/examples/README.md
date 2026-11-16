# Example workspace

Seed a useful, persistent workspace for exploring the real console. These are ordinary API records in PostgreSQL, not frontend mocks.

```sh
.venv-bdd/bin/python scripts/examples/seed_workspace.py
```

The existing local production stack must be running. The script signs in through real Keycloak with the owner-only local credential file, calls the authenticated service APIs, and revokes its own session afterward. It never prints credentials or creates an authentication bypass. It makes no model calls and does not contact a payment or customer system.

The defaults target the existing loopback deployment. Run `--help` for paths and URLs; local credential use is limited to loopback hosts. The resulting nonsecret record IDs and links are saved to `.local/example-workspace.json` with owner-only permissions.

## What gets added

| Bundle | Files | Drafts | Purpose |
| --- | ---: | ---: | --- |
| Payment operations | 9 | 2 | Retry safety, refund review and escalation context |
| Customer support | 6 | 1 | Issue triage, specialist handoff and privacy |
| Code review | 6 | 1 | Correctness review, regression tests and review standards |

Each bundle starts with one explicit example release on `stable`. The script does not publish any draft. Files include instructions, multi-file skills and approved memory, so the tree has useful content to browse.

The payment retry candidate has six evaluations against the same saved parent and candidate:

| Example | Service state | What it demonstrates |
| --- | --- | --- |
| Improved | Completed | Paired scores improve from 0.50 to about 0.92 |
| Regressed | Completed | Paired scores fall from 0.50 to 0.25 |
| Incomplete | Failed | One missing grade and one missing expected case |
| Task failed | Completed | A gradeable task failure counts as score **0**, with an explicit error |
| Requested | Requested | Request created; no evaluator has claimed it |
| Interrupted | Interrupted | Operator stopped the example before execution |

Four comparisons are bound to their real request, attempt, parent, candidate and digests. Usage includes known zero cost and unknown usage. No fake progress or invented backend status is stored.

**All evaluation evidence is simulated.** Runtime metadata includes `source: simulated-example`, model `none` and executor `example-seed`. Dataset names, grader revision, output references and the bundle's memory file identify the examples. A completed request means the service accepted complete simulated evidence, not that a real agent benchmark ran.

## Safe reruns

The reserved workspace ID is `acclimate-examples`. The script checks its name and each bundle's example origin/source before touching it. It finds existing matching drafts and evaluation requests through paginated readbacks, then only creates missing seed records. Repeating a completed seed keeps the same bundle, draft, request and comparison IDs.

A changed example release, conflicting workspace identity or evaluation claimed by a different attempt causes the script to stop instead of replacing data. It never deletes data, edits an existing draft, changes memberships, issues a machine credential or touches another workspace. If you customize a seeded draft, the script may add the original example candidate again on a later run; it keeps your edited draft.

The initial local run and immediate repeat produced identical manifests: 3 bundles, 4 open drafts, 6 evaluations and 4 comparisons. The same IDs were confirmed by API readbacks. Authentication sessions and audit entries are expected to change between runs.

## Open the seeded data

- [Workspace](https://localhost:3443/w/acclimate-examples/bundles)
- [Payment content](https://localhost:3443/w/acclimate-examples/bundles/1536f1ec-986f-45d3-9393-4c4b47028513/channels/stable/content)
- [Payment changes](https://localhost:3443/w/acclimate-examples/bundles/1536f1ec-986f-45d3-9393-4c4b47028513/changes?channel=stable)
- [Improved evaluation](https://localhost:3443/w/acclimate-examples/bundles/1536f1ec-986f-45d3-9393-4c4b47028513/changes?channel=stable&draft=b11c60ca-4e57-49b2-bc50-c3a740ba52d5&generation=1&candidate=144ce3fb-e940-4bec-bfbd-46f50826c1f9&comparison=1389c935-0497-409d-b6dc-320035e58f0c)

These links refer to this local deployment. For another deployment, use the links printed by that run.

## Read-only browser captures

After building and starting the console, capture the actual persisted example routes with a frozen build hash:

```sh
.venv-bdd/bin/python scripts/examples/capture_workspace.py \
  --expected-build-hash <production-output-sha256> \
  --output artifacts/example-workspace-browser
```

This project runner signs in with the real Keycloak form in a fresh browser context. It captures improved, regressed, incomplete, zero-scored task failure and unselected evaluation views, content, changes, the bundle library, workspace menu and account dialog. It does not inject cookies, storage, DOM or focus, and it performs no content mutation. Identity sign-in creates its normal session/audit records. The runner checks that the production output stays unchanged, the pages have no horizontal overflow or application errors, and every evaluation view visibly identifies simulated examples. It stores no authentication state.

The final build pass captured all ten states successfully; see [browser proof](../../artifacts/production-redesign-final-examples/summary.json). The banner check reads the visible attribution paragraphs, including their icons; it does not depend on error text inside a collapsed request.
