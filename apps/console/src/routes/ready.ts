import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/ready')({
  server: {
    handlers: {
      GET: async () => {
        const { readinessResponse } = await import('../server/probes');
        return readinessResponse(process.env);
      },
    },
  },
});
