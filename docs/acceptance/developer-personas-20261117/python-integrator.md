# Python integrator acceptance

This is a role-play of the original Python integrator, not observed user research.
Acceptance criteria were defined before running the consumer:

1. Install the operator-managed wheel into an external Python 3.11 environment; run an application-owned two-case task with version-dependent instruction, skill and approved memory consumption and an independent grader. Use its public descriptor/handoff against actual Rust/PostgreSQL.
2. Prove the consumer runs with Python-only PATH, no Node and no third-party runtime dependency; distinguish deterministic simulation from model evidence.
3. Exercise real-service recovery after an injected lost submit response; retain identical submission key/body and execute no completed callback again. Rerunning a sealed terminal request must execute no callbacks.
4. Exercise whole-lifetime asyncio thread offloading against a real service: unrelated heartbeat remains responsive; two caller cancellations signal cooperative cancellation without releasing prepared input or its lock before the callback is quiescent; future callbacks stop and terminal retry remains sealed.
5. Confirm infrastructure and grader failures remain distinct in a real paired comparison.
6. Check installed typing with strict positive/negative fixtures and inspect wheel distribution guidance.

Run completed successfully on 2026-11-17, using the existing checksummed operator release and existing Rust binary with isolated PostgreSQL 16. The executable consumer and fixture driver are staged from `scripts/acceptance/dx_personas/python_integrator.py`. Public IDs, scalar results and hashes are in [python-integrator.json](python-integrator.json). Private callback outputs, configuration, journals and captured command logs remain under ignored `artifacts/dx-personas-20261117/python-integrator/`.

| Criterion | Result | Evidence |
| --- | --- | --- |
| 1. Python-owned task, independent grader, real pairing | Accepted | Two saved support tickets; parent routes everything to general, candidate follows the routing skill. Approved VIP memory supplies priority. Four execution and four grading callbacks produced a complete Rust-bound comparison: parent mean reward 0.5, candidate 1. Expected answers stay in grading and never enter task inputs. `describe` supplied the public descriptor; installed `request` produced the immutable public handoff; `doctor` was ready. |
| 2. Python-only installed runtime | Accepted | Fresh Python 3.11 venv installed the wheel with `--no-index --no-deps`; imported SDK resolved inside that venv's site-packages. Every consumer command ran with PATH containing only its venv bin directory. `shutil.which('node')` returned none, and installed SDK metadata declared no runtime dependencies. |
| 3. Durable retry and terminal sealing | Accepted | A controlled application transport wrapper discarded the first submit result **after the real Rust HTTP mutation returned**. Runner surfaced `submission.unconfirmed`; same-journal recovery submitted the identical saved body and key. Callback count stayed at eight after recovery and after another sealed terminal retry. The JSON records the saved body hash. This is injected response loss following an actual commit, not a claim that a network outage occurred. |
| 4. Async responsiveness and cancellation lifetimes | Accepted | Used `run_in_thread_until_quiescent` from the actual extracted release's `async_eval.py`, with the whole installed `run_evaluation` lifetime and real service. Both cooperative cancellation and a callback that ignores cancellation until it returns received two caller `cancel()` calls. The event loop advanced 24 heartbeat ticks per run; the active prepared input and kernel lock remained held until release. Caller cancellation surfaced only after the worker settled and cleaned its files. Each comparison sealed failed; only the first executor ran, with no graders or future executors. Re-reading each terminal request ran no callbacks. |
| 5. Failure classification | Accepted | Separate real comparison retained parent `infrastructure_failed` and candidate `gradingStatus: failed`, with terminal evaluation failed. Private exception text was absent from the public report. |
| 6. Typing and obtaining a wheel | Partial | Pinned mypy 1.18.2 in an isolated developer-tool venv checked the actual installed wheel with `--strict --python-executable <consumer-python>`. Positive lifecycle calls, generic callbacks and typed result assertions passed via `acclimate.client.AcclimateClient`. Deliberate `attempt_id`, missing finish `comparisonId`, invalid status and invalid grader return all failed with the expected static diagnostics. The documented `from acclimate import AcclimateClient` itself fails strict checking with `attr-defined`, because that root import is not explicitly exported for strict mypy. This is a concrete remaining typing issue; submodule import works. The new getting-started/operator guides explain obtaining the release; `python/README.md` still opens by assuming a wheel exists, without linking back to the canonical obtaining/build guide. |

Reproduce from the checkout, using the existing release and prebuilt service (no build is performed):

```sh
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 scripts/acceptance/dx_personas/python_integrator.py --output artifacts/dx-personas-20261117/python-integrator
```

The static follow-up reused the retained installed consumer without starting another service:

```sh
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 scripts/acceptance/dx_personas/python_integrator.py --typing-existing artifacts/dx-personas-20261117/python-integrator/python-integrator-tcxdnw6q
```

This is an application-owned deterministic task simulator, not a model-backed agent or a provider-quality claim. It exercises actual service requests, exact version payloads, filesystem preparation, independently graded application behavior, durable evidence and recovery. The fixture does not attest that the existing service binary was built from the reviewed source; both source inventory and binary hashes are recorded. The SDK was installed offline from the release. The static follow-up downloaded mypy 1.18.2 and its developer-tool dependencies from public PyPI into a separate tool venv; the consumer runtime remained unchanged. No paid/provider calls, product changes, release/promotion, or production resources were involved. Console visibility was not inspected in a browser; service GET verified each bound comparison.

Initial local driver iterations caught two consumer/setup mistakes: using prepared `path` instead of `absolutePath`, and leaving the private command-intent parent at 0755. Both were corrected in this persona driver before the successful run. A further local assertion incorrectly rejected a venv located beneath the workspace; it was replaced with the meaningful site-packages/venv provenance check. None required product edits.
