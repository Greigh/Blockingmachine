/**
 * Cross-feed agreement: every artifact the add-on serves is rendered from the same `dns.txt`,
 * and the feeds agree about which hosts are blocked.
 *
 * This is the property `hostRules.js` exists to guarantee — the Unbound drop-in, the Shadowrocket
 * rule set, the Privoxy action file and the BIND zone are four renderings of one feed, and a host
 * that parses in one but not another is a hole between two deploy targets that agree on nothing
 * else either. A suite that renders them separately would not catch the divergence, so this one
 * compares the *emitted* sets.
 *
 * Two layers, matching the claim's two halves:
 *
 *   - Served: the real server is spawned against a fixture `dns.txt`, every feed route is fetched
 *     over HTTP, and each artifact's parsed host set is compared to the set the fixture declares —
 *     which is what "derived from the same DNS feed" means in a checkable form, rather than trusting
 *     that each route happens to pass `dns.rules` to a renderer.
 *   - Agree: each artifact is parsed back into the hosts it blocks, by an extractor written here —
 *     not by reusing the renderers' own parser, which would let a shared bug cancel itself out.
 *
 * One divergence is encoded rather than smoothed over: Unbound cannot express an allow (the feed
 * drops `@@` lines by design), so a blocked parent keeps its whole subtree sinkholed even where
 * the other three feeds carve the child out. The test asserts that difference explicitly, because
 * a suite that found it later without expecting it would file it as a bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { renderUnboundFeed } from '../unboundFeed.js';
import { renderShadowrocketFeed } from '../shadowrocketFeed.js';
import { renderPrivoxyFeed } from '../privoxyFeed.js';
import { renderBindRpzFeed } from '../bindFeed.js';

/**
 * One fixture line per input shape the shared parser accepts, plus shapes it must refuse.
 *
 * The allow entries are deliberate: `child.ads.example.com` is an allow *under a blocked parent*
 * (the case ordering exists for), `free.example.org` is a standalone allow, and `x.example` is a
 * direct contradiction — a block and an allow for the same name, which every feed resolves to the
 * allow and Unbound cannot express at all.
 */
const FIXTURE_DNS_TXT = [
  '! Blockingmachine test fixture — every parseable shape',
  '||doubleclick.net^',
  '||ads.example.com^',
  '@@||child.ads.example.com^',
  '@@||free.example.org^',
  '0.0.0.0 tracker.example.net',
  'address=/mqtt.example.io/0.0.0.0',
  'plain-ads.example',
  '||x.example^',
  '@@||x.example^',
  '# a hosts-style comment',
  'printer.local',
  '||localhost^',
  'example.com##.ad-banner',
  '',
];

/** Hosts that appear on block lines — what every feed is obliged to express somehow. */
const EXPECTED_BLOCKS = new Set([
  'doubleclick.net',
  'ads.example.com',
  'tracker.example.net',
  'mqtt.example.io',
  'plain-ads.example',
  'x.example',
]);

/** Hosts that appear on allow lines. */
const EXPECTED_ALLOWS = new Set([
  'child.ads.example.com',
  'free.example.org',
  'x.example',
]);

/**
 * What "blocked" means once the allows resolve: a feed that can express an allow keeps the host
 * out of its effective block set; the contradiction resolves to the allow.
 */
const EXPECTED_EFFECTIVE_BLOCKS = new Set(
  [...EXPECTED_BLOCKS].filter((host) => !EXPECTED_ALLOWS.has(host)),
);

// ─── Independent per-format extractors ───────────────────────────────────────
//
// Written from each format's documented shape, not from the modules under test — extracting with
// the same parser that rendered the artifact would make a parser bug invisible here.

/** dns.txt: the raw feed. The same line shapes the renderers consume — this is the baseline. */
function extractDnsFeed(text) {
  const blocked = new Set();
  const allowed = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) continue;
    const isAllow = line.startsWith('@@');
    const value = isAllow ? line.slice(2) : line;
    // The shapes this suite's fixture uses, parsed plainly.
    const match =
      /^\|\|([a-z0-9.-]+)\^/.exec(value) ||
      /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)/.exec(value) ||
      /^(?:address|server)=\/([^/]+)\//.exec(value) ||
      (/^[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+$/.test(value) ? [null, value] : null);
    if (!match) continue;
    const host = match[1];
    // The same refusals normalizeHost applies — localhost, .local and .arpa are not blockable
    // names, and a wildcard is not a host.
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.arpa') || host.includes('*')) continue;
    (isAllow ? allowed : blocked).add(host);
  }
  return { blocked, allowed };
}

/** unbound.conf: a host per `local-zone`, whatever action it carries. */
function extractUnboundZones(text) {
  const zones = new Set();
  for (const match of text.matchAll(/^ {2}local-zone: "([^"]+)" \S+\s*$/gm)) {
    zones.add(match[1]);
  }
  return zones;
}

/**
 * shadowrocket.conf: `DOMAIN-SUFFIX,host,ACTION` — REJECT blocks, DIRECT allows.
 *
 * Order-aware because the format is first-match-wins: for a host listed both ways, whichever
 * action appears *first* in the file is the verdict, so emitting the allows after the blocks
 * would block the exception — a real regression a set-only extractor cannot see.
 */
function extractShadowrocketRules(text) {
  const emittedBlocked = new Set();
  const emittedAllowed = new Set();
  const firstAction = new Map();
  for (const match of text.matchAll(/^DOMAIN-SUFFIX,([a-z0-9.-]+),(REJECT|DIRECT)\s*$/gm)) {
    (match[2] === 'REJECT' ? emittedBlocked : emittedAllowed).add(match[1]);
    if (!firstAction.has(match[1])) firstAction.set(match[1], match[2]);
  }
  // Effective blocked set = hosts whose first matching rule says REJECT.
  const blocked = new Set(emittedBlocked);
  for (const host of blocked) if (firstAction.get(host) !== 'REJECT') blocked.delete(host);
  return { emitted: { blocked: emittedBlocked, allowed: emittedAllowed }, blocked, allowed: emittedAllowed, firstAction };
}

/**
 * privoxy.action: `.host` patterns belong to the section marker above them — `{+block}` blocks,
 * `{-block}` allows. Last match wins, so a host listed under both resolves to whichever section
 * came *last* — emitting the bypass section first would re-block the exception, and a set-only
 * extractor would not see it.
 */
function extractPrivoxyPatterns(text) {
  const emittedAllowed = new Set();
  const lastSection = new Map();
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('{+block')) { section = 'block'; continue; }
    if (line.startsWith('{-block')) { section = 'allow'; continue; }
    if (line.startsWith('{')) { section = null; continue; }
    if (!section || !line.startsWith('.')) continue;
    lastSection.set(line.slice(1), section);
    if (section === 'allow') emittedAllowed.add(line.slice(1));
  }
  const blocked = new Set();
  for (const [host, last] of lastSection) if (last === 'block') blocked.add(host);
  return { blocked, allowed: emittedAllowed };
}

/** db.blockingmachine.rpz: bare `name CNAME .` blocks, `name CNAME rpz-passthru.` allows. */
function extractBindRpzRecords(text) {
  const blocked = new Set();
  const allowed = new Set();
  const wildcards = new Set();
  for (const match of text.matchAll(/^(\*\.)?([a-z0-9.-]+) CNAME (\.|rpz-passthru\.)\s*$/gm)) {
    if (match[1]) {
      wildcards.add(`${match[2]}|${match[3]}`);
      continue;
    }
    (match[3] === '.' ? blocked : allowed).add(match[2]);
  }
  return { blocked, allowed, wildcards };
}

// ─── The agreement assertions, shared by both levels ─────────────────────────

function assertFeedsAgree({ unbound, shadowrocket, privoxy, bind }) {
  // Unbound emits a zone for every block line and cannot express an allow at all — so its zone
  // set is the raw block set, including the contradiction the other feeds resolve.
  assert.deepEqual(
    [...unbound].sort(),
    [...EXPECTED_BLOCKS].sort(),
    'unbound feed should emit one local-zone per block line, allows dropped by design',
  );
  // And the divergence stays visible: the allowed child has no zone of its own, so the parent's
  // zone still covers it where the other feeds carve it out.
  assert.ok(!unbound.has('child.ads.example.com'));

  // The three feeds that can express an allow agree on what is *emitted* — every block line
  // produces a block record, every allow line an allow record — and on what is *effective*:
  // Shadowrocket resolves the contradiction by first match (DIRECT precedes REJECT), Privoxy by
  // last match ({-block} follows {+block}), BIND by suppressing the block pair outright. Three
  // mechanisms, one verdict — and the extractors model the mechanisms, so an ordering regression
  // lands here as a wrong verdict.
  assert.deepEqual([...shadowrocket.emitted.blocked].sort(), [...EXPECTED_BLOCKS].sort());
  assert.deepEqual([...shadowrocket.allowed].sort(), [...EXPECTED_ALLOWS].sort());
  assert.deepEqual([...privoxy.allowed].sort(), [...EXPECTED_ALLOWS].sort());
  assert.deepEqual([...bind.allowed].sort(), [...EXPECTED_ALLOWS].sort());
  for (const [name, effective] of [
    ['shadowrocket', shadowrocket.blocked],
    ['privoxy', privoxy.blocked],
    ['bind', bind.blocked],
  ]) {
    assert.deepEqual(
      [...effective].sort(),
      [...EXPECTED_EFFECTIVE_BLOCKS].sort(),
      `${name} effective block set should equal blocks minus allows`,
    );
  }

  // BIND: every bare record needs its wildcard sibling, on both the block and passthru sides —
  // a bare trigger matches that name only, so a missing `*.` pair silently under-covers.
  for (const host of bind.blocked) assert.ok(bind.wildcards.has(`${host}|.`), `missing *.${host} CNAME .`);
  for (const host of bind.allowed) assert.ok(bind.wildcards.has(`${host}|rpz-passthru.`), `missing *.${host} passthru`);

  // Nothing the fixture cannot express may leak in — cosmetic rules, localhost, .local, wildcards.
  for (const blocked of [unbound, shadowrocket.blocked, privoxy.blocked, bind.blocked]) {
    assert.ok(!blocked.has('printer.local'));
    assert.ok(!blocked.has('localhost'));
    for (const host of blocked) assert.ok(!host.includes('example.com##'));
  }
}

// ─── Module level: the four renderers over one fixture ───────────────────────

test('the four rendered feeds agree on which hosts are blocked', () => {
  // What loadFeed('dns.txt') would return for the fixture: non-comment, non-empty lines.
  const rules = FIXTURE_DNS_TXT.map((l) => l.trim()).filter((l) => l && !l.startsWith('!') && !l.startsWith('#'));

  assertFeedsAgree({
    unbound: extractUnboundZones(renderUnboundFeed(rules)),
    shadowrocket: extractShadowrocketRules(renderShadowrocketFeed(rules)),
    privoxy: extractPrivoxyPatterns(renderPrivoxyFeed(rules)),
    bind: extractBindRpzRecords(renderBindRpzFeed(rules)),
  });
});

// ─── Wire level: the served routes really are rendered from dns.txt ───────────

test('every feed route serves an artifact derived from the same dns.txt', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-feed-agreement-'));
  await writeFile(join(dataDir, 'dns.txt'), FIXTURE_DNS_TXT.join('\n') + '\n', 'utf8');
  // browser.txt exists with unrelated content — a route that read the wrong file would surface.
  await writeFile(join(dataDir, 'browser.txt'), 'unrelated-browser.example##.banner\n', 'utf8');

  const port = 43000 + Math.floor(Math.random() * 5000);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DATA_DIR: dataDir, FEED_PORT: String(port), AUTO_COMPILE: 'disabled' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  // Wait for the listener rather than racing the first fetch.
  let served = false;
  for (let attempt = 0; attempt < 40 && !served; attempt += 1) {
    await delay(100);
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/dns.txt`);
      served = probe.ok;
    } catch { /* not up yet */ }
  }
  assert.ok(served, 'the add-on server did not come up');

  const fetchText = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200, `${path} should be served`);
    return res.text();
  };

  // The baseline is the DNS feed *as served* — the routes all claim to render exactly this.
  const baseline = extractDnsFeed(await fetchText('/dns.txt'));
  assert.deepEqual([...baseline.blocked].sort(), [...EXPECTED_BLOCKS].sort(),
    'the served dns.txt should carry the fixture blocks');
  assert.deepEqual([...baseline.allowed].sort(), [...EXPECTED_ALLOWS].sort(),
    'the served dns.txt should carry the fixture allows');

  assertFeedsAgree({
    unbound: extractUnboundZones(await fetchText('/unbound.conf')),
    shadowrocket: extractShadowrocketRules(await fetchText('/shadowrocket.conf')),
    privoxy: extractPrivoxyPatterns(await fetchText('/privoxy.action')),
    bind: extractBindRpzRecords(await fetchText('/db.blockingmachine.rpz')),
  });
});
