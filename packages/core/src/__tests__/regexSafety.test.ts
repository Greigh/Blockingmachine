/**
 * Tests for `refusedRegexReason`, the structural precheck that stands between a downloaded
 * `/regex/` rule and an engine with no step budget.
 *
 * The refused shapes are the provable ones: a quantifier over a quantified group, a nullable
 * group under repetition, and a quantified alternation whose branches can begin on the same
 * character. Everything else — including the ordinary `(?:^|\.)` anchors a real list carries —
 * has to be admitted, because a refusal is a rule that never runs.
 */

import { describe, expect, test } from '@jest/globals';
import { refusedRegexReason, MAX_REGEX_PATTERN_LENGTH } from '../regexSafety.js';
import { compileRuleSet } from '../ai/domainEvaluator.js';
import { requestUrlMatcher } from '../coverage.js';

describe('refusedRegexReason', () => {
  test('refuses the classic catastrophic shapes', () => {
    expect(refusedRegexReason('^(a+)+$')).toContain('nested repetition');
    expect(refusedRegexReason('^(a|aa)+$')).toContain('partition the same input');
    expect(refusedRegexReason('^(a|a?)+$')).not.toBeNull(); // nullable branch under a loop
    expect(refusedRegexReason('(x+x+)+y')).toContain('nested repetition');
    expect(refusedRegexReason('(\\w+)*$')).toContain('nested repetition');
    expect(refusedRegexReason('(.*)*$')).toContain('empty string'); // `.*` is nullable
    expect(refusedRegexReason('(a?)+b')).toContain('empty string');
    expect(refusedRegexReason('(|x)+')).not.toBeNull(); // an empty branch is nullable
    // A bounded interval over a quantified group is the same shape at a bounded degree —
    // refused on star height rather than trusted, since `{500}` is the same pattern.
    expect(refusedRegexReason('(a+){2}')).toContain('nested repetition');
  });

  test('refuses ambiguous alternations that reach the same input through complements', () => {
    // `[^a]` begins on every character except `a`, so `b` reaches both branches — the same
    // exponential partition as `a|aa`, expressed through a negated class rather than a prefix.
    expect(refusedRegexReason('([^a]|b)+')).toContain('partition the same input');
    // Uppercase shorthands are complements too: `x` is in `\D` and is the literal branch.
    expect(refusedRegexReason('(\\D|x)+')).toContain('partition the same input');
    expect(refusedRegexReason('(\\S|\\w)+')).toContain('partition the same input'); // `\w` ⊂ non-space
    expect(refusedRegexReason('([^\\s]|\\w)+')).toContain('partition the same input'); // `[^\s]` = \S
    expect(refusedRegexReason('([^\\d a-z]|!)+')).toContain('partition the same input'); // '!' is not excluded
  });

  test('admits alternations whose complement branches stay disjoint', () => {
    // `a` is the only character `[^a]` excludes — the branches partition cleanly and the
    // pattern is linear, which is the case the check exists to tell apart from `b|[^a]`.
    expect(refusedRegexReason('(a|[^a])+')).toBeNull();
    expect(refusedRegexReason('(\\D|\\d)+')).toBeNull(); // complement pairs cover without overlap
    expect(refusedRegexReason('(\\W|\\w)+')).toBeNull();
    expect(refusedRegexReason('(x|[^x])+')).toBeNull();
  });

  test('refuses a pattern on length alone', () => {
    expect(refusedRegexReason(`/${'a'.repeat(MAX_REGEX_PATTERN_LENGTH)}/`)).toContain('exceeds');
  });

  test('admits the shapes a real blocklist carries', () => {
    // Anchored prefixes, alternations with disjoint starts, optional groups, bounded repeats.
    expect(refusedRegexReason('(^|\\.)doubleclick\\.net$')).toBeNull();
    expect(refusedRegexReason('(?:^|\\.)ads?\\.')).toBeNull();
    expect(refusedRegexReason('banner|popup|tracking')).toBeNull();
    expect(refusedRegexReason('(banner|popup)-?\\d+')).toBeNull();
    expect(refusedRegexReason('(ab|ac)+')).toBeNull(); // shared literal start is disjoint after it
    expect(refusedRegexReason('(a|b)?c')).toBeNull();
    expect(refusedRegexReason('(a+)?b')).toBeNull(); // `?` applies the group once — no loop
    expect(refusedRegexReason('^https?://.*ads\\b')).toBeNull();
    expect(refusedRegexReason('(?<vendor>ad|track)\\.js')).toBeNull();
    expect(refusedRegexReason('^https?://([^/]+\\.)?example\\.com/')).toBeNull();
  });

  test('the refusal lands where a malicious list line would hang the scan', () => {
    // The proof the flag wants: this pattern is what burns time unbounded, so demonstrate the
    // gap — refused before `new RegExp` is even asked.
    const evil = '/^([a-zA-Z]+)*$/';
    expect(refusedRegexReason('^([a-zA-Z]+)*$')).toContain('nested repetition');
    const compiled = compileRuleSet([evil, '||doubleclick.net^']);
    expect(compiled.getRefusedRules()).toEqual([
      { rule: evil, reason: expect.stringContaining('nested repetition') },
    ]);
    // And the scan completes over a corpus that includes it.
    expect(compiled.evaluate('doubleclick.net').verdict).toBe('blocked');
  });
});

describe('rule ingestion', () => {
  test('a refused /regex/ rule is recorded, not compiled, and the rest of the list still works', () => {
    const set = compileRuleSet([
      '||tracker.example^',
      '/^(a+)+$/',
      '/(ad|ads)-[0-9]+\\./', // a legitimate slashed regex — kept
    ]);
    expect(set.getRefusedRules()).toEqual([
      { rule: '/^(a+)+$/', reason: 'a quantified group contains a quantifier (nested repetition)' },
    ]);
    expect(set.evaluate('tracker.example').verdict).toBe('blocked');
    expect(set.evaluate('ad-7.example.com').verdict).toBe('blocked');
    expect(set.getIndexedRuleCount()).toBe(2);
  });

  test('a refused Pi-hole regex is recorded the same way', () => {
    const set = compileRuleSet(['(^|\\.)(x+x+)+y$', '(^|\\.)doubleclick\\.net$']);
    expect(set.getRefusedRules()).toEqual([
      { rule: '(^|\\.)(x+x+)+y$', reason: 'a quantified group contains a quantifier (nested repetition)' },
    ]);
    expect(set.evaluate('www.doubleclick.net').verdict).toBe('blocked');
  });

  test('a refused @@/regex/ exception is recorded rather than dropped silently', () => {
    // A catastrophic exception regex fails the URL matcher *and* the domain extractor — the
    // refusal record is the only place the missing rule can be seen.
    const set = compileRuleSet(['@@/^([^a]|b)+$/', '@@||cdn.example^', '||ads.example^']);
    expect(set.getRefusedRules()).toEqual([
      { rule: '@@/^([^a]|b)+$/', reason: 'a quantified alternation has branches that can partition the same input' },
    ]);
    expect(set.evaluate('ads.example').verdict).toBe('blocked');
    expect(set.evaluate('ads.example.cdn.example').verdict).toBe('exception');
  });
});

describe('requestUrlMatcher', () => {
  test('a catastrophic /regex/ is undecidable rather than run', () => {
    expect(requestUrlMatcher('/^(a+)+$/')).toBeNull();
    expect(requestUrlMatcher('/(a|aa)+/')).toBeNull();
    // A legitimate slashed regex still matches.
    expect(requestUrlMatcher('/ad-?server\\d*\\./')?.('https://ad-server9.example/x')).toBe(true);
  });
});
