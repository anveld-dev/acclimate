import { accessDenied, accessTransport } from './access-core';
import type { Environment } from './selection';
import { MACHINE_TOKEN_RIGHTS, type MachineTokenRight } from '../lib/evaluator-config';

export type MachineToken = {
  id: string;
  name: string;
  principalId: string;
  rights: MachineTokenRight[];
  secretPrefix: string;
  status: 'active' | 'expired' | 'revoked';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  rotatedFrom: string | null;
};
export type MachineTokenEvent = {
  tokenId: string;
  tokenName: string;
  action: 'issued' | 'rotated' | 'revoked';
  actorPrincipal: string;
  reason: string | null;
  createdAt: string;
};
export type MachineTokenCommand =
  | { kind: 'list'; projectId: string }
  | {
      kind: 'issue';
      projectId: string;
      name: string;
      rights: MachineTokenRight[];
      expiresInDays: number;
      reason?: string;
    }
  | { kind: 'rotate'; projectId: string; id: string; overlapSeconds: number }
  | { kind: 'revoke'; projectId: string; id: string; reason: string };
export type MachineTokenResult =
  | {
      ok: true;
      items?: MachineToken[];
      events?: MachineTokenEvent[];
      /** Returned once, only by issue and rotate. */
      secret?: string;
      token?: MachineToken;
      publicApiUrl?: string;
    }
  | { ok: false; message: string; denied?: boolean };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const workspace = (id: string) => /^[a-zA-Z0-9_.-]{1,128}$/.test(id) && !['.', '..'].includes(id);

export async function machineTokenCommand(
  env: Environment,
  input: MachineTokenCommand,
  fetcher: typeof fetch = fetch,
): Promise<MachineTokenResult> {
  if (!input || !['list', 'issue', 'rotate', 'revoke'].includes(input.kind))
    return { ok: false, message: 'Invalid token action.' };
  if (!workspace(input.projectId)) return { ok: false, message: 'Invalid workspace.' };
  if ('id' in input && !uuid.test(input.id)) return { ok: false, message: 'Invalid token.' };
  if (
    input.kind === 'issue' &&
    (!Array.isArray(input.rights) ||
      !input.rights.length ||
      input.rights.some((right) => !MACHINE_TOKEN_RIGHTS.includes(right)))
  )
    return { ok: false, message: 'Choose at least one right.' };
  if (input.kind === 'revoke' && !input.reason?.trim())
    return { ok: false, message: 'Enter a reason for revoking this token.' };
  try {
    const request = accessTransport(env, fetcher);
    const base = `/v1/workspaces/${encodeURIComponent(input.projectId)}`;
    if (input.kind === 'list') {
      const [tokens, events] = await Promise.all([
        request(`${base}/machine-tokens`),
        request(`${base}/machine-token-events`),
      ]);
      if (!Array.isArray(tokens?.items) || !Array.isArray(events?.items)) throw new Error();
      return {
        ok: true,
        items: tokens.items,
        events: events.items,
        publicApiUrl: env.CONSOLE_PUBLIC_API_URL,
      };
    }
    if (input.kind === 'revoke') {
      const value = await request(`${base}/machine-tokens/${input.id}/revoke`, 'POST', {
        reason: input.reason.trim(),
      });
      return { ok: true, token: value.token };
    }
    const value =
      input.kind === 'issue'
        ? await request(`${base}/machine-tokens`, 'POST', {
            name: input.name.trim(),
            rights: input.rights,
            expiresInDays: input.expiresInDays,
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          })
        : await request(`${base}/machine-tokens/${input.id}/rotate`, 'POST', {
            overlapSeconds: input.overlapSeconds,
          });
    if (typeof value?.secret !== 'string' || !value.token) throw new Error();
    return { ok: true, secret: value.secret, token: value.token };
  } catch (error) {
    if (error instanceof Error && error.name === 'MachineTokenError')
      return { ok: false, message: error.message };
    const denied = accessDenied(error);
    return {
      ok: false,
      ...(denied ? { denied: true } : {}),
      message: denied
        ? 'Only workspace administrators can manage evaluator tokens.'
        : 'Could not confirm the token change. Refresh the token list before trying again.',
    };
  }
}
