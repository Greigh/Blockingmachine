import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveFormatOutputs,
  deriveDnsAdGuardLines,
  stampHeaders,
} from '../scripts/update.js';

const NOW = new Date('2026-10-16T12:00:00Z');

const source = [
  '! Title: Fixture',
  '! Last updated: 2000-01-01T00:00:00Z',
  '! Rules count: 0',
  '',
  '||ads.example^',
  '||tracker.example^',
  '@@||allowed.example^',
  '@@||parent.example^',
  '||sub.parent.example^',
  '||cdn.example^$third-party',
  '||wild*.example^',
  '0.0.0.0 hostsline.example',
  '127.0.0.1 loopback.example',
  '||sub.allowed.example^',
];

function out(lines = source) {
  return deriveFormatOutputs(lines, NOW);
}

test('a blocked domain reaches every format with the right shape', () => {
  const o = out();
  assert.ok(o.hostsRules.includes('0.0.0.0 ads.example'));
  assert.ok(o.dnsmasqRules.includes('address=/ads.example/0.0.0.0'));
  assert.ok(o.unboundRules.includes('local-zone: "ads.example" redirect'));
  assert.ok(o.unboundRules.includes('local-data: "ads.example A 0.0.0.0"'));
  assert.ok(o.namedRules.includes('ads.example CNAME .'));
  assert.ok(o.privoxyRules.includes('.ads.example'));
  assert.ok(o.shadowrocketRules.includes('DOMAIN-SUFFIX,ads.example,REJECT'));
});

test('exception domains suppress the exact host and its subdomains everywhere', () => {
  const o = out();
  for (const blocked of [
    '0.0.0.0 allowed.example',
    'address=/allowed.example/0.0.0.0',
    '0.0.0.0 sub.allowed.example',
    'address=/sub.allowed.example/0.0.0.0',
    'allowed.example CNAME .',
    'sub.allowed.example CNAME .',
    'DOMAIN-SUFFIX,allowed.example,REJECT',
  ]) {
    assert.ok(
      ![o.hostsRules, o.dnsmasqRules, o.namedRules, o.shadowrocketRules]
        .some((r) => r.includes(blocked)),
      `${blocked} must not appear`,
    );
  }
  // But the exception itself is documented in each artifact.
  assert.ok(o.hostsRules.includes('# EXCEPTION: @@||allowed.example^'));
  assert.ok(o.dnsmasqRules.includes('server=/allowed.example/#'));
  assert.ok(o.unboundRules.includes('local-zone: "allowed.example" transparent'));
  assert.ok(o.namedRules.includes('; EXCEPTION: @@||allowed.example^'));
});

test('a child exception does not spare the parent', () => {
  // @@||child.parent.example^ suppresses the child only — the blocked parent
  // stays blocked (an exception narrows downward, never upward).
  const o = out(['||parent.example^', '@@||child.parent.example^']);
  assert.ok(o.hostsRules.includes('0.0.0.0 parent.example'));
  assert.ok(!o.hostsRules.includes('0.0.0.0 child.parent.example'));
});

test('$-modifier rules are skipped everywhere and land in the audit', () => {
  const o = out();
  for (const format of [
    o.hostsRules, o.dnsmasqRules, o.unboundRules,
    o.namedRules, o.privoxyRules, o.shadowrocketRules,
  ]) {
    assert.ok(!format.some((l) => l.includes('cdn.example')), 'cdn.example skipped');
  }
  assert.ok(o.skippedModifierRules.includes('||cdn.example^$third-party'));
});

test('wildcard domains never convert to host-style entries', () => {
  const o = out();
  for (const format of [
    o.hostsRules, o.dnsmasqRules, o.unboundRules,
    o.namedRules, o.privoxyRules, o.shadowrocketRules,
  ]) {
    assert.ok(!format.some((l) => l.includes('*')), 'wildcards must not be emitted');
  }
});

test('hosts-format source lines reach only hosts and dnsmasq artifacts', () => {
  const o = out();
  assert.ok(o.hostsRules.includes('0.0.0.0 hostsline.example'));
  assert.ok(o.hostsRules.includes('0.0.0.0 loopback.example'));
  assert.ok(o.dnsmasqRules.includes('address=/hostsline.example/0.0.0.0'));
  // Zone formats cannot consume hosts-format lines — they must not appear.
  assert.ok(!o.unboundRules.some((l) => l.includes('hostsline.example')));
  assert.ok(!o.namedRules.some((l) => l.includes('hostsline.example')));
  assert.ok(!o.privoxyRules.some((l) => l.includes('hostsline.example')));
  assert.ok(!o.shadowrocketRules.some((l) => l.includes('hostsline.example')));
});

test('rule counts land in the header placeholders', () => {
  // ads + tracker + the two hosts-format lines = 4; the suppressed subdomains
  // (sub.allowed.example, sub.parent.example) and the wildcard/$-modifier rules
  // never count. Zone formats don't consume hosts lines, so they carry 2.
  const o = out();
  assert.ok(o.hostsRules.includes('# Rules count: 4'), o.hostsRules.join('\n'));
  assert.ok(o.dnsmasqRules.includes('# Rules count: 4'));
  assert.ok(o.unboundRules.includes('# Rules count: 2'));
  assert.ok(o.namedRules.includes('; Rules count: 2'));
  assert.ok(o.privoxyRules.includes('# Rules count: 2'));
  assert.ok(o.shadowrocketRules.includes('# Rules count: 2'));
});

test('BIND RPZ artifact is a loadable zone, not a stanza list', () => {
  const o = out();
  const idx = o.namedRules.indexOf('$TTL 3600');
  assert.ok(idx > 0);
  assert.ok(o.namedRules.some((l) => l.startsWith('@ IN SOA')));
  assert.ok(o.namedRules.some((l) => l.startsWith('@ IN NS')));
  // Blocked names are CNAME-to-NXDOMAIN policy records.
  assert.ok(o.namedRules.includes('tracker.example CNAME .'));
});

test('the DNS subset drops browser-only rules and keeps DNS-consumable ones', () => {
  const content = [
    '! Title: Fixture',
    '||dns.example^',
    '||cosmetic.example^$third-party',
    'example.com##.ad-banner',
    '@@||allowed.example^',
    '0.0.0.0 hostfmt.example',
  ].join('\n');
  const lines = deriveDnsAdGuardLines(content, NOW);
  assert.ok(lines.includes('||dns.example^'));
  assert.ok(lines.includes('@@||allowed.example^'));
  assert.ok(lines.includes('0.0.0.0 hostfmt.example'));
  assert.ok(!lines.includes('||cosmetic.example^$third-party'));
  assert.ok(!lines.includes('example.com##.ad-banner'));
});

test('stampHeaders rewrites timestamp and recomputes the count from shipped lines', () => {
  const stamped = stampHeaders(
    ['! Last updated: old', '! Rules count: 999', '||a.example^', '||b.example^'],
    NOW,
  );
  assert.equal(stamped[0], `! Last updated: ${NOW.toISOString()}`);
  assert.equal(stamped[1], '! Rules count: 2');
});
