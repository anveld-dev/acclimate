import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, type AcclimateClient } from '../client.js';
import type { LearningEvolveCase, LearningEvolveCasesRequest, LearningLoopRequest } from '../types.js';

export async function resolveAppPrincipal(
  client: Pick<AcclimateClient, 'getPrincipal'>,
  workspaceId: string,
  { explicit, separateEnrollment }: { explicit?: string; separateEnrollment: boolean },
) {
  if (explicit) return explicit;
  const principal = await client.getPrincipal(workspaceId);
  if (principal.kind !== 'machine') throw new Error('Use a machine token for ACCLIMATE_TOKEN.');
  const required = separateEnrollment ? ['evaluate'] : ['evaluate', 'promote'];
  const missing = required.filter(right => !principal.rights.includes(right) &&
    !(right === 'evaluate' && principal.rights.includes('write')));
  if (missing.length)
    throw new Error(`ACCLIMATE_TOKEN needs the following workspace rights: ${missing.join(', ')}.`);
  return principal.principalId;
}

export async function reconcileLoop(
  client: Pick<AcclimateClient, 'getLearningLoop' | 'enrollLearningLoop'>,
  workspaceId: string,
  bundleId: string,
  desired: LearningLoopRequest,
  enrollment: Pick<AcclimateClient, 'enrollLearningLoop'> = client,
) {
  const existing = await client.getLearningLoop(workspaceId, bundleId).catch(error => {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  });
  const heldOutChanged = !!existing && !isDeepStrictEqual(existing.heldOut, desired.heldOut);
  if (heldOutChanged && existing.activeRound) {
    throw new Error('The held-out commitment cannot change during an active round. Pause the loop and let the round finish, then rerun acclimate learn.');
  }
  if (!existing || existing.status === 'stopped' || existing.channel !== desired.channel ||
      existing.appPrincipalId !== desired.appPrincipalId || heldOutChanged ||
      !isDeepStrictEqual(existing.setting, desired.setting)) {
    try {
      return await enrollment.enrollLearningLoop(workspaceId, bundleId, desired, randomUUID());
    } catch (error) {
      if (heldOutChanged && error instanceof ApiError && error.code === 'learning_conflict')
        throw new Error('The service refused the held-out commitment change. Pause the loop and let the active round finish, then rerun acclimate learn.');
      throw error;
    }
  }
  return existing;
}

export async function syncEvolveCases(
  client: Pick<AcclimateClient, 'listLearningEvolveCases' | 'addLearningEvolveCases'>,
  workspaceId: string,
  bundleId: string,
  cases: readonly LearningEvolveCase[],
  /** Runs once, before the first write, only when the sync will add or retire cases. */
  beforeWrite?: () => Promise<void>,
) {
  const desired = new Map(cases.map(item => [item.caseId, item]));
  const retire: string[] = [];
  let after: string | undefined;
  let revision: number | undefined;
  // Large cases can push a 100-case page past the client's 4 MiB response cap; halve and retry.
  let limit = 100;
  for (;;) {
    let page;
    try {
      page = await client.listLearningEvolveCases(workspaceId, bundleId, { after, limit });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'response_too_large' || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    if (revision !== undefined && page.evolveRevision !== revision)
      throw new Error('The evolve cases changed during listing. Rerun acclimate learn to sync.');
    revision = page.evolveRevision;
    for (const { caseId, input, expected } of page.items) {
      if (caseId.startsWith('outcome:')) continue;
      const item = desired.get(caseId);
      if (!item) retire.push(caseId);
      else if (!isDeepStrictEqual(item.input, input) || !isDeepStrictEqual(item.expected, expected))
        throw new Error(`Evolve case ${caseId} already exists with different data. Give the edited case a new case ID.`);
      desired.delete(caseId);
    }
    after = page.next ?? undefined;
    if (!after) break;
  }

  const add = [...desired.values()];
  // The service rejects bodies over 2 MiB. Each case is at most 128 KiB of input and expected
  // JSON, so batch by bytes as well as count, leaving room for the envelope and 100 retirements.
  const byteBudget = 2 * 1024 * 1024 - 14_000;
  let added = 0;
  let removed = 0;
  if (add.length || retire.length) await beforeWrite?.();
  while (added < add.length || removed < retire.length) {
    const cases: typeof add = [];
    let size = 0;
    for (const item of add.slice(added, added + 100)) {
      const itemSize = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size + itemSize > byteBudget) break;
      cases.push(item);
      size += itemSize;
    }
    const body: LearningEvolveCasesRequest = { cases, retire: retire.slice(removed, removed + 100) };
    await client.addLearningEvolveCases(workspaceId, bundleId, body, randomUUID());
    added += cases.length;
    removed += body.retire!.length;
  }
}
