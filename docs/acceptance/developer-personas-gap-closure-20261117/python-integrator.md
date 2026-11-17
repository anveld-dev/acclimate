# Python integrator gap-closure acceptance

This is a role-play of the original Python integrator, not observed user research. The original [report](../developer-personas-20261117/python-integrator.md) is retained. These criteria were fixed before the fresh-release retest:

1. Install the newly verified release wheel offline with no dependencies into a physically external Python consumer. Run its own two-case ticket-routing task and independent grader against actual Rust/PostgreSQL, consuming version-dependent instructions, skill and approved memory.
2. Prove that ordinary consumer commands have no Node on PATH, the SDK resolves inside the external venv site-packages, installed SDK content matches the release wheel, and runtime dependencies are empty.
3. Inject submit-response loss after the actual service mutation. Recover with exactly the same report bytes and key, execute no completed callback again, and execute no callbacks when retrying a sealed terminal request.
4. Run the extracted complete async recipe against the actual service. Two caller cancellations must preserve heartbeat responsiveness and hold prepared inputs and their kernel lock until both cooperative and cancellation-ignoring callbacks quiesce. No later executor or grader may run; terminal rereads must remain sealed.
5. Keep infrastructure execution failures and grading failures distinct in actual paired evidence.
6. Check every documented root import and native public DTO export from the installed PEP 561 wheel using strict mypy 1.18.2, isolated in its own development-tool environment. Reject all seven negative diagnostics, including an analysis binding missing comparisonId. Confirm README obtaining, build and getting-started guidance.
7. Record public IDs, exit codes, immutable-input/content hashes and safe cleanup outcomes. Retain private configurations, callback output, journals and command logs only beneath the private temporary evidence root.

Run completed successfully on 2026-11-17 using the fresh checksummed `acclimate-dx-release-20261117-gaps-1` release, installed wheel, extracted async recipe, existing Rust service and isolated PostgreSQL 16. The command exited 0. Public IDs, scalar results, hashes, type diagnostics and cleanup outcomes are in [python-integrator.json](python-integrator.json). Private configuration, callback outputs, journals and command logs remain under `/private/tmp/acclimate-python-gap-retest-20261117/python-integrator-dnqlvphn/`, mode 0700.

| Criterion | Result | Evidence |
| --- | --- | --- |
| 1. Python-owned task and independent grader | Accepted | Two saved support tickets; parent routes everything to general, candidate follows the routing skill, and approved VIP memory selects priority. Four executions plus four grades produced a Rust-bound comparison: parent mean reward 0.5, candidate 1. Expected answers stayed in grading. Installed `describe`, `request` and ready `doctor` created the public handoff. |
| 2. External Python-only installed runtime | Accepted | Fresh Python 3.11 venv physically outside the checkout, offline `--no-index --no-deps` wheel install, verified site-packages provenance and all 19 release-wheel files. Node was absent from the consumer PATH; SDK runtime dependencies were empty. |
| 3. Lost response and sealed retries | Accepted | Response loss was injected after the real Rust comparison mutation returned. `submission.unconfirmed` recovered using byte-identical saved submit body and the identical key; the JSON records both hashes. Callback count stayed eight after recovery and sealed terminal retry. |
| 4. Async cancellation lifetime | Accepted | Cooperative and cancellation-ignoring callbacks each received two caller cancellations. Heartbeat advanced 27 and 25 times respectively. Input files and kernel lock stayed held until callback quiescence; files then cleaned and lock released. Only the first executor ran, no grader or future executor ran, and each terminal reread remained failed without callbacks. |
| 5. Failure classification | Accepted | A separate real paired comparison retained parent `infrastructure_failed` and candidate `gradingStatus: failed`, with terminal evaluation failed. Private exception text is absent from the public report. |
| 6. Installed strict typing and obtaining/build guidance | Accepted; previous partial closed | Pinned mypy 1.18.2 ran in a separate developer-tool venv against the fresh installed wheel. Every public domain root export and documented client/delivery import passed strict positive checking; native DTO identities and annotations and `py.typed` passed. All seven expected static diagnostics were rejected, including required analysis `comparisonId`, start spelling/required key, missing finish comparison ID, invalid status, and invalid executor/grader return. README links to obtaining/getting started, source development and release verification, and includes the wheel build command. |
| 7. Provenance and cleanup | Accepted | Release manifest, checksums, source inventory, wheel archive and installed content hashes recorded. Release and existing service binary remained unchanged through execution. Disposable database directory removed; service stopped; private consumer evidence retained. |

The fresh release source inventory SHA256 is `63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd`; tested service binary SHA256 is `c84d1961249e635c024346fb23328dccf738f0aa7eef0e5e50fa4b00111d2a50`. The wheel archive SHA256 is `f25f6380080a0ceba369c9f6ac7b49733f11c04f5a828f218bca2addbe26b577`.

Reproduce from the checkout with the fresh release and existing service binary; this command does not build SDKs or the service:

```sh
ACCLIMATE_PERSONA_RELEASE=/private/tmp/acclimate-dx-release-20261117-gaps-1 \
ACCLIMATE_PERSONA_SOURCE_SHA256=63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd \
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  scripts/acceptance/dx_personas/python_integrator.py \
  --output /private/tmp/acclimate-python-gap-retest-20261117
```

This is an application-owned deterministic simulator, not a model-backed agent or a provider-quality claim. Response loss is controlled injection following an actual service commit, not an asserted real network outage. This fixture records the source inventory and service binary hashes without attesting the binary's source build. No models, paid/provider calls, production resources, SDK builds, source consumer imports, product edits, commits or pushes were used for this retest. The SDK was installed offline from the new release; mypy and its development dependencies were installed only into the separate tool venv. Browser console visibility was not checked; actual service reads verified the comparisons. Original persona reports remain unchanged.
