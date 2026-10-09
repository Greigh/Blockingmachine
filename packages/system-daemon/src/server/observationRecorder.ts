import dnsPacket from 'dns-packet';
import { decomposeDomain } from '@blockingmachine/core';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DnsVerdict } from '../types.js';

/**
 * DNS observation stream — the behavioural data the learned model is missing (flag 43).
 *
 * v2 proved plain-HTTP crawl features cannot separate a tracker pixel from a benign
 * endpoint (`packages/ai-training` README, M4 findings). What discriminates is what only
 * a resolver can see: the CNAME chain a name actually resolves through (cloaking), the
 * response shape, and when the domain was truly observed. This module appends one JSONL
 * record per deduped query to `<observationsFile>` so `ai-training/obs_ingest.py` can
 * join them onto the label store — the same discipline as `learned-shadow.jsonl`
 * (docs/learned-shadow-privacy.md): a domain and its DNS metadata only, never a client
 * IP, written to a local file that is never transmitted.
 *
 * Bounds, so a busy resolver cannot grow this forever:
 * - per-domain dedup window (`dedupWindowMs`) — one record per domain per window,
 * - a capped `lastSeen` map (oldest quarter evicted at cap),
 * - file rotation at `maxFileBytes` to a single `.1` sibling.
 */
export interface DnsObservation {
  domain: string;
  /** ISO-8601 — real observation time, unlike the label store's shared import stamp. */
  observed_at: string;
  qtype?: string;
  verdict: DnsVerdict;
  /** Wire rcode (0 NOERROR, 3 NXDOMAIN, 2 SERVFAIL); null when upstream never answered. */
  rcode: number | null;
  upstream_ok: boolean;
  /** CNAME hops walked from the question name; 0 when the answer had none. */
  cname_depth: number;
  /** Raw chain targets in order, capped — cloaking shows up as the foreign name. */
  cname_hosts?: string[];
  /** Any chain target whose registrable domain differs from the queried name's —
   *  the CNAME-cloaking signal, computed here because the training side has no
   *  public-suffix tables. */
  cname_foreign?: boolean;
  ttl_min?: number;
  answer_count?: number;
  latency_ms?: number;
}

const DEFAULT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const MAX_SEEN_DOMAINS = 50_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CNAME_HOSTS = 8;

// dns-packet's local declaration returns `any` from decode() — describe only the
// answer fields we read.
interface DecodedAnswer {
  name?: string;
  type?: string;
  data?: unknown;
  ttl?: number;
}
interface DecodedPacket {
  flags?: number;
  answers?: DecodedAnswer[];
}

/** Extract the chain a CNAME-cloaked name resolves through, from a decoded answer. */
export function cnameChainOf(questionName: string, decoded: DecodedPacket): { depth: number; hosts: string[] } {
  const answers = (decoded.answers ?? []).filter(
    (a) => a.type === 'CNAME' && typeof a.name === 'string' && typeof a.data === 'string',
  ) as { name: string; data: string; type: string }[];
  const hosts: string[] = [];
  let current = questionName.toLowerCase().replace(/\.$/, '');
  const seen = new Set<string>([current]);
  while (hosts.length < MAX_CNAME_HOSTS) {
    const hop = answers.find((a) => a.name.toLowerCase().replace(/\.$/, '') === current);
    if (!hop) break;
    const next = hop.data.toLowerCase().replace(/\.$/, '');
    if (seen.has(next)) break; // answer loops — malformed but real
    seen.add(next);
    hosts.push(next);
    current = next;
  }
  return { depth: hosts.length, hosts };
}

/**
 * Summarize a decoded upstream answer into the observation fields the training side
 * reads. Rcode is `decoded.rcode` when dns-packet surfaces it; it does not always, so
 * the flag field's low nibble is the fallback (same encoding the sinkhole path uses).
 */
export function summarizeAnswer(
  questionName: string,
  upstreamBuffer: Buffer,
): Pick<DnsObservation, 'rcode' | 'cname_depth' | 'cname_hosts' | 'cname_foreign' | 'ttl_min' | 'answer_count'> {
  const decoded = dnsPacket.decode(upstreamBuffer) as DecodedPacket;
  const { depth, hosts } = cnameChainOf(questionName, decoded);
  const flags = typeof decoded.flags === 'number' ? decoded.flags : 0;
  const answerList = decoded.answers ?? [];
  const ttls = answerList
    .map((a: DecodedAnswer) => (typeof a.ttl === 'number' ? a.ttl : undefined))
    .filter((t: number | undefined): t is number => t !== undefined);
  return {
    rcode: flags & 0xf,
    cname_depth: depth,
    ...(hosts.length > 0 ? { cname_hosts: hosts, cname_foreign: chainCrossesOrigin(questionName, hosts) } : {}),
    ...(ttls.length > 0 ? { ttl_min: Math.min(...ttls) } : {}),
    answer_count: answerList.length,
  };
}

/**
 * True when the chain ends up under a different registrable domain than the one
 * asked for — the classic CNAME-cloaking shape (`metrics.example.com` →
 * `*.tracker.example`). `decomposeDomain` carries the shared suffix tables, so the
 * comparison honours compound ccTLDs and shared-hosting platforms the way the rest
 * of the system does.
 */
function chainCrossesOrigin(questionName: string, hosts: string[]): boolean {
  const origin = registrable(questionName);
  if (!origin) return false;
  return hosts.some((h) => registrable(h) !== origin);
}

function registrable(host: string): string {
  const { sld, tld } = decomposeDomain(host);
  if (!tld || sld === tld) return sld || host;
  return `${sld}.${tld}`;
}

export class ObservationRecorder {
  private lastSeen = new Map<string, number>();
  private filePath: string;
  private dedupWindowMs: number;
  private now: () => number;

  constructor(filePath: string, opts: { dedupWindowMs?: number; now?: () => number } = {}) {
    this.filePath = filePath;
    this.dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Records one observation unless the domain was already recorded this window. */
  observe(obs: DnsObservation): void {
    const at = this.now();
    const last = this.lastSeen.get(obs.domain);
    if (last !== undefined && at - last < this.dedupWindowMs) return;
    this.lastSeen.set(obs.domain, at);
    if (this.lastSeen.size > MAX_SEEN_DOMAINS) {
      // Evict the oldest quarter — a Map's insertion order makes the front the oldest.
      const drop = Math.floor(MAX_SEEN_DOMAINS / 4);
      let i = 0;
      for (const key of this.lastSeen.keys()) {
        if (i++ >= drop) break;
        this.lastSeen.delete(key);
      }
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.rotateIfFull();
      appendFileSync(this.filePath, JSON.stringify(obs) + '\n');
    } catch (err) {
      // Fail-soft like learnedShadow: a full disk must not take DNS answering down.
      console.warn('[DnsObservations] write failed:', err);
    }
  }

  /** For tests/diagnostics — the dedup map's live size. */
  get trackedDomainCount(): number {
    return this.lastSeen.size;
  }

  private rotateIfFull(): void {
    try {
      if (!existsSync(this.filePath)) return;
      if (statSync(this.filePath).size < MAX_FILE_BYTES) return;
      const sibling = `${this.filePath}.1`;
      if (existsSync(sibling)) unlinkSync(sibling);
      renameSync(this.filePath, sibling);
    } catch {
      // Rotation failure just means the file keeps growing this cycle — next write retries.
    }
  }
}
