import type { LearningEnrollmentRequest, EvaluationDescriptor } from '@acclimate/sdk';

export type LearningSetup = {
  installationId: string;
  permittedPaths: string;
  maxProposalAdmissions: string;
  descriptors: string;
  outcomePrincipal: string;
  evaluatorPrincipal: string;
  automaticRollout: boolean;
  automaticRollback?: boolean;
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
  'datasetDigest',
  'caseFingerprints',
  'familyFingerprints',
]);
const sha256 = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function descriptor(value: unknown): value is EvaluationDescriptor {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !descriptorFields.has(key)) ||
    !bounded(value.datasetRevision, 1024) ||
    !bounded(value.graderRevision, 1024) ||
    !object(value.runtime) ||
    !Array.isArray(value.expectedCases) ||
    value.expectedCases.length < 1 ||
    value.expectedCases.length > 1000 ||
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

export function renewalSettings(limit: unknown, descriptors: unknown) {
  const proposalAdmissions =
    typeof limit === 'string' && /^(\d{1,3}|)$/.test(limit) ? Number(limit) : NaN;
  if (!Number.isInteger(proposalAdmissions) || proposalAdmissions < 0 || proposalAdmissions > 100)
    throw Error('Add between 0 and 100 proposal admissions.');
  const audits = descriptors === '' ? [] : parseDescriptors(descriptors);
  if (!Array.isArray(audits) || audits.length > 32 || !audits.every(descriptor))
    throw Error('Import a JSON array of up to 32 installed audit descriptors.');
  if (!proposalAdmissions && !audits.length)
    throw Error('Add proposal admissions or audit cohorts.');
  return { proposalAdmissions, audits };
}

export function learningPolicy(input: unknown): LearningEnrollmentRequest {
  if (!object(input)) throw Error('Learning setup is required.');
  const {
    installationId,
    outcomePrincipal,
    evaluatorPrincipal,
    automaticRollout,
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
  if (!bounded(input.permittedPaths, 8192)) throw Error('Enter the permitted bundle paths.');
  const permittedPaths = input.permittedPaths
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (permittedPaths.length > 32 || new Set(permittedPaths).size !== permittedPaths.length)
    throw Error('Enter up to 32 distinct bundle paths, one per line.');
  const maxProposalAdmissions = bounded(input.maxProposalAdmissions, 3)
    ? Number(input.maxProposalAdmissions)
    : NaN;
  if (
    !Number.isInteger(maxProposalAdmissions) ||
    maxProposalAdmissions < 1 ||
    maxProposalAdmissions > 100
  )
    throw Error('Enter a proposal limit from 1 to 100.');
  if (typeof automaticRollout !== 'boolean') throw Error('Choose a rollout policy.');
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
    automaticRollout,
    ...(automaticRollback === undefined ? {} : { automaticRollback }),
    outcomePrincipal: outcomePrincipal.trim(),
    evaluatorPrincipal: evaluatorPrincipal.trim(),
  };
}
