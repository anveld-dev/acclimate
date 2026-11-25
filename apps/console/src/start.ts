import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';

const canonicalHost = createMiddleware({ type: 'request' }).server(async ({ request, next }) => {
  if (!['/health', '/ready'].includes(new URL(request.url).pathname)) {
    const { canonicalRequestUrl } = await import('./server/configuration');
    try {
      canonicalRequestUrl(request, process.env);
    } catch {
      return new Response('Invalid request host.', { status: 400 });
    }
  }
  return next();
});
export const startInstance = createStart(() => ({
  requestMiddleware: [
    canonicalHost,
    createCsrfMiddleware({
      filter: (context) => context.handlerType === 'serverFn',
      origin: async (origin) => {
        const { assertConsoleConfiguration } = await import('./server/configuration');
        return origin === assertConsoleConfiguration(process.env).origin;
      },
    }),
  ],
}));
