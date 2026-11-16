import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { InvitationCommand } from './invitation-core';

export const runInvitationCommand = createServerFn({ method: 'POST' })
  .validator((input: InvitationCommand) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { invitationCommand } = await import('./invitation-core');
    return invitationCommand(await requestEnvironment(), data);
  });
