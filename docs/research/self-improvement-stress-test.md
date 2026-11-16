# Self-improvement under larger tests

The harder tests changed the conclusion: improving instructions and memory helped, but the first learned setup still made unsafe and inconsistent decisions. A model-authored retrieval/calculation helper then passed a fresh large audit and SDK delivery check.

All runs used the real Rust API, PostgreSQL, version storage, proposal queue, SDK cache and Codex plugin. Every model turn used `gpt-6-luna`, with low reasoning effort and Codex SDK `0.169.0`. These are fictional payment-policy tasks; no payments were executed.

## Results

| Stage | Original setup | Learned setup | Outcome |
| --- | --- | --- | --- |
| Twenty-round final audit | 25/64 correct; 16 unsafe | 48/64 correct; 6 unsafe | Release blocked. |
| First large audit | 61/256 correct; 107 unsafe | 224/256 correct; 2 unsafe | Release blocked; 31/64 alternate-view contradictions. |
| Fresh large audit after helper repair | 58/256 correct; 122 unsafe | 256/256 correct; 0 unsafe | Passed; all 64 alternate-view checks consistent. |
| Fresh SDK job after release | 14/32 with pinned original | 32/32 with released files | Cache refresh and delivery passed. |

Each audit compares both setups on identical inputs and settings. The two large audits use different frozen inputs, so their scores are separate qualifications. Each large audit has **96 base events plus 32 alternate views**, repeated twice per setup. Repetitions and aliases are not independent incidents.

The twenty-round search made 20 proposal attempts: 18 reached paired development comparisons and eight were accepted. Two proposals used anchors absent from their original parent and were rejected. The best observed development scores reached 23/24, but the final audit still failed. More iterations did not establish reliable behavior by themselves.

## Why size mattered

Each large audit contains 12,288 receipt records across 176 files: about 5.8 MB of evidence. Each native job handles 32 views across 44 files. The agent must collect receipts from multiple JSONL shards, match their identity, ignore misleading records and apply 20 interacting policy rules.

The alternate views preserve authoritative facts while changing receipt order, customer notes and stale hints. They run in separate jobs. This exposed inconsistency that an aggregate accuracy score would miss.

This adds retrieval and input-normalization work as well as length. Efficient code can process the records without loading them all into model context. Dataset bytes are not model-token counts.

## What actually failed

- A generated loader compared the entire original request object with a receipt's five-field scope. Extra metadata made every match fail, and the agent still returned decisions.
- Some answers described the correct expiry or poll limit while returning a different action or delay.
- Single development pairs were noisy. Some parent responses omitted decisions and scored zero, making a candidate look better in that pair. Missing answers retained the full denominator.
- Rejected-candidate mistakes initially failed to reach the next proposer. The controller now retains those findings.

The first helper experiment also exposed test-harness defects: an incomplete input contract caused guessed field names, and an adoption detector rejected valid helper output preceded by inspected input text. Both were fixed before the qualified run. Those failed attempts remain saved.

## The useful artifact was a procedure

Luna wrote `skills/payment-triage/scripts/triage.py` through the service's proposal API. The operator supplied an empty allowed resource path on a private draft branch; the proposer filled it and updated `SKILL.md`. The original comparison baseline was unchanged.

The helper reads both input formats, joins receipts by incident ID, compares only account, operation, amount, currency and region, selects the unique trusted ledger receipt, and computes the complete decision object. It uses the same approved v2 policy as the earlier text-based candidates.

The corrected helper passed 56 development cases, including a distributed-file job. It then ran successfully in all eight candidate audit jobs. Its 256 computed objects and the agent's 256 raw final answers were independently correct. The grader never replaced final answers with helper output.

The delivered bundle has four real files: instructions, the skill, approved memory and the Python resource. The Rust service versions those files; the application retains its native agent runtime and tools. Python is a dependency of this example skill, not of the Rust service.

## Release proof

After the fresh audit passed, the test controller explicitly approved its disposable channel. The SDK's old channel cache was warmed immediately before promotion, then resolved to the new version. A fresh job used the learned helper on 32 separately frozen views and passed every decision. The pinned original scored 14/32. A stale release revision was rejected.

All 18 native jobs in that run had distinct thread IDs and unchanged pinned harness/input files. The audit and future-case IDs appeared in neither the proposer input nor the learned bundle. Existing application workspaces were untouched.

## Reproduce and inspect

- [Twenty-round search](../../examples/self-improvement/twenty/README.md): fixed policy, cumulative versions, acceptance decisions and plateaus.
- [Helper repair](../../examples/self-improvement/repair/README.md): bounded model-authored skill edits and development checks.
- [Large audit](../../examples/self-improvement/large/README.md): frozen data, exact gates and SDK delivery verification.

Private evidence is under `artifacts/self-improvement/`: `twenty-02`, `large-01`, `helper-01`, `helper-02` and `large-02`. Exploratory runs are retained too. The final four files are exported under `large-02/qualified-bundle/`, with provenance and a diff. The combined chart and round CSV are in `twenty-02/`.

Checks passed: 23 improvement tests, 100 package/SDK tests, package typechecking, 16 Rust unit tests and two proposal integration tests on owned PostgreSQL. Exact-anchor failures now have safe, actionable API messages; arbitrary provider details remain private.

The final audit used 16 SDK turns and delivery used two more. Its original pre-delivery counter was retained separately and the final summary corrected to 18; no scores changed. A turn can include multiple model/tool steps. Token usage is retained; USD cost remains unknown.

## Limits

This qualifies one synthetic v2 policy and the Codex/Luna integration through a local compatibility adapter. It does not establish broad agent improvement, other providers' behavior or real payment safety. Approved facts and trusted application grading remain necessary. Read-only native execution and static checks are not hostile-tenant isolation.

AgentRun's [learning bench](https://github.com/Parcha-ai/agentrun/blob/077b2fa1c831bdd2bbcb7ed7a0435914f48486b5/packages/serve/learn-bench/README.md) informed changed-rule and misleading-note tests. RRSI's [critic](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/critic.py) informed bounded repair and task-leakage checks. No upstream benchmark was executed.

The existing HTML docs export remains blocked by older layout links and unregistered review pages. This report is available directly as Markdown; the self-contained result chart needs no server.
