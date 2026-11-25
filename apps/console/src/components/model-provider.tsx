import { useModelProvider } from './use-model-provider';
import { useState } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Field, FieldGrid } from './ui/field';
import { Panel } from './panel';
import { PageTitle } from './shared';
import { ReceiptTime } from './receipt-time';
import { StatusBadge, type StatusTone } from './status-badge';
import { learningRequest } from '../server/central-actions';
import type { Provider } from '../lib/central-learning';

type Verification = NonNullable<Provider['verification']>;
const VERIFICATION: Record<Verification['status'], { tone: StatusTone; label: string }> = {
  verified: { tone: 'success', label: 'Provider verified' },
  pending: { tone: 'info', label: 'Verification pending' },
  failed: { tone: 'danger', label: 'Verification failed' },
};

export function ModelProvider({ workspaceId }: { workspaceId: string }) {
  const { provider, error, saved } = useModelProvider(workspaceId);
  const [message, report] = useState('');
  const [busy, setBusy] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);
  const verification = provider?.hasKey
    ? (provider.verification ?? { status: 'pending' as const, models: [], checkedAt: null })
    : undefined;
  const status = verification && VERIFICATION[verification.status];
  const askForKey = provider && (!provider.hasKey || replacingKey);
  return (
    <div className="space-y-4">
      <PageTitle
        title="Model provider"
        description="The OpenAI-compatible endpoint that runs task and judge models for learning in this workspace."
      />
      <Panel
        id="model-provider"
        title="Connection"
        description="Saving checks that each allowed model answers and returns usage numbers."
        actions={
          status && (
            <StatusBadge tone={status.tone} aria-live="polite">
              {status.label}
            </StatusBadge>
          )
        }
        footer={
          <>
            <span className="panel-footer-note" role="status">
              {error || message || (!provider && 'Loading model provider…')}
            </span>
            {provider && (
              <Button type="submit" form="model-provider-form" disabled={busy}>
                Save provider
              </Button>
            )}
          </>
        }
      >
        {provider && (
          <form
            id="model-provider-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              setBusy(true);
              try {
                const next = await learningRequest<Provider>({
                  workspaceId,
                  action: 'saveProvider',
                  body: {
                    baseUrl: String(fields.get('baseUrl')),
                    apiKey: String(fields.get('apiKey') || '') || undefined,
                    allowedModels: String(fields.get('allowedModels'))
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                });
                saved(next);
                // The new key is stored; the form forgets it and offers Replace key again.
                setReplacingKey(false);
                report('Provider saved.');
              } catch (error) {
                report(
                  error instanceof Error
                    ? error.message
                    : 'Could not save the workspace model provider.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <FieldGrid>
              <Field label="OpenAI-compatible base URL" htmlFor="learning-baseUrl">
                <Input
                  id="learning-baseUrl"
                  type="url"
                  required
                  name="baseUrl"
                  placeholder="https://api.example.com/v1"
                  defaultValue={provider.baseUrl || ''}
                />
              </Field>
              {askForKey ? (
                <Field
                  label="API key"
                  htmlFor="learning-apiKey"
                  hint={
                    provider.hasKey
                      ? 'The stored key stays in use until you save a new one.'
                      : 'Stored encrypted. The console never shows it again.'
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="learning-apiKey"
                      className="min-w-0 flex-1"
                      autoComplete="new-password"
                      type="password"
                      required
                      name="apiKey"
                      autoFocus={replacingKey}
                      aria-describedby="learning-apiKey-hint"
                    />
                    {provider.hasKey && (
                      <Button type="button" variant="ghost" onClick={() => setReplacingKey(false)}>
                        Keep stored key
                      </Button>
                    )}
                  </div>
                </Field>
              ) : (
                <div className="form-field">
                  <span className="form-field-label">API key</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm">A key is stored.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setReplacingKey(true)}
                    >
                      Replace key
                    </Button>
                  </div>
                </div>
              )}
              <Field
                label="Allowed models"
                htmlFor="learning-allowedModels"
                hint="Separate names with commas. Task and judge models come from this list."
              >
                <Input
                  id="learning-allowedModels"
                  name="allowedModels"
                  required
                  aria-describedby="learning-allowedModels-hint"
                  defaultValue={provider.allowedModels.join(', ')}
                />
              </Field>
            </FieldGrid>
          </form>
        )}
        {verification && (
          <section aria-labelledby="model-checks-heading" className="space-y-2 border-t pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="model-checks-heading" className="text-sm font-medium">
                Model checks
              </h3>
              {verification.checkedAt && (
                <span className="text-xs text-muted-foreground">
                  Checked <ReceiptTime value={verification.checkedAt} relative />
                </span>
              )}
            </div>
            <div aria-live="polite">
              {verification.models.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {verification.status === 'pending'
                    ? 'Checking each allowed model…'
                    : 'No model results yet.'}
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {verification.models.map((result) => {
                    const ok = result.ok && result.usage;
                    const usageNote =
                      !result.usage && (result.ok || /usage/i.test(result.message ?? ''));
                    return (
                      <li
                        key={result.model}
                        className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0 flex-1">
                          <code className="font-medium break-all">{result.model}</code>
                          {(result.message || usageNote) && (
                            <p className="text-muted-foreground">
                              {result.message}
                              {result.message && usageNote && ' '}
                              {usageNote &&
                                'The provider must return usage numbers for token limits.'}
                            </p>
                          )}
                        </div>
                        <StatusBadge tone={ok ? 'success' : 'danger'}>
                          {ok ? 'Verified' : 'Failed'}
                        </StatusBadge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        )}
      </Panel>
    </div>
  );
}
