import type { IntegrationObservation, Page } from '@acclimate/sdk';
import { ApiError } from '@acclimate/sdk';
import { consoleClient } from './console-client';
import { allPages } from './listing';
import { requireSession, type Environment } from './selection';

export type DeliveryObservationsResult =
  | { ok: false; message: string }
  | { ok: true; projectId: string; projectName: string; page: Page<IntegrationObservation> };

/** Reading app observations deliberately does not enter the admin Connections context. */
export async function readDeliveryObservationsState(
  env: Environment,
  input: { projectId: string; cursor?: string },
  fetcher: typeof fetch = fetch,
): Promise<DeliveryObservationsResult> {
  try {
    requireSession(env);
    if (
      !input ||
      typeof input.projectId !== 'string' ||
      !/^[^\x00-\x20\x7f/]{1,200}$/.test(input.projectId) ||
      (input.cursor !== undefined && !/^[a-f0-9-]{36}$/i.test(input.cursor))
    )
      return { ok: false, message: 'Select a workspace and a valid delivery page.' };
    const api = consoleClient(env, fetcher);
    const projects = await allPages((cursor) => api.listProjects({ cursor, limit: 100 }));
    const project = projects.find((item) => item.id === input.projectId);
    if (!project)
      return { ok: false, message: 'Access denied. Current workspace read access is required.' };
    const response = await api.listIntegrationObservations(input.projectId, {
      cursor: input.cursor,
      limit: 50,
    });
    // Project only the public observation DTO, even if an upstream version adds fields.
    const page: Page<IntegrationObservation> = {
      nextCursor: response.nextCursor,
      items: response.items.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        bundleId: item.bundleId,
        channel: item.channel,
        enabled: item.enabled,
        latestObservation: item.latestObservation
          ? {
              eventId: item.latestObservation.eventId,
              stage: item.latestObservation.stage,
              versionId: item.latestObservation.versionId,
              digest: item.latestObservation.digest,
              occurredAt: item.latestObservation.occurredAt,
              receivedAt: item.latestObservation.receivedAt,
            }
          : null,
      })),
    };
    return { ok: true, projectId: project.id, projectName: project.name, page };
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
