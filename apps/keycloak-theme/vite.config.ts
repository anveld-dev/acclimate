import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { keycloakify } from 'keycloakify/vite-plugin';

export default defineConfig({
  plugins: [react(), keycloakify({
    themeName: 'acclimate',
    accountThemeImplementation: 'none',
    keycloakVersionTargets: { 'all-other-versions': 'acclimate-keycloak-theme.jar', '22-to-25': false },
  })],
});
