# Plugin process protocol

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../../design/overview.md).
[Design guide](../README.md)

**For:** adapter and worker authors. **Owns:** wire behavior and host callbacks. **Status:** draft v0.1; method names are not implemented APIs.

For example, a PR-review adapter receives `session.advance`, asks the host to admit a model request, and returns the saved review reference and status. If admission waits or the outcome is unknown, it must not invent a successful result. Read [SDKs and plugins](sdk.md) first. This protocol connects an operator-installed adapter process to its worker. During a task/eval trial, the adapter and native harness run inside the sandbox; the worker and gateway stay outside. Approved plugin code does not make messages from that sandbox authoritative. A plugin may then use a native Python/TypeScript SDK, JSON-RPC subprocess, or native library internally.

## Transport and identity

Use bidirectional JSON-RPC 2.0 over worker-owned stdin/stdout, one UTF-8 JSON object per line. Keep diagnostics on stderr. Remote control-plane traffic uses the authenticated worker interface, not an exposed plugin listener.

Example: PR-7/v1/repetition-1 remains one trial slot after a worker crash. Attempt 2 gets a new ownership generation. A compatible checkpoint restore keeps its logical session/effect IDs; a full restart creates a new session and reconciles earlier uncertain work first. RPC request IDs are new connection-local labels, not new samples.

The first request is `plugin.initialize`. It negotiates protocol version, manifest-bound plugin kind, frame limits, and required features before other operations. Harness plugins additionally report native identity and checkpoint formats through `adapter.describe`. For the initial 0.x protocol, compatibility is an explicit tested minor-version set, not an assumed stable-major promise. Proposed v0.1 maximum frame size is 1 MiB; large outputs use artifact references. The host can negotiate a lower limit. Reject malformed/oversized frames, invalid schemas, duplicate JSON keys, and unsupported required fields before side effects.

Each session operation carries a context reference bound by the host to organization/project, run, attempt, ownership generation, AgentVersion, adapter digest, and deadline. Domain/grader contexts bind evaluation, slot, and job-attempt identities, plus captured-output or execution-result identities appropriate to the stage; they do not get a harness session or production authority. Their method sets are in [evaluation contracts](../evaluation/contracts.md#domain-and-grader-interfaces). The plugin cannot change that binding. Stable session/effect IDs survive supported recovery; RPC request IDs only correlate one connection's messages.

Example envelope; values are illustrative:

```json
{
  "jsonrpc": "2.0",
  "id": "host-12",
  "method": "session.open",
  "params": {
    "context_ref": "ctx-review-attempt-2",
    "command_id": "open-review-session",
    "session_id": "review-session",
    "agent_version_ref": "version-review-v1",
    "checkpoint_ref": null
  }
}
```

References must resolve to authorized immutable objects. They aren't arbitrary paths or permission grants. Host and plugin use separate request-ID namespaces and keep reading while callbacks are in flight.

## Worker-to-adapter methods

| Method | Contract |
| --- | --- |
| `adapter.describe` | Describe schemas, native versions, supported features, and checkpoint compatibility. No task execution. |
| `session.open` | Create or restore the logical session from pinned inputs/checkpoint. No model/tool effects before host admission. |
| `session.advance` | Apply input or continue a parked operation until completed, waiting, interrupted, or failed. |
| `session.checkpoint` | Quiesce supported work and return a published checkpoint reference with native/session metadata. |
| `session.inspect` | Read adapter-observed state after uncertain transport/lifecycle results. It doesn't override the host's effect journal. |
| `session.cancel` | Request cooperative stopping. Acceptance isn't proof the process tree or provider work has stopped. |
| `session.close` | Release session resources without erasing durable evidence or unresolved accounting. |

Mutating methods carry stable `command_id`. The host journals command state. Neither the SDK nor worker blindly resends an uncertain `session.advance`; inspect, reconcile ownership/process state, and recover the session first. A logical command ID isn't an external provider's idempotency key.

## Adapter-to-host callbacks

| Callback | Host responsibility |
| --- | --- |
| `host.request_model` | Validate the normalized provider request, admit the stable effect, reserve budget, dispatch, and save outcome/accounting. |
| `host.invoke_tool` | Check the exact tool/action, approval, policy, retry class, and ownership before recording intent and dispatching. |
| `host.append_events` | Validate and durably append transcript/native events; return the committed cursor. No plugin-authored state or budget mutations. |
| `host.publish_artifact` | Capture a worker-scoped staged output/checkpoint, verify digest/size, publish it, and return an authorized immutable reference. |

The worker receives callbacks on its own connection and checks the context it assigned, not a role claimed in the message. Callbacks are allowlisted by plugin kind and the bound job role. Model graders can receive job-scoped `host.request_model` authority under the [grading effect contract](../evaluation/contracts.md#domain-and-grader-interfaces); they cannot open a production session. Candidate code cannot call grading methods. Callbacks use the bound context plus stable operation/effect identity. The host computes canonical action digests. Tool retry policy comes from qualified host configuration, not a candidate's hint. Plugins don't get raw provider credentials or permission to bypass gateways.

Native SDK transport integration may route HTTP through the gateway instead of calling `host.request_model` directly. It must preserve the same admission/accounting contract, including auxiliary requests and SDK retries. Telemetry-only hooks don't meet that contract.

## Tool-provider dispatch

Tool plugins use the same framing and role-bound handshake. `tool.describe` returns schemas, declared effects, and accounting/retry metadata for host validation. `tool.execute` receives an admitted effect context and canonical arguments only after the host commits intent. The host owns the final retry classification and durable outcome.

The trusted gateway can run an operator-installed tool implementation with scoped service access. Tool credentials stay inside that trusted execution role or its broker; they never reach the harness/candidate. This differs from giving a harness adapter a provider key. MCP tools can be exposed through such a provider, under the same gate.

A lost `tool.execute` response is an uncertain effect, not permission for the SDK to run it again. Tool hints don't override qualified host policy. Tool plugins cannot call session, grading, or release methods.

## Waiting and recovery

<!-- diagram:protocol-recovery -->

```mermaid
sequenceDiagram
    participant W as Worker
    participant A as Adapter
    participant G as Gateway
    participant S as Control plane / store
    W->>A: session.advance
    A->>W: host.invoke_tool(effect ID, arguments)
    W->>G: Request tool operation
    G->>S: Record pending approval
    G-->>W: waiting(operation ID), not dispatched
    W-->>A: host.invoke_tool returns waiting
    A->>W: host.publish_artifact(checkpoint)
    W-->>A: checkpoint_ref
    A-->>W: session.advance returns waiting + checkpoint_ref
    Note over W,S: Approval answered through control plane; new worker claims recovery
    W->>A: session.open(checkpoint_ref, new attempt)
    W->>A: session.advance(pending operation)
    A->>W: host.invoke_tool(same effect ID, same arguments)
    W->>G: Request same tool operation
    G->>S: Revalidate; consume approval + hold + intent
    Note over G,S: Gateway dispatches after committed admission
    G->>S: Save tool outcome + accounting
    G-->>W: Recorded outcome
    W-->>A: host.invoke_tool returns completed
```

A host callback returns `completed`, `waiting`, `refused`, or `outcome_unknown`, with typed metadata and artifact references where needed. `waiting` is not a tool success or a model-facing fabricated result. A compatible adapter parks the native operation without letting it proceed.

Only claim durable waiting if the native pending call and its stable identity can be restored. Otherwise the adapter must reject jobs requiring it. Checkpoints bind package, native runtime, adapter, format, transcript position, and pending operations. They don't contain provider secrets or make external effects replay-safe.

The host's journal wins on recovery: an existing outcome is replayed; an uncertain nonrepeatable effect stops for reconciliation. Approval, hold, and intent commit atomically before dispatch. An earlier admitted effect may still send after cancellation/ownership loss. See [runtime effects](../runtime/execution.md#effects-and-recovery).

## Events, completion, and backpressure

Provisional text/progress can use notifications. Durable transcript events use `host.append_events` with stable source event IDs and per-session source sequence. The host deduplicates identical IDs, rejects conflicting content, and assigns its own per-run commit order. Source timestamps/sequence are not global order. The trusted gateway or current-owner reconciliation path can retain a late provider result bound to its admitted effect; this does not give a stale adapter write authority.

The adapter doesn't report a tool outcome to its native harness before the required host outcome/transcript barriers succeed. Every adapter must qualify the native ordering it relies on.

An `advance` result includes state, output references, pending operations, checkpoint reference when applicable, and error/usage completeness metadata. The worker validates it before ending the run. Exit code zero or a final text fragment alone is insufficient.

Bound pending RPCs, event queues, logs, and artifact writes. If durable storage fails, stop new admissions rather than drop required records. On fencing, stop initiating work and accept no new authority; a stale process can still finish earlier admitted work, which the current owner reconciles.

## Errors and qualification

Typed failures include `unsupported_capability`, `incompatible_checkpoint`, `invalid_request`, `permission_denied`, `budget_blocked`, `fenced`, `deadline_exceeded`, `native_failure`, and `outcome_unknown`. Error text is diagnostic, never a substitute for these states.

A capability is the intersection of the adapter declaration, registry qualification for that exact build/profile, and effective run policy. Passing handshake isn't production certification. See [conformance](../runtime/qualification.md).
