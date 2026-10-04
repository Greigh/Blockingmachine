/**
 * The scheduled-refresh report channel.
 *
 * The fetch a resolver's cron runs is the only evidence that the scheduled part of a deployment
 * is alive, and until now it was evidence the hub could only overhear while running: a fetch that
 * failed at 02:00 — a compile whose URL 404'd, a reload that did not take — was invisible forever
 * unless the next manual check happened to catch the staleness. The flag this closes calls the
 * shape plainly: have the refresh command *report* its result somewhere the hub reads later, so
 * an overnight failure is a fact rather than an absence.
 *
 * Two things the shape is deliberately not:
 *
 *  - **A guarantee.** A report can only land while the hub is reachable — a hub that is closed or
 *    a network that is down reports nothing either way, and an absence of reports is stated as
 *    "no reports", never as "no fetches". The persisted record is what survives the closed window:
 *    a failure reported at 02:00 is still named on the next launch.
 *  - **A heartbeat.** The hub does not infer a schedule and therefore does not declare a fetch
 *    *missing* — a cron interval only exists on the resolver host, and claiming one here would be
 *    the same guess from a one-sample history the watch module already refuses to make. What the
 *    record does name is the last attempt and its result, which is all the evidence there is.
 *
 * Pure: no Electron, no clock, no store. `index.ts` owns the endpoint and the persistence, and the
 * merge + parse decisions are asserted in tests rather than trusted from a `req.on('data')`.
 */

/** What one target's scheduled refreshes have reported, persisted across launches. */
export interface DeployRefreshReport {
  /** ISO time of the most recent `ok` report — a fetch *and* reload that both succeeded. */
  lastOkAt?: string;
  lastOkPeer?: string;
  /** ISO time of the most recent failed report — fetch or reload failed on the resolver host. */
  lastFailAt?: string;
  lastFailPeer?: string;
  /** A short reason the reporting side attached, when it had one. */
  lastFailDetail?: string;
}

/**
 * The targets a report can name — every deploy mechanism whose recipe could carry the report
 * tail, not only the ones that emit it today. Accepting them all here is deliberate: a resolver
 * running an older command still POSTs `target=dnsmasq`, and refusing it would file the report
 * under a parser error rather than the mechanism it names.
 */
export const DEPLOY_REFRESH_TARGETS = ['unbound', 'bind', 'bind-null', 'dnsmasq', 'privoxy', 'shadowrocket'] as const;
export type DeployRefreshTarget = (typeof DEPLOY_REFRESH_TARGETS)[number];

/** What the endpoint parsed out of the query, or null when it cannot answer safely. */
export interface DeployRefreshQuery {
  target: DeployRefreshTarget;
  ok: boolean;
  detail?: string;
}

/**
 * Parse one report request.
 *
 * Strict rather than forgiving: an unknown target or a missing/invalid `ok` is a malformed report
 * and gets refused, because storing `undefined`-as-false would file a fetch success under a key
 * that says failure. `detail` is truncated to a sentence — the reporting side is a cron line, and
 * a log dump is not what a card row can hold.
 */
export function parseDeployRefreshQuery(params: URLSearchParams): DeployRefreshQuery | null {
  const target = params.get('target');
  const okParam = params.get('ok');
  if (!target || !okParam) return null;
  if (!(DEPLOY_REFRESH_TARGETS as readonly string[]).includes(target)) return null;
  if (okParam !== '0' && okParam !== '1') return null;
  // The report was written by a shell line a human pasted together, so belt and braces:
  // control characters out before the sentence lands in a rendered row.
  const detail = params.get('detail')?.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return {
    target: target as DeployRefreshTarget,
    ok: okParam === '1',
    detail: detail ? detail.slice(0, 200) : undefined,
  };
}

/**
 * Fold one report into the persisted record.
 *
 * Success and failure are tracked independently rather than as one slot, because the pair answers
 * the question the card asks — "did anything *fail* after the last thing that worked?" — and a
 * single `lastResult` would overwrite a failure with the next success and unname it.
 */
export function recordDeployRefresh(
  previous: DeployRefreshReport | null | undefined,
  report: { ok: boolean; at: string; peer?: string; detail?: string },
): DeployRefreshReport {
  // The persisted map is user-editable JSON, so `previous` can be anything — a string spreads
  // into char-indexed junk keys that would then persist. Non-objects degrade to a fresh record.
  const next: DeployRefreshReport = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
  };
  if (report.ok) {
    next.lastOkAt = report.at;
    next.lastOkPeer = report.peer;
  } else {
    next.lastFailAt = report.at;
    next.lastFailPeer = report.peer;
    next.lastFailDetail = report.detail;
  }
  return next;
}

/**
 * The newest of the report's two timestamps — "when did we last hear from the cron" — or null
 * when there is no record at all.
 */
export function deployRefreshLastReportAt(report: DeployRefreshReport | null | undefined): string | undefined {
  const stamps = [report?.lastOkAt, report?.lastFailAt]
    .filter((stamp): stamp is string => Boolean(stamp) && Number.isFinite(Date.parse(stamp as string)));
  if (stamps.length === 0) return undefined;
  return stamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/**
 * Whether the last thing the cron said was a failure *since* the last known-good fetch.
 *
 * A failure that predates the latest successful fetch is history — the next scheduled run already
 * recovered it, and naming it again would alarm about a wound that healed. `succeededAt` is the
 * hub's whole notion of success (a served fetch or an `ok` report), so the comparison is between
 * the newest good evidence and the newest bad.
 */
export function deployRefreshFailing(
  report: DeployRefreshReport | null | undefined,
  succeededAt?: string | null,
): boolean {
  const failedAt = report?.lastFailAt;
  if (!failedAt || !Number.isFinite(Date.parse(failedAt))) return false;
  const candidates = [report?.lastOkAt, succeededAt ?? undefined]
    .filter((stamp): stamp is string => Boolean(stamp) && Number.isFinite(Date.parse(stamp as string)));
  const lastGood = candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return !lastGood || Date.parse(failedAt) > Date.parse(lastGood);
}
