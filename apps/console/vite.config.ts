import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';
import { createNitro } from 'nitro/builder';
import { defineConfig, type Plugin, type PluginOption, type UserConfig } from 'vite';
import { assertConsoleConfiguration } from './src/server/configuration';

// This pinned Start release independently loads all dotenv values despite Vite.envDir.
// Retain its compiler/router plugins while removing only that implicit loader.
async function explicitEnvironmentPlugins(option: PluginOption): Promise<Plugin[]> {
  const plugin = await option;
  if (!plugin) return [];
  if (Array.isArray(plugin))
    return (await Promise.all(plugin.map(explicitEnvironmentPlugins))).flat();
  return plugin.name === 'tanstack-start-core:load-env' ? [] : [plugin];
}

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const runtime = command === 'serve' ? assertConsoleConfiguration(process.env) : undefined;
  // Nitro's Vite integration otherwise loads .env files independently of Vite.envDir.
  const server = await createNitro(
    {
      rootDir: fileURLToPath(new URL('.', import.meta.url)),
      builder: 'vite',
      dev: command === 'serve',
      preset: 'node-server',
      plugins: [fileURLToPath(new URL('./src/server/prelisten.ts', import.meta.url))],
    },
    { dotenv: false },
  );
  return {
    envDir: false,
    server: {
      host: '127.0.0.1',
      port: 3100,
      strictPort: true,
      allowedHosts: runtime ? [new URL(runtime.origin).hostname] : [],
    },
    resolve: {
      alias: [
        { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        {
          find: /^@anveld\/sdk\/validation$/,
          replacement: fileURLToPath(
            new URL('../../packages/sdk/src/validation.ts', import.meta.url),
          ),
        },
        {
          find: /^@anveld\/sdk$/,
          replacement: fileURLToPath(new URL('../../packages/sdk/src/index.ts', import.meta.url)),
        },
      ],
    },
    plugins: [
      {
        name: 'console-production-prelisten',
        configureServer() {
          assertConsoleConfiguration(process.env);
        },
      },
      tailwindcss(),
      await explicitEnvironmentPlugins(tanstackStart()),
      nitro({ _nitro: server }),
      react(),
    ],
  };
});
