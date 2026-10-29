/**
 * Flag-43 mobile intake: JSONL draining from the app-group stream, the
 * bounded AsyncStorage backlog, and the batched hub upload with
 * retry-next-tick semantics.
 */

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

// The app-group drain is a native bridge — mock the module seam wholesale.
let mockDrain = '';
jest.mock('../filter/dnsProxy', () => ({
  drainTunnelObservations: jest.fn(async () => mockDrain),
}));

import { collectObservations, reportObservations } from '../filter/shadowObservations';
import type { BlockingmachineClient } from '../api/client';
import type { ShadowObservationRecord } from '../api/types';

const BUFFER_KEY = '@blockingmachine/shadow-observations';

function rec(domain: string): ShadowObservationRecord {
  return { domain, verdict: 'blocked', rcode: 0, cname_depth: 0, ttl_min: 60, latency_ms: 4 };
}

function clientWith(behavior: (records: ShadowObservationRecord[]) => { success?: boolean }) {
  const calls: ShadowObservationRecord[][] = [];
  const client = {
    postShadowObservations: jest.fn(async (records: ShadowObservationRecord[]) => {
      calls.push(records);
      return behavior(records);
    }),
  } as unknown as BlockingmachineClient;
  return { client, calls };
}

beforeEach(() => {
  mockStorage.clear();
  mockDrain = '';
  jest.clearAllMocks();
});

describe('collectObservations', () => {
  test('parses drained JSONL into the buffer and skips torn lines', async () => {
    mockDrain = `${JSON.stringify(rec('ads.example.com'))}\n{"torn":\n${JSON.stringify(rec('tracker.example.com'))}\n`;
    const pending = await collectObservations();
    expect(pending).toBe(2);
    const stored = JSON.parse(mockStorage.get(BUFFER_KEY)!) as ShadowObservationRecord[];
    expect(stored.map((r) => r.domain)).toEqual(['ads.example.com', 'tracker.example.com']);
  });

  test('lines without a domain are dropped', async () => {
    mockDrain = `{"verdict":"allowed"}\n${JSON.stringify(rec('ok.example.com'))}\n`;
    expect(await collectObservations()).toBe(1);
  });

  test('an empty drain leaves the existing backlog untouched', async () => {
    mockStorage.set(BUFFER_KEY, JSON.stringify([rec('kept.example.com')]));
    expect(await collectObservations()).toBe(1);
  });

  test('the buffer caps at 2000 records, oldest dropped first', async () => {
    const old = Array.from({ length: 1999 }, (_, i) => rec(`old-${i}.example.com`));
    mockStorage.set(BUFFER_KEY, JSON.stringify(old));
    mockDrain = `${JSON.stringify(rec('new-1.example.com'))}\n${JSON.stringify(rec('new-2.example.com'))}\n`;
    expect(await collectObservations()).toBe(2000);
    const stored = JSON.parse(mockStorage.get(BUFFER_KEY)!) as ShadowObservationRecord[];
    expect(stored[0].domain).toBe('old-1.example.com');
    expect(stored[1999].domain).toBe('new-2.example.com');
  });
});

describe('reportObservations', () => {
  test('no client leaves the full backlog pending with zero posted', async () => {
    mockDrain = `${JSON.stringify(rec('a.example.com'))}\n${JSON.stringify(rec('b.example.com'))}\n`;
    const res = await reportObservations(null);
    expect(res).toEqual({ pending: 2, posted: 0 });
  });

  test('posts the backlog in ≤500-record batches until empty', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => rec(`d-${i}.example.com`));
    mockStorage.set(BUFFER_KEY, JSON.stringify(many));
    const { client, calls } = clientWith(() => ({ success: true }));
    const res = await reportObservations(client);
    expect(res.posted).toBe(1200);
    expect(res.pending).toBe(0);
    expect(calls.map((c) => c.length)).toEqual([500, 500, 200]);
    expect(mockStorage.get(BUFFER_KEY)).toBe('[]');
  });

  test('a refused batch keeps the unsent remainder buffered for the next tick', async () => {
    const many = Array.from({ length: 600 }, (_, i) => rec(`d-${i}.example.com`));
    mockStorage.set(BUFFER_KEY, JSON.stringify(many));
    const { client, calls } = clientWith((records) =>
      records.length === 500 ? { success: true } : { success: false },
    );
    const res = await reportObservations(client);
    expect(calls.length).toBe(2);
    expect(res.posted).toBe(500);
    expect(res.pending).toBe(100);
    const stored = JSON.parse(mockStorage.get(BUFFER_KEY)!) as ShadowObservationRecord[];
    expect(stored.length).toBe(100);
    expect(stored[0].domain).toBe('d-500.example.com');
  });
});
