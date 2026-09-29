/**
 * Per-site blocking control — pure state transitions and display helpers.
 *
 * Everything here is deliberately free of `chrome.*` so the behaviour can be unit
 * tested directly. The background service worker owns persistence and rule
 * application; this module owns the decisions.
 */

import type { TrackerDetection } from './types.js';

/** Stored shape. Sites are canonical (lower-cased, `www.`-stripped, validated). */
export interface SiteControlState {
  /** Sites where blocking is paused (the page and its frames are allowed through). */
  pausedSites: string[];
  /** Individual third-party domains the user has explicitly allowed everywhere. */
  allowedDomains: string[];
  /** Master switch — when on, no block rules are installed at all. */
  globalPaused: boolean;
}

export const EMPTY_SITE_CONTROL: SiteControlState = {
  pausedSites: [],
  allowedDomains: [],
  globalPaused: false,
};

const HOSTNAME_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Canonicalises a hostname, URL, or pattern into the stored site key.
 * Returns `''` when the input can never be a real site (`localhost`, an IP that
 * isn't routable, a browser-internal page, or malformed input).
 */
export function normalizeSite(input: unknown): string {
  if (typeof input !== 'string') return '';
  let host = input.trim().toLowerCase();
  if (!host) return '';

  if (host.includes('://')) {
    try {
      const url = new URL(host);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      host = url.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  host = host.replace(/^\.+|\.+$/g, '');
  if (host.length > 253) return '';

  // Strip a leading `www.` so `www.example.com` and `example.com` are one site.
  // Guard the edge case where `www.` is the registrable label itself (`www.com`).
  if (host.startsWith('www.') && host.slice(4).includes('.')) {
    host = host.slice(4);
  }

  return HOSTNAME_REGEX.test(host) ? host : '';
}

/** Extracts the pausable site from a tab URL, or null for non-web pages. */
export function siteFromUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return normalizeSite(url.hostname) || null;
  } catch {
    return null;
  }
}

/** Builds a validated, de-duplicated, sorted site list from untrusted storage. */
export function normalizeSiteList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    const site = normalizeSite(item);
    if (site && !out.includes(site)) out.push(site);
  }
  return out.sort();
}

/** Repairs arbitrary stored data into a usable control state. */
export function normalizeSiteControl(input: unknown): SiteControlState {
  const source = (input && typeof input === 'object' ? input : {}) as Partial<SiteControlState>;
  return {
    pausedSites: normalizeSiteList(source.pausedSites),
    allowedDomains: normalizeSiteList(source.allowedDomains),
    globalPaused: source.globalPaused === true,
  };
}

/** True when `host` is `site` or any subdomain of it. */
function covers(site: string, host: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/**
 * Any object carrying site decisions. Deliberately structural so the popup's
 * `SiteControlView` (which also carries a pre-computed `sitePaused` flag) can be
 * passed straight in without being reshaped into a full control state.
 */
export interface SiteDecisionSource {
  globalPaused?: boolean;
  pausedSites?: string[] | null;
  allowedDomains?: string[] | null;
  /** Convenience flag computed by the background for the tab's own site. */
  sitePaused?: boolean;
}

export function isSitePaused(state: SiteDecisionSource, rawHost: unknown): boolean {
  const host = normalizeSite(rawHost);
  if (!host) return false;
  return (state.pausedSites ?? []).some((site) => covers(site, host));
}

/**
 * The single answer to "is this site paused?" for display purposes.
 *
 * A view can legitimately arrive with `sitePaused: true` while its `pausedSites`
 * list has not been re-read yet, and the two must never disagree in the UI: a
 * paused site must not render as Active. Either signal is treated as paused.
 */
export function resolveSitePaused(
  state: SiteDecisionSource | null | undefined,
  rawHost?: unknown,
): boolean {
  if (!state) return false;
  return state.sitePaused === true || isSitePaused(state, rawHost);
}

export function isDomainAllowed(state: SiteDecisionSource, rawHost: unknown): boolean {
  const host = normalizeSite(rawHost);
  if (!host) return false;
  return (state.allowedDomains ?? []).some((domain) => covers(domain, host));
}

export function setGlobalPaused(state: SiteControlState, paused: boolean): SiteControlState {
  return { ...state, globalPaused: paused === true };
}

export function setSitePaused(
  state: SiteControlState,
  rawSite: unknown,
  paused: boolean,
): SiteControlState {
  const site = normalizeSite(rawSite);
  if (!site) return state;
  const without = state.pausedSites.filter((entry) => entry !== site);
  return {
    ...state,
    pausedSites: (paused ? [...without, site] : without).sort(),
  };
}

export function setDomainAllowed(
  state: SiteControlState,
  rawDomain: unknown,
  allowed: boolean,
): SiteControlState {
  const domain = normalizeSite(rawDomain);
  if (!domain) return state;
  const without = state.allowedDomains.filter((entry) => entry !== domain);
  return {
    ...state,
    allowedDomains: (allowed ? [...without, domain] : without).sort(),
  };
}

export type ShieldStatus = 'global-paused' | 'site-paused' | 'active';

export function deriveShieldStatus(
  state: SiteDecisionSource | null | undefined,
  rawHost?: unknown,
): ShieldStatus {
  if (!state) return 'active';
  if (state.globalPaused) return 'global-paused';
  if (resolveSitePaused(state, rawHost)) return 'site-paused';
  return 'active';
}

export function shieldStatusLabel(status: ShieldStatus): string {
  switch (status) {
    case 'global-paused':
      return 'Paused';
    case 'site-paused':
      return 'Paused here';
    default:
      return 'Active';
  }
}

export function shieldStatusDetail(status: ShieldStatus, site?: string | null): string {
  switch (status) {
    case 'global-paused':
      return 'Blocking is paused on every site. Turn it back on to resume filtering.';
    case 'site-paused':
      return `Blocking is paused on ${site || 'this site'}. Other sites keep filtering normally.`;
    default:
      return site
        ? `Ads and trackers are being blocked on ${site}.`
        : 'Ads and trackers are being blocked on this page.';
  }
}

/** The exception rule that allows a single domain. */
export function allowRuleFor(rawDomain: unknown): string | null {
  const domain = normalizeSite(rawDomain);
  return domain ? `@@||${domain}^` : null;
}

/** The blocking rule for a single domain. */
export function blockRuleFor(rawDomain: unknown): string | null {
  const domain = normalizeSite(rawDomain);
  return domain ? `||${domain}^` : null;
}

/** Distinct blocked domains for a tab report. */
export function countBlockedDomains(trackers: TrackerDetection[]): number {
  return new Set(trackers.map((t) => t.domain)).size;
}

export function filterTrackers(trackers: TrackerDetection[], query: string): TrackerDetection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return trackers;
  return trackers.filter((t) => t.domain.toLowerCase().includes(needle));
}

export type TrackerSortMode = 'count' | 'name';

export function sortTrackers(
  trackers: TrackerDetection[],
  mode: TrackerSortMode,
): TrackerDetection[] {
  const copy = [...trackers];
  if (mode === 'name') {
    copy.sort((a, b) => a.domain.localeCompare(b.domain));
  } else {
    copy.sort((a, b) => b.blockedCount - a.blockedCount || a.domain.localeCompare(b.domain));
  }
  return copy;
}

/** Compact counter text: 0 / 999 / 1.2k / 15k. */
export function formatBlockedCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const n = Math.floor(value);
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Action badge text: empty at zero, capped so the icon never gets clipped. */
export function badgeTextFor(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count > 99) return '99+';
  return String(Math.floor(count));
}

/** Human label for where a blocking rule came from. */
export function ruleSourceLabel(source: TrackerDetection['source']): string {
  return source === 'user' ? 'Your rule' : 'Blocklist';
}
