import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { MachineTokenCommand } from './machine-token-core';

export const runMachineTokenCommand = createServerFn({ method: 'POST' })
  .validator((input: MachineTokenCommand) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { machineTokenCommand } = await import('./machine-token-core');
    return machineTokenCommand(await requestEnvironment(), data);
  });
