import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/learning-import')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { streamImport } = await import('../server/stream-import');
        const { requestEnvironment } = await import('../server/selection');
        return streamImport(request, await requestEnvironment());
      },
    },
  },
});
