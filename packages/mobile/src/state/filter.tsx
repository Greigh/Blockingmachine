/**
 * Standalone-filter state: the on-device ruleset's metadata plus evaluate /
 * sync / clear actions. Two producers can fill the ruleset — a hub sync
 * (`ruleset.ts`) and on-device feed fetches (`feeds.ts`) — and `ready` means
 * *either* produced rules, because the VPN/proxy services read the union.
 * The actual matching lives in `filter/ruleset.ts`; this provider just tracks
 * "do we have rules and how fresh are they" for the UI.
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
import {
  readLocalRulesMeta,
  refreshLocalRules,
  type LocalRulesMeta,
} from '../filter/feeds';
import {
  collectObservations,
  reportObservations,
} from '../filter/shadowObservations';
import { useClient } from '../api/useClient';
import { AppState } from 'react-native';

export interface FilterState {
  /** null until the on-disk meta has been read once. */
  meta: RulesetMeta | null;
  localMeta: LocalRulesMeta | null;
  hydrated: boolean;
  syncing: boolean;
  lastError: string | null;
  /** True once ANY ruleset is stored — hub or standalone — safe to evaluate(). */
  ready: boolean;
  /** DnsObservationRecords the tunnel logged that have not reached the hub
   *  yet — accrues on standalone phones and flushes on pairing. */
  pendingObservations: number;
  evaluate: (domain: string) => Promise<LocalVerdict | null>;
  sync: (baseUrl: string, token?: string) => Promise<void>;
  refreshLocal: () => Promise<void>;
  clear: () => Promise<void>;
}

const FilterContext = createContext<FilterState>({
  meta: null,
  localMeta: null,
  hydrated: false,
  syncing: false,
  lastError: null,
  ready: false,
  pendingObservations: 0,
  evaluate: () => Promise.resolve(null),
  sync: () => Promise.resolve(),
  refreshLocal: () => Promise.resolve(),
  clear: () => Promise.resolve(),
});

export function FilterProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<RulesetMeta | null>(null);
  const [localMeta, setLocalMeta] = useState<LocalRulesMeta | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingObservations, setPendingObservations] = useState(0);
  const client = useClient();

  // Flag-43's mobile half: the packet tunnel records every query it answers;
  // while the app is alive this drains the app-group stream each minute (and
  // on every foreground) and pushes the batch to the hub's shadow intake.
  // Hub-less — collect only; the buffer flushes once a hub is paired.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = client
          ? await reportObservations(client)
          : { pending: await collectObservations(), posted: 0 };
        if (!cancelled) setPendingObservations(res.pending);
      } catch {
        // A dead hub or a missing group must never break the provider.
      }
    };
    void tick();
    const interval = setInterval(tick, 60_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void tick();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
  }, [client]);

  useEffect(() => {
    void Promise.all([readRulesetMeta(), readLocalRulesMeta()])
      .then(([hub, local]) => {
        setMeta(hub);
        setLocalMeta(local);
      })
      .finally(() => setHydrated(true));
  }, []);

  const sync = useCallback(async (baseUrl: string, token?: string) => {
    setSyncing(true);
    setLastError(null);
    try {
      setMeta(await syncRuleset(baseUrl, fetch, token));
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSyncing(false);
    }
  }, []);

  const refreshLocal = useCallback(async () => {
    setSyncing(true);
    setLastError(null);
    try {
      setLocalMeta(await refreshLocalRules(fetch));
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
    setLocalMeta(null);
    setLastError(null);
  }, []);

  const value = useMemo<FilterState>(
    () => ({
      meta,
      localMeta,
      hydrated,
      syncing,
      lastError,
      ready: hydrated && (meta !== null || localMeta !== null),
      pendingObservations,
      evaluate: evaluateLocal,
      sync,
      refreshLocal,
      clear,
    }),
    [meta, localMeta, hydrated, syncing, lastError, pendingObservations, sync, refreshLocal, clear],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilter(): FilterState {
  return useContext(FilterContext);
}
