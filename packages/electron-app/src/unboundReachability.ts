/**
 * Unbound deployment reachability.
 *
 * The Deploy Hub could tell a user their Unbound recipe was correct; it could not tell them whether
 * anyone was following it. Three things have to be true for an Unbound deployment to actually be
 * blocking, and they fail independently:
 *
 *   1. **The hub is serving a usable drop-in.** A fetch of its own feed URL has to answer with
 *      `local-zone` statements — not a 404, and not an AdGuard export sitting under a `.conf` name
 *      because the format was never switched.
 *   2. **Something on the resolver host actually fetched it.** Unbound has no remote blocklist
 *      feature, so the scheduled `curl` in the recipe *is* the subscription. If nothing has
 *      requested the file since the hub started, no schedule is running.
 *   3. **The resolver reloaded it.** A drop-in that is fetched but never `include`d, or included but
 *      never reloaded, leaves the resolver answering blocked names normally — which looks exactly
 *      like "no blocking configured" from every other screen in the app.
 *
 * Only the third is observable from outside, so the check tests it directly: it picks a domain out
 * of the very file the resolver was told to load and asks the resolver for it. A name that is *in
 * the drop-in* and comes back blocked — NXDOMAIN, or NOERROR carrying an address that routes
 * nowhere — proves the drop-in is live, and a control name proves the answer is the resolver's
 * opinion rather than a dead server answering nothing. Unbound has two documented ways to block a
 * local zone and a deployment may legitimately use either, so both are read as blocking; see
 * `isSinkholedAnswer` for why that distinction is not cosmetic.
 *
 * Pure: no sockets, no clock, no store. Every function here is a function of its input, so the
 * classification is asserted in tests rather than inferred from a live resolver.
 */

import type { DeployRefreshReport } from './deployRefresh.js';
import { deployRefreshFailing, deployRefreshLastReportAt } from './deployRefresh.js';

/**
 * Addresses that mean *blocked*, not *answered*.
 *
 * `always_nxdomain` — what this project's formatter emits — answers NXDOMAIN, which is the shape
 * this check was built around. `redirect` + `local-data "…" A 0.0.0.0` — what Unbound's other
 * documented way of blocking a local zone, and what a deployment configured by hand almost
 * certainly uses — answers **NOERROR carrying an address that routes nowhere**. Both block; only
 * one of them looks like a failure.
 *
 * That asymmetry is why this list exists. A canary answered with `0.0.0.0` used to fall through
 * to `not-loaded`, and the pane's advice was "check the include: line" — for a deployment that was
 * blocking correctly and would go on blocking correctly after making no change at all. Every
 * address has to be a sinkhole address, so a resolver that answered one real address alongside
 * them is not read as blocked.
 */
const SINKHOLE_ADDRESSES = new Set(['0.0.0.0', '::', '::0', '127.0.0.1', '::1']);

/** True when the answer is a local-zone block rather than a real address. */
export function isSinkholedAnswer(answer: UnboundAnswer): boolean {
  if (answer.state !== 'resolved') return false;
  const addresses = answer.addresses ?? [];
  return addresses.length > 0 && addresses.every((address) => SINKHOLE_ADDRESSES.has(address.trim().toLowerCase()));
}

/** Header the reachability probe sends itself, so its own fetch never counts as evidence. */
export const REACHABILITY_PROBE_HEADER = 'x-blockingmachine-reachability';

/** The header a probe request must carry. One place, so the send and the check cannot drift. */
export function reachabilityProbeHeaders(): Record<string, string> {
  return { [REACHABILITY_PROBE_HEADER]: '1' };
}

/** The name the probe uses to prove the resolver still answers when the canary is NXDOMAIN. */
export const RESOLVER_CONTROL_DOMAIN = 'example.com';

/** One request for a feed file, as the hub's HTTP server saw it. */
export interface FeedServeEvent {
  /** ISO timestamp. */
  at: string;
  /** Request path, including any query the client appended. */
  path: string;
  /** Remote address as the socket reported it. */
  peer: string;
  userAgent?: string;
  status: number;
  bytes?: number;
}

/** What the hub saw when it fetched its own feed URL. */
export interface UnboundSelfFetch {
  ok: boolean;
  status?: number;
  error?: string;
  /** `local-zone` statements in the served body. */
  zones: number;
  /** Whether the served body declares the `server:` block Unbound needs. */
  hasServerBlock: boolean;
  /** A domain to test the resolver with, taken from the served body. */
  canaryDomain: string | null;
  /** True when only localhost answered, so the LAN address in the recipe was not reached. */
  viaLoopback?: boolean;
}

export type UnboundAnswerState =
  | 'resolved'
  | 'nodata'
  | 'nxdomain'
  | 'timeout'
  | 'refused'
  /**
   * The address is a name, and Node's resolver can only be pointed at an IP.
   *
   * Not `error`: nothing was asked and nothing failed. It is here because a router-hosted Unbound
   * behind a hostname is one of the two likeliest addresses to type, and reading that as a dead
   * resolver sends the user to check the resolver's health when the resolver was never queried.
   */
  | 'unqueryable'
  | 'error';

/** One resolver answer, reduced to what the verdict needs. */
export interface UnboundAnswer {
  state: UnboundAnswerState;
  detail?: string;
  addresses?: string[];
}

/** The answers a reachability check is built from. */
export interface UnboundResolverProbe {
  /** `host:port` the answers came from. */
  target: string;
  controlDomain: string;
  /** Asked about a domain in the drop-in. NXDOMAIN means the drop-in is loaded. */
  canary: { domain: string; answer: UnboundAnswer };
  /** Asked about a name that exists regardless of this deployment. */
  control: { domain: string; answer: UnboundAnswer };
  /**
   * The same canary question asked somewhere that is not this deployment.
   *
   * NXDOMAIN only proves sinkholing if the name exists to be sunk, and a resolver answering NXDOMAIN
   * for a name that was never registered looks identical to one running a blocklist. The control
   * query cannot tell those apart — it only rules out a resolver that refuses everything — so the
   * canary's existence is asked of a second resolver. Null when there is none to ask, which is
   * reported as an unconfirmed canary rather than quietly read as a pass.
   */
  reference: { target: string; answer: UnboundAnswer } | null;
}

export interface UnboundReachabilityInput {
  /** ISO time of this check. */
  checkedAt: string;
  feedUrl: string;
  feedFileName: string;
  /** Whether the hub's feed server is listening. */
  feedServerRunning: boolean;
  selfFetch: UnboundSelfFetch;
  /** Serves of the feed file recorded since the hub started, in any order. Excludes the probe. */
  serves: FeedServeEvent[];
  /** ISO time of the last successful fetch, remembered across launches. */
  lastFetchedAt?: string | null;
  /**
   * What the resolver's scheduled refresh has reported back, if the updated command is running.
   * An `ok` report is a successful fetch by definition — it had to get the file to say so — so it
   * folds into `fetchedAt`; a `fail` report is the fact the whole channel exists for: a fetch or
   * reload that broke while nobody was checking is named instead of absent.
   */
  refreshReport?: DeployRefreshReport | null;
  /** ISO time the export was last compiled, so a stale resolver copy can be named. */
  lastCompiledAt?: string | null;
  /** ISO time a check last proved the resolver had the drop-in. */
  lastConfirmedAt?: string | null;
  /** ISO time a `stale` regression was last announced, remembered so it is announced once. */
  staleAnnouncedAt?: string | null;
  probe?: UnboundResolverProbe | null;
  /** Why no probe was run, when that is the case. */
  probeSkipped?: string | null;
}

export type UnboundReachabilityState =
  | 'unverified'
  | 'live'
  | 'stale'
  /** The drop-in answered NXDOMAIN, but nothing confirmed the canary exists upstream. */
  | 'canary-unconfirmed'
  /** The canary does not resolve anywhere, so NXDOMAIN from the tested resolver proves nothing. */
  | 'canary-nonexistent'
  | 'not-loaded'
  /** The typed address is a name, so no query left the machine and no verdict is possible. */
  | 'resolver-unqueryable'
  | 'feed-offline'
  | 'feed-invalid'
  | 'resolver-unreachable'
  | 'no-canary'
  | 'inconclusive';

export interface UnboundReachabilityRow {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'off';
}

export interface UnboundReachability {
  state: UnboundReachabilityState;
  tone: 'ok' | 'warn' | 'off';
  headline: string;
  detail: string;
  /** What to do about it, when there is something to do. */
  nextStep?: string;
  rows: UnboundReachabilityRow[];
  checkedAt: string;
  feedUrl: string;
  canaryDomain?: string;
  /** ISO time of the newest fetch by a real client, from this check's serve log or the store. */
  fetchedAt?: string;
  /** ISO time the resolver was last proved to hold the drop-in, including this check. */
  lastConfirmedAt?: string;
  /**
   * ISO time of the compile that produced the file this check is about.
   *
   * Carried on the verdict rather than left to the row breakdown, because a snapshot keeps only the
   * verdict and something outside the check needs the same fact: the watch has to tell a `stale`
   * copy that is ten minutes behind a compile the resolver has not fetched yet from one that is
   * ten minutes behind a compile it never will.
   */
  compiledAt?: string;
  /**
   * ISO time a `stale` regression was last announced for this deployment.
   *
   * Owned by the watch rather than derived here, and carried on the verdict because the decision
   * to announce is a function of two consecutive snapshots. A copy that fell behind a compile five
   * minutes ago may be waiting for the resolver's next fetch; the announcement is held until it has
   * had a grace period, and this is what makes the held announcement happen *once* rather than never
   * — the finding is remembered from the tick it was first seen on, not only on the tick it crossed
   * back from `live`. A deployment that recovers clears it, so the next regression can speak.
   */
  staleAnnouncedAt?: string;
  /**
   * What the resolver's scheduled refresh has reported back, when the updated command is
   * running. Carried on the verdict — and so into the snapshot — because a `fail` report is the
   * one piece of evidence that can name an overnight fetch failure the reachability check
   * itself cannot see: the resolver still blocks from the copy it has, so `live` and
   * "the cron broke at 02:00" look identical without it.
   */
  refreshReport?: DeployRefreshReport;
}

/**
 * What the pane reads back between checks.
 *
 * The verdict without its row breakdown, kept whole rather than reduced to a state code so the pane
 * can print the same sentence the check printed. A snapshot that stored only the state would have
 * to re-derive the wording, and two places deriving it is how they drift.
 */
export type UnboundReachabilitySnapshot = Omit<UnboundReachability, 'rows'>;

/** Strip the row breakdown, leaving what is worth remembering. */
export function toReachabilitySnapshot(reachability: UnboundReachability): UnboundReachabilitySnapshot {
  const { rows: _rows, ...rest } = reachability;
  return rest;
}

/** The part of an HTTP request the log needs. Kept structural so tests need no server. */
export interface FeedServeRequest {
  headers: Record<string, string | string[] | undefined>;
  peer: string;
}

/**
 * Bounded memory, in two dimensions.
 *
 * A per-path cap is the one that matters: the hub serves several compiled files (a browser feed, a
 * DNS feed, threat feeds), and a browser extension polling `browser.txt` every minute would push the
 * resolver's single daily fetch of the drop-in out of a flat newest-200 window. The check would then
 * report "nothing has fetched it" for a deployment that fetched it an hour ago — a false alarm
 * caused by unrelated traffic. The total cap still keeps a scraped feed from growing the heap.
 */
export const FEED_SERVE_LOG_PER_PATH_LIMIT = 25;
export const FEED_SERVE_LOG_TOTAL_LIMIT = 400;

export interface FeedServeLog {
  /** Record a serve unless the reachability probe is the client. */
  record(request: FeedServeRequest, path: string, status: number, bytes?: number): void;
  /** What has been served, oldest first. */
  entries(): readonly FeedServeEvent[];
}

/**
 * The feed serve log, as a value rather than module-level state.
 *
 * The probe exclusion lives here because it is the difference between a check that works and one
 * that lies: the reachability check fetches the hub's own feed URL, so if its own request counted,
 * every check would find the file freshly fetched and the "is anything fetching this" question
 * would always answer yes. The probe carries a header instead of relying on the source address,
 * because a resolver on this same machine connects from loopback legitimately.
 */
export function createFeedServeLog(
  perPathLimit: number = FEED_SERVE_LOG_PER_PATH_LIMIT,
  totalLimit: number = FEED_SERVE_LOG_TOTAL_LIMIT,
  now: () => string = () => new Date().toISOString(),
): FeedServeLog {
  const events: FeedServeEvent[] = [];
  const key = (path: string) => basenameOf(path).toLowerCase();

  /** Drop the oldest entries until this path is under its own cap. */
  const trimPath = (pathKey: string) => {
    const mine = events.filter((event) => key(event.path) === pathKey);
    for (let i = 0; i < mine.length - perPathLimit; i += 1) {
      const index = events.indexOf(mine[i]);
      if (index >= 0) events.splice(index, 1);
    }
  };

  return {
    record(request, path, status, bytes) {
      if (request.headers?.[REACHABILITY_PROBE_HEADER]) return;
      events.push({
        at: now(),
        path,
        peer: request.peer || 'unknown',
        userAgent: typeof request.headers?.['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        status,
        bytes,
      });
      trimPath(key(path));
      if (events.length > totalLimit) events.splice(0, events.length - totalLimit);
    },
    entries() {
      return events;
    },
  };
}

export interface FeedServeSummary {
  /** Serves of this file with a 2xx status. */
  count: number;
  lastAt?: string;
  lastPeer?: string;
  lastUserAgent?: string;
  /** Distinct peers that have fetched it. */
  peers: number;
}

/**
 * Serves of the feed file, newest last.
 *
 * Compared by basename, because the recipe tells Unbound to fetch `/<file>` while a browser preview
 * or a query string would arrive as something else. Only 2xx responses count: a 404 is the hub
 * failing to answer, not a resolver fetching.
 */
export function summarizeFeedServes(events: FeedServeEvent[], feedFileName: string): FeedServeSummary {
  const wanted = feedFileName.trim().toLowerCase();
  const matches = (events ?? [])
    .filter((event) => event.status >= 200 && event.status < 300)
    .filter((event) => basenameOf(event.path).toLowerCase() === wanted)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (matches.length === 0) return { count: 0, peers: 0 };
  const last = matches[matches.length - 1];
  return {
    count: matches.length,
    lastAt: last.at,
    lastPeer: last.peer,
    lastUserAgent: last.userAgent,
    peers: new Set(matches.map((event) => event.peer)).size,
  };
}

function basenameOf(rawPath: string): string {
  const withoutQuery = (rawPath || '').split(/[?#]/)[0];
  const parts = withoutQuery.split('/');
  return parts[parts.length - 1] || '';
}

export interface UnboundDropIn {
  zones: number;
  hasServerBlock: boolean;
  /** Comments recording exceptions the format cannot express as allow rules. */
  exceptionNotes: number;
  domains: string[];
}

/** Read a served body as a Unbound drop-in, so a wrong format is caught before it ships. */
export function parseUnboundDropIn(text: string): UnboundDropIn {
  const domains: string[] = [];
  let zones = 0;
  let hasServerBlock = false;
  let exceptionNotes = 0;

  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'server:') hasServerBlock = true;
    if (line.startsWith('#') && /exception/i.test(line)) exceptionNotes += 1;
    if (line.startsWith('#') || line.startsWith('!')) continue;
    const zone = line.match(/^local-zone:\s*"([^"]+)"/i) || line.match(/^local-zone:\s*(\S+)/i);
    if (!zone) continue;
    zones += 1;
    const domain = zone[1].trim().toLowerCase().replace(/\.$/, '');
    if (domain) domains.push(domain);
  }

  return { zones, hasServerBlock, exceptionNotes, domains };
}

/**
 * The domain to test the resolver with, chosen from the drop-in itself.
 *
 * Shortest wins — fewest labels, then shortest name, then alphabetical for determinism. The reason
 * is the test's validity: NXDOMAIN only proves sinkholing if the name would otherwise resolve, and
 * a two-label registrable domain is far more likely to exist upstream than a deep tracker host that
 * may never have had an A record. The alphabetical tiebreak keeps the choice stable across runs, so
 * a passing check does not become an unexplained failure because the list reordered.
 */
export function pickCanaryDomain(domains: string[]): string | null {
  const candidates = (domains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/\.$/, ''))
    .filter((domain) => {
      if (!domain || domain.includes('*') || domain.includes('_') || domain.startsWith('.')) return false;
      if (/^\d+(\.\d+){3}$/.test(domain)) return false;
      const labels = domain.split('.');
      return labels.length >= 2 && labels.length <= 3 && labels.every((label) => label.length > 0);
    });
  if (candidates.length === 0) return null;
  const rank = (domain: string) => {
    const labels = domain.split('.');
    return [labels.length, domain.length] as const;
  };
  return candidates.slice().sort((a, b) => {
    const [aLabels, aLength] = rank(a);
    const [bLabels, bLength] = rank(b);
    if (aLabels !== bLabels) return aLabels - bLabels;
    if (aLength !== bLength) return aLength - bLength;
    return a.localeCompare(b);
  })[0];
}

/** "just now", "4m ago", "3h ago", "6d ago" — locale-independent, so it is safe to assert. */
export function formatUnboundAge(atIso: string | null | undefined, nowIso: string): string {
  if (!atIso) return 'never';
  const at = Date.parse(atIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The verdict for one check.
 *
 * Ordered by what the user would have to fix first: a feed that is not answering explains
 * everything downstream, so it is reported ahead of a resolver that cannot see it. The one case
 * worth reading twice is `stale` — the resolver *is* blocking, with a copy older than the last
 * compile, which is the difference between "deployed" and "staying current".
 */
export function classifyUnboundReachability(input: UnboundReachabilityInput): UnboundReachability {
  const served = summarizeFeedServes(input.serves, input.feedFileName);
  // An `ok` report is a successful fetch by definition — it had to get the file to say so — so
  // it counts as evidence the way an observed serve does.
  const fetchedAt = newestIso(served.lastAt, input.lastFetchedAt ?? undefined, input.refreshReport?.lastOkAt);
  const canaryDomain = input.selfFetch.canaryDomain ?? input.probe?.canary.domain ?? undefined;
  const base: Omit<UnboundReachability, 'state' | 'tone' | 'headline' | 'detail'> = {
    checkedAt: input.checkedAt,
    feedUrl: input.feedUrl,
    canaryDomain,
    fetchedAt,
    lastConfirmedAt: input.lastConfirmedAt ?? undefined,
    compiledAt: input.lastCompiledAt ?? undefined,
    staleAnnouncedAt: input.staleAnnouncedAt ?? undefined,
    refreshReport: input.refreshReport ?? undefined,
    rows: [],
  };

  const feedRow: UnboundReachabilityRow = {
    label: 'Feed address',
    value: input.feedUrl,
    tone: input.feedServerRunning ? 'ok' : 'off',
  };
  const serveRow: UnboundReachabilityRow = {
    label: 'Drop-in served',
    value: input.selfFetch.ok
      ? `${input.selfFetch.zones.toLocaleString()} local-zone ${input.selfFetch.zones === 1 ? 'statement' : 'statements'}${input.selfFetch.hasServerBlock ? '' : ' · no server: block'}${input.selfFetch.viaLoopback ? ' · answered on localhost only' : ''}`
      : (input.selfFetch.error ?? `HTTP ${input.selfFetch.status ?? '?'}`),
    tone: input.selfFetch.ok && input.selfFetch.zones > 0 ? 'ok' : 'off',
  };
  const fetchRow: UnboundReachabilityRow = {
    label: 'Fetched by the resolver',
    value: served.count > 0
      ? `${formatUnboundAge(served.lastAt, input.checkedAt)} from ${served.lastPeer ?? 'unknown peer'}`
      : fetchedAt
        ? `not since the hub started · last known ${formatUnboundAge(fetchedAt, input.checkedAt)}`
        : 'never',
    tone: served.count > 0 ? 'ok' : 'warn',
  };
  // The resolver's cron reports its own result, so a fetch or reload that failed while nobody
  // was checking is a named fact — "reported failed 02:14" — rather than the absence the rest
  // of this card has to read around. A failure older than the newest success is history: the
  // next scheduled run already healed it.
  const refreshRow: UnboundReachabilityRow = (() => {
    const report = input.refreshReport;
    if (deployRefreshFailing(report, fetchedAt)) {
      return {
        label: 'Scheduled refresh',
        value: `reported failed ${formatUnboundAge(report!.lastFailAt, input.checkedAt)}${report!.lastFailDetail ? ` — ${report!.lastFailDetail}` : ''}`,
        tone: 'warn',
      };
    }
    if (report?.lastOkAt || report?.lastFailAt) {
      return {
        label: 'Scheduled refresh',
        value: `last reported ${formatUnboundAge(deployRefreshLastReportAt(report), input.checkedAt)}`,
        tone: 'ok',
      };
    }
    return {
      label: 'Scheduled refresh',
      value: 'no reports — the refreshed command reports back when it runs',
      tone: 'off',
    };
  })();

  if (!input.feedServerRunning) {
    return finish(base, {
      state: 'feed-offline',
      tone: 'off',
      headline: 'The feed server is not running',
      detail: 'The address in the recipe answers nothing, so no scheduled fetch can succeed.',
      nextStep: 'Start the feed server above and enable Auto-start on launch.',
      rows: [feedRow, serveRow, refreshRow],
    });
  }

  if (!input.selfFetch.ok) {
    return finish(base, {
      state: 'feed-offline',
      tone: 'off',
      headline: 'The feed address did not answer',
      detail: `Fetching ${input.feedUrl} failed (${input.selfFetch.error ?? `HTTP ${input.selfFetch.status ?? '?'}`}), so the resolver has nothing to load.`,
      nextStep: 'Check that the feed server is listening on this address and that the port is reachable from the resolver host.',
      rows: [feedRow, serveRow, refreshRow],
    });
  }

  if (input.selfFetch.zones === 0) {
    return finish(base, {
      state: 'feed-invalid',
      tone: 'off',
      headline: 'The feed answered, but it is not a Unbound drop-in',
      detail: `The file served at ${input.feedUrl} contains no local-zone statements. Unbound will load it without error and block nothing.`,
      nextStep: 'Set Format to Unbound so the hub writes local-zone rules instead of the current format.',
      rows: [feedRow, serveRow, fetchRow, refreshRow],
    });
  }

  if (!canaryDomain) {
    return finish(base, {
      state: 'no-canary',
      tone: 'warn',
      headline: 'No domain in the drop-in can be used as a test target',
      detail: 'Every local-zone it serves is a wildcard, an underscore host, or a bare IP, so there is nothing a resolver answer could prove.',
      nextStep: 'Add at least one ordinary domain to the compiled set, then check again.',
      rows: [feedRow, serveRow, fetchRow, refreshRow],
    });
  }

  const probe = input.probe;
  if (!probe) {
    return finish(base, {
      state: 'unverified',
      tone: 'warn',
      headline: 'The file is served, but no resolver has been queried',
      detail: input.probeSkipped ?? 'Set the resolver address and run the check to confirm the drop-in is loaded.',
      nextStep: 'Enter the address of the Unbound instance and check again.',
      rows: [feedRow, serveRow, fetchRow, refreshRow],
    });
  }

  const resolverRow: UnboundReachabilityRow = {
    label: 'Resolver',
    value: probe.target,
    tone: 'ok',
  };
  const canaryRow: UnboundReachabilityRow = {
    label: `Canary · ${probe.canary.domain}`,
    value: describeAnswer(probe.canary.answer),
    tone: 'warn',
  };
  const confirmedRow: UnboundReachabilityRow = {
    label: 'Last confirmed live',
    value: formatUnboundAge(input.lastConfirmedAt, input.checkedAt),
    tone: input.lastConfirmedAt ? 'ok' : 'warn',
  };

  // Ahead of the control and canary branches: an address `dns` cannot be pointed at means no query
  // left the machine, so nothing about either of them is knowable and every verdict below would be
  // reading a silence the check caused itself.
  if (probe.canary.answer.state === 'unqueryable' || probe.control.answer.state === 'unqueryable') {
    return finish(base, {
      state: 'resolver-unqueryable',
      tone: 'off',
      headline: 'The resolver address is a name, so nothing was queried',
      detail: `${probe.target} is not an IP address, and Node's resolver can only be pointed at one — so no query left this machine and the deployment has not been checked. Unbound behind a hostname is common; its address is what \`getent hosts\` or the router's own page reports.`,
      nextStep: 'Enter the resolver’s IP address (with ‘:port’ if it is not 53), or resolve the name first and paste the address it gives.',
      rows: [feedRow, serveRow, fetchRow, refreshRow, resolverRow, { ...canaryRow, tone: 'off' }],
    });
  }

  // The control query decides whether *any* answer from this resolver is evidence. Checked before
  // the canary so a resolver that sinkholes everything cannot be read as a working drop-in: it
  // answers NXDOMAIN for the canary too, and that is the one shape of "success" that must not pass.
  // `isSinkholedAnswer` is included because a resolver whose default policy is `local-zone: "."
  // redirect` answers the control the same way it answers the canary, and reading that as a pass
  // would be the same failure in a different syntax.
  if (probe.control.answer.state === 'nxdomain' || isSinkholedAnswer(probe.control.answer)) {
    return finish(base, {
      state: 'inconclusive',
      tone: 'warn',
      headline: 'The resolver refuses names that should resolve',
      detail: `It answered ${describeAnswer(probe.control.answer)} for ${probe.control.domain}, which has nothing to do with this deployment, so ${describeAnswer(probe.control.answer)} for ${probe.canary.domain} would not prove the drop-in is loaded.`,
      nextStep: 'Point the check at the resolver that serves your clients, or confirm this instance is not configured to refuse everything.',
      rows: [feedRow, serveRow, fetchRow, refreshRow, resolverRow, { ...canaryRow, tone: 'warn' }],
    });
  }

  if (probe.control.answer.state !== 'resolved') {
    return finish(base, {
      state: 'resolver-unreachable',
      tone: 'off',
      headline: 'The resolver did not answer the control query',
      detail: `${probe.target} could not resolve ${probe.control.domain} (${describeAnswer(probe.control.answer)}), so nothing it said about the canary would mean anything. The file is being served at least.`,
      nextStep: 'Check the resolver address and port. Unbound answers on port 53 by default, and a router-hosted resolver needs its LAN address, not 127.0.0.1.',
      rows: [feedRow, serveRow, fetchRow, refreshRow, { ...resolverRow, tone: 'off' }],
    });
  }

  const canaryAnswer = probe.canary.answer;
  const canaryBlocked = canaryAnswer.state === 'nxdomain' || isSinkholedAnswer(canaryAnswer);
  if (canaryBlocked) {
    // A block answer from the resolver under test is only evidence if the name exists somewhere.
    // The reference answer is what separates "this resolver is blocking it" from "this name was
    // never registered" — two identical-looking answers with opposite meanings, and reading the
    // second as a pass is the one failure mode that leaves a user believing they are protected.
    const blockingAnswer = describeAnswer(canaryAnswer);
    const reference = probe.reference;
    if (!reference) {
      return finish(base, {
        state: 'canary-unconfirmed',
        tone: 'warn',
        headline: 'The drop-in answered, but the canary is unconfirmed',
        detail: `${probe.target} answered ${blockingAnswer} for ${probe.canary.domain}, which is what a drop-in asks of it — but nothing confirmed that name exists upstream, so the same answer would come back for a domain that never existed.`,
        nextStep: 'Set a reference resolver to check the canary against, or pick a domain in the compiled set that you know resolves normally.',
        rows: [
          feedRow,
          serveRow,
          fetchRow, refreshRow,
          resolverRow,
          { ...canaryRow, value: `${blockingAnswer} — but the name is unconfirmed`, tone: 'warn' },
        ],
      });
    }

    const referenceRow: UnboundReachabilityRow = {
      label: 'Canary exists upstream',
      value: `${describeAnswer(reference.answer)} on ${reference.target}`,
      tone: 'warn',
    };

    if (reference.answer.state === 'nxdomain' || reference.answer.state === 'nodata') {
      return finish(base, {
        state: 'canary-nonexistent',
        tone: 'warn',
        headline: 'The test domain does not resolve anywhere',
        detail: `${reference.target} also answers ${describeAnswer(reference.answer)} for ${probe.canary.domain}, so the tested resolver returning NXDOMAIN proves nothing — the name may never have resolved. The drop-in may well be loaded; this check cannot tell.`,
        nextStep: 'Add a domain you know resolves to the compiled set, then check again — a canary that exists upstream is what makes the NXDOMAIN meaningful.',
        rows: [
          feedRow,
          serveRow,
          fetchRow, refreshRow,
          resolverRow,
          { ...canaryRow, value: 'NXDOMAIN — not evidence', tone: 'warn' },
          referenceRow,
        ],
      });
    }

    if (reference.answer.state !== 'resolved') {
      return finish(base, {
        state: 'canary-unconfirmed',
        tone: 'warn',
        headline: 'The drop-in answered, but the canary is unconfirmed',
        detail: `${probe.target} answered NXDOMAIN for ${probe.canary.domain}, but ${reference.target} could not confirm the name exists upstream (${describeAnswer(reference.answer)}), so the answer cannot be attributed to the drop-in.`,
        nextStep: 'Check that the reference resolver is reachable and is not the resolver under test.',
        rows: [
          feedRow,
          serveRow,
          fetchRow, refreshRow,
          resolverRow,
          { ...canaryRow, value: 'NXDOMAIN — but the name is unconfirmed', tone: 'warn' },
          referenceRow,
        ],
      });
    }

    const stale = isBehind(fetchedAt, input.lastCompiledAt);
    if (stale) {
      return finish(base, {
        state: 'stale',
        tone: 'warn',
        headline: 'Blocking is live, but the resolver is running an older copy',
        detail: `${probe.target} answers ${blockingAnswer} for ${probe.canary.domain}, so the drop-in is loaded. Its copy is from ${formatUnboundAge(fetchedAt, input.checkedAt)}, which is before the last compile (${formatUnboundAge(input.lastCompiledAt, input.checkedAt)}).`,
        nextStep: 'The scheduled refresh is too infrequent or not running: re-run the refresh command, and check the cron entry on the resolver host.',
        rows: [
          feedRow,
          serveRow,
          fetchRow, refreshRow,
          resolverRow,
          { ...canaryRow, value: `${blockingAnswer} — the drop-in is loaded`, tone: 'ok' },
          { ...referenceRow, tone: 'ok' },
          { label: 'Copy age', value: `${formatUnboundAge(fetchedAt, input.checkedAt)} · compile is newer`, tone: 'warn' },
        ],
      });
    }
    return finish(base, {
      state: 'live',
      tone: 'ok',
      headline: 'The drop-in is loaded and the resolver is blocking',
      detail: `${probe.target} answers ${blockingAnswer} for ${probe.canary.domain}, a domain that is in the file it is serving and still resolves on ${reference.target}, while ${probe.control.domain} resolves here.`,
      rows: [
        feedRow,
        serveRow,
        fetchRow, refreshRow,
        resolverRow,
        { ...canaryRow, value: `${blockingAnswer} — the drop-in is loaded`, tone: 'ok' },
        { ...referenceRow, tone: 'ok' },
        { ...confirmedRow, value: 'just now · confirmed by this check', tone: 'ok' },
      ],
    });
  }

  if (canaryAnswer.state === 'resolved' || canaryAnswer.state === 'nodata') {
    return finish(base, {
      state: 'not-loaded',
      tone: 'warn',
      headline: 'The resolver is not using the drop-in',
      detail: `It answered ${describeAnswer(canaryAnswer)} for ${probe.canary.domain}, which the file it was told to load blocks. The file is served correctly${fetchedAt ? ` and was last fetched ${formatUnboundAge(fetchedAt, input.checkedAt)}` : ''}, so the gap is the include or the reload.`,
      nextStep: 'Confirm the include: line is in unbound.conf and that a reload has run since the last fetch — the copy-pasteable commands above do both.',
      rows: [feedRow, serveRow, fetchRow, refreshRow, resolverRow, canaryRow, confirmedRow],
    });
  }

  return finish(base, {
    state: 'resolver-unreachable',
    tone: 'off',
    headline: 'The resolver did not answer the canary query',
    detail: `${probe.canary.domain} against ${probe.target}: ${describeAnswer(canaryAnswer)}.`,
    nextStep: 'Check the resolver address and port before reading anything into the drop-in.',
    rows: [feedRow, serveRow, fetchRow, refreshRow, resolverRow, { ...canaryRow, tone: 'off' }],
  });
}

/** The newest of two optional ISO timestamps. */
function newestIso(...stamps: Array<string | null | undefined>): string | undefined {
  const valid = stamps.filter((stamp): stamp is string => Boolean(stamp) && Number.isFinite(Date.parse(stamp as string)));
  if (valid.length === 0) return undefined;
  return valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/**
 * True only when both times are known and the fetch predates the compile.
 *
 * Unknown fetch time means the copy cannot be dated, and staleness is not claimed on a guess — an
 * unverifiable warning would be worse than none.
 */
function isBehind(fetchedAt: string | undefined, compiledAt: string | null | undefined): boolean {
  if (!fetchedAt || !compiledAt) return false;
  const fetched = Date.parse(fetchedAt);
  const compiled = Date.parse(compiledAt);
  if (!Number.isFinite(fetched) || !Number.isFinite(compiled)) return false;
  return fetched < compiled;
}

function describeAnswer(answer: UnboundAnswer): string {
  switch (answer.state) {
    case 'resolved':
      // An answer that routes nowhere reads as "resolved" to every DNS client, which is precisely
      // why the verdict branches on it separately rather than on the state.
      if (isSinkholedAnswer(answer)) return `NOERROR with ${answer.addresses?.[0]} (blocked)`;
      return answer.addresses?.length ? `resolves to ${answer.addresses[0]}` : 'resolves';
    case 'nodata':
      return 'answers NOERROR with no records';
    case 'nxdomain':
      return 'NXDOMAIN';
    case 'timeout':
      return 'no answer before the timeout';
    case 'refused':
      return 'query refused';
    case 'unqueryable':
      return 'is a name, which cannot be queried directly';
    default:
      return answer.detail ? `failed (${answer.detail})` : 'failed';
  }
}

function finish(
  base: Omit<UnboundReachability, 'state' | 'tone' | 'headline' | 'detail'>,
  verdict: Pick<UnboundReachability, 'state' | 'tone' | 'headline' | 'detail' | 'rows'> &
    Partial<Pick<UnboundReachability, 'nextStep'>>,
): UnboundReachability {
  // A check that sees the drop-in loaded is itself the confirmation, so the timestamp advances
  // here rather than at the call site — otherwise every caller has to remember to do it, and one
  // that forgets silently stops reporting the last successful refresh.
  const confirmed =
    verdict.state === 'live' || verdict.state === 'stale' ? base.checkedAt : base.lastConfirmedAt;
  // A deployment that is current again has nothing left to announce, so the record of the last
  // `stale` announcement goes with it. Without this a deployment that went stale, recovered and went
  // stale again a month later would stay silent for ever, because its own past would look like a
  // finding already spoken about.
  const staleAnnouncedAt = verdict.state === 'live' ? undefined : base.staleAnnouncedAt;
  return { ...base, ...verdict, lastConfirmedAt: confirmed, staleAnnouncedAt };
}
