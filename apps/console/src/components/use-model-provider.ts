import { useBackgroundRefresh } from './use-background-refresh';
import { useEffect, useState } from 'react';
import { learningRequest } from '../server/central-actions';
import type { Provider } from '../lib/central-learning';

export function useModelProvider(workspaceId: string) {
  const [provider, setProvider] = useState<Provider>();
  const [error, setError] = useState('');
  const [interval, setDelay] = useState(3000);
  useEffect(() => {
    let active = true;
    setProvider(undefined);
    setError('');
    void learningRequest<Provider>({ workspaceId, action: 'provider' }).then(
      (next) => {
        if (active) setProvider(next);
      },
      () => {
        if (active) setError('Could not load the workspace model provider.');
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);
  useBackgroundRefresh(
    async () => {
      try {
        const next = await learningRequest<Provider>({ workspaceId, action: 'provider' });
        setProvider(next);
        setError('');
      } finally {
        setDelay((n) => Math.min(30000, n * 2));
      }
    },
    {
      enabled: provider?.verification?.status === 'pending',
      interval,
      allowScroll: true,
      allowButtonFocus: true,
    },
  );
  function saved(next: Provider) {
    setProvider({
      ...next,
      verification: next.verification ?? { status: 'pending', models: [], checkedAt: null },
    });
    setDelay(3000);
  }
  return { provider, error, saved };
}
