# Acclimate

Acclimate delivers versioned agent content and records proposed improvements, comparisons, and deliberate releases. The integrating application owns agent execution and grading.

## Language

**Workspace**:
A scope containing bundles and the memberships that determine who may read, edit, or release them.

**Bundle**:
A named collection of instructions, skills, and approved memory with immutable content versions.

**Version**:
An immutable bundle snapshot with its own identity and a declared digest of its exact content bytes.

**Verified bundle**:
A version whose content bytes match its declared digest and whose payload satisfies the supported content rules. Verification does not establish whether an agent used the content.

**Channel**:
A named reference to a released version, with a revision that advances for each release decision.

**Draft**:
Editable proposed content based on a version and channel revision. Saved draft generations preserve snapshots without releasing them.

**Proposal**:
A bounded request to suggest changes to allowed bundle paths, with recorded attempts and an optional candidate version.

**Comparison**:
An application-reported evaluation pairing parent and candidate outcomes against a declared case inventory. A comparison can be incomplete and is not an execution attestation.

**Release**:
A deliberate decision to advance a channel to a version, supported by comparison evidence or an explicit unevaluated reason. Restoring an older version creates a new release decision.

**Operation result**:
The recorded outcome of a content mutation, associated with its original request identity and exact request bytes so that retries can recover the same outcome.
_Avoid_: Delivery receipt

**Prepared bundle**:
Verified content materialized for an application-owned job, including the paths needed by its selected native harness. Preparation does not mean that the job started or that a skill was invoked.

**Delivery receipt**:
An optional application-reported observation of content delivery or job preparation and startup. It is distinct from an operation result and from proof of agent behavior.
_Avoid_: Operation result
