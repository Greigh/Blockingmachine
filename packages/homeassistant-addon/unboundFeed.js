/**
 * Unbound feed generation for the Home Assistant add-on.
 *
 * Unbound cannot subscribe to an ABP or hosts list the way AdGuard Home and Pi-hole can: it wants
 * `local-zone` statements, read from a drop-in file that `unbound.conf` includes. This module turns
 * the add-on's DNS feed into exactly that.
 *
 * Deliberately dependency-free — the add-on ships as a plain Node.js image and installs nothing.
 */

/** A hostname with at least one dot, lower-case, no wildcards. */
const DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Directives that express something a browser-side list wants, never a DNS zone. */
const SKIP_HINTS = ['$dnsrewrite', '$dnstype', '$client', '$ctag', '.arpa'];

/**
 * Canonicalises a host, or null when it cannot be a `local-zone` name.
 *
 * `localhost`, `.local` and `.arpa` are refused for the same reason the app refuses them as block
 * targets: zone-ing them breaks local name resolution rather than blocking anything.
 */
function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!host || host.length > 253 || host.includes('*')) return null;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.arpa')) return null;
  return DOMAIN_REGEX.test(host) ? host : null;
}

/** The Unbound statement that sinkholes one host. Matches the desktop exporter's formatting. */
function zoneLine(host, action = 'always_nxdomain') {
  return `  local-zone: "${host}" ${action}`;
}

/**
 * Extracts the blocked host from one line of the DNS feed, or null when the line is not a block.
 *
 * The DNS feed is documented as already DNS-safe, but it can still arrive in any of the shapes the
 * upstream lists use — ABP, hosts, dnsmasq, or Unbound itself — because a user is free to publish
 * their own file into the add-on's data directory. Exceptions are dropped rather than translated:
 * a `local-zone` drop-in can only sinkhole, so an allow rule has no equivalent here and quietly
 * emitting one as a block would invert the user's intent.
 */
export function unboundZoneFromRule(rule) {
  if (typeof rule !== 'string') return null;
  let value = rule.trim();
  if (!value) return null;
  if (value.startsWith('!') || value.startsWith('[') || value.startsWith('#')) return null;
  if (value.includes('##') || value.includes('#@#') || value.includes('#?#')) return null;
  if (value.includes('$$') || value.includes('+js(')) return null;
  if (SKIP_HINTS.some((hint) => value.includes(hint))) return null;
  if (value.startsWith('@@')) return null;
  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)\b/i.test(value)) {
    return null;
  }

  // Already-Unbound rules pass through, keeping whatever action they declared.
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

  // dnsmasq / Pi-hole forms: address=/host/0.0.0.0 and server=/host/#
  const dnsmasq = /^(?:address|server)=\/([^/]+)\//i.exec(value);
  if (dnsmasq) {
    const host = normalizeHost(dnsmasq[1]);
    return host ? zoneLine(host) : null;
  }

  value = value
    .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, '') // hosts entry
    .replace(/\$.*$/, '') // ABP modifiers
    .replace(/^\|\|/, '') // ABP domain anchor
    .replace(/[\^|/].*$/, '') // terminator, path, or trailing anchor
    .replace(/\.+$/, '');

  const host = normalizeHost(value);
  return host ? zoneLine(host) : null;
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
