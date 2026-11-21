# SDKs and plugins

[Design guide](README.md)

The SDK is a library in your application. A plugin is a small mapping from a bundle to the inputs your native agent SDK understands. It is not a process Acclimate hosts.

## The application flow

Use **App setup** in the console to choose a workspace, bundle and channel and copy the SDK configuration. The SDK resolves the channel, verifies the version’s bytes and prepares its files for the native SDK. Run the job, save the version with its outcome and clean up the files when the job finishes. See the [getting started guide](../getting-started.md#2-connect-your-app) for TypeScript and Python calls.

## One plugin interface

```text
prepare(version, applicationContext)
    -> nativeOptions + prepared file locations + cleanup
```

The application context supplies a job directory and an explicit collision/configuration policy. A plugin validates supported bundle content, translates it to native SDK inputs, and reports anything it cannot map. It cannot claim that a skill was invoked merely because its file was present.

Plugins are ordinary application dependencies. No OCI registration, universal session RPC, four extension categories, host callbacks, or SDK-wide model interception is required. Other languages can use the same HTTP/payload format.

## Native SDKs

| Target | Delivery route to validate |
| --- | --- |
| Claude Agent SDK | Stage native skill files in an explicitly selected SDK settings source; supply instructions through the supported prompt/configuration mechanism. |
| Pi SDK | Supply a resource loader or selected resource paths when creating a session. |
| Cursor SDK | Prepare a local workspace and use the documented native configuration. A cloud run needs files in its remote environment, not a path on the caller's laptop. |
| Codex SDK | Prepare repository instructions and native skill locations for its local working directory before starting a thread. |

These routes are backed by [SDK research](../research/sdk-file-delivery.md). Codex, Claude, Pi and Cursor now have preparation mappings; only Codex has a live Luna session check. Cursor local options are checked against its native SDK; its live scanner/provider behavior is unqualified. Each example pins a native SDK version and documents its actual resource discovery, prompt composition, and refresh behavior. Native SDKs can internally use binaries; Acclimate doesn't add a homegrown CLI control layer.

“Memory” is our bundle content category. A plugin may supply it as selected context or files; there is no assumed `memory=` option common to these SDKs. Don't replace a native system prompt wholesale unless that is the app's explicit policy.

## Small SDK surface

Start with resolve/cache/prepare support plus service calls for versions and releases. Fetch errors distinguish denial, missing content, offline cache miss, stale data, integrity failure, and unsupported schema. Retried mutations reuse a scoped idempotency key and the same payload.

The first implementation uses TypeScript with a Codex example and Claude/Pi preparation mappings. Add a thin Python client/helper and additional native examples after the delivery contract settles. Avoid generating multiple SDKs or a plugin marketplace before the common bundle contract works.

## Integration checks

For each example, test a fresh session with one instruction, one skill, and one memory file; verify the resource was actually discovered through the native mechanism. Then test a new bundle, a resumed session, cache failure, paths with spaces, and file collisions separately.

The SDK's job is correct delivery. The native SDK and app own execution semantics; Acclimate makes no stronger mediation, recovery, or isolation claim.
