import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/auth/$action')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleIdentity } = await import('../server/identity');
        return handleIdentity(request, process.env);
      },
      POST: async ({ request }) => {
        const { handleIdentity } = await import('../server/identity');
        return handleIdentity(request, process.env);
      },
    },
  },
});
