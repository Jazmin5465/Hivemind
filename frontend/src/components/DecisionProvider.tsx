import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { decisionStorageKey, readBrowserDecisions, saveBrowserDecision, type BrowserDecision } from '@/lib/browser-decisions';
import type { PlanKey } from '@/lib/operations';

const Context = createContext<{decisions: BrowserDecision[]; loading: boolean; error: string; submit: (queueId:string,optionKey:PlanKey) => Promise<void>}>({decisions:[],loading:true,error:'',submit:async()=>{throw new Error('Not ready');}});
export function DecisionProvider({children}:{children:ReactNode}) {
  const [decisions,setDecisions] = useState<BrowserDecision[]>([]), [loading,setLoading] = useState(true), [error,setError] = useState('');
  useEffect(() => {
    const load = () => {
      try { setDecisions(readBrowserDecisions(window.localStorage)); setError(''); }
      catch { setError('Saved decisions could not be loaded from this browser.'); }
      finally { setLoading(false); }
    };
    load();
    const sync = (event: StorageEvent) => { if(event.key === decisionStorageKey || event.key === null) load(); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  },[]);
  const submit = async (queueId:string,optionKey:PlanKey) => {
    try {
      setDecisions(saveBrowserDecision(window.localStorage,queueId,optionKey));
      setError('');
    } catch (cause) {
      if (cause instanceof Error && (cause.name === 'QuotaExceededError' || cause.name === 'SecurityError')) {
        throw new Error('This browser could not save your decision. Allow site storage and try again.');
      }
      throw cause;
    }
  };
  return <Context.Provider value={{decisions,loading,error,submit}}>{children}</Context.Provider>;
}
export const useDecisions = () => useContext(Context);