import React, { useEffect } from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { ServerProvider, useServers, type KeyValueStore, type SecretStore } from '../state/servers';

const memoryKv = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
};

const memorySecrets = (): SecretStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItemAsync: async (k) => data.get(k) ?? null,
    setItemAsync: async (k, v) => void data.set(k, v),
    deleteItemAsync: async (k) => void data.delete(k),
  };
};

/** Probe component exposing the hook's state to the test. The effect body must
 * return nothing — returning the assignment result would install a non-function
 * "cleanup" and React throws on unmount. */
const Probe = ({ onState }: { onState: (s: ReturnType<typeof useServers>) => void }) => {
  const state = useServers();
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  return null;
};

const renderStore = () => {
  const kv = memoryKv();
  const secrets = memorySecrets();
  let state: ReturnType<typeof useServers>;
  render(
    <ServerProvider kv={kv} secrets={secrets}>
      <Probe onState={(s) => (state = s)} />
    </ServerProvider>,
  );
  return {
    kv,
    secrets,
    get state() {
      return state!;
    },
  };
};

describe('ServerProvider', () => {
  it('hydrates empty when storage is empty', async () => {
    const harness = renderStore();
    await waitFor(() => expect(harness.state.hydrated).toBe(true));
    expect(harness.state.servers).toEqual([]);
    expect(harness.state.activeServer).toBeNull();
  });

  it('adds a server and auto-activates the first one', async () => {
    const harness = renderStore();
    await waitFor(() => expect(harness.state.hydrated).toBe(true));
    let added;
    await act(async () => {
      added = await harness.state.addServer(
        { baseUrl: 'http://hub:9191', label: 'hub', origin: 'manual' },
        'tok123',
      );
    });
    expect(harness.state.servers).toHaveLength(1);
    expect(harness.state.activeServer?.id).toBe(added!.id);
    await waitFor(() => expect(harness.state.activeToken).toBe('tok123'));
    expect(harness.secrets.data.get(`bm.token.${added!.id}`)).toBe('tok123');
    expect(JSON.parse(harness.kv.data.get('bm.servers')!)).toHaveLength(1);
  });

  it('dedupes servers by baseUrl', async () => {
    const harness = renderStore();
    await waitFor(() => expect(harness.state.hydrated).toBe(true));
    await act(async () => {
      await harness.state.addServer({ baseUrl: 'http://h:9191', label: 'a', origin: 'manual' });
      await harness.state.addServer({ baseUrl: 'http://h:9191', label: 'b', origin: 'qr' });
    });
    expect(harness.state.servers).toHaveLength(1);
    expect(harness.state.servers[0].label).toBe('b');
  });

  it('removes the server and its token, clearing the active selection', async () => {
    const harness = renderStore();
    await waitFor(() => expect(harness.state.hydrated).toBe(true));
    let added;
    await act(async () => {
      added = await harness.state.addServer(
        { baseUrl: 'http://h:9191', label: 'a', origin: 'manual' },
        'tok',
      );
    });
    await act(async () => {
      await harness.state.removeServer(added!.id);
    });
    expect(harness.state.servers).toHaveLength(0);
    expect(harness.state.activeServer).toBeNull();
    expect(harness.secrets.data.has(`bm.token.${added!.id}`)).toBe(false);
  });

  it('switches active server and persists the selection', async () => {
    const harness = renderStore();
    await waitFor(() => expect(harness.state.hydrated).toBe(true));
    let a: any, b: any;
    await act(async () => {
      a = await harness.state.addServer({ baseUrl: 'http://a:9191', label: 'a', origin: 'manual' });
      b = await harness.state.addServer({ baseUrl: 'http://b:9191', label: 'b', origin: 'manual' });
    });
    expect(harness.state.activeServer?.id).toBe(a.id);
    await act(async () => {
      await harness.state.setActive(b.id);
    });
    expect(harness.state.activeServer?.id).toBe(b.id);
    expect(harness.kv.data.get('bm.activeServerId')).toBe(b.id);
  });

  it('updates and clears tokens per server', async () => {
    const harness = renderStore();
    await waitFor(() => expect(harness.state.hydrated).toBe(true));
    let added;
    await act(async () => {
      added = await harness.state.addServer(
        { baseUrl: 'http://h:9191', label: 'a', origin: 'manual' },
      );
    });
    await act(async () => {
      await harness.state.setToken(added!.id, 'newtok');
    });
    await waitFor(() => expect(harness.state.activeToken).toBe('newtok'));
    await act(async () => {
      await harness.state.setToken(added!.id, '');
    });
    expect(harness.secrets.data.has(`bm.token.${added!.id}`)).toBe(false);
    await waitFor(() => expect(harness.state.activeToken).toBe(''));
  });
});
