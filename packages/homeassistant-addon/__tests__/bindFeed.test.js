import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindRpzRecordsFromRule,
  renderBindRpzFeed,
  rulesToBindRpzRecords,
  bindRpzRecordCount,
} from '../bindFeed.js';

test('emits the blocking pair — the name and the wildcard — for every block shape', () => {
  for (const rule of ['||doubleclick.net^', '0.0.0.0 doubleclick.net', 'address=/doubleclick.net/0.0.0.0', 'doubleclick.net']) {
    assert.deepEqual(
      bindRpzRecordsFromRule(rule),
      ['doubleclick.net CNAME .', '*.doubleclick.net CNAME .'],
      `a bare trigger for ${rule} would match the name only and let every subdomain resolve`,
    );
  }
});

test('emits the passthru pair for an allow rather than dropping it', () => {
  assert.deepEqual(
    bindRpzRecordsFromRule('@@||allowed.example.com^'),
    ['allowed.example.com CNAME rpz-passthru.', '*.allowed.example.com CNAME rpz-passthru.'],
  );
});

test('drops lines that are not DNS records', () => {
  assert.deepEqual(bindRpzRecordsFromRule('! a comment'), []);
  assert.deepEqual(bindRpzRecordsFromRule('[Adblock Plus 2.0]'), []);
  assert.deepEqual(bindRpzRecordsFromRule('example.com##.ad-banner'), []);
  assert.deepEqual(bindRpzRecordsFromRule('||localhost^'), []);
  assert.deepEqual(bindRpzRecordsFromRule('printer.local'), []);
  assert.deepEqual(bindRpzRecordsFromRule('||*.example.com^'), []);
  assert.deepEqual(bindRpzRecordsFromRule(null), []);
});

test('de-duplicates on the host, not the line', () => {
  const records = rulesToBindRpzRecords([
    '||ads.example.com^',
    '0.0.0.0 ads.example.com',
    '||tracker.example.net^',
  ]);
  assert.deepEqual(records, [
    'ads.example.com CNAME .',
    '*.ads.example.com CNAME .',
    'tracker.example.net CNAME .',
    '*.tracker.example.net CNAME .',
  ]);
});

test('a contradictory pair suppresses the block — the allow wins outright', () => {
  // `x CNAME .` and `x CNAME rpz-passthru.` at the same trigger would be two contradictory
  // RRsets, which the draft leaves undefined — so the block is dropped the way the desktop's
  // precedence pass drops it.
  const records = rulesToBindRpzRecords(['||x.example^', '@@||x.example^']);
  assert.deepEqual(records, ['x.example CNAME rpz-passthru.', '*.x.example CNAME rpz-passthru.']);
});

test('a child allow survives a blocked parent — longest match, not order', () => {
  const records = rulesToBindRpzRecords(['||parent.example^', '@@||child.parent.example^']);
  assert.ok(records.includes('parent.example CNAME .'));
  assert.ok(records.includes('*.parent.example CNAME .'));
  assert.ok(records.includes('child.parent.example CNAME rpz-passthru.'));
  assert.ok(records.includes('*.child.parent.example CNAME rpz-passthru.'));
});

test('survives a missing or malformed feed without throwing', () => {
  assert.deepEqual(rulesToBindRpzRecords(null), []);
  assert.deepEqual(rulesToBindRpzRecords('not-an-array'), []);
  assert.deepEqual(rulesToBindRpzRecords([null, 42, {}]), []);
});

test('renders a zone that loads: semicolon comments and the SOA preamble', () => {
  const feed = renderBindRpzFeed(['||ads.example.com^'], {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  const lines = feed.split('\n');

  assert.ok(lines[0].startsWith('; '), 'a zone file comment is `;` — `#` is a parse error there');
  assert.ok(feed.includes('$TTL 3600'));
  assert.ok(feed.includes('@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )'));
  assert.ok(feed.includes('@ IN NS localhost.'));
  // The named.conf recipe travels with the artifact, commented in zone-file syntax.
  assert.ok(feed.includes(';   zone "rpz.blockingmachine" { type master; file "db.blockingmachine.rpz"; };'));
  assert.ok(feed.includes(';   response-policy { zone "rpz.blockingmachine"; };'));
  assert.equal(lines.at(-1), '');
});

test('every non-comment line is a directive or a policy record', () => {
  const feed = renderBindRpzFeed(['||a.example^', '@@||b.example^', 'x.example##.ad']);
  for (const line of feed.split('\n')) {
    if (line === '' || line.startsWith(';')) continue;
    assert.match(line, /^\$TTL \d+$|^@ IN (?:SOA|NS) |^(?:\*\.)?[a-z0-9.-]+ CNAME (?:\.|rpz-passthru\.)$/);
  }
});

test('the count helper reports rendered records, not input lines', () => {
  assert.equal(bindRpzRecordCount(['||a.example^', '0.0.0.0 a.example', '@@||b.example^']), 4);
  assert.equal(bindRpzRecordCount(null), 0);
});
