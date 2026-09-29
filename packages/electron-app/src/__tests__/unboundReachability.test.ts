/**
 * Unbound reachability classification.
 *
 * The check earns its keep by telling three failure modes apart — not serving, not fetched, not
 * loaded — so the tests are written per verdict rather than per function: each case states an input
 * the hub could really observe and pins the verdict (and the sentence) a user would be shown.
 */

import { describe, test, expect } from '@jest/globals';
import {
  REACHABILITY_PROBE_HEADER,
  RESOLVER_CONTROL_DOMAIN,
  classifyUnboundReachability,
  createFeedServeLog,
  formatUnboundAge,
  parseUnboundDropIn,
  pickCanaryDomain,
  reachabilityProbeHeaders,
  summarizeFeedServes,
  toReachabilitySnapshot,
  type FeedServeEvent,
  type UnboundReachabilityInput,
  type UnboundResolverProbe,
} from '../unboundReachability';

const CHECKED_AT = '2026-09-29T12:00:00.000Z';
const FEED_URL = 'http://192.168.1.145:9191/unbound.conf';
const FEED_FILE = 'unbound.conf';

const GOOD_DROP_IN = [
  '# Format: Unbound',
  'server:',
  '  local-zone: "doubleclick.net" always_nxdomain',
  '  local-zone: "ads.example.com" always_nxdomain',
  '# EXCEPTION: @@||allowed.example.com^',
];

/** A self-fetch that served the drop-in above. */
function servedDropIn(text: string = GOOD_DROP_IN.join('\n')) {
  const dropIn = parseUnboundDropIn(text);
  return {
    ok: true,
    status: 200,
    zones: dropIn.zones,
    hasServerBlock: dropIn.hasServerBlock,
    canaryDomain: pickCanaryDomain(dropIn.domains),
  };
}

/**
 * A probe with a reference that resolves the canary, which is what makes NXDOMAIN evidence.
 *
 * The reference is a resolver other than the one under test: without it, a canary that never
 * existed and a canary the drop-in blocks answer identically, and the check would report a
 * deployment as working on the strength of a name that does not resolve anywhere.
 */
function probe(overrides: {
  canary?: Partial<UnboundResolverProbe['canary']>;
  control?: Partial<UnboundResolverProbe['control']>;
  reference?: UnboundResolverProbe['reference'];
} = {}): UnboundResolverProbe {
  return {
    target: '127.0.0.1:53',
    controlDomain: RESOLVER_CONTROL_DOMAIN,
    canary: {
      domain: 'doubleclick.net',
      answer: { state: 'nxdomain' },
      ...overrides.canary,
    },
    control: {
      domain: RESOLVER_CONTROL_DOMAIN,
      answer: { state: 'resolved', addresses: ['93.184.216.34'] },
      ...overrides.control,
    },
    reference: overrides.reference === undefined
      ? { target: '1.1.1.1:53', answer: { state: 'resolved', addresses: ['104.16.132.229'] } }
      : overrides.reference,
  };
}

function input(overrides: Partial<UnboundReachabilityInput> = {}): UnboundReachabilityInput {
  return {
    checkedAt: CHECKED_AT,
    feedUrl: FEED_URL,
    feedFileName: FEED_FILE,
    feedServerRunning: true,
    selfFetch: servedDropIn(),
    serves: [],
    ...overrides,
  };
}

describe('summarizeFeedServes', () => {
  const serve = (at: string, path: string, overrides: Partial<FeedServeEvent> = {}): FeedServeEvent => ({
    at,
    path,
    peer: '192.168.1.1',
    status: 200,
    ...overrides,
  });

  test('counts only 2xx serves of the file the resolver was told to fetch', () => {
    const summary = summarizeFeedServes(
      [
        serve('2026-09-29T11:00:00.000Z', '/unbound.conf', { peer: '192.168.1.1' }),
        serve('2026-09-29T11:30:00.000Z', '/unbound.conf?cache=1', { peer: '192.168.1.2' }),
        // A 404 is the hub failing to answer, not a resolver fetching.
        serve('2026-09-29T11:45:00.000Z', '/unbound.conf', { status: 404 }),
        // A different compiled file is a different question.
        serve('2026-09-29T11:50:00.000Z', '/hosts.txt'),
      ],
      FEED_FILE,
    );

    expect(summary.count).toBe(2);
    expect(summary.peers).toBe(2);
    expect(summary.lastAt).toBe('2026-09-29T11:30:00.000Z');
    expect(summary.lastPeer).toBe('192.168.1.2');
  });

  test('reports nothing fetched rather than an empty object when the log is cold', () => {
    expect(summarizeFeedServes([], FEED_FILE)).toEqual({ count: 0, peers: 0 });
  });

  test('takes the newest serve by timestamp, not by the order the log happens to hold', () => {
    const summary = summarizeFeedServes(
      [
        serve('2026-09-29T11:30:00.000Z', '/unbound.conf'),
        serve('2026-09-29T09:00:00.000Z', '/unbound.conf'),
      ],
      FEED_FILE,
    );
    expect(summary.lastAt).toBe('2026-09-29T11:30:00.000Z');
  });
});

describe('createFeedServeLog', () => {
  const request = (headers: Record<string, string> = {}, peer = '192.168.1.1') => ({ headers, peer });

  test('records a real fetch with the peer and user agent worth showing', () => {
    const log = createFeedServeLog(10, 100, () => '2026-09-29T12:00:00.000Z');
    log.record(request({ 'user-agent': 'curl/8.4.0' }), '/unbound.conf', 200, 1024);

    expect(log.entries()).toEqual([
      {
        at: '2026-09-29T12:00:00.000Z',
        path: '/unbound.conf',
        peer: '192.168.1.1',
        userAgent: 'curl/8.4.0',
        status: 200,
        bytes: 1024,
      },
    ]);
  });

  test('does not let the check manufacture its own evidence', () => {
    const log = createFeedServeLog(10, 100, () => '2026-09-29T12:00:00.000Z');
    // The probe fetches the hub's own feed URL. If that counted, every check would find the file
    // freshly fetched and the answer would always be yes.
    log.record(request(reachabilityProbeHeaders()), '/unbound.conf', 200, 900);
    expect(log.entries()).toHaveLength(0);
    expect(reachabilityProbeHeaders()[REACHABILITY_PROBE_HEADER]).toBeTruthy();
  });

  test('keeps only the newest entries, so a scraped feed cannot grow the heap', () => {
    const log = createFeedServeLog(2, 100, () => '2026-09-29T12:00:00.000Z');
    for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      log.record({ headers: {}, peer }, '/unbound.conf', 200);
    }
    expect(log.entries().map((event) => event.peer)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  test('a busy sibling feed cannot evict the resolver\u2019s fetch of the drop-in', () => {
    // The hub serves several compiled files, and a browser extension polling browser.txt would push
    // a single daily Unbound fetch out of a flat newest-N window — reporting "nothing has fetched
    // it" for a deployment that fetched it an hour ago.
    const log = createFeedServeLog(3, 400, () => '2026-09-29T12:00:00.000Z');
    log.record({ headers: {}, peer: '192.168.1.1' }, '/unbound.conf', 200);
    for (let i = 0; i < 50; i += 1) {
      log.record({ headers: {}, peer: '127.0.0.1' }, '/browser.txt', 200);
    }

    const summary = summarizeFeedServes([...log.entries()], 'unbound.conf');
    expect(summary.count).toBe(1);
    expect(summary.lastPeer).toBe('192.168.1.1');
    expect(log.entries().length).toBeLessThanOrEqual(400);
  });
});

describe('parseUnboundDropIn', () => {
  test('reads the zones and the server block the format requires', () => {
    const dropIn = parseUnboundDropIn(GOOD_DROP_IN.join('\n'));
    expect(dropIn.zones).toBe(2);
    expect(dropIn.hasServerBlock).toBe(true);
    expect(dropIn.domains).toEqual(['doubleclick.net', 'ads.example.com']);
    expect(dropIn.exceptionNotes).toBe(1);
  });

  test('counts nothing for a file that is not a Unbound drop-in', () => {
    // An AdGuard export under a .conf name loads without error and blocks nothing.
    const dropIn = parseUnboundDropIn(['! Title: Blockingmachine', '||doubleclick.net^', '0.0.0.0 ads.example.com'].join('\n'));
    expect(dropIn.zones).toBe(0);
    expect(dropIn.hasServerBlock).toBe(false);
  });

  test('ignores commented-out zones', () => {
    expect(parseUnboundDropIn(['# local-zone: "old.example" always_nxdomain'].join('\n')).zones).toBe(0);
  });
});

describe('pickCanaryDomain', () => {
  test('prefers the shortest registrable domain, because the test needs a name that would otherwise resolve', () => {
    expect(
      pickCanaryDomain(['ads.tracker.deep.example.com', 'tracker.example.net', 'doubleclick.net']),
    ).toBe('doubleclick.net');
  });

  test('is deterministic when two candidates are equally short', () => {
    const first = pickCanaryDomain(['b.example', 'a.example']);
    const second = pickCanaryDomain(['a.example', 'b.example']);
    expect(first).toBe('a.example');
    expect(second).toBe('a.example');
  });

  test('refuses a wildcard, an underscore host and a bare address', () => {
    expect(pickCanaryDomain(['*.example.com'])).toBeNull();
    // Underscore labels are service records, not hosts a client asks an A record for.
    expect(pickCanaryDomain(['_dmarc.example.com'])).toBeNull();
    expect(pickCanaryDomain(['0.0.0.0'])).toBeNull();
    expect(pickCanaryDomain(['com'])).toBeNull();
    expect(pickCanaryDomain([])).toBeNull();
  });
});

describe('formatUnboundAge', () => {
  test('reads in the units a person would use, and never goes negative', () => {
    expect(formatUnboundAge('2026-09-29T12:00:00.000Z', CHECKED_AT)).toBe('just now');
    expect(formatUnboundAge('2026-09-29T11:56:00.000Z', CHECKED_AT)).toBe('4m ago');
    expect(formatUnboundAge('2026-09-29T09:00:00.000Z', CHECKED_AT)).toBe('3h ago');
    expect(formatUnboundAge('2026-09-25T12:00:00.000Z', CHECKED_AT)).toBe('4d ago');
    // A clock skew must not print "in 3 minutes".
    expect(formatUnboundAge('2026-09-29T12:05:00.000Z', CHECKED_AT)).toBe('just now');
  });

  test('says never for a timestamp it does not have', () => {
    expect(formatUnboundAge(null, CHECKED_AT)).toBe('never');
    expect(formatUnboundAge(undefined, CHECKED_AT)).toBe('never');
    expect(formatUnboundAge('not a date', CHECKED_AT)).toBe('never');
  });
});

describe('classifyUnboundReachability', () => {
  test('live: the resolver answers NXDOMAIN for a name that is in the file serving it and exists elsewhere', () => {
    const verdict = classifyUnboundReachability(input({ probe: probe() }));

    expect(verdict.state).toBe('live');
    expect(verdict.tone).toBe('ok');
    expect(verdict.detail).toContain('doubleclick.net');
    expect(verdict.detail).toContain('still resolves on 1.1.1.1:53');
    // The check that sees it loaded is itself the confirmation.
    expect(verdict.lastConfirmedAt).toBe(CHECKED_AT);
    expect(verdict.canaryDomain).toBe('doubleclick.net');
  });

  test('canary-unconfirmed: NXDOMAIN with no second opinion is not a pass', () => {
    // The failure this guards against is the worst one the check can produce: reporting a
    // deployment as working because the test domain never existed in the first place.
    const verdict = classifyUnboundReachability(input({ probe: probe({ reference: null }) }));

    expect(verdict.state).toBe('canary-unconfirmed');
    expect(verdict.tone).toBe('warn');
    expect(verdict.state).not.toBe('live');
    expect(verdict.lastConfirmedAt).toBeUndefined();
    expect(verdict.nextStep).toContain('reference resolver');
  });

  test('canary-unconfirmed: a reference that cannot answer does not become a pass either', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe({ reference: { target: '1.1.1.1:53', answer: { state: 'timeout', detail: 'ETIMEOUT' } } }),
      }),
    );

    expect(verdict.state).toBe('canary-unconfirmed');
    expect(verdict.detail).toContain('could not confirm the name exists upstream');
    expect(verdict.rows.find((row) => row.label === 'Canary exists upstream')?.tone).toBe('warn');
  });

  test('canary-nonexistent: a name that resolves nowhere makes NXDOMAIN meaningless', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe({ reference: { target: '1.1.1.1:53', answer: { state: 'nxdomain' } } }),
      }),
    );

    expect(verdict.state).toBe('canary-nonexistent');
    expect(verdict.tone).toBe('warn');
    expect(verdict.detail).toContain('proves nothing');
    expect(verdict.rows.find((row) => row.label.startsWith('Canary ·'))?.value).toBe(
      'NXDOMAIN — not evidence',
    );
  });

  test('stale: blocking works but with a copy older than the last compile', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe(),
        serves: [{ at: '2026-09-29T09:00:00.000Z', path: '/unbound.conf', peer: '192.168.1.1', status: 200 }],
        lastCompiledAt: '2026-09-29T11:00:00.000Z',
      }),
    );

    expect(verdict.state).toBe('stale');
    expect(verdict.tone).toBe('warn');
    expect(verdict.detail).toContain('before the last compile');
    expect(verdict.rows.some((row) => row.label === 'Copy age' && row.tone === 'warn')).toBe(true);
  });

  test('does not claim staleness when the fetch cannot be dated', () => {
    // Nothing has fetched it since the hub started and nothing was remembered from before, so the
    // resolver's copy has no date — a warning here would be a guess.
    const verdict = classifyUnboundReachability(input({ probe: probe() }));
    expect(verdict.state).toBe('live');
    expect(verdict.rows.find((row) => row.label === 'Fetched by the resolver')?.tone).toBe('warn');
  });

  test('not-loaded: the file is served and fetched, but the resolver still resolves the canary', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe({ canary: { answer: { state: 'resolved', addresses: ['1.2.3.4'] } } }),
        serves: [{ at: '2026-09-29T11:00:00.000Z', path: '/unbound.conf', peer: '192.168.1.1', status: 200 }],
      }),
    );

    expect(verdict.state).toBe('not-loaded');
    expect(verdict.tone).toBe('warn');
    expect(verdict.nextStep).toContain('include:');
    expect(verdict.rows.find((row) => row.label.startsWith('Canary'))?.value).toContain('resolves to 1.2.3.4');
  });

  test('inconclusive: a resolver that NXDOMAINs the control cannot vouch for the canary', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe({
          canary: { answer: { state: 'nxdomain' } },
          control: { answer: { state: 'nxdomain' } },
        }),
      }),
    );

    expect(verdict.state).toBe('inconclusive');
    expect(verdict.detail).toContain(RESOLVER_CONTROL_DOMAIN);
  });

  test('resolver-unreachable: a timeout on the control is not evidence about the drop-in', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe({
          canary: { answer: { state: 'timeout' } },
          control: { answer: { state: 'timeout', detail: 'ETIMEOUT' } },
        }),
      }),
    );

    expect(verdict.state).toBe('resolver-unreachable');
    expect(verdict.tone).toBe('off');
    // The feed half is still reported, so the user knows which side is broken.
    expect(verdict.rows.find((row) => row.label === 'Drop-in served')?.tone).toBe('ok');
  });

  test('feed-offline: a server that is not listening is reported before anything downstream', () => {
    const verdict = classifyUnboundReachability(
      input({ feedServerRunning: false, selfFetch: { ...servedDropIn(), ok: false } }),
    );
    expect(verdict.state).toBe('feed-offline');
    expect(verdict.rows).toHaveLength(2);
  });

  test('feed-offline: an address that answers nothing is not a 404 to fix in Unbound', () => {
    const verdict = classifyUnboundReachability(
      input({ selfFetch: { ok: false, status: 500, error: 'HTTP 500', zones: 0, hasServerBlock: false, canaryDomain: null } }),
    );
    expect(verdict.state).toBe('feed-offline');
    expect(verdict.detail).toContain('HTTP 500');
  });

  test('feed-invalid: a file with no local-zone statements blocks nothing even when it loads', () => {
    const verdict = classifyUnboundReachability(
      input({ selfFetch: { ok: true, status: 200, zones: 0, hasServerBlock: false, canaryDomain: null } }),
    );
    expect(verdict.state).toBe('feed-invalid');
    expect(verdict.nextStep).toContain('Unbound');
  });

  test('no-canary: a drop-in of wildcards gives nothing to test with', () => {
    const verdict = classifyUnboundReachability(
      input({
        selfFetch: {
          ok: true,
          status: 200,
          zones: 1,
          hasServerBlock: true,
          canaryDomain: null,
        },
      }),
    );
    expect(verdict.state).toBe('no-canary');
  });

  test('unverified: served but never queried says so instead of implying it works', () => {
    const verdict = classifyUnboundReachability(
      input({ probe: null, probeSkipped: 'No resolver address is set.' }),
    );
    expect(verdict.state).toBe('unverified');
    expect(verdict.detail).toBe('No resolver address is set.');
  });

  test('reports a checkout of the whole reading order for a working deployment', () => {
    const verdict = classifyUnboundReachability(
      input({
        probe: probe(),
        serves: [{ at: '2026-09-29T11:55:00.000Z', path: '/unbound.conf', peer: '192.168.1.1', status: 200 }],
      }),
    );
    expect(verdict.rows.map((row) => row.label)).toEqual([
      'Feed address',
      'Drop-in served',
      'Fetched by the resolver',
      'Resolver',
      'Canary · doubleclick.net',
      'Canary exists upstream',
      'Last confirmed live',
    ]);
  });
});

describe('toReachabilitySnapshot', () => {
  test('keeps the verdict and its wording, and drops the row breakdown', () => {
    const verdict = classifyUnboundReachability(input({ probe: probe() }));
    const snapshot = toReachabilitySnapshot(verdict);

    expect(snapshot.headline).toBe(verdict.headline);
    expect(snapshot.detail).toBe(verdict.detail);
    expect(snapshot.lastConfirmedAt).toBe(CHECKED_AT);
    expect('rows' in snapshot).toBe(false);
  });
});
