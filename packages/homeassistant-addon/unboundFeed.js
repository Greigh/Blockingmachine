/**
 * Unbound feed generation for the Home Assistant add-on.
 *
 * Unbound cannot subscribe to an ABP or hosts list the way AdGuard Home and Pi-hole can: it wants
 * `local-zone` statements, read from a drop-in file that `unbound.conf` includes. This module turns
 * the add-on's DNS feed into exactly that.
 *
 * Deliberately dependency-free — the add-on ships as a plain Node.js image and installs nothing.
 *
 * The rule-to-host step lives in `hostRules.js`, shared with the Shadowrocket feed. That sharing is
 * the point: the two feeds are rendered from the same source, and a host one of them fails to parse
 * is a host that is sinkholed in the resolver but reachable through the phone.
 */

import { hostFromRule, normalizeHost } from './hostRules.js';

/** The Unbound statement that sinkholes one host. Matches the desktop exporter's formatting. */
function zoneLine(host, action = 'always_nxdomain') {
  return `  local-zone: "${host}" ${action}`;
}

/**
 * Extracts the blocked host from one line of the DNS feed, or null when the line is not a block.
 *
 * The DNS feed is documented as already DNS-safe, but it can still arrive in any of the shapes the
 * upstream lists use — ABP, hosts, dnsmasq, or Unbound itself — because a user is free to publish
 * their own file into the add-on's data directory.
 *
 * Exceptions are dropped rather than translated: a `local-zone` drop-in can only sinkhole, so an
 * allow rule has no equivalent here and quietly emitting one as a block would invert the user's
 * intent. The shared parser reports the allow separately for exactly this reason, so the decision is
 * visible here rather than buried in the parser.
 */
export function unboundZoneFromRule(rule) {
  if (typeof rule !== 'string') return null;
  const value = rule.trim();
  if (!value) return null;

  // Already-Unbound rules pass through, keeping whatever action they declared. Checked before the
  // shared parser because that one would reject the line outright rather than preserve the action.
  const localZone = /^local-zone:\s*"([^"]+)"\s+(\S+)\s*$/i.exec(value);
  if (localZone) {
    const host = normalizeHost(localZone[1]);
    return host ? zoneLine(host, localZone[2]) : null;
  }
  const localData = /^local-data:\s*"([^\s"]+)\s/i.exec(value);
  if (localData) {
    const host = normalizeHost(localData[1]);
    return host ? zoneLine(host) : null;
  }

  const parsed = hostFromRule(value);
  if (!parsed || parsed.allowed) return null;
  return zoneLine(parsed.host);
}

/**
 * Converts a whole feed into sorted, de-duplicated Unbound zone lines.
 *
 * De-duplication happens on the rendered line, so `||ads.example^` and `0.0.0.0 ads.example` — the
 * same block written two ways — collapse into one statement instead of a file Unbound parses twice.
 */
export function rulesToUnboundZones(rules) {
  const seen = new Set();
  const zones = [];

  for (const rule of Array.isArray(rules) ? rules : []) {
    const zone = unboundZoneFromRule(rule);
    if (!zone) continue;
    const key = zone.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push(zone);
  }

  return zones.sort();
}

/**
 * Renders the drop-in file the Unbound feed serves.
 *
 * A header is safe here because Unbound treats `#` lines as comments, and it tells whoever opens
 * the file where the rules came from and when they were generated.
 */
export function renderUnboundFeed(rules, { generatedAt = new Date().toISOString() } = {}) {
  const zones = rulesToUnboundZones(rules);
  const header = [
    '# Blockingmachine — Unbound local-zone feed',
    `# Generated: ${generatedAt}`,
    `# Zones: ${zones.length}`,
    '# Include this file from unbound.conf; do not edit by hand, it is regenerated.',
  ];
  return `${[...header, ...zones].join('\n')}\n`;
}
