# Evidence and experiment identity

**Status:** the selected first profile implements these concepts in the Node learning entry, 2026-11-17. Sketch helper names below are not literal exported APIs: use the [exported record types](../../../packages/sdk/src/learning/evidence-types.ts), [identity helpers](../../../packages/sdk/src/learning/identity.ts), [admission validation](../../../packages/sdk/src/learning/admission.ts) and [implementation record](implementation.md). V1 stores evidence in the integrating application's private artifact store and durable learner journal. Existing Acclimate content, evaluation and promotion records remain authoritative for their existing operations; no new server entity is required.

This specifies one evidence contract for an application-owned learner. It separates an observed task result, permission to use that result for teaching, the two harness treatments, the experiment's fixed controls, and authority to release. All digests and verdicts are app-reported evidence, not execution attestation.

## Ownership and the small interface

The learner's evidence module owns artifact integrity, scope matching, admission validation, deterministic descriptor projection and pre-launch identity checks. The application supplies its admission and context-selection policies and remains responsible for domain truth and current tool authorization. A policy may be deterministic or human reviewed; an extra model grader is optional.

Proposed internal interface, shared by an application learner and its installed evaluator:

```ts
interface LearningEvidence {
  admit(input: AdmissionInput): Promise<AdmissionDecisionRef>;
  freeze(input: ExperimentInput): Promise<FrozenExperiment>;
  bindJob(input: JobBindingInput): Promise<JobEvidenceBinding>;
}
```

`admit` never publishes content. `freeze` never launches work. `bindJob` verifies the selected arm, prepared resources and task binding before allowing the app's executor to launch; it returns an immutable binding and does not call a model. The input records are small bindings, not a new execution engine:

```ts
type AdmissionInput = { experience: Ref<ExperienceV1>; policy: PolicyRef };
type ExperimentInput = {
  scope: Scope;
  parent: Ref<HarnessManifestV1>; candidate: Ref<HarnessManifestV1>;
  controls: Ref<ControlsManifestV1>;
};
type FrozenExperiment = {
  manifest: Ref<ExperimentManifestV1>;
  publicRuntime: Readonly<Record<string, string>>;
};
type JobBindingInput = {
  experiment: Ref<ExperimentManifestV1>;
  requestId: string; attemptId: string; jobId: string;
  side: 'parent' | 'candidate'; caseId: string; repetition: number;
  preparedContext: Ref<EffectiveContextV1>;
};
type JobEvidenceBinding = Ref<{
  schemaVersion: 1; kind: 'learning-job-binding';
  experiment: Ref<ExperimentManifestV1>;
  requestId: string; attemptId: string; jobId: string;
  side: 'parent' | 'candidate'; caseId: string; repetition: number;
  harness: Ref<HarnessManifestV1>; effectiveContext: Ref<EffectiveContextV1>;
}>;
type AdmissionDecisionRef = Ref<AdmissionDecisionV1>;
```

Admission authority comes from the configured app policy adapter and its authenticated caller/audit context, not a free-form `decidedBy` argument. `freeze` validates scope, content bindings and invariant/treatment constraints before retaining a manifest. `bindJob` validates case membership and SDK job identity, prepares/verifies resources through the installed adapter, and emits its binding; callers cannot obtain a trustworthy binding merely by claiming a prepared context matches.

The campaign module owns durable decision ordering, budget reservation, audit-exposure admission and release intents. The artifact store is an implementation detail of this module, not a caller-managed sequence of check/write calls.

The current SDK already freezes an application's descriptor and case data ([definition.ts](../../../packages/sdk/src/evaluation/definition.ts#L137)), supplies side/job IDs ([types.ts](../../../packages/sdk/src/evaluation/types.ts#L18)) and persists private job bindings ([runner.ts](../../../packages/sdk/src/evaluation/runner.ts#L551)). Reuse those behaviors.

## Artifact identity and scope

The following TypeScript is a contract sketch. `Ref<T>` names an immutable serialized artifact; the application's private resolver maps its ID to storage. Physical paths and signed URLs are not identities and do not enter public descriptors.

```ts
type Sha256 = `sha256:${string}`;
type Ref<T> = {
  id: string;                 // random opaque ID in an immutable private registry
  sha256: Sha256;              // exact retained bytes, verified on read
  bytes: number;
};
type ContentRef = { versionId: string; digest: Sha256 };
type Scope = {
  projectId: string;
  bundleId: string;
  taskFamilyId: string;
  partitionId: string;         // explicit opaque partition; never inferred from text
  policyEpoch: string;         // application policy regime
};
type PolicyRef = Ref<{ schemaVersion: 1; kind: string }>;
```

All proposed records carry `schemaVersion: 1` and a distinct `kind` discriminator. Identity is the digest of retained bytes, not of a reserialized object on read. The initial writer emits a versioned deterministic encoding: UTF-8 JSON, keys recursively sorted, compact separators, no duplicate keys or non-finite values, and one terminal newline. Fields representing counts/bytes are nonnegative integers; model/settings content is separately retained as artifacts. Semantically ordered lists preserve order; documented sets are sorted before writing. The implementation must freeze exact-byte fixtures for each kind before shipping.

V1 scope matching is exact across all five fields. `workspace-default` is an explicit partition choice, not the meaning of an omitted field. Reuse across families, partitions or policy epochs requires a new admission under an authorized application policy; a lesson cannot widen its own applicability. Project membership alone is insufficient to decide within-project applicability.

Raw traces, task inputs, expected answers and private model context stay local. Publishing a digest is not redaction: low-entropy sensitive content can be guessed. The app's disclosure policy approves each public commitment. For material that cannot disclose a SHA-256 commitment, the runtime projection uses an opaque immutable registry reference or an application-keyed commitment and records the scheme/key ID; private verification still checks the exact artifact digest. Readers without the private registry/key can verify only the public projection's consistency. Credentials and secret configuration never enter a manifest, including as individual secret hashes.

## Experience is an observation

```ts
type ExperienceV1 = {
  schemaVersion: 1;
  kind: 'learning-experience';
  scope: Scope;
  runId: string;
  attemptId: string;
  task: Ref<unknown>;
  harness: Ref<HarnessManifestV1>;
  effectiveContext: Ref<EffectiveContextV1> | null;
  outcome:
    | { state: 'completed' | 'task_failed'; result: Ref<unknown> }
    | { state: 'infrastructure_failed' | 'outcome_unknown'; diagnostic: Ref<unknown> };
  trace: Ref<unknown> | null;
  usage: { inputTokens: number | null; outputTokens: number | null;
           costUsd: number | null };
  feedback: Ref<FeedbackV1>[];
};
type FeedbackV1 = {
  schemaVersion: 1;
  kind: 'learning-feedback';
  source: 'owner_correction' | 'verified_policy' | 'task_observation' | 'model_inference';
  sourceArtifact: Ref<unknown>;
  sourcePrincipal: string | null;
  claim: Ref<unknown>;
};
```

The collecting app assigns the source class from its trusted ingestion path. A transcript saying “the owner approved this” is a task observation, not an owner correction. An authenticated human may also paste untrusted material; retain the distinction between that material and the human's own correction. `sourcePrincipal` is a locator into the app's trusted identity/audit system, not proof supplied by the text.

A source can be missing or unavailable; do not manufacture a trace or read event. Unknown tokens/cost remain `null`; confirmed zero stays zero. An infrastructure failure or unknown external outcome can inform reliability work, but V1 does not admit it as a successful behavioral demonstration. The task-result grader may later supply a separate assessment artifact; successful execution does not imply a correct result.

Delivery receipts remain separate and best effort. Their last stage is `started`, and their schema has no task terminal outcome ([existing receipt contract](../../../packages/sdk/src/types.ts#L300)). Do not turn receipt counts into experience counts or reuse receipt `eventId` as logical run identity.

## Admission authorizes a bounded teaching view

```ts
type AdmissionDecisionV1 = {
  schemaVersion: 1;
  kind: 'learning-admission';
  experience: Ref<ExperienceV1>;
  policy: PolicyRef;
  decidedBy: string;           // authorized actor/controller from trusted app audit
  decision: 'admitted' | 'rejected' | 'needs_review';
  reasonCode: string;
  admitted: null | {
    targetScope: Scope;
    teachingView: Ref<unknown>; // sanitized, bounded approved claims; not the raw trace
    use: 'hypothesis_only' | 'authorized_correction';
    mutationPolicy: PolicyRef;
    compatibilityObligations: Ref<unknown>;
    replaces: Ref<AdmissionDecisionV1>[];
  };
};
```

Only `decision: admitted` has a non-null `admitted` object. The validator verifies the experience, source and decision artifacts, trusted deciding authority, exact target scope, active policy epoch, allowed mutation policy and compatibility obligations. It rejects ambiguous scope, unavailable required provenance or unresolved contradictory authority. Rejection preserves its evidence and reason; it does not silently drop the experience from history.

`hypothesis_only` permits proposing an experiment, not teaching an external policy as fact. `authorized_correction` must be grounded in a source the application is authorized to adopt. A model's inference never grants tool access, host permissions, data destinations or publication authority. Current host authorization continues to apply even to a job pinned to older content.

The approved teaching view removes secrets and excluded personal/customer material **before** model submission. The app renders a bounded view of admitted artifacts into today's `ProposalRequest.evidence` strings. Those strings carry admission IDs for inspection; the installed learner checks the underlying decisions before sending them. The existing Rust proposer does not validate this new admission protocol, and a JSON label claiming approval is not an enforcement mechanism.

A `replaces` link records a deliberate replacement, not a proof of semantic consistency. Compatibility obligations bind relevant existing lesson/context snapshots and regression cohorts. Changes of policy epoch require re-admission or exclusion. The admission policy can hold uncertain changes for a human; it need not make a forced binary model judgment.

## Harness treatment and effective context

```ts
type HarnessManifestV1 = {
  schemaVersion: 1;
  kind: 'learning-harness';
  scope: Scope;
  content: ContentRef;
  runner: Ref<unknown>;        // executable/source inventory incl relevant SDK build
  mapping: Ref<unknown>;       // native resource mapping revision/config
  tools: Ref<unknown>;         // observable schemas + capability configuration
  model: Ref<unknown>;         // requested model/settings, provider revision if available
  contextPolicy: Ref<unknown>;
};
type EffectiveContextV1 = {
  schemaVersion: 1;
  kind: 'learning-effective-context';
  harness: Ref<HarnessManifestV1>;
  task: Ref<unknown>;
  selected: Array<{ resourceId: string; digest: Sha256; role: string }>;
  omitted: Array<{ resourceId: string; reasonCode: string }>;
  hostContext: Ref<unknown> | null;
  readEvidence: Ref<unknown> | null;
};
```

The harness manifest freezes the **selection policy**. Effective context records that policy's realized output for one job; it therefore need not be identical across task cases. Selection includes loaded instructions, selected memory, offered skill/resource mappings, and app-observable host context. It does not claim knowledge of hidden provider prompts. `readEvidence` records observable SDK/tool reads when available, never an inferred read from a plausible final answer.

At binding, verify content bytes/version, runner/mapping/tool/model/context-policy artifacts and actual prepared selection against the chosen arm. Dynamic context is allowed only as declared by that policy and recorded in the job's effective context. A change in selection policy is a treatment change, not just a new descriptive label. A mutable hosted model alias remains a declared limitation; hashing the alias does not freeze provider behavior.

Reuse the native repository starter's existing source, selected-memory and context-policy binding ([job record](../../../examples/native-repository/repository-job.mjs#L504)). A selected-path hash combined with immutable content digest can identify selected memory bytes; duplicating every file body in a manifest is unnecessary. Distinguish stored, offered/selected, observed-read and behaviorally useful knowledge. Only controlled comparisons/ablations support the last claim.

## Concrete artifact specifications

Each following specification is itself retained as an immutable version-one artifact. A `Ref<unknown>` above means one of these typed app-owned artifacts, or a domain payload whose schema is declared by its owning specification; it does not permit an untyped mutable URL. `Json` below is ordinary finite JSON and `Blob` is retained exact bytes.

```ts
type RunnerSpec = {
  schemaVersion: 1; kind: 'learning-runner';
  executable: Ref<Blob>; sourceInventory: Ref<Blob> | null;
  dependencies: Array<{ name: string; version: string; artifact: Ref<Blob> }>;
  environmentContract: Ref<Json>; // relevant nonsecret OS/runtime settings and constraints
};
type MappingSpec = {
  schemaVersion: 1; kind: 'learning-mapping';
  adapter: Ref<Blob>; configuration: Ref<Json>;
};
type ToolsSpec = {
  schemaVersion: 1; kind: 'learning-tools';
  tools: Array<{ name: string; contract: Ref<Json>; implementation: Ref<Blob> | null }>;
  hostCapabilityPolicy: Ref<Json>;
};
type ModelSpec = {
  schemaVersion: 1; kind: 'learning-model';
  provider: string; model: string; providerRevision: string | null;
  identity: 'provider_revision' | 'mutable_alias';
  generationSettings: Ref<Json>;
};
type ContextPolicySpec = {
  schemaVersion: 1; kind: 'learning-context-policy';
  selector: Ref<Blob>; configuration: Ref<Json>;
  unresolvedApplicability: 'exclude_and_hold';
};
type DatasetSpec = {
  schemaVersion: 1; kind: 'learning-dataset';
  domainSchema: Ref<Json>;
  cases: Array<{ caseId: string; repetitions: number; input: Ref<Json>; expected: Ref<Json> }>;
};
type GraderSpec = {
  schemaVersion: 1; kind: 'learning-grader';
  executable: Ref<Blob>; rubric: Ref<Json>;
  outputSchema: Ref<Json>; outcomeAndMissingPolicy: Ref<Json>;
};
type CollectionSpec = {
  schemaVersion: 1; kind: 'learning-collection';
  environmentContract: Ref<Json>; fixtureFactory: Ref<Blob>;
  fixtureScope: 'fresh_per_arm';
  mode:
    | { kind: 'deterministic'; order: 'parent_first' }
    | { kind: 'stochastic'; order: 'seeded_balanced'; seed: string };
  interruptionPolicy: 'retain_and_reconcile';
};
type EvidenceUseSpec = {
  schemaVersion: 1; kind: 'learning-evidence-use';
  development: Ref<DatasetSpec>; selection: Ref<DatasetSpec>;
  audit: { epoch: string; dataset: Ref<DatasetSpec>; attempts: 1 };
  admissionPolicy: PolicyRef; searchPolicy: PolicyRef; releasePolicy: PolicyRef;
  auditFeedback: 'never_teach_in_epoch';
};
type ControlsManifestV1 = {
  schemaVersion: 1; kind: 'learning-controls';
  dataset: Ref<DatasetSpec>; grader: Ref<GraderSpec>;
  collection: Ref<CollectionSpec>; evidenceUse: Ref<EvidenceUseSpec>;
};
```

`executable` can identify a retained installed-package inventory plus entrypoint descriptor, rather than forcing every interpreted app into a binary archive. Domain schemas specify that encoding and are validated by the installed adapter. Remote tools whose implementation cannot be frozen have `implementation: null`; record their declared revision in the contract and retain the reproducibility limitation. Do not claim an immutable remote tool merely because its JSON schema is fixed.

The controls dataset must equal the selected cohort for this experiment, including every case/repetition in the public `expectedCases`. The `EvidenceUseSpec` names all cohorts to prevent relabeling; it does not expose those cohorts to execution indiscriminately. An installed grader resolves only the current cohort's expected values. The proposer has access only to admitted development/selection teaching views.

## One invariant experiment, two treatments

```ts
type ExperimentManifestV1 = {
  schemaVersion: 1;
  kind: 'learning-experiment';
  scope: Scope;
  arms: { parent: Ref<HarnessManifestV1>; candidate: Ref<HarnessManifestV1> };
  controls: Ref<ControlsManifestV1>;

};
```

Candidate-varying content, model/tool/control-flow/context behavior belongs in `arms`; the task distribution, grader, outcome rubric and collection rules belong in `controls`. A changed control starts a new experiment regime and cannot be compared as if it were just another candidate under the old controls. Comparing two model settings is permitted when deliberately declared as the treatment; do not falsely promise all comparisons change content only.

The collection artifact fixes `caseId`/repetition inventory, deterministic or stochastic mode, fixture setup/reset contract, arm order/seed and allowed missing/failure/abandonment handling. Stochastic collection uses seeded balanced arm order plus independent fixture state. Order randomization alone does not repair state contamination. The current generic runner's fixed parent-before-candidate order cannot satisfy that new stochastic mode; V1 implementations must use a controlled app collector with existing report submission, or explicitly defer that mode until the SDK collector supports it. Do not advertise it as existing `runEvaluation` behavior.

### Encoding into the existing descriptor

Public runtime projection uses these proposed namespaced keys in addition to the SDK's existing keys:

```ts
{
  'acclimate.learning.schema': '1',
  'acclimate.learning.experiment': publicExperimentCommitment,
  'acclimate.learning.parentHarness': publicParentCommitment,
  'acclimate.learning.candidateHarness': publicCandidateCommitment,
  'acclimate.learning.controls': publicControlsCommitment
}
```

For the initial fictional domain, the disclosure-approved commitments can be ordinary `sha256:...` values. The local projection retains private manifests; it need not expose paths, task names, expected answers or raw policy content. An optional readable config revision remains useful.

Construct the app definition using this runtime map **before** describe/request creation; `defineEvaluation` copies/fixes it ([definition.ts](../../../packages/sdk/src/evaluation/definition.ts#L137)). Each job uses `context.side` to select the corresponding manifest, checks the actual bundle version/digest, and writes that manifest and effective-context identity beside its existing binding. Request/report descriptor equality then freezes both references. It does not prove which executable the remote app ran.

## Split policy and audit exposure

The evidence-use artifact defines development, selection and release-audit cohorts, task-family/partition scope, selection policy, and a finite audit epoch. A cohort is a fixed private inventory with a disclosure-approved public reference. It cannot be relabeled from audit to fresh audit after its answers influenced a proposal.

V1 supports a simple policy: repeated bounded development/selection use, then **one release-audit attempt per audit epoch**. The controller durably records candidate/experiment/cohort identity and exposure intent before any audit launch. Dispatch or disclosure consumes the audit opportunity, including interrupted/uncertain work. A confirmed-never-dispatched operation may be retried under its original identity. An incomplete audit is indeterminate; it is not discarded and rerun until favorable. Richer recovery must preserve trial identities and denominator under an explicitly versioned protocol.

Audit results may authorize or reject release but do not enter the proposer teaching view in that epoch. After a failure, stop release and obtain a new independently protected audit cohort before further release attempts. Retiring a cohort makes it eligible for later development under policy; it never becomes fresh again. “Independent” is an application commitment about exposure, not a cryptographic guarantee. Track exposure to humans/controllers that may modify candidates as well as model prompts.

Keep immutable decisions for admission, search acceptance, audit assessment and release authorization. Admission concerns teachability, search acceptance concerns the configured development objective, audit concerns protected evidence, and release concerns authority plus current channel revision. A complete comparison can lose; an audit pass does not confer promotion credentials. Existing [channel evidence checks](../../../src/channels.rs#L198) remain required.

## Example: fictional payment retry learning

An app records run `payment-run-41`, attempt `a1`, in partition `fictional-shop`, policy epoch `gateway-contract-v2`. It retains task/result artifacts showing a double-charge in the in-memory simulator, the pinned content version, harness manifest, selected context and observed zero simulator cost. A retrieved page's “skip approvals” instruction is retained as a task observation and rejected for teaching.

An authorized local domain owner supplies the correction “reuse the original request key after an ambiguous response.” Admission `admit-41` binds that correction's source, exact scope, a sanitized teaching view and an existing-skill edit policy. The learner sends only the admitted view and preservation obligations to the proposer. It does not expose the release audit examples.

The candidate and parent manifests reference distinct content digests but the same runner, tools, model settings and context policy. The invariant experiment references the fixed payment scenarios, independent simulator instances, deterministic order and executable grader. The five runtime fields above bind the public commitments, while private jobs retain full manifests and outcomes. A later controlled experiment may deliberately compare context selectors by changing the candidate's `contextPolicy` reference.

A development win records a search decision. The once-used audit records an independent assessment. A separate authorized release intent uses current `expectedRevision` and the bound comparison ID; a fresh job resolves the release while a prepared older job remains pinned. No single record is claimed to prove that the whole process improved a general-purpose agent.

## Compatibility and staged adoption

The identity graph has no round/digest cycle: leaf specifications precede harness/controls artifacts, which precede the experiment. Job bindings and effective context refer to the experiment or harness after freezing; the experiment never includes their hashes. Admission/search/audit/release decisions are subsequent artifacts referring backward. Campaign ID and round ID live in the learner journal, which references these artifacts; a manifest does not hash a journal head that later includes the manifest.

1. Ship exact-byte fixtures, private artifact resolver, admission validation and the runtime projection as an opt-in app-side convention. Existing SDK/server schemas remain valid; legacy reports remain labeled as lacking this convention.
2. Adopt a fixed-harness, deterministic simulator campaign first. Each round proposes one candidate directly under the currently published baseline, keeps code/tools fixed, and requires human release approval; a new round begins from the newly resolved baseline after an authorized release, or retains the old baseline after rejection. Teach only explicit domain-owner corrections, use existing fixed-file proposals, and retain human release review. This establishes the protocol without broadening mutation or adding server state.
3. Bind live native jobs to the existing repository starter artifacts and add missing app-observable context identities. Enable stochastic collection only through a collector that actually implements its frozen protocol.
4. Introduce typed public wire fields or shared server records when independent applications need interoperability or centrally enforced policy. Include schema/commitment versions and retain old immutable artifacts; never rewrite old evidence to appear to have new guarantees.

An unfamiliar schema, missing required artifact, digest mismatch, unsupported commitment scheme or changed controls blocks launch/admission with a diagnostic. Optional trace/read evidence may be absent, but the resulting claim stays correspondingly narrow. A manifest format migration creates a new revision/experiment binding; operation recovery continues under the originally frozen artifact bytes.

## Design acceptance checks

- A planted instruction with a valid trace digest cannot become an authorized correction; a forged admission label in an evidence string is ignored by the installed learner.
- A correction for another partition/epoch is excluded until an authorized new admission exists; unresolved lesson conflicts produce `needs_review`.
- Changed tool code with unchanged content invalidates the harness binding unless deliberately frozen as the candidate treatment. Changed grader/cases invalidate controls.
- Selected memory can differ by task under the frozen selector; selected bytes and omissions are retained. Missing read events remain unknown rather than fabricated.
- Both arm commitments survive descriptor creation, report submission and recovery without requiring server execution attestation or private payload upload.
- An audit dispatched before a crash remains exposed; repeated selection cannot silently reset that fact. A losing or incomplete audit cannot be promoted by a generic “complete means good” shortcut.

## Selected profile: supplying fresh audits

The selected architecture binds a finite ordered roster of audit cohort manifests and installed audit definitions in the initial learner definition. Each reservation selects an unused eligible member under the frozen allocation policy, before candidate audit execution. Cohort names alone do not prove freshness: retain task/exposure fingerprints and the evidence-use policy's exclusion checks. Exhaustion closes admission to further audit/release and reports `audit-refresh-required`. Refresh requires an explicit definition/epoch migration with retained exposure, lineage and lifetime spend; ordinary resume does not create fresh evidence. This supports multiple release rounds without silently replacing one captured evaluator's cases.
