import type { AgentOptions } from '@cursor/sdk';
import type { PreparedCursorBundle } from './index.js';

/** Native local fields for Agent.create; the host owns credentials, model and policy. */
export function cursorLocalOptions(prepared: PreparedCursorBundle): Pick<AgentOptions, 'local'> {
  return { local: { cwd: prepared.cwd, settingSources: prepared.settingSources } };
}
