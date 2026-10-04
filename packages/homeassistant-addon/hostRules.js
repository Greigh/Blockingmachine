/**
 * Shared host extraction for the add-on's per-client feeds.
 *
 * The Unbound and Shadowrocket feeds are rendered from the same DNS feed, and each is only worth
 * anything if the two agree about *which hosts are blocked*. If they parse the same line
 * differently, a domain sinkholed in the resolver is still reachable through a proxy client that
 * read the other feed — a failure that looks like "the phone still shows ads" and is very hard to
 * trace back to a parser. So the rule-to-host step lives here once, and each feed decides what to
 * do with an allow rule rather than re-deciding what a host is.
 *
 * Deliberately dependency-free: the add-on ships as a plain Node.js image and installs nothing.
 */

/** A hostname with at least one dot, lower-case, no wildcards. */
const DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Directives that express something a browser-side list wants, never a DNS host. */
const SKIP_HINTS = ['$dnsrewrite', '$dnstype', '$client', '$ctag', '.arpa'];

/**
 * Canonicalises a host, or null when it cannot be blocked.
 *
 * `localhost`, `.local` and `.arpa` are refused for the same reason the app refuses them as block
 * targets: sinkholing them breaks local name resolution rather than blocking anything.
 */
export function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!host || host.length > 253 || host.includes('*')) return null;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.arpa')) return null;
  return DOMAIN_REGEX.test(host) ? host : null;
}

/**
 * The host one feed line is about, and whether the line allows it rather than blocking it.
 *
 * Returns null for anything that is not a block or an exception. The feed is documented as already
 * DNS-safe, but it can still arrive in any of the shapes the upstream lists use — ABP, hosts,
 * dnsmasq — because a user is free to publish their own file into the add-on's data directory.
 *
 * Cosmetic rules, comments, header fragments and script/CSS injection are dropped rather than
 * translated: they act on a document, not on a name, and a feed that cannot express them has no
 * equivalent line to emit.
 *
 * Callers decide what an allow means. The Unbound drop-in drops them, because `local-zone` can only
 * sinkhole and quietly emitting an exception as a block would invert the user's intent; Shadowrocket
 * keeps them as `DIRECT`, because its rule set *can* express an allow and the ordering makes it work.
 */
export function hostFromRule(rule) {
  if (typeof rule !== 'string') return null;
  let value = rule.trim();
  if (!value) return null;
  if (value.startsWith('!') || value.startsWith('[') || value.startsWith('#')) return null;
  if (value.includes('##') || value.includes('#@#') || value.includes('#?#')) return null;
  if (value.includes('$$') || value.includes('+js(')) return null;
  if (SKIP_HINTS.some((hint) => value.includes(hint))) return null;

  const allowed = value.startsWith('@@');
  if (allowed) value = value.slice(2).trim();
  if (!value) return null;

  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)\b/i.test(value)) {
    return null;
  }

  // dnsmasq / Pi-hole forms: address=/host/0.0.0.0 and server=/host/#
  const dnsmasq = /^(?:address|server)=\/([^/]+)\//i.exec(value);
  if (dnsmasq) {
    const host = normalizeHost(dnsmasq[1]);
    return host ? { host, allowed } : null;
  }

  value = value
    .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, '') // hosts entry
    .replace(/\$.*$/, '') // ABP modifiers
    .replace(/^\|\|/, '') // ABP domain anchor
    .replace(/[\^|/].*$/, '') // terminator, path, or trailing anchor
    .replace(/\.+$/, '');

  const host = normalizeHost(value);
  return host ? { host, allowed } : null;
}
