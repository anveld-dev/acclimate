export const MACHINE_TOKEN_RIGHTS = ['read', 'write', 'promote'] as const;
export type MachineTokenRight = (typeof MACHINE_TOKEN_RIGHTS)[number];
