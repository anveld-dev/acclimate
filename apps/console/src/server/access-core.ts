import { requireSession, actorScope, type Environment } from './selection';
import { allPages } from './listing';
export type AccessIdentity = {
  userId: string;
  issuer: string;
  subject: string;
  displayName?: string;
};
export type AccessProject = { id: string; name: string; role: string };
export type AccessState =
  | {
      ok: true;
      identity: AccessIdentity;
      projects: AccessProject[];
      canCreateWorkspace: boolean;
      actorScope?: string;
      members?: VerifiedUser[];
      nextMemberCursor?: string | null;
    }
  | {
      ok: false;
      identity: null;
      projects: [];
      message: string;
      requiresSignIn?: boolean;
      denied?: boolean;
    };
export type VerifiedUser = {
  id: string;
  issuer: string;
  subject: string;
  role: string | null;
  displayName?: string;
};
type Confirmed = { issuer: string; subject: string };
export type AccessCommand =
  | { kind: 'adoptWorkspace'; projectId: string; reason: string; confirmedIdentity: AccessIdentity }
  | { kind: 'createProject'; id: string; name: string }
  | { kind: 'userLookup'; projectId: string; userId: string }
  | {
      kind: 'setMembership';
      projectId: string;
      userId: string;
      role: 'viewer' | 'editor' | 'admin';
      confirmedIdentity: Confirmed;
    }
  | { kind: 'removeMembership'; projectId: string; userId: string; confirmedIdentity: Confirmed };
export type WorkspaceAdoption = {
  projectId: string;
  userId: string;
  reason: string;
  createdAt: string;
  alreadyAdopted: boolean;
  currentRole: string | null;
};
export type AccessResult =
  | {
      ok: true;
      kind: AccessCommand['kind'];
      project?: AccessProject;
      user?: VerifiedUser;
      adoption?: WorkspaceAdoption;
    }
  | { ok: false; message: string };
class Denied extends Error {}
class SessionExpired extends Denied {}
/** True when the service or session refused the caller (including an expired session). */
export function accessDenied(error: unknown): boolean {
  return error instanceof Denied;
}
class LastAdmin extends Error {}
export function accessTransport(env: Environment, fetcher: typeof fetch) {
  if (!env.CONSOLE_SESSION_TOKEN) throw new SessionExpired();
  requireSession(env);
  if (!env.CONSOLE_SERVICE_TOKEN) throw new Denied();
  return async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetcher(`${env.CONSOLE_SERVICE_URL!.replace(/\/$/, '')}${path}`, {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${env.CONSOLE_SERVICE_TOKEN}`,
        ...(env.CONSOLE_SESSION_TOKEN ? { 'x-acclimate-session': env.CONSOLE_SESSION_TOKEN } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      if (response.status === 401 && error?.error?.code === 'invalid_session')
        throw new SessionExpired();
      if (
        [
          'not_found',
          'email_not_verified',
          'invitation_closed',
          'already_member',
          'invitation_exists',
          'invitation_limit',
          'resend_unavailable',
          'email_unavailable',
        ].includes(error?.error?.code) &&
        path.includes('/invitations')
      ) {
        const problem = new Error(String(error.error.message).slice(0, 500));
        problem.name = 'InvitationError';
        throw problem;
      }
      if (
        ['invalid_content', 'not_found', 'machine_token_limit', 'machine_token_inactive'].includes(
          error?.error?.code,
        ) &&
        path.includes('/machine-tokens')
      ) {
        const problem = new Error(String(error.error.message).slice(0, 500));
        problem.name = 'MachineTokenError';
        throw problem;
      }
      if ([401, 403].includes(response.status)) throw new Denied();
      if (response.status === 409 && error?.error?.code === 'last_admin') throw new LastAdmin();
      throw new Error('Unavailable');
    }
    return response.status === 204 ? undefined : response.json();
  };
}
const failure = (
  error: unknown,
): { ok: false; message: string; requiresSignIn?: boolean; denied?: boolean } => ({
  ok: false,
  ...(error instanceof SessionExpired ? { requiresSignIn: true } : {}),
  ...(error instanceof Denied ? { denied: true } : {}),
  message:
    error instanceof LastAdmin
      ? 'Add another administrator before removing or demoting the final administrator.'
      : error instanceof Denied
        ? 'Access denied. Sign in with an identity authorized for this action.'
        : 'Could not confirm the service response. Refresh access before repeating an action.',
});
async function projects(request: ReturnType<typeof accessTransport>): Promise<AccessProject[]> {
  // Preserve the terminal page allowed after 1000 continuation cursors.
  return allPages(async (cursor) => {
    const page = await request(
      `/v1/workspaces?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!Array.isArray(page.items)) throw new Error('Invalid projects');
    return {
      items: page.items.map((p: AccessProject) => ({ id: p.id, name: p.name, role: p.role })),
      nextCursor: page.nextCursor || undefined,
    };
  }, 1001);
}
export async function readAccessState(
  env: Environment,
  fetcher: typeof fetch = fetch,
): Promise<AccessState> {
  try {
    const request = accessTransport(env, fetcher);
    const value = await request('/v1/auth/session');
    if (
      !userId(value.userId) ||
      typeof value.issuer !== 'string' ||
      typeof value.subject !== 'string' ||
      !value.subject
    )
      throw new Error('Invalid verified session');
    const identity = {
      userId: value.userId,
      issuer: value.issuer,
      subject: value.subject,
      ...(typeof value.displayName === 'string' &&
      value.displayName.trim() &&
      value.displayName.length <= 200
        ? { displayName: value.displayName }
        : {}),
    };
    const canCreateWorkspace = value.canCreateWorkspace === true;
    return {
      ok: true,
      identity,
      canCreateWorkspace,
      actorScope: actorScope(env),
      projects: await projects(request),
    };
  } catch (error) {
    return { ...failure(error), identity: null, projects: [] };
  }
}
export async function readWorkspaceAccessState(
  env: Environment,
  project: string,
  fetcher: typeof fetch = fetch,
): Promise<AccessState> {
  const state = await readAccessState(env, fetcher);
  if (!state.ok) return state;
  const selected = state.projects.find((value) => value.id === project);
  if (selected?.role !== 'admin')
    return {
      ...failure(new Denied()),
      identity: null,
      projects: [],
    };
  const members = await readMembershipPage(env, project, undefined, fetcher);
  if (!members.ok) return { ...members, identity: null, projects: [] };
  return {
    ...state,
    projects: [selected],
    members: members.items,
    nextMemberCursor: members.nextCursor,
  };
}
const projectId = (value: unknown): value is string =>
  typeof value === 'string' &&
  !['.', '..'].includes(value) &&
  /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
const userId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function accessCommand(
  env: Environment,
  input: AccessCommand,
  fetcher: typeof fetch = fetch,
): Promise<AccessResult> {
  if (!env.CONSOLE_SESSION_TOKEN) return failure(new Denied());
  if (
    !input ||
    ![
      'adoptWorkspace',
      'createProject',
      'userLookup',
      'setMembership',
      'removeMembership',
    ].includes(input.kind)
  )
    return { ok: false, message: 'Invalid access action.' };
  try {
    const request = accessTransport(env, fetcher);
    // Resolve the current Rust session before any access command; no client-supplied actor.
    const actor = await request('/v1/auth/session');
    if (input.kind === 'adoptWorkspace') {
      if (
        !input.confirmedIdentity ||
        input.confirmedIdentity.userId !== actor.userId ||
        input.confirmedIdentity.issuer !== actor.issuer ||
        input.confirmedIdentity.subject !== actor.subject
      )
        return {
          ok: false,
          message: 'Your account changed. Review workspace adoption again before confirming.',
        };
      if (
        !projectId(input.projectId) ||
        ['.', '..'].includes(input.projectId) ||
        typeof input.reason !== 'string' ||
        !input.reason.trim() ||
        input.reason.length > 2000
      )
        return { ok: false, message: 'Enter an exact workspace ID and adoption reason.' };
      const value = await request('/v1/auth/workspace-adoptions', 'POST', {
        projectId: input.projectId,
        reason: input.reason.trim(),
      });
      const adoption: WorkspaceAdoption = {
        projectId: value.projectId,
        userId: value.userId,
        reason: value.reason,
        createdAt: value.createdAt,
        alreadyAdopted: value.alreadyAdopted === true,
        currentRole: value.currentRole ?? null,
      };
      if (
        adoption.projectId !== input.projectId ||
        !userId(adoption.userId) ||
        typeof adoption.reason !== 'string' ||
        typeof adoption.createdAt !== 'string'
      )
        throw new Error('Invalid adoption response');
      return { ok: true, kind: input.kind, adoption };
    }
    if (input.kind === 'createProject') {
      if (
        !projectId(input.id) ||
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.length > 200
      )
        return { ok: false, message: 'Enter a valid workspace ID and name.' };
      const p = await request('/v1/workspaces', 'POST', { id: input.id, name: input.name.trim() });
      return { ok: true, kind: input.kind, project: { id: p.id, name: p.name, role: p.role } };
    }
    if (!projectId(input.projectId) || !userId(input.userId))
      return { ok: false, message: 'Enter a workspace and verified user ID.' };
    const path = `/v1/workspaces/${encodeURIComponent(input.projectId)}`;
    const value = await request(`${path}/users/${encodeURIComponent(input.userId)}`);
    const user: VerifiedUser = safeMember(value);
    if (input.kind === 'userLookup') return { ok: true, kind: input.kind, user };
    if (
      !input.confirmedIdentity ||
      input.confirmedIdentity.issuer !== user.issuer ||
      input.confirmedIdentity.subject !== user.subject
    )
      return {
        ok: false,
        message: 'Look up the user and confirm the displayed identity before changing access.',
      };
    if (input.kind === 'setMembership' && !['viewer', 'editor', 'admin'].includes(input.role))
      return { ok: false, message: 'Choose a valid membership role.' };
    await request(
      `${path}/memberships/${encodeURIComponent(input.userId)}`,
      input.kind === 'setMembership' ? 'PUT' : 'DELETE',
      input.kind === 'setMembership' ? { role: input.role } : undefined,
    );
    return { ok: true, kind: input.kind, user };
  } catch (error) {
    return failure(error);
  }
}

function safeMember(value: VerifiedUser): VerifiedUser {
  if (
    !value ||
    !userId(value.id) ||
    typeof value.issuer !== 'string' ||
    typeof value.subject !== 'string'
  )
    throw Error('Invalid verified identity');
  return {
    id: value.id,
    issuer: value.issuer,
    subject: value.subject,
    ...(typeof value.displayName === 'string' &&
    value.displayName.trim() &&
    value.displayName.length <= 200
      ? { displayName: value.displayName }
      : {}),
    role: ['viewer', 'editor', 'admin'].includes(value.role ?? '') ? value.role : null,
  };
}
export async function readMembershipPage(
  env: Environment,
  project: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { ok: true; items: VerifiedUser[]; nextCursor: string | null }
  | { ok: false; message: string; denied?: boolean }
> {
  try {
    if (!projectId(project) || (cursor !== undefined && !/^[0-9a-f]{1,512}$/i.test(cursor)))
      throw new Denied();
    const request = accessTransport(env, fetcher);
    const page = await request(
      `/v1/workspaces/${encodeURIComponent(project)}/memberships?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (
      !Array.isArray(page.items) ||
      page.items.length > 25 ||
      (page.nextCursor != null &&
        (typeof page.nextCursor !== 'string' || !/^[0-9a-f]{1,512}$/i.test(page.nextCursor)))
    )
      throw Error('Invalid membership page');
    return { ok: true, items: page.items.map(safeMember), nextCursor: page.nextCursor ?? null };
  } catch (error) {
    return failure(error);
  }
}
