/**
 * Leaf-forge admission control (flag 94 — spec §7's loop-stall posture).
 *
 * `CertAuthority.forgeLeaf` is synchronous RSA-2048 keygen (~50–150 ms) on the
 * engine's single event loop; an SNI spray of distinct valid names — or churn
 * past the 500-entry leaf LRU — used to keep the loop minting back-to-back,
 * stalling dispatch, the control API, and every in-flight relay. This queue
 * is the honest bound a *synchronous* keygen admits:
 *
 *  - **Dedupe by normalized name** — N callers racing the same SNI share one
 *    forge invocation; later callers (post-settle) re-enter the authority,
 *    where the leaf LRU serves the repeat for free. Negative results share
 *    the same fate: one rejection teaches every waiter.
 *  - **A concurrency semaphore** (default 1) serializes invocations. A forge
 *    in progress still blocks the loop while it runs — no queue can change
 *    that — but a queued burst yields the loop between forges instead of
 *    chaining every keygen inside one synchronous drain: slot grants are
 *    issued on a fresh loop turn (`setImmediate`), so pending I/O (an
 *    allowed request's bytes, a control call) interleaves between mints.
 *
 * The queue deliberately does NOT move keygen to a worker thread — the flag's
 * recorded fix shape is dedupe + bounded parallelism; revisit only if the
 * per-forge block itself becomes the measured problem.
 */

import { normalizeSni, type CertAuthority, type LeafMaterial } from './certAuthority.js';

export interface LeafForgeQueueOptions {
  /**
   * Max forge invocations in flight at once (default 1). Higher bounds admit
   * more back-to-back keygen per loop turn — the stall trade-off is the
   * caller's. Non-positive/fractional values clamp to 1.
   */
  concurrency?: number;
}

export class LeafForgeQueue {
  private readonly authority: Pick<CertAuthority, 'forgeLeaf'>;
  private readonly limit: number;
  private running = 0;
  /** Waiters holding no slot — FIFO grant order. */
  private readonly pending: Array<() => void> = [];
  /** In-flight (queued or running) forge per normalized name — the dedupe map. */
  private readonly inflight = new Map<string, Promise<LeafMaterial>>();

  constructor(authority: Pick<CertAuthority, 'forgeLeaf'>, opts: LeafForgeQueueOptions = {}) {
    this.authority = authority;
    this.limit = Math.max(1, Math.floor(opts.concurrency ?? 1));
  }

  /**
   * Forge a leaf for `sni` — deduped against any in-flight forge of the same
   * normalized name, and serialized against the rest. Never invokes the
   * authority synchronously: the await always yields at least a microtask.
   */
  forge(sni: string): Promise<LeafMaterial> {
    const name = normalizeSni(sni);
    const shared = this.inflight.get(name);
    if (shared !== undefined) {
      return shared;
    }
    const promise = this.acquire()
      .then(() => {
        try {
          return this.authority.forgeLeaf(name);
        } finally {
          this.release();
        }
      })
      .finally(() => {
        // Once settled the next same-name call re-enters the authority — its
        // LRU is where repeat-name results live, not this dedupe map.
        this.inflight.delete(name);
      });
    this.inflight.set(name, promise);
    return promise;
  }

  private acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  private release(): void {
    const next = this.pending.shift();
    if (next === undefined) {
      this.running -= 1;
      return;
    }
    // The slot passes straight to the next waiter (`running` is unchanged)
    // — but on a check-phase grant, not a microtask: that full loop turn is
    // what lets pending I/O run between two forges of a burst.
    setImmediate(next);
  }
}
