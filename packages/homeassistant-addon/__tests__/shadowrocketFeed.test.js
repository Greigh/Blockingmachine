import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderShadowrocketFeed,
  rulesToShadowrocketRules,
  shadowrocketHostCount,
  shadowrocketRuleFromRule,
} from '../shadowrocketFeed.js';
import { rulesToUnboundZones } from '../unboundFeed.js';

test('translates every block shape the feed can contain', () => {
  assert.equal(shadowrocketRuleFromRule('||doubleclick.net^'), 'DOMAIN-SUFFIX,doubleclick.net,REJECT');
  assert.equal(shadowrocketRuleFromRule('||doubleclick.net^$important'), 'DOMAIN-SUFFIX,doubleclick.net,REJECT');
  assert.equal(shadowrocketRuleFromRule('0.0.0.0 telemetry.example.com'), 'DOMAIN-SUFFIX,telemetry.example.com,REJECT');
  assert.equal(shadowrocketRuleFromRule('127.0.0.1 tracker.example.com'), 'DOMAIN-SUFFIX,tracker.example.com,REJECT');
  assert.equal(shadowrocketRuleFromRule('plain-adserver.com'), 'DOMAIN-SUFFIX,plain-adserver.com,REJECT');
  assert.equal(shadowrocketRuleFromRule('address=/ads.example.com/0.0.0.0'), 'DOMAIN-SUFFIX,ads.example.com,REJECT');
  assert.equal(shadowrocketRuleFromRule('server=/ads.example.com/#'), 'DOMAIN-SUFFIX,ads.example.com,REJECT');
});

test('uses DOMAIN-SUFFIX, never DOMAIN', () => {
  // `DOMAIN` matches that host only. A list of exact hosts silently misses every subdomain, which
  // is the defect the desktop Shadowrocket export had and had to be repaired for.
  const lines = rulesToShadowrocketRules(['||ads.example.com^', '||tracker.example.net^']);
  assert.deepEqual(lines, [
    'DOMAIN-SUFFIX,ads.example.com,REJECT',
    'DOMAIN-SUFFIX,tracker.example.net,REJECT',
  ]);
  assert.equal(lines.some((line) => line.startsWith('DOMAIN,')), false);
});

test('an allow becomes DIRECT rather than being dropped', () => {
  // Unbound's drop-in cannot express an allow and drops it. This format can, and the ordering makes
  // it work, so dropping it here would re-block a host the user explicitly released.
  assert.equal(shadowrocketRuleFromRule('@@||allowed.example.com^'), 'DOMAIN-SUFFIX,allowed.example.com,DIRECT');
  assert.equal(
    shadowrocketRuleFromRule('@@||allowed.example.com^$important'),
    'DOMAIN-SUFFIX,allowed.example.com,DIRECT',
  );
});

test('allows are emitted before blocks, because the rule set is first-match-wins', () => {
  // The child sorts *after* its parent alphabetically, so a single sorted list would put the
  // parent's REJECT first and the DIRECT would never be reached.
  const lines = rulesToShadowrocketRules(['||example.com^', '@@||sub.example.com^']);
  assert.deepEqual(lines, [
    'DOMAIN-SUFFIX,sub.example.com,DIRECT',
    'DOMAIN-SUFFIX,example.com,REJECT',
  ]);
  const firstBlock = lines.findIndex((line) => line.endsWith(',REJECT'));
  const lastAllow = lines.map((line) => line.endsWith(',DIRECT')).lastIndexOf(true);
  assert.ok(lastAllow < firstBlock, 'an allow is emitted after a block that would swallow it');
});

test('drops what a host feed cannot express', () => {
  assert.equal(shadowrocketRuleFromRule('@@||allowed.example.com^'), 'DOMAIN-SUFFIX,allowed.example.com,DIRECT');
  assert.equal(shadowrocketRuleFromRule('! a comment'), null);
  assert.equal(shadowrocketRuleFromRule('[Adblock Plus 2.0]'), null);
  assert.equal(shadowrocketRuleFromRule('# a comment'), null);
  assert.equal(shadowrocketRuleFromRule('example.com##.ad-banner'), null);
  assert.equal(shadowrocketRuleFromRule('example.com#@#.ad-banner'), null);
  assert.equal(shadowrocketRuleFromRule('example.com#$#.ad { display: none }'), null);
  assert.equal(shadowrocketRuleFromRule('example.com##+js(script.js)'), null);
  assert.equal(shadowrocketRuleFromRule('||host^$dnsrewrite=NOERROR'), null);
  assert.equal(shadowrocketRuleFromRule('||host^$dnstype=A'), null);
  assert.equal(shadowrocketRuleFromRule('0.0.0.0 localhost'), null);
  assert.equal(shadowrocketRuleFromRule('localhost'), null);
  assert.equal(shadowrocketRuleFromRule('printer.local'), null);
  assert.equal(shadowrocketRuleFromRule('2.0.192.in-addr.arpa'), null);
  assert.equal(shadowrocketRuleFromRule(''), null);
  assert.equal(shadowrocketRuleFromRule(null), null);
});

test('de-duplicates the same block written two ways', () => {
  // One host, two sources. A rule set that lists it twice is still correct, but a status payload
  // that counts rules would then overstate how many hosts are covered.
  assert.deepEqual(rulesToShadowrocketRules(['||ads.example^', '0.0.0.0 ads.example']), [
    'DOMAIN-SUFFIX,ads.example,REJECT',
  ]);
  assert.equal(shadowrocketHostCount(['||ads.example^', '0.0.0.0 ads.example']), 1);
});

test('an allow and a block for the same host both survive, in that order', () => {
  // The block is a broad parent and the allow a narrow child; DOMAIN-SUFFIX means the child is
  // matched by the parent's rule too, so the allow has to come first and the block has to stay.
  const lines = rulesToShadowrocketRules(['||example.com^', '@@||example.com^']);
  assert.deepEqual(lines, [
    'DOMAIN-SUFFIX,example.com,DIRECT',
    'DOMAIN-SUFFIX,example.com,REJECT',
  ]);
});

test('renders a [Rule] section, because rules outside it are not read', () => {
  const output = renderShadowrocketFeed(['||ads.example^'], { generatedAt: '2026-01-01T00:00:00.000Z' });
  const lines = output.split('\n');
  assert.equal(lines[4], '[Rule]');
  assert.ok(lines.includes('DOMAIN-SUFFIX,ads.example,REJECT'));
  assert.ok(output.endsWith('\n'));
});

test('uses # for comments, because ! is AdGuard syntax a Shadowrocket config rejects', () => {
  const output = renderShadowrocketFeed([]);
  for (const line of output.split('\n')) {
    if (line.trim()) assert.ok(!line.startsWith('!'), `AdGuard comment leaked into the rule set: ${line}`);
  }
  assert.ok(output.includes('# Blockingmachine'));
});

test('reports the allow and block split in its header', () => {
  const output = renderShadowrocketFeed(['||a.example^', '@@||b.example^'], {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.ok(output.includes('# Rules: 2 (1 allowed before 1 blocked)'), output);
});

test('is stable and sorted, so a re-render is diffable', () => {
  const rules = ['||z.example^', '||a.example^', '@@||m.example^'];
  assert.deepEqual(rulesToShadowrocketRules(rules), [
    'DOMAIN-SUFFIX,m.example,DIRECT',
    'DOMAIN-SUFFIX,a.example,REJECT',
    'DOMAIN-SUFFIX,z.example,REJECT',
  ]);
  assert.equal(renderShadowrocketFeed(rules, { generatedAt: 'x' }), renderShadowrocketFeed(rules, { generatedAt: 'x' }));
});

test('tolerates a feed that is not an array', () => {
  assert.deepEqual(rulesToShadowrocketRules(undefined), []);
  assert.deepEqual(rulesToShadowrocketRules(null), []);
  assert.deepEqual(rulesToShadowrocketRules('||ads.example^'), []);
});

test('agrees with the Unbound feed about which hosts are blocked', () => {
  // The two feeds are rendered from the same source, so a host sinkholed in the resolver must be
  // the host the phone blocks. This is the invariant the shared parser exists to keep.
  const rules = [
    '||ads.example.com^',
    '0.0.0.0 telemetry.example.net',
    'address=/tracker.example.org/0.0.0.0',
    'server=/pixel.example.io/#',
    'plain.example.dev',
    '||cdn.example.co^$important',
    'example.com##.banner',
    '! comment',
    '||host^$dnstype=A',
  ];
  const unboundHosts = new Set(
    rulesToUnboundZones(rules).map((line) => /"([^"]+)"/.exec(line)[1]),
  );
  const shadowrocketHosts = new Set(
    rulesToShadowrocketRules(rules).map((line) => line.split(',')[1]),
  );
  assert.deepEqual([...shadowrocketHosts].sort(), [...unboundHosts].sort());
  // The two cosmetic and DNS-scoped lines above are dropped by both feeds, so six survive out of
  // the nine that were offered. The count is asserted so the set comparison cannot pass by both
  // feeds silently returning nothing.
  assert.equal(unboundHosts.size, 6);
});
