/**
 * Persistent Radar Heat Map [Beta]
 *
 * Remembers flagged domains across watchdog sweeps and query-log scans so the
 * Sentinel Watchdog can hunt adaptively instead of starting from zero each run:
 *
 * - Repeat offenders accumulate "heat"; hotter domains are easier to justify
 *   quarantining and are surfaced to the user as persistent threats.
 * - Recent flagged volume drives an adaptive cadence suggestion: a quiet network
 *   stretches the sweep interval to save resources, while an active one tightens it.
 * - Offenders can be **ignored** (distinct from allowlisting): ignored entries
 *   stop surfacing and freeze in place, without trusting the domain or touching
 *   any rules. Ignoring generalizes across the registrable zone.
 *
 * Entries are bounded (oldest evicted first) and recent activity decays, so
 * stale domains cool off instead of haunting the ledger forever.
 */

import { getRegistrableZone } from '@blockingmachine/core';

export interface RadarHeatEntry {
  domain: string;
  /** Number of times this domain has been flagged across scans. */
  flags: number;
  clients: string[];
  verdict: string;
  category: string;
  riskLevel: string;
  /** Epoch ms of the most recent flag. */
  lastSeen: number;
  /** Epoch ms of the first flag. */
  firstSeen: number;
  /** User-hidden offender: shown in the "Ignored" section, never in Top Repeat Offenders. */
  ignored?: boolean;
  /** Epoch ms when the user ignored this domain (for display). */
  ignoredAt?: number;
}

export interface RadarHeatMap {
  version: 1;
  updatedAt: number;
  entries: RadarHeatEntry[];
}

export interface HeatCadenceSuggestion {
  /** Suggested sweep interval in minutes. */
  intervalMinutes: number;
  /** Rationale for the suggestion (shown in logs and the settings UI). */
  reason: string;
}

export interface HeatSummary {
  totalDomains: number;
  hotDomains: number;
  recentFlags: number;
  topOffenders: RadarHeatEntry[];
  /** Domains the user has chosen to ignore (hidden from Top Repeat Offenders). */
  ignoredCount: number;
  /** Most recently flagged ignored domains, newest first. */
  ignoredEntries: RadarHeatEntry[];
}

const HEAT_MAX_ENTRIES = 500;
const HEAT_DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // one week
const HEAT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const HEAT_HOT_THRESHOLD = 3;

export function emptyRadarHeatMap(): RadarHeatMap {
  return { version: 1, updatedAt: 0, entries: [] };
}

function sanitizeEntryKey(domain: unknown): string {
  return typeof domain === 'string' ? domain.trim().toLowerCase().replace(/\.$/, '') : '';
}

/**
 * Merges freshly flagged domains into the persisted heat map.
 * Only non-clean verdicts carry heat; clean scans never pollute the ledger.
 */
export function recordFlagsInHeatMap(
  heat: RadarHeatMap | null | undefined,
  flagged: Array<{ domain?: string; verdict?: string; category?: string; riskLevel?: string; client?: string }>,
  now = Date.now(),
): RadarHeatMap {
  const base: RadarHeatMap = heat && Array.isArray(heat.entries)
    ? { version: 1, updatedAt: heat.updatedAt || now, entries: heat.entries.filter((e) => e && sanitizeEntryKey(e.domain)) }
    : emptyRadarHeatMap();

  const byKey = new Map<string, RadarHeatEntry>();
  for (const entry of base.entries) {
    byKey.set(sanitizeEntryKey(entry.domain), entry);
  }

  const isZoneIgnored = (domain: string): boolean => {
    const zone = getRegistrableZone(domain) || domain;
    for (const entry of byKey.values()) {
      if (entry.ignored && (getRegistrableZone(entry.domain) || entry.domain) === zone) return true;
    }
    return false;
  };

  for (const item of flagged) {
    const key = sanitizeEntryKey(item?.domain);
    if (!key || !key.includes('.')) continue;
    if (item.verdict === 'clean') continue;
    const existing = byKey.get(key);
    if (existing) {
      // Ignored offenders stay frozen: user said "leave this alone", so new
      // flags neither resurrect it into the active list nor grow its heat.
      if (existing.ignored) continue;
      existing.flags += 1;
      existing.lastSeen = now;
      if (item.client && !existing.clients.includes(item.client)) {
        existing.clients = [...existing.clients, item.client].slice(0, 16);
      }
      // Keep the most severe recent classification
      if (item.riskLevel && item.riskLevel !== existing.riskLevel) existing.riskLevel = item.riskLevel;
      if (item.category) existing.category = item.category;
      if (item.verdict) existing.verdict = item.verdict;
    } else {
      // A brand-new sibling of an ignored zone entry starts ignored too:
      // ignoring a zone means "stop showing me this domain family".
      const zoneIgnored = isZoneIgnored(key);
      byKey.set(key, {
        domain: key,
        flags: 1,
        clients: item.client ? [item.client] : [],
        verdict: item.verdict || 'suspicious',
        category: item.category || 'Unknown',
        riskLevel: item.riskLevel || 'medium',
        lastSeen: now,
        firstSeen: now,
        ignored: zoneIgnored || undefined,
        ignoredAt: zoneIgnored ? now : undefined,
      });
    }
  }

  // Decay, prune, and evict oldest beyond the cap. Ignored entries are frozen:
  // they neither decay nor age while hidden, so restoring preserves what the
  // user saw when they hid the domain.
  const decayed = Array.from(byKey.values()).map((entry) => {
    if (entry.ignored) return entry;
    const age = now - entry.lastSeen;
    if (age <= HEAT_RECENT_WINDOW_MS || age <= 0) return entry;
    const halfLives = age / HEAT_DECAY_HALF_LIFE_MS;
    const flags = Math.max(1, Math.floor(entry.flags / 2 ** Math.min(halfLives, 4)));
    return { ...entry, flags };
  });
  decayed.sort((a, b) => b.lastSeen - a.lastSeen || b.flags - a.flags);

  return {
    version: 1,
    updatedAt: now,
    entries: decayed.slice(0, HEAT_MAX_ENTRIES),
  };
}

/**
 * Looks up heat for a domain. Beyond exact entries, heat generalizes across a
 * registrable zone: subdomains, superdomains, and sibling subdomains of a known
 * offender all resolve to its heat (a flag on any `*.example.com` sibling
 * warms the whole zone).
 */
export function getHeatForDomain(heat: RadarHeatMap | null | undefined, domain: string): RadarHeatEntry | null {
  const key = sanitizeEntryKey(domain);
  if (!heat || !Array.isArray(heat.entries) || !key) return null;
  const exact = heat.entries.find((e) => sanitizeEntryKey(e.domain) === key);
  if (exact) return exact;
  // Subdomain of a known offender (foo.ads.evil.example -> ads.evil.example)
  const parent = heat.entries
    .filter((e) => key.endsWith(`.${sanitizeEntryKey(e.domain)}`))
    .sort((a, b) => b.flags - a.flags)[0];
  if (parent) return parent;
  // Superdomain of a known offender (random.foo.evil.example when evil.example is hot)
  const child = heat.entries.find((e) => sanitizeEntryKey(e.domain).endsWith(`.${key}`));
  if (child) return { ...child, domain: key };    // Sibling sharing the same registrable zone (cdn.evil.example when ads.evil.example is hot)
  const zone = getRegistrableZone(key) || key;
  const sibling = heat.entries.find((e) => {
    const entryDomain = sanitizeEntryKey(e.domain);
    return entryDomain !== key && (getRegistrableZone(entryDomain) || entryDomain) === zone;
  });
  return sibling ? { ...sibling, domain: key } : null;
}export function summarizeHeatMap(heat: RadarHeatMap | null | undefined, now = Date.now()): HeatSummary {
  if (!heat || !Array.isArray(heat.entries)) {
    return { totalDomains: 0, hotDomains: 0, recentFlags: 0, topOffenders: [], ignoredCount: 0, ignoredEntries: [] };
  }
  const ignoredEntries = heat.entries.filter((e) => e.ignored);
  const activeEntries = heat.entries.filter((e) => !e.ignored);
  const recentFlags = activeEntries
    .filter((e) => now - e.lastSeen <= HEAT_RECENT_WINDOW_MS)
    .reduce((sum, e) => sum + e.flags, 0);
  const topOffenders = [...activeEntries]
    .sort((a, b) => b.flags - a.flags || b.lastSeen - a.lastSeen)
    .slice(0, 10);
  return {
    totalDomains: activeEntries.length,
    hotDomains: activeEntries.filter((e) => e.flags >= HEAT_HOT_THRESHOLD).length,
    recentFlags,
    topOffenders,
    ignoredCount: ignoredEntries.length,
    ignoredEntries: [...ignoredEntries].sort((a, b) => (b.ignoredAt || b.lastSeen) - (a.ignoredAt || a.lastSeen)).slice(0, 25),
  };
}

/**
 * Marks a domain (and every other entry in its registrable zone) as ignored.
 * Ignoring is distinct from allowlisting: nothing is trusted and no rules are
 * touched — the offender just stops surfacing in Top Repeat Offenders and no
 * longer accumulates heat, while its scans and verdicts continue unchanged.
 */
export function ignoreHeatDomain(heat: RadarHeatMap | null | undefined, domain: string, now = Date.now()): RadarHeatMap {
  const base = heat && typeof heat === 'object' ? heat : emptyRadarHeatMap();
  const key = sanitizeEntryKey(domain);
  if (!key || !Array.isArray(base.entries)) return base;
  const zone = getRegistrableZone(key) || key;
  const entries = base.entries.map((entry) => {
    const entryDomain = sanitizeEntryKey(entry.domain);
    const sameZone = entryDomain === key
      || entryDomain.endsWith(`.${key}`)
      || (getRegistrableZone(entryDomain) || entryDomain) === zone;
    return sameZone ? { ...entry, ignored: true, ignoredAt: now } : entry;
  });
  return { version: 1, updatedAt: now, entries };
}

/**
 * Restores previously ignored domains: clears the ignored flag and resets
 * `lastSeen` to now so restored entries re-enter the 24-hour recent window.
 */
export function unignoreHeatDomain(heat: RadarHeatMap | null | undefined, domain: string, now = Date.now()): RadarHeatMap {
  const base = heat && typeof heat === 'object' ? heat : emptyRadarHeatMap();
  const key = sanitizeEntryKey(domain);
  if (!key || !Array.isArray(base.entries)) return base;
  const zone = getRegistrableZone(key) || key;
  const entries = base.entries.map((entry) => {
    const entryDomain = sanitizeEntryKey(entry.domain);
    const sameZone = entryDomain === key
      || entryDomain.endsWith(`.${key}`)
      || (getRegistrableZone(entryDomain) || entryDomain) === zone;
    return sameZone ? { ...entry, ignored: false, ignoredAt: undefined, lastSeen: now } : entry;
  });
  return { version: 1, updatedAt: now, entries };
}

/**
 * Clears heat for a domain after the user allowlists it: removes the exact
 * entry, its subdomains, and sibling entries sharing the same registrable zone
 * (zone trust generalizes, mirroring how flags accumulate across a zone).
 */
export function clearHeatForDomain(heat: RadarHeatMap | null | undefined, domain: string): RadarHeatMap {
  const base = heat && typeof heat === 'object' ? heat : emptyRadarHeatMap();
  const key = sanitizeEntryKey(domain);
  if (!key || !Array.isArray(base.entries)) return base;
  const zone = getRegistrableZone(key) || key;
  const entries = base.entries.filter((e) => {
    const entryDomain = sanitizeEntryKey(e.domain);
    if (!entryDomain) return false;
    if (entryDomain === key || entryDomain.endsWith(`.${key}`)) return false;
    return (getRegistrableZone(entryDomain) || entryDomain) !== zone;
  });
  return { version: 1, updatedAt: Date.now(), entries };
}

/**
 * Adaptive watchdog cadence: quiet networks stretch the sweep interval (saving
 * CPU and API quota); networks with recent flagged volume tighten it (up to 2x
 * faster than configured) so emerging campaigns are caught sooner.
 */
export function suggestWatchdogCadence(
  heat: RadarHeatMap | null | undefined,
  configuredIntervalMinutes: number,
  now = Date.now(),
): HeatCadenceSuggestion {
  const configured = Math.max(5, Math.round(configuredIntervalMinutes || 60));
  const { recentFlags, hotDomains } = summarizeHeatMap(heat, now);

  if (recentFlags >= 25 || hotDomains >= 10) {
    return {
      intervalMinutes: Math.max(5, Math.round(configured / 2)),
      reason: `High threat pressure (${recentFlags} recent flags, ${hotDomains} hot domains) — doubling sweep frequency`,
    };
  }
  if (recentFlags >= 8 || hotDomains >= 3) {
    return {
      intervalMinutes: Math.max(5, Math.round((configured * 3) / 4)),
      reason: `Moderate threat pressure (${recentFlags} recent flags) — tightening sweep frequency by 25%`,
    };
  }
  if (recentFlags === 0) {
    return {
      intervalMinutes: Math.min(configured * 2, 720),
      reason: 'No recent flagged domains — stretching sweep interval to conserve resources',
    };
  }
  return {
    intervalMinutes: configured,
    reason: `Baseline threat pressure (${recentFlags} recent flags) — keeping configured sweep interval`,
  };
}
