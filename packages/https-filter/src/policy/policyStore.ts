/**
 * Pin/bypass policy store — the proxy's trust-decision ledger (design spec §5.6).
 *
 * One append-only JSONL file carries every decision as
 * `{ts, host, action, reason?, prevHash}` — `pin` (learned on client
 * handshake-abort, the certificate-pinning signal), `bypass` (user-directed),
 * and `remove` (retracts the host from both sets). Each line's `prevHash` is
 * the sha256 hex of the previous *physical* line — the genesis line's is
 * `null` — so the ledger is tamper-evident per spec §8: editing any earlier
 * line breaks the next line's chain link, and replay counts the break rather
 * than trusting the doctored tail. Corrupt lines — torn final writes, wrong
 * shapes, chain breaks — are skipped and counted in `corruptLineCount`, never
 * fatal: a damaged ledger degrades to re-learning, not to a proxy that won't
 * start.
 *
 * Replays rebuild two in-memory sets, so `isPinned`/`isBypassed` are O(1) on
 * the socket hot path — `isPinned(host) || isBypassed(host)` is the exact
 * blind-tunnel predicate the proxy listeners consume. Hosts are normalized to
 * lowercase on the way in and on replay. Per the learned-shadow privacy
 * convention the ledger holds hostnames and short reasons only — never URLs,
 * headers, or bodies.
 *
 * Writes are `appendFileSync`, durable per call, fail-soft like
 * `observationRecorder`: a full/read-only disk warns and leaves the in-memory
 * sets applied (this session still tunnels), it never kills the proxy. The
 * hash chain only advances on a persisted line — a failed append never leaves
 * a dangling `prevHash` for the next write to trip over.
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PolicyAction = 'pin' | 'bypass' | 'remove';

export interface PolicyEntry {
  ts: number;
  host: string;
  action: PolicyAction;
  reason?: string;
}

/** On-disk record — the public entry plus its hash-chain link. */
interface PolicyRecord extends PolicyEntry {
  prevHash: string | null;
}

const ACTIONS: ReadonlySet<string> = new Set<PolicyAction>(['pin', 'bypass', 'remove']);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** DNS is case-insensitive; whitespace on a host read off a socket is garbage. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function isPolicyRecord(value: unknown): value is PolicyRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.ts === 'number' &&
    Number.isFinite(rec.ts) &&
    typeof rec.host === 'string' &&
    rec.host.length > 0 &&
    typeof rec.action === 'string' &&
    ACTIONS.has(rec.action) &&
    (rec.reason === undefined || typeof rec.reason === 'string') &&
    (rec.prevHash === null || typeof rec.prevHash === 'string')
  );
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export class PolicyStore {
  private readonly filePath: string;
  private readonly pinned = new Set<string>();
  private readonly bypassed = new Set<string>();
  private readonly entries: PolicyEntry[] = [];
  /** Bytes of the last line on disk — the chain anchor for the next append. */
  private lastRawLine: string | null = null;
  private corruptLines = 0;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async open(path: string): Promise<PolicyStore> {
    const store = new PolicyStore(path);
    await mkdir(dirname(path), { recursive: true });
    const raw = await readIfExists(path);
    if (raw !== null) {
      // Hostnames of pinned apps are worth more than world-read: same re-pin
      // discipline as the CA key — writeFile's mode only applies at create.
      await chmod(path, 0o600);
      store.replay(raw);
    }
    return store;
  }

  /** Lines replay skipped — torn writes, wrong shapes, chain breaks. */
  get corruptLineCount(): number {
    return this.corruptLines;
  }

  isPinned(host: string): boolean {
    return this.pinned.has(normalizeHost(host));
  }

  /** Called by the TLS layer when a client aborts the forged handshake. */
  learnPin(host: string, reason: string): void {
    const normalized = requireHost(host);
    // Already learned → no-op: the sync appendFileSync is on the socket hot
    // path and repeat aborts would otherwise bloat the ledger.
    if (this.pinned.has(normalized)) {
      return;
    }
    this.pinned.add(normalized);
    this.append(normalized, 'pin', reason);
  }

  isBypassed(host: string): boolean {
    return this.bypassed.has(normalizeHost(host));
  }

  addBypass(host: string): void {
    const normalized = requireHost(host);
    this.bypassed.add(normalized);
    this.append(normalized, 'bypass');
  }

  remove(host: string): void {
    const normalized = requireHost(host);
    this.pinned.delete(normalized);
    this.bypassed.delete(normalized);
    this.append(normalized, 'remove');
  }

  /** The applied ledger, oldest first — chain internals stripped. */
  list(): PolicyEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Appends are synchronous and durable per call, so there is nothing to
   * flush — this exists so lifecycle owners (control shutdown, tests) have a
   * stable hook if a buffered writer ever lands.
   */
  close(): void {}

  /**
   * Rebuild sets + entries from the file. Every physical line participates in
   * the chain whether it parses or not — writers hash the previous line's
   * bytes, so a corrupt line still anchors the next line's `prevHash`.
   */
  private replay(raw: string): void {
    let previous: string | null = null;
    for (const line of raw.split('\n')) {
      if (line === '') {
        continue; // trailing newline of a clean file — not corruption
      }
      const expectedPrev = previous === null ? null : sha256Hex(previous);
      previous = line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.corruptLines++;
        continue;
      }
      if (!isPolicyRecord(parsed) || parsed.prevHash !== expectedPrev) {
        this.corruptLines++;
        continue;
      }
      this.apply(parsed);
    }
    this.lastRawLine = previous;
  }

  private apply(record: PolicyRecord): void {
    const host = normalizeHost(record.host);
    if (record.action === 'pin') {
      this.pinned.add(host);
    } else if (record.action === 'bypass') {
      this.bypassed.add(host);
    } else {
      this.pinned.delete(host);
      this.bypassed.delete(host);
    }
    const { prevHash: _prevHash, ...entry } = record;
    this.entries.push({ ...entry, host });
  }

  private append(host: string, action: PolicyAction, reason?: string): void {
    // Field order is the on-disk contract: ts, host, action, reason?, prevHash.
    const record: PolicyRecord = {
      ts: Date.now(),
      host,
      action,
      ...(reason !== undefined ? { reason } : {}),
      prevHash: this.lastRawLine === null ? null : sha256Hex(this.lastRawLine),
    };
    const line = JSON.stringify(record);
    try {
      appendFileSync(this.filePath, line + '\n', { mode: 0o600 });
    } catch (err) {
      // Fail-soft: the sets above already applied, so the host still tunnels
      // this session — and the chain stays anchored to a persisted line.
      console.warn('[PolicyStore] append failed:', err);
      return;
    }
    this.lastRawLine = line;
    const { prevHash: _prevHash, ...entry } = record;
    this.entries.push(entry);
  }
}

function requireHost(host: string): string {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) {
    throw new Error('PolicyStore: host must be a non-empty hostname');
  }
  return normalized;
}
