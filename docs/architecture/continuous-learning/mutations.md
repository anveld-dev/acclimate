# Candidate mutations and effective delivery

The default service proposer edits existing files. Applications can opt into structural planning with [planCandidate](../../../packages/sdk/src/learning/mutations.ts) and the [Acclimate learning adapter](../../../packages/sdk/src/learning/adapters/acclimate.ts). See the [implementation record](implementation.md).

## Enable skill package mutations

1. Store the campaign's `mutationPolicy` artifact as `{ schemaVersion: 1, kind: 'learning-mutation-policy', policy }`. Use `mode: 'skill-packages'` and explicitly name the packages the campaign may create or retire.
2. Configure the adapter's `mutation` option with the same policy, a deterministic `propose` callback and a map of pure preflight functions. The callback receives the verified immutable parent, the policy digest and the retained admission decision digest. Include those bindings in the returned `MutationV1`.
3. Install a campaign-specific `learning.reference-review` preflight for package creation or retirement. Its scope is static review of the complete planned payload, including references owned by the application. Configure behavioral and delivery checks in the development and audit evaluations when they require execution.

The adapter verifies admission and policy bindings and confirms that the bundle's stored compatibility target matches the installed policy before planning. It checks every required preflight and retains the mutation, plan and passed preflight IDs before storing a candidate. After a lost response, reconciliation reconstructs the request from the same deterministic inputs, checks the service's retained operation fingerprint and verifies the stored candidate. The proposal receipt links to the preparation artifact.

## Decision

Keep the existing fixed-file proposer as the default. Add an application-owned candidate planner that applies a capability-bounded mutation to one verified immutable parent, validates the complete resulting snapshot, and publishes it with the existing `createVersion` operation. Enable creation and retirement of skill packages only for campaigns that need repertoire growth. No new server endpoint is required for the initial learner.

The planner is a deep module: its caller supplies parent, requested changes and a mutation policy; the implementation owns exact preconditions, simultaneous application, package integrity, final payload/native validation and a retained change artifact. Publication remains a separate journaled external operation, so pure planning is repeatable and paid execution is never hidden inside it.

## What exists today

- The service proposer permits only existing `allowedPaths`; it requires identical file sets and kinds, and its model envelope supports exact original-text replacements ([request checks](../../../src/improvement.rs#L239), [candidate checks](../../../src/improvement.rs#L420), [envelope](../../../src/proposal_edits.rs#L6)). Empty scaffolded helper files can already receive executable content; fixed-file means location restriction, not prose-only behavior.
- Full-payload version creation accepts a declared parent, validates generic payload bounds, and commits one immutable child and its idempotency outcome ([server](../../../src/bundles.rs#L140), [SDK](../../../packages/sdk/src/client.ts#L293)). It does **not** enforce a learner's mutation policy or require native compatibility before storing every version. The app planner must do those checks before calling it; publication separately rechecks native compatibility.
- Native validation requires package manifests and matching names; native preparation maps an instruction entrypoint, whole skill trees and memory files ([compatibility](../../../src/compatibility.rs#L84), [mapping](../../../packages/sdk/src/internal/native-files.ts#L55)). Drafts may deliberately retain incomplete metadata during human editing. This proposal does not remove that behavior.

## Proposed v1 interface

```ts
type Digest = `sha256:${string}`; // runtime validation requires 64 lowercase hex digits

type ParentBinding = {
  projectId: string;
  bundleId: string;
  versionId: string;
  contentDigest: Digest;
};

type FileBinding = { path: string; kind: 'instruction' | 'skill' | 'memory'; textDigest: Digest };

type TextEdit = {
  op: 'editText';
  file: FileBinding;
  replacements: Array<{ oldText: string; newText: string }>;
};

type SkillCreate = {
  op: 'createSkill';
  name: string;
  files: Array<{ relativePath: string; text: string }>;
};

type SkillRetire = {
  op: 'retireSkill';
  name: string;
  expectedPackageDigest: Digest;
};

type MutationV1 = {
  schemaVersion: 1;
  parent: ParentBinding;
  policyDigest: Digest;
  operations: Array<TextEdit | SkillCreate | SkillRetire>;
  rationale: string;
  // Supplied by the controller from admitted evidence, not trusted because a model cites it.
  admissionDigests: Digest[];
};

type MutationPolicyV1 = {
  schemaVersion: 1;
  mode: 'fixed-files' | 'skill-packages';
  compatibilityTarget: 'generic' | 'codex' | 'claude' | 'pi' | 'cursor';
  editablePaths: string[];                  // exact paths, never shell globs
  createSkillNames: string[];               // exact permitted names, absent in fixed-files mode
  retireSkillNames: string[];
  maxChangedArtifacts: number;              // a file edit or whole skill create/retire counts as one
  maxChangedFiles: number;
  maxAddedTextBytes: number;
  maxFinalFiles: number;
  maxFinalBytes: number;
  requiredPreflightIds: string[];
};

type CandidatePlanV1 = {
  schemaVersion: 1;
  parent: ParentBinding;
  policyDigest: Digest;
  mutationDigest: Digest;
  // Complete ordinary schemaVersion:1 payload; no patch application on the server.
  payload: BundlePayload;
  changedFiles: Array<{ path: string; before: Digest | null; after: Digest | null }>;
  createdSkills: string[];
  retiredSkills: string[];
  requiredPreflightIds: string[];
  referenceReview: { state: 'required' | 'not-required'; paths: string[] };
};

function planCandidate(input: {
  parent: VerifiedBundle;
  binding: ParentBinding;
  mutation: MutationV1;
  policy: MutationPolicyV1;
}): CandidatePlanV1;
```

This is one public planning operation, with immutable inputs and output. The owning learner hides serialization, artifact retention and publication sequencing from product callers. Its internal publisher uses `client.createVersion(projectId, bundleId, {parentVersionId, payload}, key)` after persisting the exact submitted body and operation key. A network retry reuses that body/key; replanning never silently replaces an unresolved submission.

### Binding and digest rules

Use the server-provided content digest to verify the fetched parent **bytes** before interpreting them. Do not recompute that digest by inventing a different JSON canonicalization: the existing service digest covers its exact serialized payload bytes ([verification](../../../packages/sdk/src/verification.ts#L6)). Parent binding includes workspace and bundle identity; IDs from another scope fail even if file bytes match.

For new local artifacts, retain their exact immutable UTF-8 bytes and hash those bytes. File `textDigest` hashes the exact UTF-8 text, with no whitespace or newline normalization. A package digest hashes a versioned manifest of the package's path/kind/text-digest inventory, sorted by bytewise path, using the architecture's artifact serialization convention. The retained manifest bytes define the hash; the package digest is not a replacement for the bundle content digest.

`policyDigest` identifies an application-authorized frozen policy. A model cannot grant itself a capability by changing that field or listing an admission digest. The planner receives the authorized policy from the controller; it checks all declared references against the controller's frozen inputs.

## Validation and construction order

1. Verify the parent payload bytes and scope binding, then require exact equality with `mutation.parent`. Resolve the immutable bundle compatibility target; policy must name that target. Reject unsupported mutation/policy schema versions and unknown fields.
2. Validate controller-authorized policy and evidence-admission bindings. Fixed-files mode must have no create/retire capabilities. Each policy bound may tighten the current service limit; it may never widen it. Current hard limits include 128 files, 256 KiB per text file and 1 MiB total ([payload validator](../../../src/bundles.rs#L4)). Bounds are checked in UTF-8 bytes.
3. Validate operation names and paths using the same path/case/prefix-collision rules as payload validation. Normalize nothing. Require nonempty operations, unique affected files/packages, and no overlapping operation ownership. A file inside a created/retired package cannot also be edited in the same mutation.
4. Resolve all preconditions against the **original parent**. Every text edit must match path, kind and text digest; each `oldText` must match exactly once and replacement ranges must not overlap. Empty `oldText` is legal only for an empty file and only once. Creation requires the package absent, including case-folded collisions. Retirement requires an exact package digest and removes every package member.
5. Authorize every operation. Exact editable paths control text edits. Exact approved package names control creation/retirement; child paths must remain below that package. Every created child has kind `skill`; `SKILL.md` is mandatory with native-valid name/description metadata. The model cannot change file kinds or introduce a second instruction entrypoint through these operations.
6. Construct one final payload in memory. Preserve untouched files/text and their order; edits replace text in place; retirements remove all members; creations append a deterministically path-sorted package. Treat the envelope as one simultaneous transformation: no operation reads the result of another operation.
7. Check changed-artifact/file/byte bounds, then validate the **whole final payload** for safe paths, kind support, file/directory collisions, bounds and the bundle's native target. A generic target still requires package integrity for `createSkill`; generic compatibility bypass is not permission to create malformed skill packages. Reject an empty final bundle and a semantic no-op mutation.
8. Produce a retained plan/change inventory and required preflight list. No files are executed, no version is published and no channel is moved by planning. Native validation establishes delivery shape; it does not establish behavioral quality or policy authority.
9. Before evaluation or release, the learner requires successful application preflights, applicable admission decisions, and the relevant behavioral evidence. Persist their identities with the plan. Store the complete candidate through existing version creation and read back its authoritative version/digest. Later channel movement still requires its own expected-revision/evidence checks.

A new parent is a new plan and experiment. Do not automatically rebase a learned edit after a parent/channel conflict: its evidence and policy context may no longer apply.

## Package references and retirement

V1 has no automatic rename operation. A rename can be represented by one atomic create/retire envelope plus explicit text edits to known references, but requires package-mode authority and reference review. Do not assume textual replacement proves all command names, paths or task-routing references remain valid.

Creation and retirement make `referenceReview.state` required. The planner reports changed package names and paths for the application's preflight to check against its declared references. The adapter declines publication if the preflight is absent or fails. Semantic references in arbitrary prose and code require application-specific review and regression evaluation. An application may explicitly create an alias package as part of its candidate.

Human drafts may remain incomplete while edited. Automated candidates intended for evaluation must pass final native validation. Atomic full-snapshot publication already supplies the needed transaction unit; do not add a distributed multi-file transaction protocol.

## Effective delivery is distinct from stored content

Proposed local record, retained by the app before native execution:

```ts
type EffectiveDeliveryV1 = {
  schemaVersion: 1;
  content: ParentBinding; // candidate binding once its stored version exists
  target: 'generic' | 'codex' | 'claude' | 'pi' | 'cursor';
  mappingImplementationDigest: Digest;
  selectionPolicyDigest: Digest;
  files: Array<{
    sourcePath: string;
    sourceTextDigest: Digest;
    relativeDestination: string;
    role: 'instruction-entrypoint' | 'skill-resource' | 'selected-memory';
    deliveredTextDigest: Digest;
  }>;
  omittedSourcePaths: string[];
};
```

The implementation must inventory actual staged files, not merely repeat requested mappings. Check source/destination collisions, unexpected files and target-specific entrypoints. Retain transformed entrypoint/resource text digests where a plugin generates wrappers. Bind the record to the mapping implementation and selection policy. Exclude absolute private paths and credentials from shared exports; the private job record retains physical ownership information.

The source content digest continues to identify **all original bundle bytes**, even when selected memory is a subset. Do not label the filtered workspace as those exact original bytes. The native repository starter already removes unselected memory and records effective context ([starter](../../../examples/native-repository/README.md#L102)); reuse that behavior rather than treating a prompt's list of paths as access exclusion.

An effective-delivery record establishes what the app staged/offered. Actual read events require separate runtime observations. Neither proves that a resource caused a behavioral gain. The harness/experiment manifest should reference this record; content rollback alone is not rollback of mapping/selection/tool policy.

## Runtime capabilities are a separate policy

`editablePaths` cannot mean “safe behavior.” An existing `SKILL.md` or helper may request network access, subprocesses or different writes without changing its path/kind. Runtime tool grants, filesystem/data access, fixture effects, approval semantics and time/cost admission belong to the app's execution policy, whose digest is bound into the harness manifest.

The planner does not supply a sandbox. Domain preflights, such as helper AST checks, are evidence about a particular code subset; they are not hostile-code isolation. Keep the trusted grader and expected answers outside candidate access. Mutation authority and execution authority remain independent even when one controller orchestrates both.

## Resource/configuration role migration decision

Do **not** add a fourth wire `FileKind` in v1. Existing Rust/TypeScript/Python schemas, fixtures, native mappings and clients support instruction/skill/memory. Relabeling arbitrary JSON as an instruction is not a portable workaround: native mapping allows at most one instruction file.

For the initial learner, put app-owned configuration in the app's immutable harness artifact. Put declarative data inside a skill package only when it actually belongs to that skill; map it as a skill resource, not an instruction entrypoint. Generic file delivery remains explicitly generic and makes no native-target promise. Never switch native to generic delivery silently after a validation failure.

If independently versioned general resources become a demonstrated shared requirement, introduce a versioned payload/mapping contract with explicit `resource` semantics across the service, SDKs, schemas and plugins. Old readers must reject the unsupported schema; do not reinterpret historical instruction/memory kinds. Content bytes/digests remain immutable and migration creates new versions after explicit mapping review.

## Error contract

Planner failures are local structured diagnostics, not new service HTTP error codes. They contain a stable code and safe relevant relative paths; no candidate content or secret-bearing evidence is included by default.

- `mutation.schema_unsupported` / `mutation.invalid`: unsupported/unknown fields or invalid envelope.
- `mutation.parent_mismatch` / `mutation.policy_mismatch`: wrong immutable parent/scope/policy binding. No automatic retry against a new parent.
- `mutation.capability_denied`: an operation exceeds authorized paths/package names or mode.
- `mutation.precondition_failed`: file/package missing, present-when-creating, wrong kind/digest, absent/nonunique anchor or overlapping edits.
- `mutation.operation_conflict`: overlapping file/package ownership or case-colliding operations.
- `mutation.limit_exceeded`: changed/final artifact, file or byte bounds exceeded.
- `mutation.package_invalid` / `mutation.native_incompatible`: final package or native-target validation failed; include existing compatibility issue codes where available.
- `mutation.no_change`: no useful candidate bytes changed.

Publication/network uncertainty stays an operation-recovery state in the learner journal. It is not a planner error and never authorizes a new body/key retry.

## Adoption sequence and acceptance checks

1. **Fixed-file learner:** reuse the existing proposer and ordinary publication/evaluation flow. Retain parent/policy/plan and effective-delivery artifacts. No server migration. A proposer model can be replaced without changing the planner contract.
2. **External package proposer:** enable the application planner's package mode. The app owns validation and the write credential; `createVersion` enforces current server invariants, not campaign policy. Keep the credential inside the trusted controller, outside generated helpers. Preserve existing service proposer behavior for old clients.
3. **Shared structural proposal support, only if needed:** add an explicitly versioned service proposal grammar/policy. Repeat capability/final-snapshot validation server-side, require compatible clients/contracts, and preserve full-snapshot transactional persistence. Never relax the old allowed-path semantics in place.

Meaningful tests for the future implementation cross the planning/publishing/delivery interfaces:

- Exact fixed-file anchor replacement preserves every untouched byte; stale parent/file digest fails even if an anchor still matches.
- One complete skill package is created and native-prepared; a manifest-only or orphan-child retirement fails, with no partial stored candidate.
- An allowed retirement removes all members; sibling packages stay byte-identical. Case collisions, traversal, file/directory collisions and overlapping operations fail.
- A rename plan updates declared references and triggers required semantic review; no global replacement is inferred.
- Exact byte boundaries, missing/empty anchors, duplicate operation ownership, no-op changes and unsupported schema/kind fail deterministically.
- Wrong policy/admission binding cannot widen mutation rights. A native-compatible helper still cannot alter runtime grants.
- Native memory exclusion physically removes unselected files, effective-delivery inventory matches actual bytes, and a stored content digest remains distinct from filtered-context identity.
- Lost version-creation response reuses retained body/key and settles one stored child; a changed proposal waits until that operation is resolved.
- Existing incomplete human drafts remain saveable; automated native candidates require compatibility before execution/release.

Adapter tests cover whole-package creation and retirement, admission and policy binding, mandatory preflight, and recovery after a lost version-creation response.
