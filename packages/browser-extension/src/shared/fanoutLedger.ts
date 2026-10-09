/**
 * First-party fan-out ledger — flag 43's browser-level behavioural signal.
 *
 * The learned model's hard cases are domains lexically indistinguishable from trackers
 * (`fonts.gstatic.com` vs `cm.g.doubleclick.net`). The signal that separates them is
 * distribution: how many distinct sites embed the resource. Only a browser sees that —
 * the daemon sees DNS names without page context, and the v2 crawl proved plain HTTP
 * cannot tell them apart.
 *
 * This tally records, per matched third-party host, the set of registrable
 * first-party domains it appeared under. The same caveats as the hit ledger apply:
 * coverage is matched requests only — an allowed tracker is invisible — so an absent
 * entry means "never seen matched", never "embeds nowhere". First-party identity is
 * the registrable domain (`registrableDomainOf`), not the URL: we count *sites*, and
 * never keep page paths.
 *
 * Bounds, so a long-lived tally cannot grow without limit:
 * - `MAX_FANOUT_HOSTS` third-party entries, least-recently-seen evicted,
 * - `MAX_FIRST_PARTIES` sites per host — beyond the cap the exact set stops mattering
 *   ("embedded on 64+ sites" is already the signal), so a `firstPartiesCapped` flag
 *   says the list is a floor, not a count.
 */

export const FANOUT_TALLY_STORAGE_KEY = 'bm_fanout_tally_v1';
export const MAX_FANOUT_HOSTS = 2000;
export const MAX_FIRST_PARTIES = 64;

export interface FanoutEntry {
  /** Registrable first-party domains, sorted. A floor when `firstPartiesCapped`. */
  firstParties: string[];
  firstPartiesCapped: boolean;
  /** Matched requests under any first party — counts match batches, not edges. */
  hits: number;
  /** UTC day strings `YYYY-MM-DD`. */
  firstSeen: string;
  lastSeen: string;
}

export interface FanoutTally {
  entries: Record<string, FanoutEntry>;
}

export function emptyFanoutTally(): FanoutTally {
  return { entries: {} };
}

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface RecordEdgeResult {
  tally: FanoutTally;
  /** False when the edge changed nothing — e.g. the same host under the same site again. */
  newEdge: boolean;
}

/**
 * Record `thirdPartyHost` observed under `firstParty` once. `now` is injected for the
 * same reason the ledger's is: a test can prove day boundaries without sleeping, and a
 * caller records the match's own timestamp rather than whatever the clock says later.
 */
export function recordFanoutEdge(
  tally: FanoutTally,
  thirdPartyHost: string,
  firstParty: string,
  now: number,
  hits = 1,
): RecordEdgeResult {
  if (!thirdPartyHost || !firstParty) return { tally, newEdge: false };
  const today = dayOf(now);
  const entries = { ...tally.entries };
  let entry = entries[thirdPartyHost];
  let newEdge = false;

  if (!entry) {
    if (Object.keys(entries).length >= MAX_FANOUT_HOSTS) {
      // Evict the least-recently-seen host — a stale name's seat goes to a live one.
      const oldest = Object.entries(entries).sort(([, a], [, b]) =>
        a.lastSeen.localeCompare(b.lastSeen),
      )[0]?.[0];
      if (oldest) delete entries[oldest];
    }
    entry = { firstParties: [], firstPartiesCapped: false, hits: Math.max(1, Math.floor(hits)), firstSeen: today, lastSeen: today };
    newEdge = true;
  } else {
    entry = { ...entry, firstParties: [...entry.firstParties] };
    entry.hits += Math.max(1, Math.floor(hits));
    entry.lastSeen = today;
  }

  if (!entry.firstParties.includes(firstParty)) {
    if (entry.firstParties.length < MAX_FIRST_PARTIES) {
      entry.firstParties.push(firstParty);
      entry.firstParties.sort();
      newEdge = true;
    } else {
      entry.firstPartiesCapped = true;
    }
  }
  entries[thirdPartyHost] = entry;
  return { tally: { entries }, newEdge };
}

/** Reads a persisted tally, dropping malformed entries rather than corrupting the file. */
export function normalizeStoredFanout(raw: unknown): FanoutTally {
  if (!raw || typeof raw !== 'object') return emptyFanoutTally();
  const rawEntries = (raw as { entries?: unknown }).entries;
  if (!rawEntries || typeof rawEntries !== 'object') return emptyFanoutTally();
  const entries: Record<string, FanoutEntry> = {};
  for (const [host, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (typeof host !== 'string' || !host || host.length > 253) continue;
    const e = value as Partial<FanoutEntry>;
    if (!e || typeof e !== 'object' || !Array.isArray(e.firstParties)) continue;
    entries[host] = {
      firstParties: e.firstParties.filter((p): p is string => typeof p === 'string' && p.length <= 253).slice(0, MAX_FIRST_PARTIES),
      firstPartiesCapped: e.firstPartiesCapped === true || e.firstParties.length > MAX_FIRST_PARTIES,
      hits: typeof e.hits === 'number' && Number.isFinite(e.hits) ? Math.max(0, Math.floor(e.hits)) : 0,
      firstSeen: typeof e.firstSeen === 'string' ? e.firstSeen : '',
      lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : '',
    };
  }
  return { entries };
}
