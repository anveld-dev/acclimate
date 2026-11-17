# Native and operations council recheck

Disposition: **APPROVE**.

Exact revision reviewed: D2, PLAN.md SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`.

I am satisfied with this plan for my native repository/worker lifecycle remit. Both original blocking objections are resolved in the normative document; I found no new material blocker. This approves the design and its stated qualification gates, not runtime behavior.

## Objection dispositions

### NO-1 — Accepted as resolved

D2 section 3 adds a narrow, read-only execution context containing request/attempt/side/job identity and a private job directory. Section 12 requires the runner to durably bind that directory before execute, and the native helper to persist a workspace locator plus launch intent before invoking the harness. Acknowledged external handles and monotone stop/retention/cleanup facts stay private. Missing acknowledgment remains possible launch.

The fixed persistent OS TMPDIR algorithm is compatible with unchanged `prepare(bundle)`: existing native preparation calls `os.tmpdir()` and returns absolute paths/its own cleanup function. The helper validates that canonical owner-only parent, verifies the returned workspace is its direct private child, adds a job ownership marker, and never relocates the tree. Recovery checks the root, path, marker and actual termination before deletion. One authoritative physical storage instance and confirmed original-worker termination are explicit restore requirements.

G21 covers the launch-intent/provider-acceptance/retention/stopped crash boundaries, locatability and refusal to clean or replay uncertain work. The small unrecorded temp-allocation interval cannot have launched a native job. These requirements close the earlier gap between “quarantine the workspace” and being able to find and safely recover it.

### NO-2 — Accepted as resolved

D2 section 12 freezes `repository-source-policy-v1`: every dot-prefixed source segment is rejected, as are case-insensitive AGENTS.md/CLAUDE.md basenames at every depth, with no implicit exceptions. This reserves `.acclimate` as well as native configuration trees; staged-resource ancestor/descendant conflicts are separately rejected. The policy revision is part of declared context identity, and exceptions require a deliberately revised recipe.

The selected-memory contract now prunes files and constructs an immutable EffectiveContext containing only approved text/paths/resources. The harness receives that view rather than unfiltered prepared memory or Pi resource arrays. G14/G21 require both filesystem and metadata exclusion, preserving existing plugin defaults outside this recipe.

## Feasibility and scope checks

- Resource preparation, private locator persistence, native execution, result retention and confirmed-stop cleanup have explicit owners and ordering. Forced termination/uncertain exceptions cannot authorize ordinary cleanup.
- The first patch collector is scoped to bounded UTF-8 text additions/modifications/deletions, avoiding a hidden general Git/patch-engine requirement.
- Source import policy does not claim to isolate arbitrary ambient host settings or prove model consumption. Official SDK documentation likewise distinguishes selected project settings from other host-managed inputs; D2 appropriately leaves host/session configuration with the application and requires it to be recorded. See [Claude Agent SDK filesystem settings](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control).
- Installed imports/type/loader/fake-resource checks are distinct from live harness stop/consumption qualification. The plan does not promote fake process outcomes into provider guarantees.
- The fixed-volume worker and same-principal overlap rotation preserve the existing deployment and evaluator ownership model. Restart overhead remains an explicit limitation rather than a solved claim.

## Verification limits

Rechecked D2 and RESOLUTIONS.md against the existing preparation/plugin/native-helper source, the first-round findings and deployment behavior described in the repository. Consulted the primary SDK documentation above for ambient-setting scope. No product source changed, no native/provider process was run, and no model, deployment, external mutation, or runtime acceptance gate was exercised.

Material edits after this digest require a new recheck; this approval does not transfer to a different revision by implication.
