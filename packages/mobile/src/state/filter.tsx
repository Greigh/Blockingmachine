/**
 * Standalone-filter state: the synced on-device ruleset's metadata plus evaluate /
 * sync / clear actions. The actual matching lives in `filter/ruleset.ts`; this
 * provider just tracks "do we have rules and how fresh are they" for the UI.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  clearRuleset,
  evaluateLocal,
  readRulesetMeta,
  syncRuleset,
  type LocalVerdict,
  type RulesetMeta,
} from '../filter/ruleset';

export interface FilterState {
  /** null until the on-disk meta has been read once. */
  meta: RulesetMeta | null;
  hydrated: boolean;
  syncing: boolean;
  lastError: string | null;
  /** True once a ruleset is stored — safe to call evaluate(). */
  ready: boolean;
  evaluate: (domain: string) => Promise<LocalVerdict | null>;
  sync: (baseUrl: string) => Promise<void>;
  clear: () => Promise<void>;
}

const FilterContext = createContext<FilterState>({
  meta: null,
  hydrated: false,
  syncing: false,
  lastError: null,
  ready: false,
  evaluate: () => Promise.resolve(null),
  sync: () => Promise.resolve(),
  clear: () => Promise.resolve(),
});

export function FilterProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<RulesetMeta | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    void readRulesetMeta()
      .then(setMeta)
      .finally(() => setHydrated(true));
  }, []);

  const sync = useCallback(async (baseUrl: string) => {
    setSyncing(true);
    setLastError(null);
    try {
      setMeta(await syncRuleset(baseUrl));
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSyncing(false);
    }
  }, []);

  const clear = useCallback(async () => {
    await clearRuleset();
    setMeta(null);
    setLastError(null);
  }, []);

  const value = useMemo<FilterState>(
    () => ({
      meta,
      hydrated,
      syncing,
      lastError,
      ready: hydrated && meta !== null,
      evaluate: evaluateLocal,
      sync,
      clear,
    }),
    [meta, hydrated, syncing, lastError, sync, clear],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilter(): FilterState {
  return useContext(FilterContext);
}
