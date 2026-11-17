import path from 'node:path';
import { canonicalJson, hashArtifact } from './identity.js';
import { LearningError } from './operations.js';
import { openLearningStore } from './store.js';
import type { Scope } from './evidence-types.js';
import type { AuditCohort } from './types.js';

const MAX_COHORTS = 256;
const MAX_CASES_PER_COHORT = 1_000;
const MAX_EXPOSURES = 10_000;
const MAX_IDENTITIES = 20_000;
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

type Exposure = { operationId: string; cohortDigest: string; cases: string[]; families: string[] };
interface Ledger { revision: number; exposures: Exposure[] }

export function validateAuditRoster(cohorts: readonly AuditCohort[], requireRegistration: boolean): void {
  if (cohorts.length > MAX_COHORTS ||
      cohorts.some(cohort => !cohort || typeof cohort.id !== 'string' || !cohort.id || cohort.id.length > 256 || !digest(cohort.digest)) ||
      new Set(cohorts.map(cohort => cohort.id)).size !== cohorts.length ||
      new Set(cohorts.map(cohort => cohort.digest)).size !== cohorts.length)
    throw new LearningError('audit-roster-invalid');
  for (const cohort of cohorts) {
    if (cohort.cases === undefined && !requireRegistration) continue;
    if (!Array.isArray(cohort.cases) || !cohort.cases.length || cohort.cases.length > MAX_CASES_PER_COHORT ||
        cohort.cases.some(item => !item || !digest(item.caseFingerprint) || !digest(item.familyFingerprint)) ||
        new Set(cohort.cases.map(item => item.caseFingerprint)).size !== cohort.cases.length)
      throw new LearningError('audit-registration-invalid');
  }
}

function exposure(cohort: AuditCohort, operationId: string): Exposure {
  return {
    operationId, cohortDigest: cohort.digest,
    cases: [...new Set(cohort.cases?.map(item => item.caseFingerprint))].sort(),
    families: [...new Set(cohort.cases?.map(item => item.familyFingerprint))].sort(),
  };
}

function available(ledger: Ledger, cohort: Exposure): boolean {
  const cases = new Set(cohort.cases);
  const families = new Set(cohort.families);
  return !ledger.exposures.some(entry => entry.cohortDigest === cohort.cohortDigest ||
    entry.cases.some(item => cases.has(item)) || entry.families.some(item => families.has(item)));
}

function identityCount(ledger: Ledger): number {
  return ledger.exposures.reduce((count, entry) => count + entry.cases.length + entry.families.length, 0);
}

export async function openAuditLineage(root: string, scope: Scope) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new LearningError('audit-lineage-directory');
  // The family, partition, channel, campaign and policy epoch are intentionally absent from this key.
  const lineage = hashArtifact({ projectId: scope.projectId, bundleId: scope.bundleId }).sha256;
  const store = await openLearningStore(path.join(root, 'audit-lineages', lineage.slice(7)));
  async function read(): Promise<Ledger | null> {
    const ledger = await store.readCheckpoint<Ledger>();
    if (!ledger) return null;
    if (!Array.isArray(ledger.exposures) || ledger.exposures.length > MAX_EXPOSURES ||
        ledger.exposures.some(entry => !entry || typeof entry.operationId !== 'string' || !digest(entry.cohortDigest) ||
          !Array.isArray(entry.cases) || !entry.cases.every(digest) || !Array.isArray(entry.families) || !entry.families.every(digest)))
      throw new LearningError('audit-lineage-corrupt');
    return ledger;
  }
  return {
    directory: store.directory,
    async select(cohorts: readonly AuditCohort[]): Promise<AuditCohort | undefined> {
      if (!cohorts.length) return undefined;
      const ledger = await read();
      if (!ledger) return cohorts[0];
      if (ledger.exposures.length >= MAX_EXPOSURES) return undefined;
      const remaining = MAX_IDENTITIES - identityCount(ledger);
      return cohorts.find(cohort => {
        const candidate = exposure(cohort, '');
        return candidate.cases.length + candidate.families.length <= remaining && available(ledger, candidate);
      });
    },
    async claim(cohort: AuditCohort, operationId: string): Promise<boolean> {
      const intent = exposure(cohort, operationId);
      // Checkpoint writes use the store's revision lock, and this outer lock serializes the read and decision.
      return store.withInboxLock(async lock => {
        const previous = await read();
        const ledger = previous ?? { revision: -1, exposures: [] };
        const existing = ledger.exposures.find(entry => entry.operationId === operationId);
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(intent)) throw new LearningError('audit-lineage-conflict');
          return true;
        }
        if (!available(ledger, intent)) return false;
        if (ledger.exposures.length >= MAX_EXPOSURES ||
            identityCount(ledger) + intent.cases.length + intent.families.length > MAX_IDENTITIES) return false;
        lock.assertOwned();
        await store.writeCheckpoint(previous?.revision ?? null, {
          revision: ledger.revision + 1, exposures: [...ledger.exposures, intent],
        });
        return true;
      });
    },
  };
}
