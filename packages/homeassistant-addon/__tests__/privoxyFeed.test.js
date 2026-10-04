import test from 'node:test';
import assert from 'node:assert/strict';
import {
  privoxyPatternFromRule,
  renderPrivoxyFeed,
  rulesToPrivoxyPatterns,
  privoxyPatternCount,
} from '../privoxyFeed.js';

test('translates every block shape the feed can contain into a dotted pattern', () => {
  assert.deepEqual(privoxyPatternFromRule('||doubleclick.net^'), { pattern: '.doubleclick.net', allowed: false });
  assert.deepEqual(privoxyPatternFromRule('0.0.0.0 telemetry.example.com'), { pattern: '.telemetry.example.com', allowed: false });
  assert.deepEqual(privoxyPatternFromRule('address=/ads.example.com/0.0.0.0'), { pattern: '.ads.example.com', allowed: false });
  assert.deepEqual(privoxyPatternFromRule('plain-adserver.com'), { pattern: '.plain-adserver.com', allowed: false });
});

test('keeps the leading dot — a bare host would match itself only', () => {
  // `.example.com` covers the domain and every subdomain; `example.com` would leave the
  // subdomains resolving, which is the same under-block the BIND wildcard pair fixes.
  const { pattern } = privoxyPatternFromRule('||example.com^');
  assert.ok(pattern.startsWith('.'));
});

test('marks allows rather than dropping them — the action file can express a bypass', () => {
  assert.deepEqual(privoxyPatternFromRule('@@||allowed.example.com^'), { pattern: '.allowed.example.com', allowed: true });
  assert.deepEqual(privoxyPatternFromRule('@@||allowed.example.com^$important'), { pattern: '.allowed.example.com', allowed: true });
});

test('drops lines that are not URL patterns', () => {
  assert.equal(privoxyPatternFromRule('! a comment'), null);
  assert.equal(privoxyPatternFromRule('[Adblock Plus 2.0]'), null);
  assert.equal(privoxyPatternFromRule('example.com##.ad-banner'), null);
  assert.equal(privoxyPatternFromRule('||localhost^'), null);
  assert.equal(privoxyPatternFromRule('printer.local'), null);
  assert.equal(privoxyPatternFromRule('||*.example.com^'), null);
  assert.equal(privoxyPatternFromRule(''), null);
  assert.equal(privoxyPatternFromRule(null), null);
});

test('blocks and allows land in separate, individually sorted groups', () => {
  const { blocks, allows } = rulesToPrivoxyPatterns([
    '||zeta.example^',
    '@@||alpha.example^',
    '||beta.example^',
    '@@||yoke.example^',
  ]);
  assert.deepEqual(blocks, ['.beta.example', '.zeta.example']);
  assert.deepEqual(allows, ['.alpha.example', '.yoke.example']);
});

test('de-duplicates the same block written two different ways', () => {
  const { blocks } = rulesToPrivoxyPatterns([
    '||ads.example.com^',
    '0.0.0.0 ads.example.com',
    'address=/ads.example.com/0.0.0.0',
  ]);
  assert.deepEqual(blocks, ['.ads.example.com']);
});

test('a contradictory pair resolves to the allow, matching the Shadowrocket feed', () => {
  // `||x^` + `@@||x^` in the same feed: Shadowrocket emits both and first-match-wins answers
  // DIRECT. The action file emits both and last-match-wins answers -block. Same verdict.
  const { blocks, allows } = rulesToPrivoxyPatterns(['||x.example^', '@@||x.example^']);
  assert.deepEqual(blocks, ['.x.example']);
  assert.deepEqual(allows, ['.x.example']);
});

test('survives a missing or malformed feed without throwing', () => {
  assert.deepEqual(rulesToPrivoxyPatterns(null), { blocks: [], allows: [] });
  assert.deepEqual(rulesToPrivoxyPatterns('not-an-array'), { blocks: [], allows: [] });
  assert.deepEqual(rulesToPrivoxyPatterns([null, 42, {}]), { blocks: [], allows: [] });
});

test('renders the block section before the patterns and the bypass section after', () => {
  const feed = renderPrivoxyFeed(['||a.example^', '@@||b.a.example^'], {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  const lines = feed.split('\n');

  const blockIdx = lines.indexOf('{+block{Blockingmachine Blocklist}}');
  const bypassIdx = lines.indexOf('{-block}');
  assert.ok(blockIdx > -1, 'a block section has to open before any pattern');
  assert.ok(bypassIdx > blockIdx, 'last match wins — bypasses must come after the blocks');
  assert.ok(lines.indexOf('.a.example') > blockIdx && lines.indexOf('.a.example') < bypassIdx);
  assert.ok(lines.indexOf('.b.a.example') > bypassIdx);
});

test('omits the bypass section entirely when nothing is allowed', () => {
  const feed = renderPrivoxyFeed(['||a.example^']);
  assert.ok(!feed.includes('{-block}'));
});

test('renders a comment header with the real pattern count', () => {
  const feed = renderPrivoxyFeed(['||a.example^', '@@||b.example^'], {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  const lines = feed.split('\n');
  assert.equal(lines[0], '# Blockingmachine — Privoxy action file');
  assert.equal(lines[2], '# Patterns: 1 blocked, 1 allowed');
  assert.equal(lines.at(-1), '');
});

test('every rendered line is a comment, a section marker, or a dotted host pattern', () => {
  const feed = renderPrivoxyFeed(['||a.example^', '@@||b.example^', '! comment', 'x.example##.ad']);
  for (const line of feed.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('{+') || line.startsWith('{-')) continue;
    assert.match(line, /^\.[a-z0-9.-]+$/);
  }
});

test('the count helper reports rendered patterns, not input lines', () => {
  assert.equal(privoxyPatternCount(['||a.example^', '0.0.0.0 a.example', '@@||b.example^']), 2);
  assert.equal(privoxyPatternCount(null), 0);
});
