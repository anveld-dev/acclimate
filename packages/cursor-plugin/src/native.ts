import type { AgentOptions } from '@cursor/sdk';
import type { PreparedCursorVersion } from './index.js';

/** Native local fields for Agent.create; the host owns credentials, model and policy. */
export function cursorLocalOptions(prepared: PreparedCursorVersion): Pick<AgentOptions, 'local'> {
  return { local: { cwd: prepared.cwd, settingSources: prepared.settingSources } };
}
