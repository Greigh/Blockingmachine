/**
 * Live resolver observations, indexed by domain, for the serving-time mini-AI.
 *
 * The daemon's dns-observations.jsonl already feeds the shadow-training tail;
 * this index lets the *production* classifier see the same facts: a foreign
 * CNAME hop, a prior BLOCKED answer, NXDOMAIN churn. One stream, two readers —
 * the training corpus and the serving model — and one shared parser, so the
 * serving index can never drift from what training ingested.
 *
 * Keys are normalized with the same helpers `AiDetectorService.normalizeDomain`
 * uses, so a raw wire name (`WWW.Foo.`) lands where a scanned domain looks.
 *
 * Bounded LRU keyed by domain: a fresh record for a seen domain replaces the
 * stale one and refreshes recency; the oldest entries evict past the cap.
 */

import { readFileSync, statSync } from 'node:fs';
import { isPublicHostname, normalizeHostname, sanitizeDomain, type BehavioralObservation } from '@blockingmachine/core';

const MAX_ENTRIES = 20_000;
/** Tail window for cold-start priming — enough for ~3k typical records. */
const PRIME_TAIL_BYTES = 512 * 1024;

const observations = new Map<string, BehavioralObservation>();

/** The fields the daemon's ObservationRecorder writes — parsed leniently. */
export interface DnsObservationRecord {
  domain?: string;
  verdict?: string;
  rcode?: number | null;
  cname_depth?: number;
  cname_foreign?: boolean;
  ttl_min?: number;
  latency_ms?: number;
}

/**
 * Map one daemon JSONL record to a live BehavioralObservation. Single-sample
 * fields are honest: queryCount is 1 (the recorder dedups), nxdomainRate is the
 * degenerate 0/1 rate for this record, and fanout_* stay absent — the hub's
 * ledger merges them at lookup time.
 */
export function observationFromDnsRecord(rec: DnsObservationRecord): BehavioralObservation {
  return {
    dnsSeen: true,
    dnsQueryCount: 1,
    dnsBlocked: rec.verdict === 'BLOCKED',
    dnsCnameDepth: rec.cname_depth ?? null,
    dnsCnameForeign: rec.cname_foreign ?? null,
    dnsNxdomainRate: rec.rcode === 3 ? 1 : typeof rec.rcode === 'number' ? 0 : null,
    dnsTtlMin: rec.ttl_min ?? null,
    dnsLatencyMs: rec.latency_ms ?? null,
  };
}

function keyFor(domain: string): string {
  const host = normalizeHostname(domain);
  return sanitizeDomain(host) ?? host;
}

export function indexLiveObservation(domain: string, obs: BehavioralObservation): void {
  const key = keyFor(domain);
  if (!key) return;
  if (observations.has(key)) observations.delete(key);
  observations.set(key, obs);
  if (observations.size > MAX_ENTRIES) {
    observations.delete(observations.keys().next().value as string);
  }
}

/**
 * Parse and index one daemon record. Returns the mapped observation, or null
 * when the record carries no usable domain.
 */
export function indexDnsRecord(rec: DnsObservationRecord): BehavioralObservation | null {
  if (typeof rec.domain !== 'string' || !isPublicHostname(rec.domain)) return null;
  const obs = observationFromDnsRecord(rec);
  indexLiveObservation(rec.domain, obs);
  return obs;
}

export function getLiveObservation(domain: string): BehavioralObservation | undefined {
  return observations.get(keyFor(domain));
}

export function liveObservationCount(): number {
  return observations.size;
}

/** Test seam. */
export function clearLiveObservations(): void {
  observations.clear();
}

/**
 * Cold-start fill: the shadow tail only reads *new* bytes (its offset file
 * persists across restarts), so without this the index would sit empty until
 * fresh DNS traffic. Reads the file's tail window — file order means the last
 * record per domain wins, which is also the freshest. Returns the number of
 * records indexed; 0 when the file is absent, empty, or unreadable.
 */
export function primeLiveObservations(filePath: string): number {
  try {
    const size = statSync(filePath).size;
    if (size === 0) return 0;
    const offset = Math.max(0, size - PRIME_TAIL_BYTES);
    // Byte offset, not char — utf8 slicing can split a multibyte label. Skip the
    // head fragment by starting after its newline; a truncated tail record just
    // fails JSON.parse below and is skipped like any corrupt line.
    let text = readFileSync(filePath).subarray(offset).toString('utf8');
    if (offset > 0) {
      const nl = text.indexOf('\n');
      if (nl === -1) return 0;
      text = text.slice(nl + 1);
    }
    let primed = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        if (indexDnsRecord(JSON.parse(trimmed) as DnsObservationRecord)) primed++;
      } catch {
        // Partial or corrupt record — the daemon's writer never produces these,
        // but a rotated/crashed tail can; skip rather than poison the index.
      }
    }
    return primed;
  } catch {
    return 0;
  }
}
