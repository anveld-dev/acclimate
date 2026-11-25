/** Explicit production identity configuration for unit transports; never used by runtime. */
export const consoleEnvironment = {
  CONSOLE_ORIGIN: 'https://console.example',
  CONSOLE_OIDC_ISSUER: 'https://identity.example',
  CONSOLE_OIDC_CLIENT_ID: 'console',
  CONSOLE_OIDC_CLIENT_SECRET: 'unit-client',
  CONSOLE_LOGIN_TOKEN: 'unit-login',
  CONSOLE_SERVICE_TOKEN: 'unit-console-transport',
  CONSOLE_SESSION_TOKEN: 'unit-session',
  CONSOLE_SERVICE_URL: 'http://127.0.0.1:3000',
  CONSOLE_PUBLIC_API_URL: 'https://api.example',
};
