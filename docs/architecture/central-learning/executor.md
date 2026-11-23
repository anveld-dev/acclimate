# Executor

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

The executor runs each rollout and grades its output. Its internal API is documented in [API and data](api-and-data.md).

## The container

`acclimate-executor` is a second binary, run as its own container in the same Compose stack as the service.

- It has no database access and no optimizer credentials.
- It hosts the gateway. The workspace's provider endpoint and key are stored encrypted by the service and sent with each lease over the internal listener. The executor keeps them in memory only. It never writes them to disk, a log or a sandbox.
- It reaches the service over an internal listener that is not published outside the Compose network and is not routed through the public proxy.
- It authenticates with its own executor token. The token is separate from workspace machine tokens, can be revoked, and identifies the executor in each lease.

Remote executors on other hosts, and the mutual TLS they need, are not planned for the first release.

## Rollouts and leases

When the service queues an evaluation, it writes one `learning_rollouts` row per task and rollout in the same transaction. A trial writes one `learning_trials` row, and its rollouts carry that `trial_id`. The executor works through them:

1. **Lease.** The executor asks for work. The service marks rows `running` with an owner, and returns the bundle payload, the task input, the harness, the pinned models, the limits, the provider endpoint and key, and a per-lease token.
2. **Run.** The executor starts a fresh sandbox, runs the harness inside it and sends heartbeats. The sandbox receives the bundle payload and the task input, and nothing else. A lease whose heartbeats stop is expired.
3. **Grade.** The row moves to `grading`. Grading is a separate step with its own inputs: the output, the gateway log, and the reference and criteria. Those grading inputs never enter the agent's sandbox.
4. **Report.** The executor posts one result per rollout: output, verdict, judge reasons and the gateway log. The service records it and writes an audit entry, as it does for start and report today.
5. **Assemble.** When all rollouts of an evaluation have results, the service scores it. Five rollouts per task and the scoring rule are unchanged. See [loop](loop.md).

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for an executor. |
| `running` | An executor holds the lease and is running the harness. |
| `grading` | The harness finished and the grader is running. |
| `scored` | The grader gave a verdict. |
| `converted` | The executor returned task cards for a material conversion batch. |
| `failed` | An infrastructure failure. Not a score. |
| `cancelled` | Its round ended first. |

Rules:

- An expired lease returns to `queued`. A crash therefore requeues one rollout, not a round.
- Only infrastructure failures are retried, once. They are gateway upstream failures, executor crashes and sandbox start failures.
- An agent that hits its token or time limit is not an infrastructure failure. The rollout is `scored` as a fail. A deadline reached while a gateway request is awaiting the upstream is a `gateway-upstream` infrastructure failure.
- **Errors are never scores.** A rollout that fails twice makes its evaluation fail, and a failed evaluation fails the round as it does today. A `failed` rollout is never counted as a failed task and never dropped from the count.

Prior art behind these rules: Harbor deleted unfinished runs on resume, so a sleeping laptop lost hours of work. Inspect dropped errored samples from the denominator without saying so.

## Sandboxes

**Every rollout runs in a sandbox, from the first release.** The harness runs inside it, and nothing else does.

- **Fresh per run.** Each rollout gets a new sandbox, destroyed afterward.
- **No network.** The sandbox has no network interface. The gateway is the only way out, and it only reaches a model.
- **Runner image.** The executor ships one pinned runner image holding the built-in `chat` runner. The bundle payload and the task input are mounted read-only. Nothing is installed at run time.
- **Grading is outside.** The reference answer and criteria never enter the agent's sandbox. `exact` and the judge run in the executor process, which runs no user code. A grader sandbox arrives with `check` scripts, the first grader that runs user code. It receives only the files the agent produced.
- **Runtime.** Production uses gVisor (`runsc`). The local Compose stack uses plain Docker and prints a warning that isolation is weaker. This is an operator setting on the executor, not a product mode.
- **Fail closed.** If the configured runtime can't provide the isolation asked for, the rollout fails as an infrastructure failure. It does not fall back.

The `chat` runner runs no user code, but the bundle it renders is written by the optimizer, and the `codex` harness will run code. Shipping the sandbox first means the later harness reuses isolation that already carries every round.


## The gateway

The gateway is the only path from a rollout to a model. It runs inside the executor, outside every sandbox.

- **Key custody.** It uses the provider key that arrived with the lease and drops it when the lease ends. The key never enters a sandbox, a task or a log.
- **Pass-through.** It forwards request and response bodies unchanged apart from the rules below. It does not translate between APIs. Inspect's proxy translates, and that is where its message-corruption bugs came from.
- **Routes.** The first release allows `POST /chat/completions` only. Anthropic Messages and OpenAI Responses are added later as more pass-through routes.
- **Model list.** A request must name the task model or judge model the round pinned. Anything else is refused.
- **Provider errors.** The gateway retries HTTP 429 and 5xx responses twice with backoff. A 400 with `error.code` or `error.type` equal to `context_length_exceeded`, or a reply with null message content, yields a failing verdict.
- **Token caps.** It counts tokens per rollout and refuses requests past the cap. A capped rollout is scored as a fail.
- **No hosted tools.** It refuses provider-hosted tools such as web search and code execution, because they run outside the sandbox. Function tools are allowed.
- **No server-side state.** It forces `store: false` and refuses references to stored responses or conversations.
- **Gateway log.** It writes every request and response. The judge reads the final request and response, and the optimizer reads it for evolve rollouts only. Neither reads a transcript the agent wrote.

Inside the sandbox the gateway appears as a base URL on `localhost`, forwarded to a Unix socket the executor owns. Harnesses and agent CLIs expect a base URL, and the socket is the only way out of the sandbox.

The upstream is an OpenAI-compatible endpoint, which today means Codex through CLIProxyAPI.

## The chat harness

`chat` is the first harness and needs no code from the developer. It is a small built-in runner in the runner image, and it runs inside the rollout's sandbox.

1. Render the bundle as the system prompt: instructions as `# path` followed by the text, then skills, then memory. This is the rendering the `openai()` adapter uses today.
2. Append the task input: a string as one user message, a `{messages}` list as given, and any other JSON as one user message holding the JSON text.
3. Send one request to the gateway's `localhost` URL with the round's task model.
4. Take the reply as the output.

Grading follows [tasks and grading](tasks-and-grading.md). Both graders run in the executor, outside the sandbox. `exact` compares with no model. `criteria` calls the loop's judge model through the same gateway, three times.

The harness follows from where the bundle is delivered, so the developer is not asked to choose one.

## Trials

A trial is a Try run from the console, an admission check or a material conversion job. It uses the same lease path, harness, gateway and grader as a round.

- A trial is a `learning_trials` row, apart from rounds. Its rollouts carry the `trial_id`.
- A trial never enters round history, memory or the optimizer's input, and a test asserts it.
- A trial of an evolve task shows the full gateway log to whoever ran it. A trial of a held-out task shows its log only to a person signed in to the console, never to a machine token. See the [custody rules](tasks-and-grading.md#held-out-custody).
- Trials lease ahead of round rollouts so that Try feels immediate.

## Runtime identity

`start_round` already pins the channel head, the task and memory revisions, and the optimizer model and effort. It also pins a runtime identity:

- the executor build;
- the harness and its version;
- the sandbox runtime and the runner image digest, and later the environment image digest;
- the task model, the judge model and the gateway upstream.

An executor leases only rollouts whose pinned runtime it matches. To upgrade, drain the executor, replace it, and let the next round pin the new identity. A round never mixes runtimes, so scores within a round are comparable.

## Later: the codex harness and environments

Coding agents come after the chat harness ships. They reuse the sandbox, lease and gateway that already ship.

- **Environment.** A versioned object made of a base image, a setup script and a stored token the service uses to clone the repository. There is no GitHub app.
- **Build.** The service builds the image, with network on, and caches it by digest. The digest is pinned on the round. Harbor's most persistent operational problem was agents installing themselves at run time, so everything is installed at build.
- **Run.** The agent CLI runs in a fresh no-network sandbox with the bundle installed by the same code that delivery uses, and reaches the model through the gateway's Responses route.
- **Grade.** A `check` script runs in a separate grader sandbox against the agent's output files.

What was considered and is not planned is listed in [plan](plan.md).

## Provider verification

Saving provider settings queues a probe lease. The executor sends one minimal, non-streaming chat completion per model through the gateway transport and reports whether the provider answered and supplied prompt and completion token counts. Probes run outside the sandbox and use the same lease heartbeat as rollouts.

For each upstream attempt the executor checks the endpoint and every resolved address, pins the approved addresses for the connection and disables redirects. An address refusal is reported per model for probes and as a gateway failure for rollout, grade and conversion leases. Failed attempts report the task and judge tokens already recorded.
