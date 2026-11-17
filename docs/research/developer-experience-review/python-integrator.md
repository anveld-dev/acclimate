# Python-first agent developer review

This is a simulated, source-based persona review, not observed user research. It reviews the checkout on 2026-11-16. P1 means a major adoption obstacle for this persona; P2 means substantial integration friction; P3 means a smaller discoverability problem. These priorities describe developer experience, not a security or production incident.

## Persona and job

I maintain a Python agent service with an application-owned tool loop, async request handling, existing task fixtures, and an existing grader. I want Acclimate to version and deliver instructions, skills, and approved memory. My first success is proving that the same saved tasks improve under a candidate bundle, inspecting failures, and explicitly releasing the candidate. I expect to keep my model credentials and runtime, and I do not expect Acclimate to host my agent.

## Journey through the current product

1. **Install:** `python/README.md:3` tells me to install an existing wheel. The console has a Python selector and a source-build command (`apps/console/src/components/sdk-setup.tsx:36`, `:39`, `:78`). The checkout development guide also supplies a build command (`docs/development.md:59`). I can install without adopting Node for delivery, but the Python README itself does not lead me to package creation.
2. **Fetch:** the README's `AcclimateClient` and `resolve_and_cache` recipe is short and the offline/fallback policy is explicit (`python/README.md:5`, `:14`). Content-read credentials and my stable cache scope are different concerns. The console explains the credential requirement (`apps/console/src/components/sdk-setup.tsx:125`).
3. **Prepare:** `prepare_files` verifies payload structure and stages original relative paths in private directories (`python/acclimate/delivery.py:401`). The context manager removes its created files when it exits (`:378`, `:397`). This is usable generic delivery, not a Python framework adapter or native coding-agent mapping.
4. **Connect my actual agent:** the README prints file descriptors. The fuller Python delivery example launches a child process that reads the files (`python/examples/delivery_check.py:33`). I must design how instructions, skills, and memory enter my runtime, how references remain available, and how long to retain the prepared directory.
5. **Evaluate:** Python exposes create/get/list/start/finish/interrupt operations (`python/acclimate/client.py:338`). I can manually construct and submit a `ComparisonRequest` (`python/acclimate/types.py:122`, `python/acclimate/client.py:260`). However, the callback-based paired comparison helper and durable installed-adapter runner are TypeScript (`packages/sdk/src/compare.ts:39`, `examples/evaluation/runner.ts:51`). The Python package has neither equivalent nor a Python walkthrough for the raw protocol.
6. **Release:** `promote` and typed `PromoteRequest` exist (`python/acclimate/client.py:227`, `python/acclimate/types.py:50`). The service permits evidence-based promotion only with matching version bindings/current channel state; its complete flag is evidence completeness rather than proof that quality improved (`contracts/IMPLEMENTATION.md:13`). The underlying capability exists, but reaching it from a Python eval is largely my own assembly work.

## Findings

### P1 — Python can submit eval evidence, but lacks a supported path for producing it safely

**Observed evidence:** `python/acclimate/__init__.py:1` exports the HTTP client, delivery helpers, wire types, and receipt reporters. `python/acclimate/client.py:338` provides raw lifecycle calls, while `:260` submits a prebuilt comparison. In contrast, `packages/sdk/src/compare.ts:39` accepts execute/grade callbacks and frozen paired case inputs; `examples/evaluation/runner.ts:98` refuses unsafe reruns, `:116` persists the execution marker before callbacks, and `:131` saves the exact report before submission. `examples/evaluation/README.md:1` describes the installed application path through a Node checkout and `npm run evaluate:app`.

**Impact for this persona:** delivery is Python-native, but my first behavioral eval requires translating the TypeScript orchestration, introducing a Node sidecar/bridge, or implementing pairing, failure classification, attempt ownership, idempotency, output retention, and recovery myself. Raw endpoints are genuinely supported; the missing piece is the Python orchestration/cookbook, not HTTP reachability. This is an inferred adoption obstacle, not an observed invalid report.

**Recommendation:** ship a documented Python evaluator adapter accepting my execute/grade callbacks, or initially a complete, explicitly low-level Python recipe with matching protocol guarantees and clear recovery limits. Show create/fetch request → verify exact versions → start attempt → execute paired cases → save report → submit → finish → review/promotion. Keep app execution and credentials with the application.

**Acceptance criterion:** an external wheel consumer with no Node dependency can run a deterministic two-version/two-case evaluation, produce a request-bound comparison visible in the console, retain infrastructure/grade failures distinctly, and retry a lost submission response without reexecuting completed callbacks. Document interruption when safe recovery is impossible.

### P2 — The Python typing contract stops at the newer workflows

**Observed evidence:** the wheel advertises `py.typed` (`python/pyproject.toml:14`). Original comparison and promotion methods have typed requests/results (`python/acclimate/client.py:227`, `:260`); evaluation and draft methods have no parameter/return annotations (`:317`, `:338`). Integration calls use plain `dict` (`:277`). The complete `python/acclimate/types.py` defines `ComparisonRequest` and ends at `VerifiedBundle` (`:122`, `:142`), with no `Evaluation`, lifecycle request, draft, or integration types. TypeScript does define evaluation request/status/attempt types (`packages/sdk/src/types.ts:188`).

**Impact:** my IDE cannot tell me which fields to send to start/finish, what statuses exist, or that casing is camelCase. The strict server rejects unknown fields (`src/evaluations.rs:18`) and binds report identities (`:355`), so mistakes surface as runtime HTTP errors after I have already built the workflow. Shipping a typed older core alongside untyped new workflows makes support depth hard to predict.

**Recommendation:** add Python `TypedDict`/`Literal` contracts and method annotations for evaluation lifecycle, drafts, integrations, and pagination; link a generated or maintained method reference from the Python README.

**Acceptance criterion:** a strict type checker flags `attempt_id` in place of `attemptId`, missing finish fields, and an invalid evaluation status in a small installed-package example. Documented request/response fixtures match the service's current wire contract.

### P2 — The Python happy path demonstrates file delivery without demonstrating agent integration

**Observed evidence:** the first Python example stops at `print(prepared.files)` (`python/README.md:10`). The fuller example executes a standard-library child that reads files (`python/examples/delivery_check.py:35`); the generated console Python recipes do the same (`apps/console/src/components/sdk-setup-recipes.ts:40`, `:138`). Generic preparation preserves paths/kinds (`python/acclimate/delivery.py:450`), whereas the native integration guide explains TypeScript package mappings and explicit memory context (`examples/native-integration.md:9`, `:15`, `:19`).

**Impact:** a successful delivery check does not show where my system instruction goes, how my agent discovers a skill, or how memory is selected. I must invent the most consequential application glue. If I launch a background task after leaving the `with` block, prepared files have already been cleaned up (`python/acclimate/delivery.py:397`). These are risks inferred from the examples; generic file preparation is behaving as designed.

**Recommendation:** provide a framework-neutral Python `run_agent` example that explicitly reads the instruction, exposes skill/reference files through the application's own mechanism, selects memory, records the version/digest, and awaits execution inside the preparation lifetime. Then show an optional concrete Python framework adapter. State which discovery semantics the application supplies.

**Acceptance criterion:** following only the Python guide, a developer can identify the exact lines that attach each content kind to their runtime and can run a deterministic fake-agent test proving those contents reached the agent input. The example retains file references until execution completes.

### P2 — Synchronous delivery needs an explicit recipe for async Python services

**Observed evidence:** `_request` calls the blocking `urllib` opener and response reads (`python/acclimate/client.py:107`, `:113`). The public client defaults to a 30-second timeout and two mutation retries (`:35`). `resolve_and_cache` performs synchronous filesystem and HTTP operations (`python/acclimate/delivery.py:271`, `:303`). The Python README describes neither async behavior nor thread offloading; its full recipe also uses blocking `Popen` reads (`python/examples/delivery_check.py:42`).

**Impact:** directly copying these calls into an async agent handler blocks its event loop during network/disk work. A shared service can stall unrelated agent requests while resolving content or recording evidence. This is a normal consequence of a synchronous API, not a claim that synchronous support is inherently defective.

**Recommendation:** label APIs synchronous and provide an `asyncio.to_thread` integration recipe with one complete fetch/prepare/run/cleanup lifetime. Document timeout/retry budgets and that cancelling the await does not automatically stop the worker thread; offer an async client later if demand warrants it.

**Acceptance criterion:** a fake delayed transport integration example demonstrates that another async task remains responsive during delivery, with cleanup occurring after the worker actually completes. No example implies cancellation has stopped synchronous work.

### P3 — The Python README assumes a wheel exists and loses the path back to obtaining it

**Observed evidence:** `python/README.md:3` starts with `pip install acclimate_sdk-*.whl`; the rest of that document has no wheel-build command or link to the package build/deployment guide. `python/pyproject.toml:6` identifies the distributable package, `docs/development.md:59` explains building it, and the console embeds a separate correct source-build path (`apps/console/src/components/sdk-setup.tsx:39`). The root guide explicitly says registry publication is not performed (`docs/development.md:53`).

**Impact:** entering through the Python package directory, I cannot tell whether to download an official artifact, ask an administrator, build the wheel, or attempt a registry install. This is a discoverability issue; the necessary build command already exists elsewhere.

**Recommendation:** put “get the wheel from your admin, or build from this checkout” and the exact source-build command in the Python README, link back to deployment/access setup, and use one canonical packaging reference.

**Acceptance criterion:** a developer starting at `python/README.md` can create and install the wheel in a new Python 3.11+ environment without searching other repository files; the guide makes no registry-availability promise.

## Strengths worth preserving

- Standard-library-only runtime and a small installed surface make delivery easy to embed (`python/pyproject.toml`, `python/README.md:3`).
- Exact digest verification, explicit offline policy, bounded transport, and preservation of denials/integrity failures are useful production semantics (`python/README.md:14`, `python/acclimate/delivery.py:297`).
- Scoped credentials and best-effort optional observations are separated from execution success (`python/README.md:20`, `:38`). The docs correctly avoid claiming a receipt proves model consumption (`:51`).
- The context manager gives preparation a clear cleanup lifetime (`python/acclimate/delivery.py:394`).
- Python is not limited to read-only delivery: comparison submission, evaluation lifecycle, and promotion endpoints really are exposed. The gap is usability and orchestration depth, not total lack of capability.

## Verification and limits

- Read current package, Python docs/examples/tests, generated console Python recipe source, the TypeScript compare/installed adapter runner, and Rust evaluation binding checks. No applicable `AGENTS.md` files were found in the checkout.
- Ran `PYTHONPATH=python /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 -m unittest discover -s python/tests -v`: **12 tests passed** in about 4.3 seconds. These include a local HTTP fixture and child-process delivery recipe; they do not establish live provider, public deployment, or Python eval-runner behavior.
- The first attempt with the documented generic `python3` name used this machine's Python 3.9.5 and failed importing `typing.NotRequired`. The supported minimum is clearly Python 3.11, so this is an environment mismatch, not a supported-runtime product defect. An attempted `python3.11` pyenv shim also required selecting its installed interpreter explicitly.
- No real model calls, secrets, external service changes, production code edits, browser inspection, or real-person usability sessions. Async impact and abandonment are source-derived predictions. I did not validate a published wheel or framework-specific consumption.

## Top three changes

1. Provide the complete Python app-owned eval path, including durable report/retry behavior.
2. Make new workflow APIs typed and discoverable from the Python entry point.
3. Extend delivery onboarding into actual agent context wiring, with correct async/preparation lifetimes.
