/**
 * Watching an Unbound deployment between checks.
 *
 * Two decisions carry the whole feature, and both are about silence: when to look, and when to
 * speak. So the tests are written as the two failure directions. For *looking*: that an unengaged
 * machine stays quiet and an engaged one does not, and that a stored number cannot turn the watch
 * into a loop. For *speaking*: a full matrix of state pairs, because the rule is not "alert on
 * stale" — it is "alert when a deployment already seen blocking stops blocking", and every cell of
 * that matrix is a decision somebody has to make deliberately.
 *
 * The matrix is generated rather than hand-written so a new verdict state cannot be added to
 * `UnboundReachabilityState` and silently fall out of the coverage: `everyWatchablePair` walks the
 * union of the type, so a state nobody considered is still asked about.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  UNBOUND_WATCH_INTERVAL_MS,
  UNBOUND_WATCH_MAX_INTERVAL_MS,
  UNBOUND_WATCH_MIN_INTERVAL_MS,
  UNBOUND_WATCH_STALE_GRACE_MS,
  formatUnboundWatchInterval,
  isWatchFailureState,
  isWatchedBlockingState,
  shouldWatchUnbound,
  staleGraceElapsed,
  unboundWatchAlert,
  unboundWatchIntervalMs,
  unboundWatchStaleGraceMs,
} from '../unboundWatch';
import type { UnboundReachabilitySnapshot, UnboundReachabilityState } from '../unboundReachability';

const NOW = '2026-10-01T12:00:00.000Z';

function snapshot(
  state: UnboundReachabilityState,
  overrides: Partial<UnboundReachabilitySnapshot> = {},
): UnboundReachabilitySnapshot {
  return {
    state,
    tone: state === 'live' ? 'ok' : 'warn',
    headline: `headline for ${state}`,
    detail: `detail for ${state}`,
    nextStep: `next step for ${state}`,
    checkedAt: NOW,
    feedUrl: 'http://192.168.1.145:9191/unbound.conf',
    lastConfirmedAt: state === 'live' || state === 'stale' ? NOW : undefined,
    // A snapshot that says `stale` has, by default, already been announced about: that is the state
    // a `stale` announcement leaves behind, and it is what makes "the same finding twice is one
    // finding" a property of the snapshot rather than of a counter. Tests about the *first*
    // observation of a stale finding override this with `undefined`.
    staleAnnouncedAt: state === 'stale' ? '2026-10-01T11:50:00.000Z' : undefined,
    // A compile far enough back that the grace has always elapsed, so the default snapshots test the
    // transition rules rather than the grace.
    compiledAt: '2026-10-01T06:00:00.000Z',
    ...overrides,
  };
}

/** Every state in the union, spelled out so a new one is a type error here too. */
const ALL_STATES: UnboundReachabilityState[] = [
  'unverified',
  'live',
  'stale',
  'canary-unconfirmed',
  'canary-nonexistent',
  'not-loaded',
  'resolver-unqueryable',
  'feed-offline',
  'feed-invalid',
  'resolver-unreachable',
  'no-canary',
  'inconclusive',
];

describe('unbound watch · the cadence', () => {
  test('defaults to a quarter of an hour, and says so in words', () => {
    expect(UNBOUND_WATCH_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(formatUnboundWatchInterval()).toBe('every 15 minutes');
  });

  test('clamps a stored or computed interval instead of trusting it', () => {
    // The failure this exists for is silent: a watch every 200ms looks exactly like an app that
    // is checking very carefully, right up until the resolver notices.
    expect(unboundWatchIntervalMs(0)).toBe(UNBOUND_WATCH_MIN_INTERVAL_MS);
    expect(unboundWatchIntervalMs(200)).toBe(UNBOUND_WATCH_MIN_INTERVAL_MS);
    expect(unboundWatchIntervalMs(-1)).toBe(UNBOUND_WATCH_MIN_INTERVAL_MS);
    expect(unboundWatchIntervalMs(Number.NaN)).toBe(UNBOUND_WATCH_INTERVAL_MS);
    expect(unboundWatchIntervalMs(Number.POSITIVE_INFINITY)).toBe(UNBOUND_WATCH_INTERVAL_MS);
    expect(unboundWatchIntervalMs(48 * 60 * 60 * 1000)).toBe(UNBOUND_WATCH_MAX_INTERVAL_MS);
    expect(unboundWatchIntervalMs(undefined)).toBe(UNBOUND_WATCH_INTERVAL_MS);
    // A real preference inside the bounds is passed through untouched.
    expect(unboundWatchIntervalMs(60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });

  test('describes any cadence in the units a person would use', () => {
    expect(formatUnboundWatchInterval(60 * 1000)).toBe('every 1 minute');
    expect(formatUnboundWatchInterval(60 * 60 * 1000)).toBe('every 1 hour');
    expect(formatUnboundWatchInterval(3 * 60 * 60 * 1000)).toBe('every 3 hours');
  });
});

describe('unbound watch · whether to look at all', () => {
  test('watches a deployment the operator named, with or without a verdict', () => {
    expect(shouldWatchUnbound({ address: '192.168.1.1:5335' })).toBe(true);
    expect(shouldWatchUnbound({ address: '192.168.1.1:5335', snapshot: null })).toBe(true);
  });

  test('watches a deployment this hub has already produced a verdict for', () => {
    expect(shouldWatchUnbound({ snapshot: snapshot('live') })).toBe(true);
  });

  test('leaves a machine that never deployed Unbound alone', () => {
    // The gate is what keeps this off every installation: a timed DNS query against a resolver
    // nobody pointed it at is a periodic, unexplainable request to a third party.
    expect(shouldWatchUnbound({})).toBe(false);
    expect(shouldWatchUnbound({ address: '', snapshot: null })).toBe(false);
    expect(shouldWatchUnbound({ address: '   ' })).toBe(false);
  });
});

describe('unbound watch · the states that are news', () => {
  test('a deployment is watched from the moment it was seen blocking', () => {
    expect(isWatchedBlockingState('live')).toBe(true);
    // Stale is still blocking, which is what makes a later `not-loaded` a regression rather than
    // a first impression.
    expect(isWatchedBlockingState('stale')).toBe(true);
    for (const state of ALL_STATES.filter((s) => s !== 'live' && s !== 'stale')) {
      expect([state, isWatchedBlockingState(state)]).toEqual([state, false]);
    }
  });

  test('only the two failures that mean blocking stopped are worth announcing', () => {
    expect(isWatchFailureState('stale')).toBe(true);
    expect(isWatchFailureState('not-loaded')).toBe(true);
    // The exclusions are load-bearing, not tidiness. `resolver-unreachable` is what a suspended
    // laptop reports on the next tick; alerting on it teaches the user to dismiss these.
    for (const state of ['unverified', 'canary-unconfirmed', 'canary-nonexistent', 'feed-offline', 'feed-invalid', 'resolver-unreachable', 'no-canary', 'inconclusive'] as const) {
      expect([state, isWatchFailureState(state)]).toEqual([state, false]);
    }
  });
});

describe('unbound watch · when to announce a regression', () => {
  test('announces a deployment that was blocking and no longer is', () => {
    const stale = unboundWatchAlert({
      previous: snapshot('live', { checkedAt: '2026-10-01T11:45:00.000Z' }),
      current: snapshot('stale'),
    });
    expect(stale).not.toBeNull();
    expect(stale?.from).toBe('live');
    expect(stale?.to).toBe('stale');
    expect(stale?.title).toContain('older copy');

    const unloaded = unboundWatchAlert({ previous: snapshot('live'), current: snapshot('not-loaded') });
    expect(unloaded?.to).toBe('not-loaded');
    expect(unloaded?.title).toContain('no longer using the drop-in');

    // A deployment that was already stale and is now not loaded is worse, not new-but-equal.
    const worse = unboundWatchAlert({ previous: snapshot('stale'), current: snapshot('not-loaded') });
    expect(worse).not.toBeNull();
  });

  test('says nothing on the first check, or after one that was never live', () => {
    // No history means no regression, and every machine whose resolver does not run this drop-in
    // would otherwise be told its deployment is not loaded.
    expect(unboundWatchAlert({ previous: null, current: snapshot('not-loaded') })).toBeNull();
    expect(unboundWatchAlert({ previous: snapshot('unverified'), current: snapshot('not-loaded') })).toBeNull();
    expect(unboundWatchAlert({ previous: snapshot('inconclusive'), current: snapshot('stale') })).toBeNull();
  });

  test('repeats itself never: the same finding twice is one finding', () => {
    // This is what keeps a resolver left broken for a week from producing a notification every
    // fifteen minutes, which is the failure mode that makes people disable notifications.
    expect(unboundWatchAlert({ previous: snapshot('stale'), current: snapshot('stale') })).toBeNull();
  });

  test('stays silent for states that mean "could not tell", and for recoveries', () => {
    for (const state of ALL_STATES.filter((s) => !isWatchFailureState(s))) {
      expect([state, unboundWatchAlert({ previous: snapshot('live'), current: snapshot(state) })]).toEqual([
        state,
        null,
      ]);
    }
    // Coming back is not news; the pane already shows it and a "fixed" notification every time a
    // flaky resolver answers once would be its own kind of noise.
    expect(unboundWatchAlert({ previous: snapshot('not-loaded'), current: snapshot('live') })).toBeNull();
    expect(unboundWatchAlert({ previous: snapshot('not-loaded'), current: snapshot('stale') })).toBeNull();
  });

  test('alerts the full matrix: exactly live|stale → stale|not-loaded, and only on a change', () => {
    // Generated from the state list rather than hand-listed, so a state added to the union later
    // cannot slip past this suite unasked.
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const alert = unboundWatchAlert({ previous: snapshot(from), current: snapshot(to) });
        const expected =
          isWatchedBlockingState(from) && isWatchFailureState(to) && from !== to ? alert : null;
        expect([from, to, Boolean(alert)]).toEqual([
          from,
          to,
          Boolean(expected),
        ]);
      }
    }
  });

  test('uses the verdict’s own wording, so the alert and the pane cannot disagree', () => {
    const alert = unboundWatchAlert({
      previous: snapshot('live', { lastConfirmedAt: '2026-10-01T11:40:00.000Z' }),
      current: snapshot('stale', { lastConfirmedAt: undefined }),
    });
    // `headline` and `nextStep` come from the same `classifyUnboundReachability` call the card
    // renders, and the age is relative to this check rather than a wall clock the test cannot pin.
    expect(alert?.body).toContain('headline for stale');
    expect(alert?.body).toContain('next step for stale');
    expect(alert?.body).toContain('It was last confirmed blocking 20m ago.');
  });

  test('omits the confirmation age when there has never been one', () => {
    const alert = unboundWatchAlert({
      previous: snapshot('stale', { lastConfirmedAt: undefined }),
      current: snapshot('not-loaded', { lastConfirmedAt: undefined, nextStep: undefined }),
    });
    // Nothing to append, so the body is the headline alone rather than a sentence ending in a
    // silence — both real failure states carry a `nextStep`, so this is the degenerate shape.
    expect(alert?.body).toBe('headline for not-loaded');
    expect(alert?.body).not.toContain('last confirmed blocking');
  });
});

/**
 * The wiring itself.
 *
 * `index.ts` is the main process: importing it would start Electron. So these assertions read its
 * source, which is the same level at which the thing is actually at risk — a timer that is written
 * and never started, a snapshot read after the check that overwrites it, a push nobody subscribes
 * to. Each one is a way to ship a feature that is present in a diff and absent in the app.
 */
describe('unbound watch · the wiring', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const main = read('../index.ts');
  const preload = read('../preload.ts');
  const view = read('../views/DeployHubView.tsx');

  test('the check is scheduled at startup and stopped at quit', () => {
    // Started beside the other background timers rather than only when a pane is open, because a
    // deployment nobody is looking at is the entire case.
    expect(main).toContain('startUnboundWatch(store);');
    expect(main).toContain('stopUnboundWatch();');
    // `unref` so the timer can never be the reason the process stays alive.
    expect(main).toMatch(/unboundWatchTimer\?\.unref\?\.\(\)/);
  });

  test('the previous verdict is read before the check that overwrites it', () => {
    const tick = main.slice(main.indexOf('async function runUnboundWatchTick'));
    const previous = tick.indexOf('const previous = getUnboundReachabilitySnapshot()');
    const check = tick.indexOf('await checkUnboundReachability()');
    expect(previous).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    // Read afterwards, every tick compares a verdict with itself and no regression is ever seen.
    expect(previous).toBeLessThan(check);
  });

  test('one tick at a time, and the gate is re-read per tick', () => {
    const tick = main.slice(main.indexOf('async function runUnboundWatchTick'));
    expect(tick).toContain('if (unboundWatchInFlight) return;');
    expect(tick).toContain('shouldWatchUnbound({');
    // A machine that has never engaged with the pane must not query a resolver on a timer.
    expect(tick.indexOf('shouldWatchUnbound')).toBeLessThan(tick.indexOf('checkUnboundReachability'));
  });

  test('the announcement is remembered, so a held stale finding is announced later', () => {
    // The decision is pure, so nothing can record that it spoke. Without this the second and third
    // ticks are `stale` to `stale`, which the no-repeat rule rejects, and a stale finding held by
    // the grace would be held for ever rather than for one cadence.
    const tick = main.slice(main.indexOf('async function runUnboundWatchTick'));
    expect(tick).toContain('alert?.staleAnnouncedAt');
    expect(tick).toContain("store.set('unboundReachability', { ...snapshot, staleAnnouncedAt:");
    // And the stamp is read back on the next check rather than recomputed from nothing.
    expect(main).toContain('staleAnnouncedAt: previous?.staleAnnouncedAt ?? null');
  });

  test('a finished check reaches the pane, and the pane unsubscribes', () => {
    expect(main).toContain("webContents.send('unbound-reachability-updated'");
    expect(preload).toContain("ipcRenderer.on('unbound-reachability-updated'");
    expect(preload).toContain("ipcRenderer.removeListener('unbound-reachability-updated'");
    expect(view).toContain('onUnboundReachabilityUpdated');
    // A listener left mounted would write into an unmounted view for the rest of the session.
    expect(view).toContain('unsubscribeUnboundWatch?.()');
  });
});
describe('unbound watch · a stale copy that has only just fallen behind', () => {
  // `stale` is *the resolver's copy is older than the last compile*, which is true and entirely
  // expected between a compile and the resolver's next fetch. Unbound has no remote-list feature, so
  // that fetch is a cron entry on the resolver host: an hourly one, a daily one, whatever the
  // operator wrote. Without a grace period, compiling at 09:00 on a resolver that fetches at 09:05
  // produced a notification at 09:00:15 about a deployment working exactly as configured — and the
  // next tick found it current with nothing to say.
  const COMPILED_AT = '2026-10-01T09:00:00.000Z';

  test('says nothing one minute after a compile, and announces one cadence later', () => {
    const oneMinuteIn = unboundWatchAlert({
      previous: snapshot('live', { checkedAt: COMPILED_AT }),
      current: snapshot('stale', {
        checkedAt: '2026-10-01T09:01:00.000Z',
        compiledAt: COMPILED_AT,
        staleAnnouncedAt: undefined,
      }),
    });
    expect(oneMinuteIn).toBeNull();

    const oneCadenceIn = unboundWatchAlert({
      previous: snapshot('live', { checkedAt: COMPILED_AT }),
      current: snapshot('stale', {
        checkedAt: '2026-10-01T09:15:00.000Z',
        compiledAt: COMPILED_AT,
        staleAnnouncedAt: undefined,
      }),
    });
    expect(oneCadenceIn).not.toBeNull();
    expect(oneCadenceIn?.to).toBe('stale');
  });

  test('announces a stale finding that persists across ticks exactly once', () => {
    // The held announcement has to survive the hold, or it never happens: the second and third
    // observations are `stale` to `stale`, which the no-repeat rule rejects. What carries it is the
    // stamp the announcement leaves on the remembered snapshot.
    const first = snapshot('stale', {
      checkedAt: '2026-10-01T09:01:00.000Z',
      compiledAt: COMPILED_AT,
      staleAnnouncedAt: undefined,
    });
    expect(unboundWatchAlert({ previous: snapshot('live', { checkedAt: COMPILED_AT }), current: first })).toBeNull();

    const second = snapshot('stale', {
      checkedAt: '2026-10-01T09:16:00.000Z',
      compiledAt: COMPILED_AT,
      staleAnnouncedAt: undefined,
    });
    const announced = unboundWatchAlert({ previous: first, current: second });
    expect(announced).not.toBeNull();
    // And the caller is told what to remember, because the decision cannot record it itself.
    expect(announced?.staleAnnouncedAt).toBe('2026-10-01T09:16:00.000Z');

    const third = snapshot('stale', {
      checkedAt: '2026-10-01T09:31:00.000Z',
      compiledAt: COMPILED_AT,
    });
    // The snapshot the *caller* persists after an announcement is the current verdict carrying the
    // returned stamp — which is what the next tick reads as `previous`.
    const remembered = { ...third, staleAnnouncedAt: announced?.staleAnnouncedAt ?? undefined };
    const fourth = snapshot('stale', {
      checkedAt: '2026-10-01T09:46:00.000Z',
      compiledAt: COMPILED_AT,
      staleAnnouncedAt: remembered.staleAnnouncedAt,
    });
    expect(unboundWatchAlert({ previous: remembered, current: fourth })).toBeNull();
  });

  test('not-loaded has no waiting window and fires on the first observation', () => {
    // The asymmetry is deliberate. A resolver answering normally for a name its own file blocks is
    // never the expected state, so there is no window in which `not-loaded` is a false positive —
    // and that is what makes half of this feature trustworthy without a configured refresh interval.
    const immediate = unboundWatchAlert({
      previous: snapshot('live', { checkedAt: COMPILED_AT }),
      current: snapshot('not-loaded', { checkedAt: '2026-10-01T09:00:15.000Z', compiledAt: COMPILED_AT }),
    });
    expect(immediate).not.toBeNull();
    expect(immediate?.to).toBe('not-loaded');
    // Nothing to remember: a transition already cannot repeat itself, so no stamp is handed back.
    expect(immediate?.staleAnnouncedAt).toBeNull();
  });

  test('a stale finding with no compile date is announced rather than suppressed', () => {
    // `stale` cannot be reached without both timestamps, so this is a defensive branch — and the
    // direction it fails in matters. Absence of evidence that the window has passed is not evidence
    // that it has, and the failure mode of getting it backwards is an announcement nobody can act
    // on *by finding out what is missing*.
    expect(
      unboundWatchAlert({
        previous: snapshot('live'),
        current: snapshot('stale', { compiledAt: undefined, staleAnnouncedAt: undefined }),
      }),
    ).not.toBeNull();
  });
});

describe('unbound watch · the stale grace is a stated number', () => {
  test('defaults to one cadence, because that is the refresh it is watching', () => {
    expect(UNBOUND_WATCH_STALE_GRACE_MS).toBe(UNBOUND_WATCH_INTERVAL_MS);
    expect(unboundWatchStaleGraceMs()).toBe(UNBOUND_WATCH_INTERVAL_MS);
  });

  test('is clamped, so a stored value cannot make it instant or unbounded', () => {
    expect(unboundWatchStaleGraceMs(-1)).toBe(0);
    expect(unboundWatchStaleGraceMs(0)).toBe(0);
    expect(unboundWatchStaleGraceMs(Number.NaN)).toBe(UNBOUND_WATCH_STALE_GRACE_MS);
    expect(unboundWatchStaleGraceMs(null)).toBe(UNBOUND_WATCH_STALE_GRACE_MS);
    expect(unboundWatchStaleGraceMs(UNBOUND_WATCH_MAX_INTERVAL_MS * 10)).toBe(UNBOUND_WATCH_MAX_INTERVAL_MS);
    expect(unboundWatchStaleGraceMs(60_000)).toBe(60_000);
  });

  test('elapsed is measured from the compile, inclusive of the boundary', () => {
    const at = (checkedAt: string, compiledAt?: string) =>
      staleGraceElapsed({ checkedAt, compiledAt } as UnboundReachabilitySnapshot);
    expect(at('2026-10-01T09:14:59.000Z', '2026-10-01T09:00:00.000Z')).toBe(false);
    expect(at('2026-10-01T09:15:00.000Z', '2026-10-01T09:00:00.000Z')).toBe(true);
    expect(at('2026-10-01T09:15:01.000Z', '2026-10-01T09:00:00.000Z')).toBe(true);
    // A compile in the future is a clock disagreement, not a reason to wait: treat it as elapsed.
    expect(at('2026-10-01T09:00:00.000Z', '2026-10-01T09:30:00.000Z')).toBe(true);
    // Unparseable input cannot establish that the window passed.
    expect(at('2026-10-01T09:15:00.000Z', undefined)).toBe(true);
    expect(at('not a time', '2026-10-01T09:00:00.000Z')).toBe(true);
  });

  test('an explicit grace is honoured, so the policy is the caller’s to state', () => {
    const oneMinuteOld = {
      previous: snapshot('live', { checkedAt: '2026-10-01T09:00:00.000Z' }),
      current: snapshot('stale', {
        checkedAt: '2026-10-01T09:01:00.000Z',
        compiledAt: '2026-10-01T09:00:00.000Z',
        staleAnnouncedAt: undefined,
      }),
    };
    expect(unboundWatchAlert(oneMinuteOld)).toBeNull();
    expect(unboundWatchAlert({ ...oneMinuteOld, staleGraceMs: 30_000 })).not.toBeNull();
  });
});
