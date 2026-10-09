import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { SyncClient } from '../background/syncClient.js';

/**
 * The hot-set half of a sync.
 *
 * The property that matters most here is negative: a deployment with no measurement must produce
 * a normal-looking successful sync. Anything that turns "no hot set" into an error, a hang, or a
 * failed whole-list sync would take out the far more common case to fix the rare one.
 */

const HOT_BODY = ['! comment', '', '||measured.example^', '||second.example^'].join('\n');
const FULL_BODY = ['! full export', '', '||a.example^', '||b.example^'].join('\n');

function mockFetch(handler: (url: string) => { ok: boolean; body: string }) {
  const calls: string[] = [];
  const fetchMock = (jest.fn() as any).mockImplementation(async (url: string) => {
    calls.push(String(url));
    const { ok, body } = handler(String(url));
    return { ok, text: async () => body };
  });
  (globalThis as any).fetch = fetchMock;
  return calls;
}

describe('SyncClient hot set', () => {
  // ReturnType<typeof jest.spyOn> — the jest-mock copies in this tree diverged
  // (npm update), so naming the type across the boundary misassigns; infer instead.
  let info: ReturnType<typeof jest.spyOn>;
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    info = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    delete (globalThis as any).fetch;
  });

  test('fetches the hot set from beside the full list', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('hotlist.txt') ? { ok: true, body: HOT_BODY } : { ok: true, body: FULL_BODY },
    );

    const result = await new SyncClient('http://127.0.0.1:9191/browser.txt').fetchCompiledRules();

    expect(result.hotRuleLines).toEqual(['||measured.example^', '||second.example^']);
    expect(result.networkRules).toEqual(['||a.example^', '||b.example^']);
    expect(calls).toContain('http://127.0.0.1:9191/hotlist.txt');
  });

  test('derives the hot-set URL from whichever feed the full list came from', async () => {
    // A deployment whose feed is not the local default must not have to configure the hot set
    // separately — it is served from wherever it keeps its rules.
    const calls = mockFetch((url) =>
      url.endsWith('hotlist.txt') ? { ok: true, body: HOT_BODY } : { ok: false, body: '' },
    );

    const result = await new SyncClient('http://hub.internal:8080/feeds/browser.txt').fetchCompiledRules();

    expect(result.hotRuleLines).toEqual(['||measured.example^', '||second.example^']);
    expect(calls).toContain('http://hub.internal:8080/feeds/hotlist.txt');
  });

  test('strips comments and blanks from the hot set', async () => {
    mockFetch((url) =>
      url.endsWith('hotlist.txt') ? { ok: true, body: HOT_BODY } : { ok: true, body: FULL_BODY },
    );

    const result = await new SyncClient().fetchCompiledRules();

    expect(result.hotRuleLines).toEqual(['||measured.example^', '||second.example^']);
  });

  test('reports no hot set, and still returns the full list, when none is served', async () => {
    mockFetch((url) => (url.endsWith('hotlist.txt') ? { ok: false, body: '' } : { ok: true, body: FULL_BODY }));

    const result = await new SyncClient().fetchCompiledRules();

    expect(result.hotRuleLines).toBeNull();
    expect(result.networkRules).toEqual(['||a.example^', '||b.example^']);
  });

  test('treats an empty hot set as absent rather than as "block nothing"', async () => {
    // The server answers 200 with an empty body when it has no measurement. Installing that as a
    // hot set would mean installing zero rules, so the client prunes the full list instead.
    mockFetch((url) =>
      url.endsWith('hotlist.txt') ? { ok: true, body: '! only comments\n\n' } : { ok: true, body: FULL_BODY },
    );

    const result = await new SyncClient().fetchCompiledRules();

    expect(result.hotRuleLines).toBeNull();
    expect(result.networkRules).toEqual(['||a.example^', '||b.example^']);
  });

  test('an unreachable hot set does not fail the sync', async () => {
    (globalThis as any).fetch = (jest.fn() as any).mockImplementation(async (url: string) => {
      if (String(url).endsWith('hotlist.txt')) throw new Error('ECONNREFUSED');
      return { ok: true, text: async () => FULL_BODY };
    });

    const result = await new SyncClient().fetchCompiledRules();

    expect(result.hotRuleLines).toBeNull();
    expect(result.networkRules).toEqual(['||a.example^', '||b.example^']);
  });

  test('a hot set that times out is abandoned without stalling the sync', async () => {
    // Reproduces the abort: the request rejects with an AbortError and the candidate is skipped.
    (globalThis as any).fetch = (jest.fn() as any).mockImplementation(async (url: string) => {
      if (String(url).endsWith('hotlist.txt')) {
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      return { ok: true, text: async () => FULL_BODY };
    });

    const result = await new SyncClient().fetchCompiledRules();

    expect(result.hotRuleLines).toBeNull();
    expect(result.networkRules).toEqual(['||a.example^', '||b.example^']);
  });

  test('a rejected request leaves no timer pending', async () => {
    // A fetch that rejects never reaches a `clearTimeout` placed after the await, so the handle
    // would survive — and a 5-second live timer in a service worker is a worker kept awake for
    // nothing. Jest otherwise reports this only as "did not exit one second after the test run",
    // which says nothing about which request leaked; the timer count names it exactly.
    jest.useFakeTimers();
    try {
      (globalThis as any).fetch = (jest.fn() as any).mockRejectedValue(new Error('ECONNREFUSED'));

      await new SyncClient().fetchCompiledRules();

      // Every timeout started during the call must have been cleared, leaving none pending.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('still returns a hot set when the full list is unreachable', async () => {
    // "The feed is down" and "we have no full list" are different states. In the second one a
    // measured subset is strictly better than nothing, and it must not be discarded because the
    // request that also wanted the full list failed.
    mockFetch((url) => (url.endsWith('hotlist.txt') ? { ok: true, body: HOT_BODY } : { ok: false, body: '' }));

    const result = await new SyncClient().fetchCompiledRules();

    expect(result.hotRuleLines).toEqual(['||measured.example^', '||second.example^']);
    expect(result.networkRules).toEqual([]);
  });

  test('requests the hot set without delaying the full list', async () => {
    // The hot set has four candidates of its own, each with a 5-second timeout. Awaiting it
    // before the full list would mean a deployment whose host drops packets rather than refusing
    // the connection spends twenty seconds discovering it has no measurement before the full list
    // is even requested. So the two must be in flight together.
    const events: string[] = [];
    let releaseHotSet: (() => void) | null = null;
    const hotSetBlocked = new Promise<void>((resolve) => {
      releaseHotSet = resolve;
    });

    (globalThis as any).fetch = (jest.fn() as any).mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.endsWith('hotlist.txt')) {
        events.push('hot-requested');
        // Never resolves until released: a hot set that takes arbitrarily long.
        await hotSetBlocked;
        events.push('hot-replied');
        return { ok: true, text: async () => HOT_BODY };
      }
      events.push('full-requested');
      return { ok: true, text: async () => FULL_BODY };
    });

    const sync = new SyncClient().fetchCompiledRules();

    // The full list must be requested while the hot set is still outstanding, which is only true
    // if the two are concurrent.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain('full-requested');
    expect(events).toContain('hot-requested');
    expect(events).not.toContain('hot-replied');

    releaseHotSet!();
    const result = await sync;
    expect(result.networkRules).toEqual(['||a.example^', '||b.example^']);
    expect(result.hotRuleLines).toEqual(['||measured.example^', '||second.example^']);
  });

  test('falls back to the default host when the configured feed serves no hot set', async () => {
    // The configured feed is up but has no measurement beside it, so the hot set is served from
    // the local default instead — the same fallback order the full list already uses.
    const calls = mockFetch((url) => {
      if (url.endsWith('hotlist.txt')) {
        return url === 'http://127.0.0.1:9191/hotlist.txt'
          ? { ok: true, body: HOT_BODY }
          : { ok: false, body: '' };
      }
      return { ok: true, body: FULL_BODY };
    });

    const result = await new SyncClient('http://elsewhere.invalid/browser.txt').fetchCompiledRules();

    expect(result.hotRuleLines).toEqual(['||measured.example^', '||second.example^']);
    expect(calls).toContain('http://elsewhere.invalid/hotlist.txt');
    expect(calls).toContain('http://127.0.0.1:9191/hotlist.txt');
  });

  test('sends the configured feed token on every feed request', async () => {
    const seen: Record<string, string>[] = [];
    (globalThis as any).fetch = (jest.fn() as any).mockImplementation(async (url: string, init: any) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      if (String(url).endsWith('hotlist.txt')) return { ok: false, text: async () => '' };
      return { ok: true, text: async () => FULL_BODY };
    });

    const client = new SyncClient('http://hub.internal:9191/browser.txt');
    client.setFeed('http://hub.internal:9191/browser.txt', 'feed-secret');
    await client.fetchCompiledRules();

    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers['Authorization']).toBe('Bearer feed-secret');
    }
  });

  test('setFeed with a blank token drops the header entirely', async () => {
    const seen: Record<string, string>[] = [];
    (globalThis as any).fetch = (jest.fn() as any).mockImplementation(async (_url: string, init: any) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return { ok: true, text: async () => FULL_BODY };
    });

    const client = new SyncClient();
    client.setFeed('http://hub.internal:9191/browser.txt', '  ');
    await client.fetchCompiledRules();

    for (const headers of seen) {
      expect(headers['Authorization']).toBeUndefined();
    }
  });

  test('a 401 on every candidate still falls back to baseline — and says why', async () => {
    const seen: Record<string, string>[] = [];
    (globalThis as any).fetch = (jest.fn() as any).mockImplementation(async (_url: string, init: any) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return { ok: false, status: 401, text: async () => '' };
    });

    const client = new SyncClient('http://hub.internal:9191/browser.txt');
    client.setFeed('http://hub.internal:9191/browser.txt', 'wrong-token');
    const result = await client.fetchCompiledRules();

    expect(result.networkRules).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('feed token'));
  });
});
