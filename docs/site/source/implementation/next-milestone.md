# SDK release milestone

This pass makes the first implementation usable outside the checkout and tests a real app-owned improvement loop. It keeps one Rust service, app-owned agent execution, and human promotion.

## What shipped

| Path | Result | Evidence |
| --- | --- | --- |
| TypeScript distribution | SDK and three plugin tarballs with JavaScript and declarations | Clean external app installs them offline; preparation types work without native peers. |
| Python SDK | Python 3.11+ client, byte verification, private cache and safe preparation | Fixture tests, isolated wheel install, and delivery against the real Rust service. |
| Native adapters | Claude options helper; real Pi resource loader | Actual pinned SDK types and offline loader checks, including skill references and selected memory. |
| Codex sessions | Separate fresh/refreshed workspaces and an explicitly resumed thread | Three Luna turns returned their expected resource values; no in-place reload claim. |
| Improvement example | Draft one skill, publish a child, compare both versions, save evidence | Five Luna turns completed a two-case paired run; the channel stayed on its parent for review. |
| Service hardening | Validated grants, worker supervision, lock-loss detection and attempt fencing | PostgreSQL tests terminate the lock connection and hold a stale model result across recovery. |

Terra agents owned the separate paths. Calls made by the software under test used only `gpt-6-luna`; default checks remain offline. No package was published to a registry.

## The review artifacts

The live example saves a private directory containing:

```text
parent-payload.json      exact content selected for the baseline
candidate-payload.json   published child content
skill-change.json        allowed path, before text, after text
<case>-<version>.json     saved response, version, known usage, unknown cost
summary.json             full paired report, IDs/digests and comparison record
cache/                   verified SDK content
```

The grader sees saved outputs and case identity, not version identity. Missing results and costs remain explicit. The run stops before promotion; the reviewer applies a separate command with an expected channel revision. Two cases demonstrate wiring, not a general quality gain.

## Package boundaries

`@acclimate/sdk` and each root plugin entry point work without a native runtime. SDK-dependent helpers live at `@acclimate/claude-plugin/native` and `@acclimate/pi-plugin/native`; applications install the corresponding optional peer deliberately. The Pi adapter uses `@earendil-works/pi-coding-agent` 1.5.2. Its native SDK requires Node 22.19 or newer.

The former Pi npm scope has no patched release for its reported issues; the maintained scope contains the fixes. The migration resolved this checkout's audit findings. [Upstream advisory](https://github.com/advisories/GHSA-jfgx-wxx8-mp94).

## Qualification limits

Claude/Pi provider sessions are not live-tested. Codex resume retains its original workspace and conversation, so this does not prove file rereads or hot reload. The Luna improvement demo uses an app-owned direct author flow; it does not qualify a live Rust proposer provider call. Costs remain unknown, and no statistical gain is claimed.

The service exits after observed lock loss or worker exit. An already-dispatched model request can still incur cost during detection. Attempt checks prevent an older result from overwriting a later retry; this remains a single-process deployment.

See [Run locally](../development.md) for install/build/test commands and the live example. Keep R0 wire changes coordinated. Future agent worktrees need a committed baseline; these paths used separate file ownership in the shared checkout.
