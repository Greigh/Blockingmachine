/**
 * The Unbound reachability check, against real resolvers.
 *
 * The rest of this suite proves that the classifier maps answers to verdicts, and it does that with
 * hand-built answers: `{ state: 'nxdomain' }` becomes `live`, `{ state: 'resolved' }` becomes
 * `not-loaded`. Every one of those mappings is correct given its input, and none of them says the
 * input is what a real Unbound produces. That gap is load-bearing, because the check's entire
 * premise is an empirical claim about another program's behaviour — spelled out at the top of
 * `unboundReachability.ts` as *"The export emits `local-zone: "x" always_nxdomain`, so NXDOMAIN for
 * a name that is in the drop-in proves the drop-in is loaded."*
 *
 * If that claim is wrong, every test here still passes and the product is wrong: a correctly
 * deployed resolver answers something other than NXDOMAIN, the classifier reads it as `not-loaded`,
 * and the Hub tells a user their working deployment is broken — while telling them to re-check an
 * include line that is already correct. Nothing in a unit suite can catch that, because the claim is
 * not about the code under test.
 *
 * So this file asks real resolvers. Each scenario is a genuinely configured Unbound, reached over a
 * real socket, answering a real query with the pipeline's own compiled drop-in as the thing it
 * loaded. Gated on `UNBOUND_LIVE_DROPIN` and friends: unset, the whole suite skips, the way the BIND
 * tests skip when `named` is absent. Most contributors and most CI runners have no resolver to point
 * at, and a suite that fails for that reason teaches people to ignore it.
 *
 * Verified against Unbound 1.19.2 (Linux container) and 1.26.1 (native) — see
 * `docs/unbound-reachability-live.md` for what each verdict looked like and the two defects it found.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';

import {
  RESOLVER_CONTROL_DOMAIN,
  classifyUnboundReachability,
  createFeedServeLog,
  parseUnboundDropIn,
  pickCanaryDomain,
  reachabilityProbeHeaders,
  summarizeFeedServes,
  type UnboundReachability,
  type UnboundReachabilityInput,
} from '../unboundReachability';
import { probeUnboundResolver } from '../unboundProbe';
import { parseUnboundResolverAddress, type UnboundResolverTarget } from '../unboundAddress';

/** The drop-in the resolvers under test were configured to load, and the one this suite serves. */
const DROPIN = process.env.UNBOUND_LIVE_DROPIN;
/** A resolver with the drop-in included. The deployment the recipe is supposed to produce. */
const DEPLOYED = process.env.UNBOUND_LIVE_DEPLOYED;
/** The same image without the include. The fetch worked, the reload or the include did not. */
const BARE = process.env.UNBOUND_LIVE_BARE;
/** A resolver that refuses the control name too. The one shape of "success" that must never pass. */
const SWALLOW = process.env.UNBOUND_LIVE_SWALLOW;

const canRun = Boolean(DROPIN && DEPLOYED);
const describeWithResolvers = canRun ? describe : describe.skip;

function target(address: string): UnboundResolverTarget {
  const parsed = parseUnboundResolverAddress(address);
  if (!parsed.ok) throw new Error(`UNBOUND_LIVE_* address is not resolvable: ${parsed.message}`);
  return parsed.target;
}

describeWithResolvers('Unbound reachability, against real resolvers', () => {
  let server: Server;
  let baseUrl: string;
  let dropIn: ReturnType<typeof parseUnboundDropIn>;
  let canaryDomain: string;
  const serveLog = createFeedServeLog();

  beforeAll(async () => {
    const body = readFileSync(DROPIN!, 'utf8');
    dropIn = parseUnboundDropIn(body);
    const picked = pickCanaryDomain(dropIn.domains);
    if (!picked) throw new Error('the drop-in has no domain that could serve as a canary');
    canaryDomain = picked;

    // The hub's feed server, reduced to what this check reads: the file, and a log of who fetched
    // it. The check's own request carries the probe header so it cannot log itself as evidence.
    server = createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0];
      const ok = pathname === '/blockingmachine.conf';
      serveLog.record({ headers: req.headers, peer: req.socket.remoteAddress ?? 'unknown' }, pathname, ok ? 200 : 404, body.length);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
      res.end(ok ? body : 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the feed server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Unbound has no remote blocklist feature, so the recipe's scheduled `curl` *is* the
    // subscription. Stand in for it with a real request carrying no probe header, so the serve log
    // holds a genuine fetch with a genuine timestamp — staleness is only ever claimed on a dated
    // fetch, so without this the `stale` verdict is unreachable and the suite would not cover it.
    const fetched = await fetch(`${baseUrl}/blockingmachine.conf`, {
      headers: { 'user-agent': 'curl/8.7.1 (the recipe refresh)' },
    });
    await fetched.text();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  /**
   * Run the check the way the main process runs it: fetch the served file, read the drop-in out of
   * the body, probe the resolver, classify. Nothing is hand-built below this line — the only
   * argument a test supplies is which resolver to ask.
   */
  async function check(options: {
    tested: string;
    reference?: string | null;
    /** Skip the resolver query entirely, as the main process does when the file is not served. */
    probeSkipped?: string | null;
    lastCompiledAt?: string | null;
  }): Promise<UnboundReachability> {
    const response = await fetch(`${baseUrl}/blockingmachine.conf`, { headers: reachabilityProbeHeaders() });
    const body = await response.text();
    const parsed = parseUnboundDropIn(body);

    const probe = options.probeSkipped
      ? null
      : await probeUnboundResolver({
          target: target(options.tested),
          canaryDomain,
          controlDomain: RESOLVER_CONTROL_DOMAIN,
          referenceTarget: options.reference ? target(options.reference) : null,
        });

    const input: UnboundReachabilityInput = {
      checkedAt: new Date().toISOString(),
      feedUrl: `${baseUrl}/blockingmachine.conf`,
      feedFileName: 'blockingmachine.conf',
      feedServerRunning: true,
      selfFetch: {
        ok: response.ok,
        status: response.status,
        zones: parsed.zones,
        hasServerBlock: parsed.hasServerBlock,
        canaryDomain: pickCanaryDomain(parsed.domains),
      },
      serves: [...serveLog.entries()],
      lastCompiledAt: options.lastCompiledAt ?? null,
      probe,
      probeSkipped: options.probeSkipped ?? null,
    };
    return classifyUnboundReachability(input);
  }

  test('the drop-in the resolvers loaded is one this check reads as a drop-in', () => {
    expect(dropIn.zones).toBeGreaterThan(0);
    expect(dropIn.hasServerBlock).toBe(true);
    expect(canaryDomain).toBeTruthy();
    // The recipe's refresh was recorded, and the check's own request was not. That asymmetry is the
    // difference between a check that works and one whose answer is always "yes, something is
    // fetching this" because the thing asking asked itself.
    const serves = summarizeFeedServes([...serveLog.entries()], 'blockingmachine.conf');
    expect(serves.count).toBe(1);
    expect(serves.lastUserAgent).toMatch(/curl/);
  });

  test('a resolver that loaded the drop-in answers NXDOMAIN for the canary', async () => {
    const probe = await probeUnboundResolver({
      target: target(DEPLOYED!),
      canaryDomain,
      controlDomain: RESOLVER_CONTROL_DOMAIN,
    });
    // This is the empirical claim the whole check rests on, asserted against the real program rather
    // than against a fixture that was written to agree with the comment above it.
    expect(probe.canary.answer.state).toBe('nxdomain');
    // And the control, so the NXDOMAIN is the drop-in's opinion rather than a resolver refusing all.
    expect(probe.control.answer.state).toBe('resolved');
  });

  test('live: the drop-in is loaded, the resolver blocks, and the verdict says so', async () => {
    const verdict = await check({ tested: DEPLOYED!, reference: BARE ?? undefined });
    expect(verdict.state).toBe('live');
    expect(verdict.tone).toBe('ok');
    // A `live` verdict whose rows still read as warnings is a card that says "working" above a list
    // that says otherwise, which is the failure the row breakdown exists to prevent.
    expect(verdict.rows.every((row) => row.tone === 'ok')).toBe(true);
    expect(verdict.headline).toMatch(/loaded and the resolver is blocking/i);
  });

  test('live: a check that proves the deployment is the confirmation, recorded', async () => {
    const verdict = await check({ tested: DEPLOYED!, reference: BARE ?? undefined });
    // The store remembers this so the pane can say "last confirmed 3h ago" between checks.
    expect(verdict.lastConfirmedAt).toBe(verdict.checkedAt);
  });

  test('stale: the same working resolver reports a copy older than the last compile', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const verdict = await check({ tested: DEPLOYED!, reference: BARE ?? undefined, lastCompiledAt: future });
    // This is the difference between "deployed" and "staying current", and it is only reachable by
    // way of a resolver that is genuinely blocking.
    expect(verdict.state).toBe('stale');
    expect(verdict.tone).toBe('warn');
  });

  test('canary-unconfirmed: NXDOMAIN with nobody to confirm the name exists is not a pass', async () => {
    const verdict = await check({ tested: DEPLOYED!, reference: null });
    expect(verdict.state).toBe('canary-unconfirmed');
    expect(verdict.tone).toBe('warn');
    expect(verdict.headline).toMatch(/unconfirmed/i);
  });

  test('resolver-unreachable: a closed port is reported as such, not as a working blocklist', async () => {
    const verdict = await check({ tested: '127.0.0.1:1', reference: BARE ?? undefined });
    expect(verdict.state).toBe('resolver-unreachable');
    expect(verdict.tone).toBe('off');
  });

  describe('the scenarios the rig has to configure', () => {
    const describeWith = (address: string | undefined) => (address ? describe : describe.skip);

    describeWith(BARE)('with a resolver that never loaded the file', () => {
      test('not-loaded: served, fetched, and the resolver still answers the canary', async () => {
        const verdict = await check({ tested: BARE!, reference: DEPLOYED });
        // The state a user hits when the fetch ran but the include or the reload did not. Asserted
        // live because it is the state whose correctness depends entirely on what a resolver that
        // has *not* loaded a drop-in actually says.
        expect(verdict.state).toBe('not-loaded');
        expect(verdict.tone).toBe('warn');
        expect(verdict.nextStep).toMatch(/include|reload/i);
      });
    });

    describeWith(SWALLOW)('with a resolver that refuses the control name', () => {
      test('inconclusive: a resolver that refuses everything cannot vouch for the canary', async () => {
        const verdict = await check({ tested: SWALLOW!, reference: BARE ?? undefined });
        // The check is right to refuse this, and only because the control query exists. Verified
        // live because a resolver configured to sinkhole the world is indistinguishable from a
        // working drop-in by any single query.
        expect(verdict.state).toBe('inconclusive');
        expect(verdict.tone).toBe('warn');
      });
    });
  });

  test('unverified: served but never queried is not read as working', async () => {
    const verdict = await check({ tested: DEPLOYED!, probeSkipped: 'no probe for this case' });
    expect(verdict.state).toBe('unverified');
  });
});
