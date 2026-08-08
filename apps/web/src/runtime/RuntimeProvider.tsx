import { createContext, useContext, useEffect, type ReactElement, type ReactNode } from 'react';
import { HttpRuntimeClient } from './client';
import { DeterministicMockRuntimeClient } from './mock';
import { RuntimeStore } from './store';

const RuntimeContext = createContext<RuntimeStore | null>(null);

export function RuntimeProvider({
  children,
  store: providedStore,
}: {
  children: ReactNode;
  store?: RuntimeStore;
}): ReactElement {
  const store = providedStore ?? getRuntimeStore();
  useEffect(() => {
    const invoke = typeof window === 'undefined' ? undefined : window.__TAURI_INTERNALS__?.invoke;
    let cancelled = false;
    const configureAndStart = async (): Promise<void> => {
      if (invoke) {
        let lastError: unknown;
        let configured = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          try {
            const config = await invoke('local_runtime_config');
            if (cancelled) return;
            store.setRuntime({
              baseUrl: config.apiBase ?? config.baseUrl ?? '',
              token: config.authToken ?? config.token,
            });
            configured = true;
            break;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(250, 50 + attempt * 10)));
          }
        }
        if (!configured && lastError !== undefined && !cancelled) {
          store.markUnavailable(lastError);
          return;
        }
      }
      if (!cancelled) await store.start();
    };
    void configureAndStart().catch((error) => {
      if (!cancelled) store.markUnavailable(error);
    });
    return () => {
      cancelled = true;
      store.stop();
    };
  }, [store]);
  return <RuntimeContext.Provider value={store}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeStore {
  const store = useContext(RuntimeContext);
  if (!store) throw new Error('useRuntime must be used inside RuntimeProvider');
  return store;
}

let singleton: RuntimeStore | undefined;

function getRuntimeStore(): RuntimeStore {
  const mode = import.meta.env.VITE_AGENTIC_RUNTIME_MODE;
  singleton ??= new RuntimeStore(
    mode === 'mock' ? new DeterministicMockRuntimeClient() : new HttpRuntimeClient(),
  );
  return singleton;
}
