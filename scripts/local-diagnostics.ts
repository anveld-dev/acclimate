export type LocalDiagnosticCode =
  | 'port_busy'
  | 'tools_missing'
  | 'database_unavailable'
  | 'private_path_unsafe'
  | 'config_conflict'
  | 'startup_failed';

const messages: Record<LocalDiagnosticCode, string> = {
  port_busy:
    'Startup [port_busy]: a required local port (3000 or 3100) is occupied. Choose an explicit free bind address or stop its owner deliberately.',
  tools_missing:
    'Startup [tools_missing]: install Node 22.22+, Rust/Cargo and PostgreSQL 16 client/server tools; ensure cargo, psql and createdb are on PATH.',
  database_unavailable:
    'Startup [database_unavailable]: the explicitly configured PostgreSQL could not be reached. Review DATABASE_URL and role permissions privately; existing data was preserved.',
  private_path_unsafe:
    'Startup [private_path_unsafe]: private state must use owner-only directories (0700) and files (0600), owned by the current user, without symlinks. Inspect permissions before retrying.',
  config_conflict:
    'Startup [config_conflict]: private configuration is invalid. Review it privately; no automatic provisioning or replacement is performed. See deploy/README.md.',
  startup_failed:
    'Startup [startup_failed]: a build or process failed to become ready. Check the service/PostgreSQL log above; retry after correcting the reported failure.',
};

export class LocalSetupError extends Error {
  constructor(readonly code: LocalDiagnosticCode) {
    super(messages[code]);
  }
}

/** Only allowlisted text reaches the launcher error output. Never render a cause. */
export function localDiagnostic(error: unknown): string {
  return messages[error instanceof LocalSetupError ? error.code : 'startup_failed'];
}
import { createConnection } from 'node:net';

export async function assertLocalPortsAvailable(ports = [3000, 3100]): Promise<void> {
  const occupied = await Promise.all(
    ports.map(
      (port) =>
        new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: '127.0.0.1', port });
          const finish = (busy: boolean) => {
            socket.destroy();
            resolve(busy);
          };
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
          socket.setTimeout(300, () => finish(false));
        }),
    ),
  );
  if (occupied.some(Boolean)) throw new LocalSetupError('port_busy');
}
