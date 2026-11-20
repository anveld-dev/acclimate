import { accessTransport } from './access-core';
import type { Environment } from './selection';
export type Invitation = {
  id: string;
  email: string;
  role: 'viewer' | 'editor' | 'admin';
  status: 'pending' | 'accepted' | 'revoked';
  deliveryStatus: 'queued' | 'sending' | 'sent' | 'failed';
  expiresAt: string;
  sentAt: string | null;
  workspaceId?: string;
  projectName?: string;
};
export type InvitationCommand =
  | { kind: 'list'; workspaceId: string }
  | { kind: 'create'; workspaceId: string; email: string; role: 'viewer' | 'editor' | 'admin' }
  | { kind: 'resend' | 'revoke'; workspaceId: string; id: string }
  | { kind: 'preview' | 'accept'; id: string };
export type InvitationResult =
  | {
      ok: true;
      items?: Invitation[];
      available?: boolean;
      invitation?: Invitation;
      workspaceId?: string;
    }
  | { ok: false; message: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function invitationCommand(
  env: Environment,
  input: InvitationCommand,
  fetcher: typeof fetch = fetch,
): Promise<InvitationResult> {
  if (!input || !['list', 'create', 'resend', 'revoke', 'preview', 'accept'].includes(input.kind))
    return { ok: false, message: 'Invalid invitation action.' };
  if ('id' in input && !uuid.test(input.id))
    return { ok: false, message: 'Invalid invitation link.' };
  if (
    'workspaceId' in input &&
    (!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.workspaceId) || ['.', '..'].includes(input.workspaceId))
  )
    return { ok: false, message: 'Invalid workspace.' };
  try {
    const request = accessTransport(env, fetcher);
    const base =
      'workspaceId' in input
        ? `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/invitations`
        : `/v1/invitations/${input.id}`;
    if (input.kind === 'list') {
      const value = await request(base);
      if (!Array.isArray(value.items) || typeof value.available !== 'boolean') throw new Error();
      return { ok: true, items: value.items, available: value.available };
    }
    if (input.kind === 'preview') return { ok: true, invitation: await request(base) };
    if (input.kind === 'accept')
      return { ok: true, workspaceId: (await request(`${base}/accept`, 'POST')).workspaceId };
    if (input.kind === 'revoke') {
      await request(`${base}/${input.id}`, 'DELETE');
      return { ok: true };
    }
    if (input.kind === 'resend')
      return { ok: true, invitation: await request(`${base}/${input.id}/resend`, 'POST') };
    if (input.kind === 'create')
      return {
        ok: true,
        invitation: await request(base, 'POST', { email: input.email, role: input.role }),
      };
    return { ok: false, message: 'Invalid invitation action.' };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === 'InvitationError'
          ? error.message
          : 'Could not confirm this invitation. Check your account and try again.',
    };
  }
}
