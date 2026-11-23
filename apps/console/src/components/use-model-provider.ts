import { useEffect, useState } from 'react';
import { learningRequest } from '../server/central-actions';
import type { Provider } from '../lib/central-learning';

export function useModelProvider(workspaceId: string) {
  const [provider, setProvider] = useState<Provider>();
  const [error, setError] = useState('');
  const [generation, restart] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const next = await learningRequest<Provider>({ workspaceId, action: 'provider' });
        if (!active) return;
        setProvider(next);
        setError('');
        if (!next.hasKey || (next.verification && next.verification.status !== 'pending')) return;
      } catch {
        if (!active) return;
        setError('Could not load the workspace model provider.');
      }
      timer = setTimeout(() => void read(), 3000);
    }
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId, generation]);
  function saved(next: Provider) {
    setProvider({ ...next, verification: undefined });
    restart((value) => value + 1);
  }
  return { provider, error, saved };
}
