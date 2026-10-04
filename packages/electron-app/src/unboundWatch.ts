/**
 * Watching an Unbound deployment between checks.
 *
 * The reachability check answers one question — *is this deployment blocking right now?* — and until
 * now only a person could ask it, because the pane had a **Check now** button and nothing else.
 * That is the wrong shape for a check whose entire value is noticing a change: every deployment
 * breaks while nobody is looking. The resolver's cron stops running, a router update drops the
 * `include:` line, a reload is missed, the copy ages past the last compile — and the verdict on
 * screen stays `live` from three days ago, because nobody pressed anything.
 *
 * So the check is re-run on a cadence, and a *regression* is announced rather than left to be
 * discovered. The rule that makes the announcement worth having is the narrow one: it takes a
 * deployment this hub has already seen blocking, and it says so only when that stops being true.
 * A machine that never deployed Unbound hears nothing, ever, no matter what its resolver answers.
 *
 * Pure: no Electron, no clock, no store. `index.ts` owns the timer and the notification, and the
 * decisions worth pinning — when to look, and when to speak — are functions of persisted verdicts,
 * so they are asserted in tests rather than trusted from a `setInterval`.
 */

import { formatUnboundAge, type UnboundReachabilitySnapshot, type UnboundReachabilityState } from './unboundReachability';

/**
 * How often the check re-runs itself.
 *
 * A quarter of an hour, chosen against the refresh it is watching: Unbound has no remote-list
 * feature, so the resolver host fetches the drop-in from a cron entry the operator writes, and
 * hourly or daily is the ordinary answer. Fifteen minutes notices a missed fetch within a quarter
 * of one refresh interval, and costs three DNS queries and one local HTTP fetch per tick — which
 * is why it only runs for a deployment somebody has engaged with (see `shouldWatchUnbound`).
 *
 * One constant, so it is a one-line change; `unboundWatchIntervalMs` clamps whatever it is given
 * to bounds that cannot hammer the resolver.
 */
export const UNBOUND_WATCH_INTERVAL_MS = 15 * 60 * 1000;

/** A watch more frequent than this is a loop, not a check. */
export const UNBOUND_WATCH_MIN_INTERVAL_MS = 60 * 1000;

/** A watch slower than this is not watching. */
export const UNBOUND_WATCH_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The cadence to actually run at.
 *
 * Clamped rather than trusted, because a persisted or computed value of 0, `NaN` or a few hundred
 * milliseconds is a busy loop against someone's resolver, and that failure is silent — it looks
 * exactly like an app that is watching very carefully.
 */
export function unboundWatchIntervalMs(preferred?: number | null): number {
  if (typeof preferred !== 'number' || !Number.isFinite(preferred)) return UNBOUND_WATCH_INTERVAL_MS;
  const rounded = Math.round(preferred);
  if (rounded < UNBOUND_WATCH_MIN_INTERVAL_MS) return UNBOUND_WATCH_MIN_INTERVAL_MS;
  if (rounded > UNBOUND_WATCH_MAX_INTERVAL_MS) return UNBOUND_WATCH_MAX_INTERVAL_MS;
  return rounded;
}

/** The cadence in words, for the pane and the notification. */
export function formatUnboundWatchInterval(intervalMs?: number | null): string {
  const ms = unboundWatchIntervalMs(intervalMs);
  const minutes = ms / 60000;
  if (minutes < 1) return `every ${Math.round(ms / 1000)} seconds`;
  if (minutes < 60) {
    const whole = Math.round(minutes);
    return `every ${whole} minute${whole === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  return `every ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Whether this machine has a deployment worth watching.
 *
 * Deliberately narrow: an address the operator typed, or a verdict this hub has already produced.
 * Both mean somebody used the Unbound pane. Without that gate every installation of the app would
 * query a resolver on a timer forever to learn something it has no stake in — and on a machine
 * where the default address happens to answer, that is a periodic, unexplainable DNS request to a
 * third party.
 *
 * A stored address is enough on its own: the operator named a resolver, so the deployment is
 * theirs whether or not they have pressed the button yet.
 */
export function shouldWatchUnbound(input: {
  address?: string | null;
  snapshot?: UnboundReachabilitySnapshot | null;
}): boolean {
  if ((input.address ?? '').trim()) return true;
  return Boolean(input.snapshot);
}

/**
 * The states in which the resolver was demonstrably blocking.
 *
 * `stale` counts: blocking with an old copy is still blocking, so it is the state a deployment has
 * to be *seen* in before a later verdict is a regression rather than a first impression.
 */
export function isWatchedBlockingState(state: UnboundReachabilityState): boolean {
  return state === 'live' || state === 'stale';
}

/**
 * The states worth waking someone for.
 *
 * `stale` and `not-loaded` only, and the exclusions are the point. `resolver-unreachable` is what a
 * laptop that suspended, roamed to a café, or lost Wi-Fi reports on the next tick — alerting on it
 * would teach the user to dismiss these, which costs the real failure its meaning. `feed-offline`
 * is the hub's own server being stopped, and the resolver keeps blocking from the copy it already
 * has. `canary-unconfirmed`, `inconclusive` and `canary-nonexistent` are the check admitting it
 * could not tell.
 */
export function isWatchFailureState(state: UnboundReachabilityState): boolean {
  return state === 'stale' || state === 'not-loaded';
}

/**
 * How long a `stale` finding has to stand still before it is announced.
 *
 * One cadence by default, and the reason is a window rather than a doubt. `stale` means *the
 * resolver's copy is older than the last compile*, which is true — and entirely expected — between
 * a compile and the resolver's next fetch. Unbound has no remote-list feature, so that fetch is a
 * cron entry on the resolver host: an hourly one, a daily one, whatever the operator wrote.
 * Someone who compiles at 09:00 with a resolver that fetches at 09:05 would otherwise be notified
 * at 09:00:15 about a deployment that is working exactly as configured, and the next tick would find
 * it current again with nothing to say.
 *
 * A cadence is the honest unit here, and it is stated as one rather than discovered: the refresh
 * interval the operator actually configured is not something this hub can know, and inferring it
 * from observed fetch gaps would be a guess from a history that may be one sample long. A guess in
 * the long direction is a missed alert rather than an extra one, and this alert is cheap to miss
 * once and expensive to miss for a week. `unboundWatchStaleGraceMs` clamps whatever it is given,
 * so a stored `0` cannot turn this into an immediate announcement.
 */
export const UNBOUND_WATCH_STALE_GRACE_MS = UNBOUND_WATCH_INTERVAL_MS;

/** The grace to actually apply: clamped, defaulted, never negative. */
export function unboundWatchStaleGraceMs(preferred?: number | null): number {
  if (typeof preferred !== 'number' || !Number.isFinite(preferred)) return UNBOUND_WATCH_STALE_GRACE_MS;
  return Math.min(UNBOUND_WATCH_MAX_INTERVAL_MS, Math.max(0, Math.round(preferred)));
}

/**
 * Whether a `stale` copy has been behind the compile long enough to be a finding.
 *
 * Measured from the compile, not from how many times this has looked: the question is whether the
 * resolver's next fetch has had a chance to happen, and the compile is when it was due. Requires the
 * finding to have survived a full cadence *after* the compile, so a check one minute into an hourly
 * refresh is silence and the same check one cadence later is not.
 *
 * A snapshot with no compile date is answered `true`. The absence of evidence that the window has
 * passed is not evidence that it has, and the failure mode of getting this backwards is an
 * announcement the operator cannot act on.
 */
export function staleGraceElapsed(
  current: UnboundReachabilitySnapshot,
  graceMs: number = UNBOUND_WATCH_STALE_GRACE_MS,
): boolean {
  const compiledAt = Date.parse(current.compiledAt ?? '');
  const checkedAt = Date.parse(current.checkedAt);
  if (!Number.isFinite(compiledAt) || !Number.isFinite(checkedAt)) return true;
  // A compile dated in the future is a clock disagreement or a corrupted stamp, and holding the
  // announcement until real time caught up with it could mean never — so it counts as elapsed.
  if (checkedAt < compiledAt) return true;
  return checkedAt - compiledAt >= unboundWatchStaleGraceMs(graceMs);
}

export interface UnboundWatchAlert {
  /** The state the deployment was in when it was last seen blocking. */
  from: UnboundReachabilityState;
  to: UnboundReachabilityState;
  title: string;
  body: string;
  /**
   * What the caller must remember so this finding is announced once.
   *
   * The decision is pure, so it cannot record anything itself; `index.ts` folds this back into the
   * snapshot it persists after a `stale` announcement. Null for every other state, where a
   * transition already cannot repeat itself.
   */
  staleAnnouncedAt: string | null;
}

/**
 * The announcement for a check that has just run, or null for silence.
 *
 * Silence is the common answer and it has to be *earned*, so the three refusals are separate:
 *
 *  - **Nothing before it.** A first check has no history to have regressed from, and every machine
 *    whose resolver does not run this drop-in would otherwise be notified that its deployment is
 *    not loaded. A deployment nobody has confirmed is a deployment to watch, not to announce.
 *  - **Nothing confirmed before it.** Same reason, one step on: `unverified` to `not-loaded` is not
 *    a regression, it is the first honest answer anyone has had.
 *  - **Not a transition.** `stale` to `stale` is the same finding twice. Only the *change* is news,
 *    which is what keeps a resolver left unfixed for a week from producing a notification every
 *    fifteen minutes.
 *  - **Not yet, for `stale`.** A copy that fell behind a compile less than one grace ago may simply
 *    be waiting for the resolver's next fetch, which is a cron entry this hub cannot see. This is
 *    the one refusal that is about a *time* rather than a state, and it is why `not-loaded` — which
 *    has no such window, because a resolver answering normally for a name its own file blocks is
 *    never the expected state — still fires on first observation. The asymmetry is deliberate and
 *    is the honest answer to which half of this feature can be trusted without a configured
 *    refresh interval.
 *
 * The wording is the pane's: `headline` and `nextStep` come from the same `classifyUnboundReachability`
 * call the card renders, so an alert and the screen cannot describe the same failure two ways.
 */
export function unboundWatchAlert(input: {
  previous: UnboundReachabilitySnapshot | null;
  current: UnboundReachabilitySnapshot;
  /** How long a `stale` copy must have been behind the compile before it is announced. */
  staleGraceMs?: number | null;
}): UnboundWatchAlert | null {
  const previous = input.previous;
  const current = input.current;
  if (!previous) return null;
  if (!isWatchedBlockingState(previous.state)) return null;
  if (!isWatchFailureState(current.state)) return null;
  if (current.state === 'stale') {
    // Announced once, and not on a transition alone. A copy that has been behind the compile for
    // less than the grace may be waiting for the resolver's next fetch, and the next tick would
    // then find it current with nothing to say — so the announcement is held. Holding it on the
    // transition would mean it is *never* made, because every later tick is `stale` to `stale`;
    // `staleAnnouncedAt` on the remembered snapshot is what makes the held announcement happen
    // exactly once, at the tick the grace names.
    if (previous.staleAnnouncedAt) return null;
    if (!staleGraceElapsed(current, input.staleGraceMs ?? UNBOUND_WATCH_STALE_GRACE_MS)) return null;
  } else if (previous.state === current.state) {
    // `not-loaded` has no waiting window — a resolver answering normally for a name its own file
    // blocks is never the expected state — so it announces on the change and only on the change.
    return null;
  }

  const title =
    current.state === 'stale'
      ? 'Unbound deployment is running an older copy'
      : 'Unbound deployment is no longer using the drop-in';
  const confirmedAt = current.lastConfirmedAt ?? previous.lastConfirmedAt;
  const sentences = [current.headline];
  if (current.nextStep) sentences.push(current.nextStep);
  if (confirmedAt) {
    sentences.push(`It was last confirmed blocking ${formatUnboundAge(confirmedAt, current.checkedAt)}.`);
  }

  return {
    from: previous.state,
    to: current.state,
    title,
    body: sentences.join(' '),
    staleAnnouncedAt: current.state === 'stale' ? current.checkedAt : null,
  };
}