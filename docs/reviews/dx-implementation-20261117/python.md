# Python evaluator review — 2026-11-17

Reviewed the uncommitted Python evaluator implementation against HEAD `52c1ce1`, the unchanged normative D2 plan, and the implementation evidence/contract. Independently inspected callback isolation, cancellation and ownership checks, durable writes, exact-body recovery, terminal identity, and bounded nonredirecting HTTP transport.

## Confirmed findings and fixes

1. **P1 — pending asynchronous work could become ordinary failed evidence.** Returning `ExecutionResult({Future(): "value"})`, a set containing a pending Future, or a list subclass containing one bypassed `_async_value`. JSON rejection then produced and submitted a failed comparison while the Future remained pending. The detector now traverses dictionary keys and values, sets/frozensets, and built-in container subclasses before JSON validation. Regression coverage exercises execute and grader explanations, confirms no sealed report/submission, and confirms retries never invoke another callback.
2. **P2 — equivalent terminal evidence could fail recovery.** Reversing a confirmed comparison's unique `expectedCases` and `results` arrays caused `evidence.identity_mismatch`, despite identical keyed evidence. Terminal reconciliation now compares these arrays by case/repetition identity while retaining all report wire assertions. A two-case regression confirms the original comparison is returned without callbacks and changed rewards still fail.
3. **P2 — internally hashed lifecycle bodies could contradict their journal.** A pending start body with a different attempt ID but matching recorded hash/size was sent before the owner mismatch was detected, claiming the wrong attempt. A finish body could likewise contradict its saved comparison/attempt. Body reads now verify their closed operation shape and exact saved identities before transport. Journal reads also validate canonical attempt/comparison IDs and printable bounded operation keys; body byte counts reject booleans. The regression injects precommit transport loss, changes the saved body and its metadata, and verifies both start/finish recovery refuse all additional mutations and callbacks.

## Files changed

- `python/acclimate/evaluation.py`
- `python/acclimate/_evaluation_journal.py`
- `python/tests/test_evaluation_core.py`
- This review report.

No edits to D2, client/types, packaging, or other agents' Python CLI/policy/artifact scope.

## Evidence and limits

Passed on Python 3.11.7, POSIX:

```sh
PYTHONPATH=python:python/tests /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 -m unittest test_evaluation_core test_evaluation_artifacts test_sdk
```

**46 tests passed**, including 26 evaluator core tests, artifact compatibility, real subprocess/cross-language flock exclusion, cancellation-held resources, directory fsync ordering, exact replay, committed oversized HTTP-response recovery, and existing redirect checks. The three new regression methods include multiple execute/grade/container and start/finish subcases.

An earlier full discovery run executed **77 tests with one failure** in the concurrently edited CLI regression `test_check_rejects_unbound_request_and_candidate_without_direct_parent` (`status == 0`, expected `1`, line 354). Reported to the coordinator/CLI owner; that scope is not changed here. This is a point-in-time result while other reviewers are editing the shared tree.

No unresolved finding remains in this agent's owned scope. No paid/live provider calls, deployment, commits, package builds, or release qualification were performed. Local deterministic tests do not establish external provider termination or power-loss durability on other filesystems.
