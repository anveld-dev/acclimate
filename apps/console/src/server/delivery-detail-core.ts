import type { ConnectionObservation, Page } from '@anveld/sdk';
import { consoleClient } from './console-client';
import { allPages } from './listing';
import { requireSession, type Environment } from './selection';

type Observation = NonNullable<ConnectionObservation['latestObservation']>;
export type Report = Observation & { revision?: string | null; source?: string; delayed?: boolean };
export type DeliveryDetail = {
  current: { versionId: string; digest: string; revision: string; promotedAt: string } | null;
  receipts: Page<Report>;
};
export type DetailResult = { ok: true; detail: DeliveryDetail } | { ok: false; message: string };
export type SetupReportResult =
  | { state: 'empty' | 'error' }
  | { state: 'received'; report: Observation; app: string; appId: string };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const identifier = /^[^\x00-\x20\x7f/]{1,200}$/;
export function publicReport(report: Observation): Observation {
  const { eventId, stage, versionId, digest, occurredAt, receivedAt } = report;
  return { eventId, stage, versionId, digest, occurredAt, receivedAt };
}

// PostgreSQL can receive multiple events in the same JavaScript millisecond.
function compareReceipts(a: Observation, b: Observation) {
  const fraction = (time: string) => (/\.(\d+)/.exec(time)?.[1] ?? '').padEnd(9, '0');
  return (
    Date.parse(b.receivedAt) - Date.parse(a.receivedAt) ||
    fraction(b.receivedAt).localeCompare(fraction(a.receivedAt)) ||
    b.eventId.localeCompare(a.eventId)
  );
}

export async function readSetupReportState(
  env: Environment,
  scope: { workspaceId: string; bundleId: string; channel: string },
  fetcher: typeof fetch = fetch,
): Promise<SetupReportResult> {
  try {
    requireSession(env);
    if (
      !scope ||
      typeof scope.workspaceId !== 'string' ||
      !identifier.test(scope.workspaceId) ||
      !uuid.test(scope.bundleId) ||
      typeof scope.channel !== 'string' ||
      !identifier.test(scope.channel)
    )
      return { state: 'error' };
    const client = consoleClient(env, fetcher);
    const observations = await allPages((cursor) =>
      client.listConnectionObservations(scope.workspaceId, { cursor, limit: 100 }),
    );
    const latest = observations
      .filter(
        (item) =>
          item.bundleId === scope.bundleId &&
          item.channel === scope.channel &&
          item.latestObservation,
      )
      .sort((a, b) => compareReceipts(a.latestObservation!, b.latestObservation!))[0];
    if (!latest?.latestObservation) return { state: 'empty' };
    return {
      state: 'received',
      report: publicReport(latest.latestObservation),
      app: latest.displayName,
      appId: latest.id,
    };
  } catch {
    return { state: 'error' };
  }
}

export async function readDeliveryDetailState(
  env: Environment,
  input: { workspaceId: string; connectionId: string; cursor?: string },
  fetcher: typeof fetch = fetch,
): Promise<DetailResult> {
  try {
    requireSession(env);
    if (
      !input ||
      typeof input.workspaceId !== 'string' ||
      !identifier.test(input.workspaceId) ||
      !uuid.test(input.connectionId) ||
      (input.cursor !== undefined && !uuid.test(input.cursor))
    )
      throw Error();
    const api = consoleClient(env, fetcher);
    // Resolve bundle and channel from the public integration directory using this user's session.
    const apps = await allPages((cursor) =>
      api.listConnectionObservations(input.workspaceId, { cursor, limit: 100 }),
    );
    const app = apps.find((item) => item.id === input.connectionId);
    if (!app) return { ok: false, message: 'This app is unavailable in this workspace.' };
    const [history, releases] = await Promise.all([
      api.listDeliveryReceipts(input.workspaceId, app.id, { cursor: input.cursor, limit: 12 }),
      api.listReleases(input.workspaceId, app.bundleId, app.channel, { limit: 1 }),
    ]);
    const latest = releases.items[0];
    if (latest && (latest.channel !== app.channel || latest.version.bundleId !== app.bundleId))
      throw Error();
    const items = history.items.map((report) => {
      if (
        report.workspaceId !== input.workspaceId ||
        report.connectionId !== app.id ||
        report.bundleId !== app.bundleId ||
        (report.channel && report.channel !== app.channel)
      )
        throw Error();
      return {
        ...publicReport(report),
        revision: report.revision,
        source: report.source,
        delayed: report.delayed,
      };
    });
    return {
      ok: true,
      detail: {
        receipts: { items, nextCursor: history.nextCursor },
        current: latest
          ? {
              versionId: latest.version.id,
              digest: latest.version.digest,
              revision: latest.revision,
              promotedAt: latest.createdAt,
            }
          : null,
      },
    };
  } catch {
    return {
      ok: false,
      message:
        'Could not verify receipt history and the current channel release. Refresh to retry.',
    };
  }
}
