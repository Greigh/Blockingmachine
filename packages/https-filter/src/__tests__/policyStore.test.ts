/**
 * Pin/bypass policy store contract (design spec §5.6, plan Task 3).
 *
 * The store is an append-only JSONL ledger — one record per decision,
 * `{ts, host, action, reason?, prevHash}` — where each line's `prevHash` is the
 * sha256 of the previous physical line (genesis line: `null`), giving the pin
 * list the tamper-evidence spec §8 asks for. Replaying the file rebuilds two
 * in-memory sets so `isPinned`/`isBypassed` are O(1) lookups on the socket hot
 * path; `isPinned || isBypassed` is the proxy's blind-tunnel predicate. Per the
 * learned-shadow privacy convention the ledger holds hostnames and reasons
 * only — never URLs, headers, or bodies.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyStore } from '../policy/policyStore.js';

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-policy-'));
  storePath = join(dir, 'policy.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('learn + recall', () => {
  test('learnPin marks the host pinned; addBypass marks it bypassed', async () => {
    const store = await PolicyStore.open(storePath);

    expect(store.isPinned('pin.example')).toBe(false);
    store.learnPin('pin.example', 'handshake-abort');
    expect(store.isPinned('pin.example')).toBe(true);
    expect(store.isBypassed('pin.example')).toBe(false);

    expect(store.isBypassed('bypass.example')).toBe(false);
    store.addBypass('bypass.example');
    expect(store.isBypassed('bypass.example')).toBe(true);
    expect(store.isPinned('bypass.example')).toBe(false);
  });

  test('host matching is case-insensitive — reads and writes normalize to lowercase', async () => {
    const store = await PolicyStore.open(storePath);

    store.learnPin('CDN.Example.COM', 'handshake-abort');
    expect(store.isPinned('cdn.example.com')).toBe(true);
    expect(store.isPinned('CDN.EXAMPLE.COM')).toBe(true);

    store.addBypass('MIXED.Example.Org');
    expect(store.isBypassed('mixed.example.org')).toBe(true);
  });
});

describe('durability', () => {
  test('pins and bypasses survive close + reopen via JSONL replay', async () => {
    const first = await PolicyStore.open(storePath);
    first.learnPin('pinned.example', 'handshake-abort');
    first.addBypass('bypassed.example');
    first.close();

    const second = await PolicyStore.open(storePath);
    expect(second.isPinned('pinned.example')).toBe(true);
    expect(second.isBypassed('bypassed.example')).toBe(true);
    expect(second.isPinned('bypassed.example')).toBe(false);
    expect(second.isBypassed('pinned.example')).toBe(false);
  });

  test('remove() retracts a host from both sets — in memory and after reopen', async () => {
    const first = await PolicyStore.open(storePath);
    first.learnPin('gone.example', 'handshake-abort');
    first.addBypass('gone-bypass.example');
    // A host can sit in both sets; remove() retracts it from both.
    first.learnPin('both.example', 'handshake-abort');
    first.addBypass('both.example');
    expect(first.isPinned('both.example')).toBe(true);
    expect(first.isBypassed('both.example')).toBe(true);

    first.remove('gone.example');
    first.remove('gone-bypass.example');
    first.remove('both.example');
    expect(first.isPinned('gone.example')).toBe(false);
    expect(first.isBypassed('gone-bypass.example')).toBe(false);
    expect(first.isPinned('both.example')).toBe(false);
    expect(first.isBypassed('both.example')).toBe(false);
    first.close();

    const second = await PolicyStore.open(storePath);
    expect(second.isPinned('gone.example')).toBe(false);
    expect(second.isBypassed('both.example')).toBe(false);
    // Removal is itself an entry: later lines re-pinning the host must win on replay.
    second.learnPin('gone.example', 'handshake-abort');
    expect(second.isPinned('gone.example')).toBe(true);
  });
});

describe('on-disk format', () => {
  test('appends hash-chained records: {ts, host, action, reason?, prevHash}', async () => {
    const store = await PolicyStore.open(storePath);
    store.learnPin('a.example', 'handshake-abort');
    store.addBypass('b.example');
    store.remove('a.example');
    store.close();

    const raw = await readFile(storePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(Object.keys(records[0])).toEqual(['ts', 'host', 'action', 'reason', 'prevHash']);
    expect(Object.keys(records[1])).toEqual(['ts', 'host', 'action', 'prevHash']);
    expect(records.map((r) => r.action)).toEqual(['pin', 'bypass', 'remove']);
    expect(records[0].host).toBe('a.example');
    expect(typeof records[0].ts).toBe('number');

    // The chain: genesis prevHash is null, then each line commits to the exact
    // bytes of the previous line.
    expect(records[0].prevHash).toBeNull();
    expect(records[1].prevHash).toBe(sha256Hex(lines[0]));
    expect(records[2].prevHash).toBe(sha256Hex(lines[1]));
  });
});

describe('corruption tolerance', () => {
  test('a corrupt trailing line is skipped and counted, not fatal', async () => {
    const first = await PolicyStore.open(storePath);
    first.learnPin('kept.example', 'handshake-abort');
    first.close();

    // A torn final write (crash mid-append) leaves non-JSON behind; a wrong
    // shape that parses is just as dead to the replay.
    await appendFile(storePath, '{"ts":12345,"host":"truncated.exa\n');
    await appendFile(storePath, '{"ts":"NaN","host":123,"action":"pin","prevHash":null}\n');

    const second = await PolicyStore.open(storePath);
    expect(second.isPinned('kept.example')).toBe(true);
    expect(second.corruptLineCount).toBe(2);
  });

  test('a tampered line breaks the chain — the dependent next entry is counted corrupt', async () => {
    const first = await PolicyStore.open(storePath);
    first.learnPin('honest.example', 'handshake-abort');
    first.addBypass('victim.example');
    first.close();

    // Flip a byte inside the first line: it still parses and its own prevHash
    // still matches the genesis, but line two's prevHash no longer equals the
    // sha256 of the modified bytes — the tamper is surfaced, not silent.
    const raw = await readFile(storePath, 'utf8');
    const lines = raw.split('\n');
    lines[0] = lines[0].replace('honest', 'forged-');
    await writeFile(storePath, lines.join('\n'), 'utf8');

    const second = await PolicyStore.open(storePath);
    expect(second.isPinned('forged-.example')).toBe(true); // the doctored line itself still parses
    expect(second.isBypassed('victim.example')).toBe(false); // its successor fails the chain check
    expect(second.corruptLineCount).toBe(1);
  });
});

describe('list()', () => {
  test('replays the applied ledger oldest-first, without chain internals', async () => {
    const store = await PolicyStore.open(storePath);
    store.learnPin('a.example', 'handshake-abort');
    store.remove('a.example');
    store.addBypass('b.example');

    const entries = store.list();
    expect(entries.map((e) => e.action)).toEqual(['pin', 'remove', 'bypass']);
    expect(entries[0].host).toBe('a.example');
    expect(entries[0].reason).toBe('handshake-abort');
    expect(entries[1].reason).toBeUndefined();
    expect('prevHash' in entries[0]).toBe(false);
  });
});

describe('proxy_event audit lines', () => {
  test('recordEvent persists a line that replay keeps OUT of the pin/bypass sets', async () => {
    const first = await PolicyStore.open(storePath);
    first.learnPin('pinned.example', 'handshake-abort');
    first.recordEvent('page.example', 'html-inject');
    first.recordEvent('page.example', 'csp-rewrite');
    first.close();

    const second = await PolicyStore.open(storePath);
    // Audit lines apply to no set — the evented host is neither pinned nor
    // bypassed, while the real pin still replays.
    expect(second.isPinned('page.example')).toBe(false);
    expect(second.isBypassed('page.example')).toBe(false);
    expect(second.isPinned('pinned.example')).toBe(true);
    const events = second.list().filter((e) => e.action === 'proxy_event');
    expect(events.map((e) => e.host)).toEqual(['page.example', 'page.example']);
    expect(events.map((e) => e.reason)).toEqual(['html-inject', 'csp-rewrite']);
    // …and the policy view excludes them entirely.
    expect(second.listPolicy().every((e) => e.action !== 'proxy_event')).toBe(true);
    expect(second.corruptLineCount).toBe(0);
  });

  test('the same (host, reason) records once per session — audit is not metrics', () => {
    const store = PolicyStore.ephemeral();
    store.recordEvent('dup.example', 'csp-rewrite');
    store.recordEvent('dup.example', 'csp-rewrite');
    store.recordEvent('dup.example', 'html-inject'); // different reason → new line
    store.recordEvent('other.example', 'csp-rewrite'); // different host → new line
    const events = store.list().filter((e) => e.action === 'proxy_event');
    expect(events).toHaveLength(3);
  });

  test('a reason longer than the bound is truncated like any ledger note', () => {
    const store = PolicyStore.ephemeral();
    store.recordEvent('reasons.example', 'r'.repeat(400));
    const event = store.list().find((e) => e.action === 'proxy_event');
    expect(event?.reason).toBe('r'.repeat(200));
  });

  test('a client-shaped non-hostname is refused — callers wrap it, the store stays strict', () => {
    const store = PolicyStore.ephemeral();
    expect(() => store.recordEvent(`${'x'.repeat(300)}.example`, 'csp-rewrite')).toThrow();
    expect(() => store.recordEvent('', 'csp-rewrite')).toThrow();
  });

  test('past the 10k dedupe cap events still record — only deduplication lapses', () => {
    const store = PolicyStore.ephemeral();
    // (host, reason) pairs are client-shaped — a spray must not grow the
    // dedupe set without bound. The cap stops it from learning; the audit
    // lines keep landing.
    for (let i = 0; i < 10_000; i++) {
      store.recordEvent(`h${i}.example`, 'csp-rewrite');
    }
    expect(store.list().filter((e) => e.action === 'proxy_event')).toHaveLength(10_000);
    // A learned pair still dedupes…
    store.recordEvent('h0.example', 'csp-rewrite');
    // …but a pair past the cap records outright — and again, because the
    // capped set never memorized it.
    store.recordEvent('post-cap.example', 'csp-rewrite');
    store.recordEvent('post-cap.example', 'csp-rewrite');
    expect(store.list().filter((e) => e.action === 'proxy_event')).toHaveLength(10_002);
  });
});
