/**
 * Leaf-forge queue tests (flag 94): concurrent same-name calls dedupe onto a
 * single authority invocation, distinct-name bursts serialize and yield the
 * loop between forges, and post-settle calls re-enter the authority — the
 * leaf LRU carries repeat-name reuse, the queue itself caches nothing.
 */

import { describe, expect, jest, test } from '@jest/globals';
import type { LeafMaterial } from '../ca/certAuthority.js';
import { LeafForgeQueue } from '../ca/leafForgeQueue.js';

function leaf(sni: string): LeafMaterial {
  return { certPem: `cert:${sni}`, keyPem: `key:${sni}` };
}

describe('LeafForgeQueue', () => {
  test('concurrent same-name calls share one authority forge — all waiters get the same material', async () => {
    const forgeLeaf = jest.fn((sni: string) => leaf(sni));
    const queue = new LeafForgeQueue({ forgeLeaf }, { concurrency: 1 });
    const [a, b, c] = await Promise.all([
      queue.forge('shared.example'),
      queue.forge('shared.example'),
      queue.forge('shared.example'),
    ]);
    expect(forgeLeaf).toHaveBeenCalledTimes(1);
    expect(forgeLeaf).toHaveBeenCalledWith('shared.example');
    expect(a).toEqual(leaf('shared.example'));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('dedupe keys on the normalized name — case and trailing dots fold', async () => {
    const forgeLeaf = jest.fn((sni: string) => leaf(sni));
    const queue = new LeafForgeQueue({ forgeLeaf }, { concurrency: 1 });
    await Promise.all([
      queue.forge('Norm.EXAMPLE.'),
      queue.forge('norm.example'),
      queue.forge('NORM.example.'),
    ]);
    expect(forgeLeaf).toHaveBeenCalledTimes(1);
    expect(forgeLeaf).toHaveBeenCalledWith('norm.example');
  });

  test('a distinct-name burst never overlaps invocations and yields the loop between forges', async () => {
    const marks: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const forgeLeaf = jest.fn((sni: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      marks.push(`forge:${sni}`);
      inFlight -= 1;
      return leaf(sni);
    });
    const queue = new LeafForgeQueue({ forgeLeaf }, { concurrency: 1 });
    const pending = [
      queue.forge('a.example'),
      queue.forge('b.example'),
      queue.forge('c.example'),
    ];
    // A probe scheduled inside the burst: slot grants land on a fresh loop
    // turn (setImmediate), so this marker must interleave between two forges
    // — a burst chaining every keygen inside one synchronous drain would
    // leave it strictly last.
    const probe = new Promise<void>((resolve) => {
      setImmediate(() => {
        marks.push('loop-turn');
        resolve();
      });
    });
    await Promise.all([...pending, probe]);
    expect(forgeLeaf).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    const probeIdx = marks.indexOf('loop-turn');
    const forgeIdxs = ['a.example', 'b.example', 'c.example'].map((n) =>
      marks.indexOf(`forge:${n}`),
    );
    expect(probeIdx).toBeGreaterThan(Math.min(...forgeIdxs));
    expect(probeIdx).toBeLessThan(Math.max(...forgeIdxs));
  });

  test('a wider bound admits more immediate grants — concurrency: 2 forges two names before the next loop turn', async () => {
    const marks: string[] = [];
    const forgeLeaf = jest.fn((sni: string) => {
      marks.push(`forge:${sni}`);
      return leaf(sni);
    });
    const queue = new LeafForgeQueue({ forgeLeaf }, { concurrency: 2 });
    const pending = [
      queue.forge('a.example'),
      queue.forge('b.example'),
      queue.forge('c.example'),
    ];
    const probe = new Promise<void>((resolve) => {
      setImmediate(() => {
        marks.push('loop-turn');
        resolve();
      });
    });
    await Promise.all([...pending, probe]);
    expect(forgeLeaf).toHaveBeenCalledTimes(3);
    const probeIdx = marks.indexOf('loop-turn');
    // Two slots free at call time: both forges run in the first microtask
    // drain, ahead of the probe — the bound, not a queue artifact, gates it.
    expect(marks.indexOf('forge:b.example')).toBeLessThan(probeIdx);
    expect(marks.indexOf('forge:c.example')).toBeGreaterThan(probeIdx);
  });

  test('post-settle calls re-enter the authority — repeat-name reuse lives in its LRU, not the queue', async () => {
    const forgeLeaf = jest.fn((sni: string) => leaf(sni));
    const queue = new LeafForgeQueue({ forgeLeaf }, { concurrency: 1 });
    const first = await queue.forge('cached.example');
    const second = await queue.forge('cached.example');
    // Sequential calls see the dedupe window already closed; the authority
    // decides what a repeat name costs (its LRU → ~free).
    expect(forgeLeaf).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  test('a throwing forge shares one rejection across same-name waiters, then retries cleanly', async () => {
    const forgeLeaf = jest.fn((_sni: string): LeafMaterial => {
      throw new Error('invalid SNI');
    });
    const queue = new LeafForgeQueue({ forgeLeaf }, { concurrency: 1 });
    const results = await Promise.allSettled([queue.forge('bad'), queue.forge('bad')]);
    expect(forgeLeaf).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // The in-flight slot cleared — a later same-name call re-invokes, not a
    // permanently cached rejection.
    await expect(queue.forge('bad')).rejects.toThrow('invalid SNI');
    expect(forgeLeaf).toHaveBeenCalledTimes(2);
  });
});
