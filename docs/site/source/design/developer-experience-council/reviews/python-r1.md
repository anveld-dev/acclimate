# Python and cross-language critique — round 1

Disposition: **BLOCKED** on PY-1 and PY-2.

Reviewed normative PLAN.md revision D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`, against the current Python client/types/delivery and TypeScript comparison/runner/journal. This is an independent source/design review, not runtime qualification. The Python proposal is explanatory only; requirements omitted from PLAN.md do not become normative through that proposal.

## PY-1 — isolate the verified bundle as well as the saved task inputs

**Blocking omission.** Section 3, PLAN.md:89, promises cloned input, expected-answer and output values per side/repetition. It does not give `execute.bundle` the same immutable/fresh-copy contract. Section 5 verifies bundle bytes once and then runs repeated callbacks. Both public representations remain mutable: Python `VerifiedBundle` is a TypedDict containing mutable payload/files (`python/acclimate/types.py:142`), and the current TypeScript runner passes the same resolved object from its versions map to every callback for that version (`examples/evaluation/runner.ts:115`, `:125`). A frozen outer dataclass or readonly reference does not recursively freeze a Python dictionary/list.

**Concrete failure.** The first Python execute callback selects memory by removing an item from `run.bundle['payload']['files']`. A later repetition receives the modified list while its version metadata still carries the original verified digest. This can also happen accidentally when adapting an existing agent function that normalizes or annotates the supplied bundle. Private task inputs are cloned, yet the content being compared now varies across repetitions without a different revision/context identity. The new runner should not preserve this existing mutation channel while promising fixed paired inputs.

**Minimum change.** State that the module retains its own verified bundle snapshot and supplies each execution with a fresh isolated deep copy, or a recursively immutable representation with equivalent behavior. Python must not share mutable payload/metadata with another invocation or with module recovery state. TypeScript can freeze a private snapshot and clone per execution. A callback may transform its own copy deliberately, but that transformation cannot change any later callback's versioned input. Preserve original byte/digest verification; cloning is isolation rather than a new content attestation.

**Acceptance.** A deterministic callback mutates/removes bundle file entries and metadata on its first invocation. Subsequent parent/candidate repetitions receive the original verified content and identity; cached/module-owned bundles and report bindings are unchanged. Run the same fixture in Python and TypeScript, alongside existing snapshot/expected/output isolation checks.

## PY-2 — freeze the Python cancellation interface and async-misuse outcome

**Blocking interface gap.** Section 3, PLAN.md:85, says Python callbacks are synchronous and coroutine callbacks/results are rejected. Section 11, PLAN.md:345, mentions a cooperative threading cancellation context and retaining a worker task, but the only concrete callback/run declaration is TypeScript's AbortSignal interface. The normative plan does not name the Python run cancellation argument, the object supplied to execute/grade, how callbacks report confirmed cooperative cancellation, or what happens when a nominally synchronous callable returns an already-started awaitable. Those decisions affect whether a run can seal incomplete evidence and release resources or must retain uncertain execution.

**Concrete failure.** An adopter passes an `async def` callback, a callable object with asynchronous `__call__`, or a synchronous wrapper that schedules native work and returns an asyncio/concurrent future. Merely treating the returned object as invalid JSON and recording infrastructure failure could finish the request and clean its workspace while external work is still active. Separately, `await asyncio.to_thread(...)` normally allows cancellation of the asyncio task while the thread continues; retaining that canceled task alone does not preserve an awaitable representation of thread completion. The plan correctly prohibits these outcomes but leaves implementers to invent incompatible public cancellation contracts.

**Minimum change.** Specify a small Python cancellation contract, for example optional `threading.Event` passed to `run_evaluation(..., cancel_event=...)` and a callback context exposing `is_cancelled()` plus a defined confirmed-quiescent cancellation exception/result. Reject statically identifiable coroutine functions/callable implementations at definition time. Runtime awaitable/future returns must never count as valid outputs; if safe quiescence cannot be established, use ExecutionUncertainError semantics, retain artifacts/marker, and do not seal/submit or authorize cleanup. Provide the actual shielded worker-task pattern in the Python starter, including what happens when cancellation repeats during drain. No force-stop promise is required.

**Acceptance.** Tests cover async functions, callable objects returning coroutine/future objects, and an external job still active after callback return; none yield a completed/ordinary failed report that falsely authorizes cleanup. The async integration fixture cancels its caller twice while a deterministic worker remains active, proves the worker still owns its files/lock, then demonstrates actual completion/quiescence and the documented terminal/cancellation result. A cooperating synchronous callback has a deterministic way to report cancellation and produce truthful incomplete evidence.

## Nonblocking advice

- Add explicit scalar boolean fixtures: `reward=True`, boolean cost/token counts, boolean policy limits, and bool-as-repetition must not accidentally use Python's integer subclass behavior. Match the TypeScript/runtime wire interpretation rather than relying on `math.isfinite` alone.
- In shared numeric fixtures include unequal repetition counts, large finite values whose sequential sum overflows, negative zero, non-ASCII case ordering, and thresholds exactly equal to computed results. D1's specified double operation order is implementable and avoids Python-version-dependent sum behavior.
- Keep the shared scope-encoding fixture authoritative for Python's compact JSON escaping (`ensure_ascii=False` and exact legacy field order). Cross-language journal takeover is correctly excluded; lock compatibility is still required.

## Strengths accepted

The plan appropriately ships Python in the same acceptance milestone, keeps the wheel independent of Node/native SDKs, captures exact mutation bodies rather than reserializing them, requires same scope/flock exclusion with separate ownership formats, and makes legacy receipt limitations explicit. The online bound-request policy check and advisory-only artifact verification avoid conflating self-consistency with execution authenticity.

## Review limits

Only this report was written. No application implementation, credential inspection, package install, model call, browser session, service mutation, or runtime test was performed. Final approval requires explicit re-review of the coordinator's revised plan and exact digest after the two blockers are resolved.
