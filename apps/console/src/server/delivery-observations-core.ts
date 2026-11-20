import type { ConnectionObservation, Page } from '@acclimate/sdk';
import { ApiError } from '@acclimate/sdk';
import { consoleClient } from './console-client';
import { publicReport } from './delivery-detail-core';
import { allPages } from './listing';
import { requireSession, type Environment } from './selection';

export type DeliveryObservationsResult =
  | { ok: false; message: string }
  | { ok: true; workspaceId: string; workspaceName: string; page: Page<ConnectionObservation> };

/** Reading app observations deliberately does not enter the admin Connections context. */
export async function readDeliveryObservationsState(
  env: Environment,
  input: { workspaceId: string; cursor?: string; connectionId?: string },
  fetcher: typeof fetch = fetch,
): Promise<DeliveryObservationsResult> {
  try {
    requireSession(env);
    if (
      !input ||
      typeof input.workspaceId !== 'string' ||
      !/^[^\x00-\x20\x7f/]{1,200}$/.test(input.workspaceId) ||
      (input.cursor !== undefined && !/^[a-f0-9-]{36}$/i.test(input.cursor)) ||
      (input.connectionId !== undefined && !/^[a-f0-9-]{36}$/i.test(input.connectionId))
    )
      return { ok: false, message: 'Select a workspace and a valid delivery page.' };
    const api = consoleClient(env, fetcher);
    const projects = await allPages((cursor) => api.listWorkspaces({ cursor, limit: 100 }));
    const project = projects.find((item) => item.id === input.workspaceId);
    if (!project)
      return { ok: false, message: 'Access denied. Current workspace read access is required.' };
    const response = await api.listConnectionObservations(input.workspaceId, {
      cursor: input.cursor,
      limit: 50,
    });
    if (
      input.connectionId &&
      !response.items.some((item) => item.id === input.connectionId) &&
      response.nextCursor
    ) {
      const remaining = await allPages((cursor) =>
        api.listConnectionObservations(input.workspaceId, {
          cursor: cursor ?? response.nextCursor!,
          limit: 100,
        }),
      );
      const linked = remaining.find((item) => item.id === input.connectionId);
      if (linked) response.items.push(linked);
    }
    // Workspace only the public observation DTO, even if an upstream version adds fields.
    const page: Page<ConnectionObservation> = {
      nextCursor: response.nextCursor,
      items: response.items.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        bundleId: item.bundleId,
        channel: item.channel,
        enabled: item.enabled,
        latestObservation: item.latestObservation ? publicReport(item.latestObservation) : null,
      })),
    };
    return { ok: true, workspaceId: project.id, workspaceName: project.name, page };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof ApiError && [401, 403].includes(error.status)
          ? 'Access denied. Current workspace read access is required.'
          : 'Delivery observations could not be read. Reported delivery is currently unknown.',
    };
  }
}
