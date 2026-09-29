/**
 * Resolver addresses, and which one the check should use.
 *
 * Split from `unboundProbe` on purpose: this module is pure string work with no `dns` import, and
 * the Deploy Hub's renderer needs it (to render the hints). Keeping the two together made the
 * renderer bundle resolve `dns/promises`, which fails the build — the browser has no such module,
 * and a bundle-time alias hiding it would only move the failure to the first call.
 */

export interface UnboundResolverTarget {
  host: string;
  port: number;
  /** `host:port`, for messages that should name what was actually queried. */
  label: string;
}

export const DEFAULT_UNBOUND_RESOLVER_PORT = 53;

/**
 * Where the check looks when no address is set.
 *
 * The usual deployment is one resolver host, and the hub is usually on it — so the conventional
 * address is a better default than refusing to check. It is still only a default: the verdict names
 * the address it queried, so a wrong guess is visible rather than silent.
 */
export const DEFAULT_UNBOUND_RESOLVER_ADDRESS = '127.0.0.1';

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Whether a host is this machine itself.
 *
 * Used to keep a deployment from being its own reference, and to keep the hint from suggesting an
 * address the user is already on. `::1` and `localhost` are the same resolver as `127.0.0.1`, so a
 * check that treats them as different would accept a second query to the same instance and call it
 * corroboration.
 */
export function isLoopbackResolvHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host ?? '');
  if (!normalized) return false;
  return normalized === '::1'
    || normalized === 'localhost'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '127.0.0.1'
    || /^127\./.test(normalized);
}

/**
 * Parse `host`, `host:port`, or a bare URL into something queryable.
 *
 * A user pasting `http://192.168.1.1/unbound` or `192.168.1.1:5335` should not have to be told to
 * strip it, so the scheme and path are tolerated. IPv6 needs its brackets kept, which is why the
 * host is re-wrapped from the parsed URL rather than hand-split on `:`.
 */
export function parseUnboundResolverAddress(
  raw: string | null | undefined,
  defaultPort = DEFAULT_UNBOUND_RESOLVER_PORT,
): { ok: true; target: UnboundResolverTarget } | { ok: false; message: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, message: 'No resolver address is set.' };

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split('/')[0];
  if (!authority) return { ok: false, message: `"${trimmed}" is not a resolvable address.` };

  let host = authority;
  let port = defaultPort;
  const bracketed = authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if (authority.split(':').length === 2) {
    const [name, rawPort] = authority.split(':');
    host = name;
    port = Number(rawPort);
  }
  if (!host) return { ok: false, message: `"${trimmed}" is not a resolvable address.` };
  // Whitespace never belongs in a host, and without this a pasted "192.168.1.1 53" or a stray space
  // becomes a query to a name that cannot exist — indistinguishable from an unreachable resolver.
  if (/\s/.test(host)) return { ok: false, message: `"${trimmed}" is not a resolvable address.` };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: `"${trimmed}" has no usable port.` };
  }

  return { ok: true, target: { host, port, label: `${host}:${port}` } };
}

export interface ResolvedUnboundTarget {
  target: UnboundResolverTarget;
  /** True when nothing was set and the conventional address was used. */
  usedDefault: boolean;
}

/**
 * The target a check will actually query.
 *
 * Only a *blank* value falls back. A typo must not: silently querying 127.0.0.1 for `192.168.1.`
 * would produce a confident verdict about a resolver the user never named, which is worse than the
 * error message.
 */
export function resolveUnboundResolver(
  raw: string | null | undefined,
  defaultPort = DEFAULT_UNBOUND_RESOLVER_PORT,
): { ok: true; resolved: ResolvedUnboundTarget } | { ok: false; message: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    const fallback = parseUnboundResolverAddress(DEFAULT_UNBOUND_RESOLVER_ADDRESS, defaultPort);
    if (!fallback.ok) return { ok: false, message: 'No resolver address is set.' };
    return { ok: true, resolved: { target: fallback.target, usedDefault: true } };
  }
  const parsed = parseUnboundResolverAddress(trimmed, defaultPort);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, resolved: { target: parsed.target, usedDefault: false } };
}

/** Where the reference answer comes from, and whether the user named it. */
export interface UnboundReferenceTarget {
  target: UnboundResolverTarget;
  source: 'explicit' | 'system';
}

/**
 * Pick the resolver that will confirm the canary exists.
 *
 * The tested resolver can never be its own reference, so an explicit choice that points at it is
 * refused rather than used — a circular answer would make any NXDOMAIN look confirmed. When nothing
 * is named, the machine's own configured servers are the next best thing: they are local (no name
 * leaves the network), and whatever they are, they are not the deployment under test *unless they
 * are*, which is exactly the case the equality check catches.
 */
export function pickReferenceTarget(
  tested: UnboundResolverTarget,
  explicit: string | null | undefined,
  systemServers: readonly string[] = [],
): { ok: true; reference: UnboundReferenceTarget } | { ok: false; message: string } {
  const sameAsTested = (entry: UnboundResolverTarget) => {
    if (entry.port !== tested.port) return false;
    if (normalizeHost(entry.host) === normalizeHost(tested.host)) return true;
    // `::1` and `127.0.0.1` are one resolver; treating them as two is how a deployment ends up as
    // its own reference.
    return isLoopbackResolvHost(entry.host) && isLoopbackResolvHost(tested.host);
  };

  const trimmed = (explicit ?? '').trim();
  if (trimmed) {
    const parsed = parseUnboundResolverAddress(trimmed);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (sameAsTested(parsed.target)) {
      return {
        ok: false,
        message: `The reference resolver is the resolver under test (${parsed.target.label}). A second query to the same instance cannot confirm anything.`,
      };
    }
    return { ok: true, reference: { target: parsed.target, source: 'explicit' } };
  }

  for (const server of systemServers) {
    const parsed = parseUnboundResolverAddress(server);
    if (!parsed.ok || sameAsTested(parsed.target)) continue;
    return { ok: true, reference: { target: parsed.target, source: 'system' } };
  }

  return {
    ok: false,
    message: 'No reference resolver is available — this machine resolves through the resolver under test.',
  };
}
