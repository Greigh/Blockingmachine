/**
 * Standalone-feed pipeline: AsyncStorage-backed feed config, per-feed fetch
 * fault tolerance, merge into ruleset_local.txt, and the hub/local union the
 * native rules file + matcher consume.
 */

// In-memory FileSystem — the modules under test read/write real paths, and
// the union assertions depend on what was actually persisted.
const mockFs = new Map<string, string>();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/mock/docs/',
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFs.has(path) })),
  readAsStringAsync: jest.fn(async (path: string) => {
    if (!mockFs.has(path)) throw new Error(`ENOENT: ${path}`);
    return mockFs.get(path);
  }),
  writeAsStringAsync: jest.fn(async (path: string, body: string) => {
    mockFs.set(path, body);
  }),
  deleteAsync: jest.fn(async (path: string) => {
    mockFs.delete(path);
  }),
}));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStorage.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStorage.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStorage.delete(k);
  }),
}));

import {
  readFeeds,
  saveFeeds,
  readLocalRulesMeta,
  refreshLocalRules,
  clearLocalRules,
  DEFAULT_FEEDS,
} from '../filter/feeds';
import {
  clearRuleset,
  evaluateLocal,
  LOCAL_RULES_FILE,
  syncRuleset,
} from '../filter/ruleset';

const ok = (body: string) =>
  ({ ok: true, status: 200, text: () => Promise.resolve(body) }) as unknown as Response;

const bad = (status: number) =>
  ({ ok: false, status, text: () => Promise.resolve('') }) as unknown as Response;

beforeEach(() => {
  mockFs.clear();
  mockStorage.clear();
});

describe('readFeeds', () => {
  it('seeds the default feed list on first read', async () => {
    const feeds = await readFeeds();
    expect(feeds).toEqual(DEFAULT_FEEDS);
    expect(feeds.length).toBeGreaterThan(0);
  });

  it('drops malformed entries instead of failing the whole list', async () => {
    mockStorage.set(
      '@blockingmachine/filter-feeds',
      JSON.stringify([
        { name: 'Good', url: 'https://a.example/list.txt', enabled: true },
        { name: 42, url: null, enabled: 'yes' },
      ]),
    );
    const feeds = await readFeeds();
    expect(feeds).toHaveLength(1);
    expect(feeds[0].name).toBe('Good');
  });
});

describe('refreshLocalRules', () => {
  it('merges enabled feeds into the local ruleset and writes meta', async () => {
    await saveFeeds([
      { name: 'A', url: 'https://a.example/list.txt', enabled: true },
      { name: 'B', url: 'https://b.example/list.txt', enabled: true },
      { name: 'off', url: 'https://off.example/list.txt', enabled: false },
    ]);
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('a.example')) return ok('||ads-a.example^\n0.0.0.0 track-a.example\n');
      if (url.includes('b.example')) return ok('||ads-a.example^\n||ads-b.example^\n');
      return bad(404);
    }) as unknown as typeof fetch;
    const meta = await refreshLocalRules(fetchImpl);
    expect(meta.ruleCount).toBe(3); // dedupe across feeds
    expect(meta.feedCount).toBe(2);
    expect(meta.errors).toEqual([]);
    const body = mockFs.get(LOCAL_RULES_FILE);
    expect(body).toContain('||ads-a.example^');
    expect(body).toContain('||track-a.example^');
    expect(body).toContain('||ads-b.example^');
    expect((await readLocalRulesMeta())?.ruleCount).toBe(3);
  });

  it('records a failing feed in meta.errors and still succeeds', async () => {
    await saveFeeds([
      { name: 'Good', url: 'https://good.example/list.txt', enabled: true },
      { name: 'Dead', url: 'https://dead.example/list.txt', enabled: true },
    ]);
    const fetchImpl = jest.fn(async (url: string) =>
      url.includes('good') ? ok('||ads.example^') : bad(500),
    ) as unknown as typeof fetch;
    const meta = await refreshLocalRules(fetchImpl);
    expect(meta.ruleCount).toBe(1);
    expect(meta.errors).toHaveLength(1);
    expect(meta.errors[0].name).toBe('Dead');
  });

  it('throws when every enabled feed fails — never writes an empty ruleset', async () => {
    await saveFeeds([{ name: 'Dead', url: 'https://dead.example/list.txt', enabled: true }]);
    const fetchImpl = jest.fn(async () => bad(503)) as unknown as typeof fetch;
    await expect(refreshLocalRules(fetchImpl)).rejects.toThrow(/Every feed failed/);
    expect(await readLocalRulesMeta()).toBeNull();
  });

  it('throws a useful error when nothing is enabled', async () => {
    await saveFeeds([{ name: 'Off', url: 'https://x.example/list.txt', enabled: false }]);
    await expect(refreshLocalRules(jest.fn() as unknown as typeof fetch)).rejects.toThrow(
      /No feeds are enabled/,
    );
  });

  it('rejects non-https feed URLs before fetching', async () => {
    await saveFeeds([{ name: 'HTTP', url: 'http://insecure.example/list.txt', enabled: true }]);
    const fetchImpl = jest.fn(async () => ok('||x.example^')) as unknown as typeof fetch;
    await expect(refreshLocalRules(fetchImpl)).rejects.toThrow(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('hub/local union', () => {
  it('unions local feeds and the hub ruleset for the matcher', async () => {
    await saveFeeds([{ name: 'Local', url: 'https://l.example/list.txt', enabled: true }]);
    const localFetch = jest.fn(async () =>
      ok('||local-only.example^\n||shared.example^'),
    ) as unknown as typeof fetch;
    await refreshLocalRules(localFetch);
    const hubFetch = jest.fn(async () =>
      ok('||hub-only.example^\n||shared.example^'),
    ) as unknown as typeof fetch;
    await syncRuleset('http://hub.local:9191', hubFetch);
    expect((await evaluateLocal('local-only.example'))?.blocked).toBe(true);
    expect((await evaluateLocal('hub-only.example'))?.blocked).toBe(true);
    expect((await evaluateLocal('shared.example'))?.blocked).toBe(true);
  });

  it('clearLocalRules drops the local half but keeps hub rules', async () => {
    await saveFeeds([{ name: 'Local', url: 'https://l.example/list.txt', enabled: true }]);
    const localFetch = jest.fn(async () => ok('||local-only.example^')) as unknown as typeof fetch;
    await refreshLocalRules(localFetch);
    const hubFetch = jest.fn(async () => ok('||hub-only.example^')) as unknown as typeof fetch;
    await syncRuleset('http://hub.local:9191', hubFetch);
    await clearLocalRules();
    expect(await readLocalRulesMeta()).toBeNull();
    // Hub rules remain — the matcher stays live; the local-only host just
    // falls out of coverage and evaluates allowed rather than missing.
    expect((await evaluateLocal('local-only.example'))?.blocked).toBe(false);
    expect((await evaluateLocal('hub-only.example'))?.blocked).toBe(true);
  });

  it('clearRuleset empties both sides and the matcher', async () => {
    await saveFeeds([{ name: 'Local', url: 'https://l.example/list.txt', enabled: true }]);
    const localFetch = jest.fn(async () => ok('||local-only.example^')) as unknown as typeof fetch;
    await refreshLocalRules(localFetch);
    await clearRuleset();
    expect(await evaluateLocal('local-only.example')).toBeNull();
    expect(mockFs.get(`${'/mock/docs/'}ruleset_native.txt`)).toBe('\n');
  });
});
