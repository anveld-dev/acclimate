import { lazy, Suspense } from 'react';
import { BookOpen } from 'lucide-react';
import { useI18n, type I18n } from './i18n';
import type { KcContext } from 'keycloakify/login/KcContext';
import DefaultPage from 'keycloakify/login/DefaultPage';
import DefaultTemplate from 'keycloakify/login/Template';
import type { TemplateProps, ClassKey } from 'keycloakify/login/TemplateProps';

const UserProfileFormFields = lazy(() => import('keycloakify/login/UserProfileFormFields'));

const classes = {
  kcBodyClass: 'auth-body', kcLoginClass: 'auth-layout', kcHeaderClass: 'auth-upstream-brand',
  kcFormCardClass: 'auth-card', kcFormHeaderClass: 'auth-heading',
  kcFormGroupClass: 'auth-field', kcLabelClass: 'auth-label', kcInputClass: 'auth-input',
  kcInputGroup: 'auth-input-group', kcFormPasswordVisibilityButtonClass: 'auth-password-toggle',
  kcButtonClass: 'auth-button', kcButtonPrimaryClass: 'auth-button-primary',
  kcButtonDefaultClass: 'auth-button-secondary', kcButtonBlockClass: 'auth-button-block',
  kcInputErrorMessageClass: 'auth-field-error', kcAlertClass: 'auth-alert',
  kcFormOptionsWrapperClass: 'auth-options', kcFormSocialAccountListClass: 'auth-providers',
  kcFormSocialAccountListButtonClass: 'auth-provider', kcSignUpClass: 'auth-info',
} satisfies Partial<Record<ClassKey, string>>;

function Template(props: TemplateProps<KcContext, I18n>) {
  return (
    <main className="auth-page" data-acclimate-theme="keycloakify">
      <div className="auth-brand"><BookOpen aria-hidden="true" /><span>Acclimate</span></div>
      <DefaultTemplate {...props} doUseDefaultCss={false} classes={classes} />
    </main>
  );
}

/** Keep upstream credential, MFA, passkey, recovery and error behavior intact. */
export default function KcPage({ kcContext }: { kcContext: KcContext }) {
  const { i18n } = useI18n({ kcContext });
  return <Suspense fallback={<p role="status" className="auth-loading">Loading sign-in…</p>}>
    <DefaultPage kcContext={kcContext} i18n={i18n} Template={Template} doUseDefaultCss={false}
      classes={classes} UserProfileFormFields={UserProfileFormFields} doMakeUserConfirmPassword />
  </Suspense>;
}
