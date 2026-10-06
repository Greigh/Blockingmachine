/**
 * Server registry: the list of Blockingmachine hubs the app knows about, which one
 * is active, and each one's bearer token.
 *
 * Two stores with two sensitivity levels: the server list (hosts, labels — not
 * secret) lives in AsyncStorage; tokens live in expo-secure-store keyed per server,
 * so wiping the list leaves no credential residue and vice versa. Both are injected
 * in tests via props so the provider itself stays runtime-free in jest.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface SavedServer {
  id: string;
  label: string;
  baseUrl: string;
  /** 'manual' | 'qr' | 'mdns' — how it was added, for the settings list icon. */
  origin: 'manual' | 'qr' | 'mdns';
  addedAt: string;
  lastOkAt?: string;
}

export interface KeyValueStore {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export interface SecretStore {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

const SERVERS_KEY = 'bm.servers';
const ACTIVE_KEY = 'bm.activeServerId';
const tokenKey = (id: string) => `bm.token.${id}`;

export interface ServersState {
  hydrated: boolean;
  servers: SavedServer[];
  activeServerId: string | null;
  activeServer: SavedServer | null;
  /** Token for the active server — null until loaded, '' means none configured. */
  activeToken: string;
  addServer: (server: Omit<SavedServer, 'id' | 'addedAt'>, token?: string) => Promise<SavedServer>;
  removeServer: (id: string) => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  setToken: (id: string, token: string) => Promise<void>;
  markOk: (id: string) => Promise<void>;
}

const ServersContext = createContext<ServersState | null>(null);

let idCounter = 0;
const newId = () => `srv_${Date.now().toString(36)}_${(idCounter += 1)}`;

export function ServerProvider(props: {
  kv: KeyValueStore;
  secrets: SecretStore;
  children: React.ReactNode;
}) {
  const { kv, secrets } = props;
  const [hydrated, setHydrated] = useState(false);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeToken, setActiveToken] = useState('');

  // Batched calls (two addServer in one act/await-block) would otherwise each see
  // the pre-call list and lose each other's entries — the refs always read latest.
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const activeIdRef = useRef(activeServerId);
  activeIdRef.current = activeServerId;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rawServers, rawActive] = await Promise.all([
          kv.getItem(SERVERS_KEY),
          kv.getItem(ACTIVE_KEY),
        ]);
        if (cancelled) return;
        const list: SavedServer[] = rawServers ? JSON.parse(rawServers) : [];
        setServers(Array.isArray(list) ? list : []);
        setActiveServerId(rawActive && list.some((s) => s.id === rawActive) ? rawActive : null);
      } catch {
        // Corrupt storage must not wedge the app — start empty rather than crash-loop.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kv]);

  // Load the active server's token whenever the selection changes.
  useEffect(() => {
    let cancelled = false;
    if (!activeServerId) {
      setActiveToken('');
      return;
    }
    void secrets.getItemAsync(tokenKey(activeServerId)).then((t) => {
      if (!cancelled) setActiveToken(t ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [activeServerId, secrets]);

  const persistServers = useCallback(
    async (next: SavedServer[]) => {
      // Mutate the ref synchronously — batched calls inside one act() never see a
      // re-render between them, so without this the second write would overwrite
      // the first's still-uncommitted state.
      serversRef.current = next;
      setServers(next);
      await kv.setItem(SERVERS_KEY, JSON.stringify(next));
    },
    [kv],
  );

  const setActive = useCallback(
    async (id: string | null) => {
      setActiveServerId(id);
      activeIdRef.current = id;
      if (id) await kv.setItem(ACTIVE_KEY, id);
      else await kv.removeItem(ACTIVE_KEY);
    },
    [kv],
  );

  const addServer = useCallback(
    async (server: Omit<SavedServer, 'id' | 'addedAt'>, token?: string): Promise<SavedServer> => {
      const entry: SavedServer = {
        ...server,
        id: newId(),
        addedAt: new Date().toISOString(),
      };
      const deduped = serversRef.current.filter((s) => s.baseUrl !== entry.baseUrl);
      await persistServers([...deduped, entry]);
      if (token) await secrets.setItemAsync(tokenKey(entry.id), token);
      if (!activeIdRef.current) await setActive(entry.id);
      return entry;
    },
    [persistServers, secrets, setActive],
  );

  const removeServer = useCallback(
    async (id: string) => {
      await persistServers(serversRef.current.filter((s) => s.id !== id));
      await secrets.deleteItemAsync(tokenKey(id)).catch(() => {});
      if (activeIdRef.current === id) await setActive(null);
    },
    [persistServers, secrets, setActive],
  );

  const setToken = useCallback(
    async (id: string, token: string) => {
      if (token) await secrets.setItemAsync(tokenKey(id), token);
      else await secrets.deleteItemAsync(tokenKey(id));
      if (id === activeServerId) setActiveToken(token);
    },
    [secrets, activeServerId],
  );

  const markOk = useCallback(
    async (id: string) => {
      const next = serversRef.current.map((s) =>
        s.id === id ? { ...s, lastOkAt: new Date().toISOString() } : s,
      );
      await persistServers(next);
    },
    [persistServers],
  );

  const value = useMemo<ServersState>(
    () => ({
      hydrated,
      servers,
      activeServerId,
      activeServer: servers.find((s) => s.id === activeServerId) ?? null,
      activeToken,
      addServer,
      removeServer,
      setActive,
      setToken,
      markOk,
    }),
    [hydrated, servers, activeServerId, activeToken, addServer, removeServer, setActive, setToken, markOk],
  );

  return <ServersContext.Provider value={value}>{props.children}</ServersContext.Provider>;
}

export function useServers(): ServersState {
  const ctx = useContext(ServersContext);
  if (!ctx) throw new Error('useServers must be used inside <ServerProvider>');
  return ctx;
}
