import type {
  AdmissionDecisionV1, AdmissionValidationInput, ExperienceV1, FeedbackV1,
  HarnessManifestV1, Ref, Scope,
} from './evidence-types.js';
import {
  LearningEvidenceError, assertArtifactBytes, canonicalJson, sameRef, sameScope,
  validateAdmissionDecision, validateEffectiveContext, validateExperience,
  validateFeedback, validateHarness, validateRef, validateScope,
} from './identity.js';

const refuse = (code: string): never => { throw new LearningEvidenceError(code); };

export function teachingText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  if (value && typeof value === 'object' && 'claims' in value) return teachingText(value.claims);
  return [canonicalJson(value).trimEnd()];
}
async function readVerified<T>(resolve: AdmissionValidationInput['resolve'], ref: Ref<T>): Promise<T> {
  validateRef(ref);
  const value = await resolve(ref);
  assertArtifactBytes(ref, canonicalJson(value));
  return value;
}

/**
 * Validate a host admission decision against verified private artifacts.
 * Authority is configured by the integrating app, never inferred from source text.
 * This validates identity and scope; it does not prove domain truth or redaction.
 */
export async function validateAdmission(input: AdmissionValidationInput): Promise<AdmissionDecisionV1> {
  const { decision, experience, experienceRef, targetScope, policy, mutationPolicy, trustedDecider, resolve } = input;
  validateExperience(experience); validateAdmissionDecision(decision); validateScope(targetScope);
  validateRef(experienceRef); validateRef(policy); validateRef(mutationPolicy);
  for (const ref of input.authorizedFeedback) validateRef(ref);
  assertArtifactBytes(experienceRef, canonicalJson(experience));
  if (!sameRef(decision.experience, experienceRef) || !sameRef(decision.policy, policy))
    refuse('learning.admission.identity_mismatch');
  if (!trustedDecider.trim() || decision.decidedBy !== trustedDecider)
    refuse('learning.admission.unauthorized');
  if (!sameScope(experience.scope, targetScope)) refuse('learning.admission.scope_mismatch');
  await readVerified(resolve, policy);
  const harness = await readVerified<HarnessManifestV1>(resolve, experience.harness);
  validateHarness(harness);
  if (!sameScope(harness.scope, experience.scope)) refuse('learning.admission.scope_mismatch');
  await readVerified(resolve, experience.task);
  await readVerified(resolve, 'result' in experience.outcome ? experience.outcome.result : experience.outcome.diagnostic);
  if (experience.trace) await readVerified(resolve, experience.trace);
  if (experience.effectiveContext) {
    const context = await readVerified(resolve, experience.effectiveContext);
    validateEffectiveContext(context);
    if (!sameRef(context.harness, experience.harness) || !sameRef(context.task, experience.task))
      refuse('learning.admission.identity_mismatch');
  }
  if (decision.decision !== 'admitted') return structuredClone(decision);
  const admitted = decision.admitted!;
  if (!sameScope(admitted.targetScope, targetScope) || !sameRef(admitted.mutationPolicy, mutationPolicy))
    refuse('learning.admission.scope_mismatch');
  if (experience.outcome.state === 'infrastructure_failed' || experience.outcome.state === 'outcome_unknown')
    refuse('learning.admission.outcome_ineligible');
  await readVerified(resolve, mutationPolicy);
  await readVerified(resolve, admitted.teachingView);
  await readVerified(resolve, admitted.compatibilityObligations);
  let trustedCorrection = false;
  for (const ref of experience.feedback) {
    const feedback = await readVerified<FeedbackV1>(resolve, ref);
    validateFeedback(feedback);
    await readVerified(resolve, feedback.sourceArtifact);
    await readVerified(resolve, feedback.claim);
    if (input.authorizedFeedback.some((known) => sameRef(known, ref)) &&
        ['owner_correction', 'verified_policy'].includes(feedback.source) && feedback.sourcePrincipal !== null)
      trustedCorrection = true;
  }
  if (admitted.use === 'authorized_correction' && !trustedCorrection)
    refuse('learning.admission.correction_unauthorized');
  for (const ref of admitted.replaces) {
    const previous = await readVerified<AdmissionDecisionV1>(resolve, ref);
    validateAdmissionDecision(previous);
    if (previous.decision !== 'admitted' || !sameScope(previous.admitted!.targetScope, targetScope))
      refuse('learning.admission.replacement_scope');
  }
  return structuredClone(decision);
}

/** Pure controller guard after its configured admission callback; no policy is inferred. */
export function authorizeTeaching(
  decision: AdmissionDecisionV1,
  scope: Scope,
): Ref | null {
  validateAdmissionDecision(decision); validateScope(scope);
  if (decision.decision !== 'admitted') return null;
  if (!sameScope(decision.admitted!.targetScope, scope)) refuse('learning.admission.scope_mismatch');
  return structuredClone(decision.admitted!.teachingView);
}

export function experienceKey(experience: ExperienceV1): string {
  validateExperience(experience);
  return canonicalJson({ scope: experience.scope, runId: experience.runId, attemptId: experience.attemptId });
}
