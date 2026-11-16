import type { AccessIdentity } from '../server/access-core';

export type AdoptionReview = {
  projectId: string;
  reason: string;
  identity: AccessIdentity;
};

/** Capture exactly the workspace and verified actor shown by the review. */
export function reviewWorkspaceAdoption(
  projectId: string,
  reason: string,
  identity: AccessIdentity,
): AdoptionReview | null {
  if (
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(projectId) ||
    ['.', '..'].includes(projectId) ||
    !reason.trim() ||
    reason.length > 2000
  )
    return null;
  return { projectId, reason: reason.trim(), identity: { ...identity } };
}

export function adoptionIdentityMatches(review: AdoptionReview, identity: AccessIdentity) {
  return (
    review.identity.userId === identity.userId &&
    review.identity.issuer === identity.issuer &&
    review.identity.subject === identity.subject
  );
}

export function adoptionOutcome(adoption: { alreadyAdopted: boolean; currentRole: string | null }) {
  return adoption.alreadyAdopted
    ? `This is the original adoption record. No access was restored or role changed. Current role: ${adoption.currentRole ?? 'No membership'}.`
    : `Workspace adopted. Current role: ${adoption.currentRole ?? 'No membership'}.`;
}
