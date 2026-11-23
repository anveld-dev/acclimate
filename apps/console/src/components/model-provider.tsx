import { useEffect, useState } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { learningRequest } from '../server/central-actions';
import type { Provider } from '../lib/central-learning';

export function ModelProvider({ workspaceId }: { workspaceId: string }) {
  const [provider, setProvider] = useState<Provider>();
  const [message, report] = useState('Loading model provider…');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void learningRequest<Provider>({ workspaceId, action: 'provider' }).then(
      (value) => {
        if (active) {
          setProvider(value);
          report('');
        }
      },
      () => {
        if (active) report('Could not load the workspace model provider.');
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);
  return (
    <section id="model-provider" className="workspace-panel space-y-4 p-5">
      <h2 className="font-semibold">Model provider</h2>
      {provider && (
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const fields = new FormData(form);
            setBusy(true);
            try {
              const next = await learningRequest<Provider>({
                workspaceId,
                action: 'saveProvider',
                payload: JSON.stringify({
                  baseUrl: fields.get('baseUrl'),
                  apiKey: fields.get('apiKey'),
                  allowedModels: String(fields.get('allowedModels'))
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
              });
              setProvider(next);
              form.querySelector<HTMLInputElement>('[name=apiKey]')!.value = '';
              report('Provider saved.');
            } catch {
              report('Could not save the workspace model provider.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="learning-baseUrl">
            OpenAI-compatible base URL
            <Input
              id="learning-baseUrl"
              type="url"
              required
              name="baseUrl"
              defaultValue={provider.baseUrl || ''}
            />
          </label>
          <label htmlFor="learning-apiKey">
            API key {provider.hasKey && '(key stored)'}
            <Input
              id="learning-apiKey"
              autoComplete="new-password"
              type="password"
              required
              name="apiKey"
            />
          </label>
          <label htmlFor="learning-allowedModels">
            Allowed models (comma-separated)
            <Input
              id="learning-allowedModels"
              name="allowedModels"
              required
              defaultValue={provider.allowedModels.join(', ')}
            />
          </label>
          <Button disabled={busy}>Save provider</Button>
        </form>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
