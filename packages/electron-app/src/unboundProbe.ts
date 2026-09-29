/**
 * Resolver queries for the Unbound reachability check.
 *
 * The check's whole claim rests on one answer — NXDOMAIN for a name that is in the drop-in — so the
 * query has to be typed narrowly enough that a timeout, a refusal and an NXDOMAIN are three
 * different outcomes. Node reports all three as a rejected lookup, and only the `code` separates
 * them; collapsing those into "failed" is how a dead resolver gets reported as a working blocklist.
 *
 * The DNS call itself is one function behind the `UnboundResolverQuery` type, so the classification
 * is exercised by tests with no socket and no resolver. Address parsing and the reference choice
 * live in `unboundAddress`, because they are pure and the renderer needs them — this module imports
 * `dns`, so anything reaching it from the UI would drag Node's resolver into the browser bundle.
 */

import { Resolver as DnsResolver } from 'dns/promises';
import type { UnboundAnswer, UnboundResolverProbe } from './unboundReachability.js';
import type { UnboundResolverTarget } from './unboundAddress.js';

export type { UnboundResolverTarget } from './unboundAddress.js';

export type UnboundResolverQuery = (
  domain: string,
  target: UnboundResolverTarget,
  timeoutMs: number,
) => Promise<UnboundAnswer>;

/**
 * Ask a specific resolver for a name's A records.
 *
 * `resolve4` rather than a raw query, because the interesting part is the RCODE: `always_nxdomain`
 * answers NXDOMAIN for every type, a live resolver answers a name that has no A record with
 * NOERROR/NODATA, and those two are `ENOTFOUND` and `ENODATA` to Node. One attempt only — a retry
 * on a dead resolver just makes the check take three times as long to say the same thing.
 */
export const queryUnboundResolver: UnboundResolverQuery = async (domain, target, timeoutMs) => {
  const resolver = new DnsResolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([`${target.host}:${target.port}`]);
  try {
    const addresses = await resolver.resolve4(domain);
    return addresses.length > 0 ? { state: 'resolved', addresses } : { state: 'nodata' };
  } catch (error) {
    return classifyLookupFailure(error);
  }
};

/** Reduce a rejected lookup to the state the verdict reads, keeping the code for the detail line. */
export function classifyLookupFailure(error: unknown): UnboundAnswer {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  const name = typeof (error as { name?: unknown })?.name === 'string' ? (error as { name: string }).name : '';
  const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : '';
  if (code === 'ENOTFOUND' || code === 'NXDOMAIN') return { state: 'nxdomain', detail: code };
  if (code === 'ENODATA' || code === 'ENOENT') return { state: 'nodata', detail: code };
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT' || code === 'ESERVFAIL' || name === 'TimeoutError') {
    return { state: 'timeout', detail: code || name };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EREFUSED') {
    return { state: 'refused', detail: code };
  }
  return { state: 'error', detail: code || message || name || 'unknown error' };
}

export interface UnboundProbeOptions {
  target: UnboundResolverTarget;
  canaryDomain: string;
  controlDomain: string;
  /** Where to confirm the canary exists. Omitted means the check reports an unconfirmed canary. */
  referenceTarget?: UnboundResolverTarget | null;
  query?: UnboundResolverQuery;
  timeoutMs?: number;
}

/**
 * Ask the resolvers about the canary, the control and the reference.
 *
 * All three go out together: they answer different parts of one question and none short-cuts
 * another, so serialising them would only add latency to a local check. `Promise.all` never rejects
 * here — `queryUnboundResolver` converts every failure into an answer state — so one dead query
 * cannot discard the others' results.
 */
export async function probeUnboundResolver(options: UnboundProbeOptions): Promise<UnboundResolverProbe> {
  const query = options.query ?? queryUnboundResolver;
  const timeoutMs = options.timeoutMs ?? 2500;
  const [canaryAnswer, controlAnswer, referenceAnswer] = await Promise.all([
    query(options.canaryDomain, options.target, timeoutMs),
    query(options.controlDomain, options.target, timeoutMs),
    options.referenceTarget
      ? query(options.canaryDomain, options.referenceTarget, timeoutMs)
      : Promise.resolve(null),
  ]);
  return {
    target: options.target.label,
    controlDomain: options.controlDomain,
    canary: { domain: options.canaryDomain, answer: canaryAnswer },
    control: { domain: options.controlDomain, answer: controlAnswer },
    reference:
      options.referenceTarget && referenceAnswer
        ? { target: options.referenceTarget.label, answer: referenceAnswer }
        : null,
  };
}
