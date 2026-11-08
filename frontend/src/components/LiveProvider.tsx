// Provides the live SpacetimeDB snapshot and reducer actions to every page.
// The connection starts in the browser only (TanStack Start also renders on the server).
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { emptyLive, LiveStore, type LiveData } from '@/lib/live/store';

export interface LiveActions {
  /** the decision popup's options (optimal / shut-in only / trucks only / do nothing); facilityId = hypothetical failure */
  requestOptions: (systemId: string, facilityId?: string) => Promise<void>;
  approvePlan: (planId: bigint) => Promise<void>;
  selectContingency: (planId: bigint) => Promise<void>;
  sendInspector: (eventId: string, note?: string) => Promise<void>;
}

const noStore = () => Promise.reject(new Error('Not connected to the backend yet'));
const Ctx = createContext<{ store: LiveStore | null }>({ store: null });

export function LiveProvider({ children, store: injected }: { children: ReactNode; store?: LiveStore }) {
  const [store, setStore] = useState<LiveStore | null>(injected ?? null);
  useEffect(() => {
    if (injected) return;
    const s = new LiveStore();
    s.start();
    setStore(s);
    return () => s.stop();
  }, [injected]);
  return <Ctx.Provider value={{ store }}>{children}</Ctx.Provider>;
}

const noop = () => () => {};
const empty = () => emptyLive;

/** the current live snapshot (re-renders on every backend change) */
export function useLive(): LiveData {
  const { store } = useContext(Ctx);
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? empty, empty);
}

export function useLiveActions(): LiveActions {
  const { store } = useContext(Ctx);
  const live = useLive();
  const ds = live.dataset?.datasetId;
  return useMemo<LiveActions>(() => {
    if (!store || !ds) return { requestOptions: noStore, approvePlan: noStore, selectContingency: noStore, sendInspector: noStore };
    return {
      requestOptions: (systemId, facilityId) => store.reducers.requestPlanOptions({ datasetId: ds, systemId, facilityId }),
      approvePlan: (planId) => store.reducers.approvePlan({ planId }),
      selectContingency: (planId) => store.reducers.selectContingency({ planId }),
      sendInspector: (eventId, note = '') => store.reducers.sendInspector({ eventId, note }),
    };
  }, [store, ds]);
}
