import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUnboundFeed, rulesToUnboundZones, unboundZoneFromRule } from '../unboundFeed.js';

test('translates every block shape the feed can contain', () => {
  assert.equal(unboundZoneFromRule('||doubleclick.net^'), '  local-zone: "doubleclick.net" always_nxdomain');
  assert.equal(
    unboundZoneFromRule('||doubleclick.net^$important'),
    '  local-zone: "doubleclick.net" always_nxdomain',
  );
  assert.equal(unboundZoneFromRule('0.0.0.0 telemetry.example.com'), '  local-zone: "telemetry.example.com" always_nxdomain');
  assert.equal(unboundZoneFromRule('127.0.0.1 tracker.example.com'), '  local-zone: "tracker.example.com" always_nxdomain');
  assert.equal(unboundZoneFromRule('plain-adserver.com'), '  local-zone: "plain-adserver.com" always_nxdomain');
  assert.equal(unboundZoneFromRule('address=/ads.example.com/0.0.0.0'), '  local-zone: "ads.example.com" always_nxdomain');
  assert.equal(unboundZoneFromRule('server=/ads.example.com/#'), '  local-zone: "ads.example.com" always_nxdomain');
});

test('strips a path and a trailing terminator down to the host', () => {
  assert.equal(
    unboundZoneFromRule('||cdn.example.com/ads/tracker.js'),
    '  local-zone: "cdn.example.com" always_nxdomain',
  );
  assert.equal(unboundZoneFromRule('||example.com^|'), '  local-zone: "example.com" always_nxdomain');
});

test('passes an already-Unbound rule through with its own action', () => {
  assert.equal(
    unboundZoneFromRule('local-zone: "ads.example.com" static'),
    '  local-zone: "ads.example.com" static',
  );
  assert.equal(
    unboundZoneFromRule('local-data: "ads.example.com A 0.0.0.0"'),
    '  local-zone: "ads.example.com" always_nxdomain',
  );
});

test('drops exceptions rather than inverting the user intent', () => {
  // A local-zone drop-in can only sinkhole; emitting an allow rule as a block would be a
  // security-relevant lie about what the feed does.
  assert.equal(unboundZoneFromRule('@@||allowed.example.com^'), null);
  assert.equal(unboundZoneFromRule('@@||allowed.example.com^$important'), null);
});

test('drops lines that are not DNS blocks', () => {
  assert.equal(unboundZoneFromRule('! a comment'), null);
  assert.equal(unboundZoneFromRule('[Adblock Plus 2.0]'), null);
  assert.equal(unboundZoneFromRule('example.com##.ad-banner'), null);
  assert.equal(unboundZoneFromRule('example.com#@#.sponsor'), null);
  assert.equal(unboundZoneFromRule('example.com##+js(set, ads, true)'), null);
  assert.equal(unboundZoneFromRule(''), null);
  assert.equal(unboundZoneFromRule(null), null);
  assert.equal(unboundZoneFromRule(undefined), null);
});

test('drops directives and hosts that would break local resolution', () => {
  assert.equal(unboundZoneFromRule('||1.0.0.127.in-addr.arpa^'), null);
  assert.equal(unboundZoneFromRule('||example.com^$dnsrewrite=1.2.3.4'), null);
  assert.equal(unboundZoneFromRule('||example.com^$dnstype=AAAA'), null);
  assert.equal(unboundZoneFromRule('||localhost^'), null);
  assert.equal(unboundZoneFromRule('0.0.0.0 broadcasthost'), null);
  assert.equal(unboundZoneFromRule('printer.local'), null);
  assert.equal(unboundZoneFromRule('||*.example.com^'), null);
  assert.equal(unboundZoneFromRule('||plainword^'), null);
});

test('de-duplicates the same block written two different ways', () => {
  const zones = rulesToUnboundZones([
    '||ads.example.com^',
    '0.0.0.0 ads.example.com',
    'address=/ads.example.com/0.0.0.0',
    '||tracker.example.net^',
  ]);

  assert.deepEqual(zones, [
    '  local-zone: "ads.example.com" always_nxdomain',
    '  local-zone: "tracker.example.net" always_nxdomain',
  ]);
});

test('sorts deterministically so the feed does not churn between renders', () => {
  const zones = rulesToUnboundZones(['||zeta.example^', '||alpha.example^']);
  assert.deepEqual(zones, [
    '  local-zone: "alpha.example" always_nxdomain',
    '  local-zone: "zeta.example" always_nxdomain',
  ]);
});

test('survives a missing or malformed feed without throwing', () => {
  assert.deepEqual(rulesToUnboundZones(null), []);
  assert.deepEqual(rulesToUnboundZones(undefined), []);
  assert.deepEqual(rulesToUnboundZones('not-an-array'), []);
  assert.deepEqual(rulesToUnboundZones([null, 42, {}, '']), []);
});

test('renders a drop-in file with a comment header and a real zone count', () => {
  const feed = renderUnboundFeed(['||ads.example.com^', '0.0.0.0 ads.example.com', '||x.example^'], {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  const lines = feed.split('\n');
  assert.equal(lines[0], '# Blockingmachine — Unbound local-zone feed');
  assert.equal(lines[1], '# Generated: 2026-01-01T00:00:00.000Z');
  // The count must describe the de-duplicated zones the file actually contains.
  assert.equal(lines[2], '# Zones: 2');
  assert.equal(lines.at(-1), '');
  assert.ok(feed.includes('  local-zone: "ads.example.com" always_nxdomain'));
  assert.ok(feed.includes('  local-zone: "x.example" always_nxdomain'));
});

test('every rendered line is either a comment or a local-zone statement', () => {
  const feed = renderUnboundFeed(['||a.example^', 'b.example', '! comment', 'x.example##.ad']);
  for (const line of feed.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    assert.match(line, /^ {2}local-zone: "[a-z0-9.-]+" \S+$/);
  }
});
