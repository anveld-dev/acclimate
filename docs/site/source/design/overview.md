# A service for better harness files

[Design guide](README.md)

Your app already runs a background agent through a native SDK. Acclimate supplies the versioned instructions, skills, and approved reusable memory that agent uses, then helps improve those files.

## One background job

A PR-review worker is about to start a Claude session. Its Acclimate SDK resolves `reviewer/stable` to bundle version `v7`, fetches it if needed, and verifies its digest. A local plugin prepares that content for the Claude Agent SDK. The app starts the agent and handles the review exactly as it normally would.

Later jobs can use a newly released version. An existing job keeps `v7`; refreshing the cache does not rewrite its conversation.

<!-- diagram:service-delivery -->

## One improvement

Reviews keep missing retry bugs. An authorized developer sends a few selected examples and asks Acclimate to improve the retry-review skill.

The service's proposer drafts a changed `skills/retry-review/SKILL.md` against `v7`. It saves candidate `v8` with the diff and rationale. The app's evaluation helper runs `v7` and `v8` on the same saved PRs using its native SDK and grading code. It uploads the comparison. A reviewer releases `v8` if the evidence is good enough.

A connection can use outcomes and their approved corrections to start new proposals. The application runs comparisons on separate sets of cases before a release. Your team can review the release or authorize the service to release versions that pass the configured checks. [Set up a connection](../../deploy/README.md#operate-connected-learning).

This changes files, not model weights. It does not grant the agent new tools or permissions.

## Who owns what?

| Part | Owns |
| --- | --- |
| Acclimate service | Bundle versions, scoped access, proposals, comparison records, releases, and scheduling for connections. |
| Acclimate SDK | Resolve/download, verified local caching, safe materialization, and optional evaluation helpers. |
| Harness plugin | Map one bundle to a native SDK's supported configuration or file locations. |
| Your application + native SDK | Agent loop, sessions, model/tool access, credentials, execution, recovery, and runtime safety. |

## The files

A **bundle** is one named collection of UTF-8 text files. A **version** is an immutable snapshot. A **channel**, such as `stable`, points to the version readers should use.

- **Instructions:** how the agent should approach this task.
- **Skills:** reusable procedures, such as a `SKILL.md` and supporting text.
- **Reusable memory:** approved knowledge worth sharing with future jobs.

Private session history and mutable per-user/task memory stay with the app. They only enter a shared bundle through an explicit, scoped proposal.

## First-release limits

Build one Rust HTTP service and an application-side SDK, with a Codex example and Claude/Pi preparation checks to test the plugin interface. Cursor remains a native SDK target with its own delivery recipe and checks. A generic model API client is different from an agent SDK that loads workspace resources.

Acclimate does not run the app's tasks, proxy its model calls, host its plugins, manage a sandbox fleet, or replace native checkpoint/recovery behavior. Hosted execution, automatic multi-candidate search, executable harness-code evolution, and a universal memory engine are outside v1.

**Next:** [Bundles and local cache](bundles-and-cache.md).
