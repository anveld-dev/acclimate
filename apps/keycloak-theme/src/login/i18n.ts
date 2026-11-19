import { i18nBuilder } from 'keycloakify/login';

const { useI18n, ofTypeI18n } = i18nBuilder.withCustomTranslations({
  // Sentence case matches the console's buttons and links.
  en: {
    loginAccountTitle: 'Sign in to Acclimate',
    doLogIn: 'Sign in',
    doForgotPassword: 'Forgot password?',
    emailForgotTitle: 'Forgot your password?',
    backToLogin: '« Back to sign in',
  },
}).build();
export { useI18n };
export type I18n = typeof ofTypeI18n;
