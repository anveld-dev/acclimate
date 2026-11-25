import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';

export const readDeliveryObservations = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string; cursor?: string; connectionId?: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const [{ requestEnvironment }, { readDeliveryObservationsState }] = await Promise.all([
      import('./selection'),
      import('./delivery-observations-core'),
    ]);
    return readDeliveryObservationsState(await requestEnvironment(), data);
  });

export const readDeliveryDetail = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string; connectionId: string; cursor?: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const [{ requestEnvironment }, { readDeliveryDetailState }] = await Promise.all([
      import('./selection'),
      import('./delivery-detail-core'),
    ]);
    return readDeliveryDetailState(await requestEnvironment(), data);
  });

export const readSetupReport = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string; bundleId: string; channel: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const [{ requestEnvironment }, { readSetupReportState }] = await Promise.all([
      import('./selection'),
      import('./delivery-detail-core'),
    ]);
    return readSetupReportState(await requestEnvironment(), data);
  });
