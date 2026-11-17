import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';

export const readDeliveryObservations = createServerFn({ method: 'GET' })
  .validator((input: { projectId: string; cursor?: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const [{ requestEnvironment }, { readDeliveryObservationsState }] = await Promise.all([
      import('./selection'),
      import('./delivery-observations-core'),
    ]);
    return readDeliveryObservationsState(await requestEnvironment(), data);
  });
