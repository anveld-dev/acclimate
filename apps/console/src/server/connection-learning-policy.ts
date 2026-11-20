import type { LearningEnrollmentRequest, LearningEvaluationDescriptor } from '@acclimate/sdk';
import { validateEvaluationPolicy } from '@acclimate/sdk/evaluation/policy';

export type LearningSetup = {
  installationId: string;
  permittedPaths: string;
  maxProposalAdmissions: string;
  descriptors: string;
  outcomePrincipal: string;
  evaluatorPrincipal: string;
  automaticRollback?: boolean;
  selectionPolicies?: string;
  createSkillNames?: string;
  retireSkillNames?: string;
};

function bounded(value: unknown, bytes: number): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    new TextEncoder().encode(value).length <= bytes
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const descriptorFields = new Set([
  'datasetRevision',
  'graderRevision',
  'runtime',
  'expectedCases',
  'fixtureProtocol',
  'datasetDigest',
  'caseFingerprints',
  'familyFingerprints',
]);
const sha256 = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function descriptor(value: unknown): value is LearningEvaluationDescriptor {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !descriptorFields.has(key)) ||
    !bounded(value.datasetRevision, 1024) ||
    !bounded(value.graderRevision, 1024) ||
    !object(value.runtime) ||
    !Array.isArray(value.expectedCases) ||
    value.expectedCases.length < 1 ||
    value.expectedCases.length > 1000 ||
    (value.fixtureProtocol !== undefined &&
      (value.fixtureProtocol !== 'installed-v1' ||
        !sha256(value.datasetDigest) ||
        !Array.isArray(value.caseFingerprints) ||
        !value.caseFingerprints.length)) ||
    (value.datasetDigest !== undefined && !sha256(value.datasetDigest)) ||
    [value.caseFingerprints, value.familyFingerprints].some(
      (list) => list !== undefined && (!Array.isArray(list) || !list.every(sha256)),
    )
  )
    return false;
  const runtime = Object.entries(value.runtime);
  return (
    runtime.length > 0 &&
    runtime.length <= 64 &&
    runtime.every(([key, setting]) => bounded(key, 128) && bounded(setting, 4096)) &&
    value.expectedCases.every(
      (item) =>
        object(item) &&
        Object.keys(item).length === 2 &&
        bounded(item.caseId, 1024) &&
        typeof item.repetition === 'number' &&
        Number.isInteger(item.repetition) &&
        item.repetition >= 0 &&
        item.repetition <= 0xffffffff,
    )
  );
}

function parseDescriptors(value: unknown): unknown {
  if (!bounded(value, 1_000_000))
    throw Error('Paste installed evaluator descriptors of at most 1 MB.');
  try {
    return JSON.parse(value);
  } catch {
    throw Error('Evaluation descriptors must be valid JSON.');
  }
}

function selectionPolicies(raw: unknown) {
  if (raw === undefined || raw === '') return undefined;
  if (!bounded(raw, 256_000)) throw Error('Enter selection policies of at most 256 KB.');
  try {
    const pair: unknown = JSON.parse(raw);
    if (!object(pair) || Object.keys(pair).length !== 2) throw Error();
    function stage(value: unknown) {
      if (!object(value)) throw Error();
      const { protectedCaseThresholds, minimumCostSavingsUsd, minimumRepetitionsPerCase, ...base } =
        value;
      const policy = validateEvaluationPolicy(base);
      if (
        minimumCostSavingsUsd !== undefined &&
        (typeof minimumCostSavingsUsd !== 'number' ||
          !Number.isFinite(minimumCostSavingsUsd) ||
          minimumCostSavingsUsd < 0)
      )
        throw Error();
      if (
        minimumRepetitionsPerCase !== undefined &&
        (typeof minimumRepetitionsPerCase !== 'number' ||
          !Number.isInteger(minimumRepetitionsPerCase) ||
          minimumRepetitionsPerCase < 1 ||
          minimumRepetitionsPerCase > 1000)
      )
        throw Error();
      let thresholds: Record<string, number> | undefined;
      if (protectedCaseThresholds !== undefined) {
        if (!object(protectedCaseThresholds)) throw Error();
        thresholds = Object.fromEntries(
          Object.entries(protectedCaseThresholds).map(([id, floor]) => {
            if (!bounded(id, 1024) || typeof floor !== 'number' || !Number.isFinite(floor))
              throw Error();
            return [id, floor];
          }),
        );
      }
      return {
        ...policy,
        ...(minimumRepetitionsPerCase === undefined ? {} : { minimumRepetitionsPerCase }),
        ...(thresholds === undefined ? {} : { protectedCaseThresholds: thresholds }),
        ...(minimumCostSavingsUsd === undefined ? {} : { minimumCostSavingsUsd }),
      };
    }
    return { development: stage(pair.development), audit: stage(pair.audit) };
  } catch {
    throw Error('Enter valid selection policies for development and audit.');
  }
}

export function skillPermissions(create: unknown, retire: unknown) {
  function names(value: unknown): string[] {
    if (value === undefined || value === '') return [];
    if (!bounded(value, 8192)) throw Error('Enter skill names, one per line.');
    const entries = value
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (
      entries.length > 32 ||
      new Set(entries.map((entry) => entry.toLowerCase())).size !== entries.length ||
      entries.some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name))
    )
      throw Error(
        'Use up to 32 distinct skill names of 1–64 letters, digits, underscores or hyphens.',
      );
    return entries;
  }
  return { createSkillNames: names(create), retireSkillNames: names(retire) };
}

export function renewalSettings(
  limit: unknown,
  descriptors: unknown,
  replacement?: unknown,
  policies?: unknown,
) {
  const proposalAdmissions =
    typeof limit === 'string' && /^(\d{1,3}|)$/.test(limit) ? Number(limit) : NaN;
  if (!Number.isInteger(proposalAdmissions) || proposalAdmissions < 0 || proposalAdmissions > 100)
    throw Error('Add between 0 and 100 proposal admissions.');
  const audits = descriptors === '' ? [] : parseDescriptors(descriptors);
  if (!Array.isArray(audits) || audits.length > 32 || !audits.every(descriptor))
    throw Error('Import a JSON array of up to 32 installed audit descriptors.');
  const development =
    replacement === undefined || replacement === '' ? undefined : parseDescriptors(replacement);
  if (development !== undefined && !descriptor(development))
    throw Error('Import an installed development descriptor.');
  const selection = selectionPolicies(policies);
  if (!proposalAdmissions && !audits.length && !development && !selection)
    throw Error(
      'Add admissions or audits, or supply a new development descriptor or selection policy.',
    );
  return {
    proposalAdmissions,
    audits,
    ...(development ? { development } : {}),
    ...(selection ? { selectionPolicies: selection } : {}),
  };
}

export function permittedBundlePaths(value: unknown) {
  if (!bounded(value, 8192)) throw Error('Enter the permitted bundle paths.');
  const permittedPaths = value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (permittedPaths.length > 32 || new Set(permittedPaths).size !== permittedPaths.length)
    throw Error('Enter up to 32 distinct bundle paths, one per line.');
  return permittedPaths;
}

export function learningPolicy(input: unknown): LearningEnrollmentRequest {
  if (!object(input)) throw Error('Learning setup is required.');
  const {
    installationId,
    outcomePrincipal,
    evaluatorPrincipal,
    automaticRollback,
  } = input;
  if (!bounded(installationId, 128))
    throw Error('Enter the installed evaluator’s installation ID.');
  if (
    !bounded(outcomePrincipal, 1024) ||
    !bounded(evaluatorPrincipal, 1024) ||
    outcomePrincipal.trim() === evaluatorPrincipal.trim()
  )
    throw Error('Enter two distinct machine principal IDs.');
  const permittedPaths = permittedBundlePaths(input.permittedPaths);
  const maxProposalAdmissions = bounded(input.maxProposalAdmissions, 3)
    ? Number(input.maxProposalAdmissions)
    : NaN;
  if (
    !Number.isInteger(maxProposalAdmissions) ||
    maxProposalAdmissions < 1 ||
    maxProposalAdmissions > 100
  )
    throw Error('Enter a proposal limit from 1 to 100.');
  if (input.automaticRollout === false) throw Error('Connected learning requires automatic rollout.');
  if (automaticRollback !== undefined && typeof automaticRollback !== 'boolean')
    throw Error('Choose a post-rollout policy.');
  const imported = parseDescriptors(input.descriptors);
  if (
    !object(imported) ||
    Object.keys(imported).length !== 2 ||
    !descriptor(imported.development) ||
    !Array.isArray(imported.audits) ||
    !imported.audits.length ||
    imported.audits.length > 32 ||
    !imported.audits.every(descriptor)
  )
    throw Error(
      'Import one development descriptor and 1–32 audit descriptors from your evaluator.',
    );
  if (
    [imported.development, ...imported.audits].some(
      (item) => item.fixtureProtocol !== 'installed-v1',
    )
  )
    throw Error(
      'Automatic rollout requires fixture commitments from connectedEvaluationDescriptor(app).',
    );
  const selection = selectionPolicies(input.selectionPolicies);
  const skills = skillPermissions(input.createSkillNames, input.retireSkillNames);
  const revisions = new Set<string>();
  const caseIds = new Set<string>();
  for (const cohort of [imported.development, ...imported.audits]) {
    const ids = new Set(cohort.expectedCases.map((item) => item.caseId));
    const cases = new Set(
      cohort.expectedCases.map((item) => JSON.stringify([item.caseId, item.repetition])),
    );
    if (
      revisions.has(cohort.datasetRevision) ||
      cases.size !== cohort.expectedCases.length ||
      [...ids].some((id) => caseIds.has(id))
    )
      throw Error(
        'Each descriptor needs a distinct dataset revision and case IDs disjoint from other descriptors.',
      );
    revisions.add(cohort.datasetRevision);
    for (const id of ids) caseIds.add(id);
  }
  return {
    installationId: installationId.trim(),
    permittedPaths,
    maxProposalAdmissions,
    development: imported.development,
    audits: imported.audits,
    ...(selection ? { selectionPolicies: selection } : {}),
    ...(skills.createSkillNames.length || skills.retireSkillNames.length
      ? { skillPackages: skills }
      : {}),
    ...(automaticRollback === undefined ? {} : { automaticRollback }),
    outcomePrincipal: outcomePrincipal.trim(),
    evaluatorPrincipal: evaluatorPrincipal.trim(),
  };
}
