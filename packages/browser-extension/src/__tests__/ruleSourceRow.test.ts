/**
 * The popup row that names the installed list's source. Static markup is the contract here: a user
 * on the measured hot set is running narrower protection than the full export, and a label that
 * rendered the two identically — or hedged the hot case into a bare token — would be the same
 * failure as not surfacing it at all.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { RuleSourceRow } from '../popup/RuleSourceRow.js';
import type { AppliedRuleSource } from '../shared/types.js';

function record(overrides: Partial<AppliedRuleSource> = {}): AppliedRuleSource {
  return {
    source: 'full',
    appliedAt: 1_700_000_000_000,
    installed: 28_500,
    offered: 31_219,
    fullOverflow: 0,
    ...overrides,
  };
}

describe('RuleSourceRow', () => {
  it('names the full export plainly when the full list installed', () => {
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, { record: record(), appliedLabel: '3m ago' }),
    );

    expect(html).toContain('Rule source');
    expect(html).toContain('full export');
    expect(html).toContain('3m ago');
    expect(html).toContain('mini-status ok');
    expect(html).not.toContain('measured hot set');
  });

  it('names the measured hot set as warn-toned and carries the pruned count it stands in for', () => {
    // The hover text is where "narrower" becomes a number: a reader hovering "measured hot set"
    // sees how much of the full export it is covering for.
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, {
        record: record({ source: 'hot', installed: 17, offered: 17, fullOverflow: 98_500 }),
        appliedLabel: 'just now',
      }),
    );

    expect(html).toContain('measured hot set');
    expect(html).toContain('mini-status warn');
    expect(html).toContain('98,500');
    expect(html).not.toContain('>full export<');
  });

  it('says the full list is the compiled export, not merely "not the hot set"', () => {
    // A pruned full export and a hot set can both leave few rules installed. The label's job is
    // to end that ambiguity in the user's favour, so the full case names what it is.
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, { record: record(), appliedLabel: 'x' }),
    );

    expect(html).toContain('title="the full compiled export"');
  });

  it('names a stale hot set even when the full export is the installed source', () => {
    // The case this whole comparison exists for: the export fits and wins, the hot set idles —
    // and three of its rules are absent from the list it was served beside. Silencing the count
    // because the hot set lost would hide exactly the staleness a deployment needs to catch.
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, {
        record: record({
          source: 'full',
          hotSet: { offered: 17, overflow: 0, absentFromFull: 3, shipped: 17, ownRules: 0 },
        }),
        appliedLabel: '1h ago',
      }),
    );

    expect(html).toContain('full export');
    expect(html).toContain('3 stale');
    expect(html).toContain('mini-status warn');
    expect(html).toContain('measured against an older list');
  });

  it('names the measured-benefit trim on a cut full export', () => {
    // A full export that had to drop 98,000 rules is not "the full compiled export" — the
    // hover has to say the cut happened and how it was ordered, or the label reads as total
    // protection while a fifth of the list is gone.
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, {
        record: record({
          installed: 28_500,
          offered: 127_820,
          fullOverflow: 99_320,
          tierTrimmed: true,
        }),
        appliedLabel: '2m ago',
      }),
    );

    expect(html).toContain('full export');
    expect(html).toContain('measured tier benefit');
    expect(html).toContain('28,500');
    expect(html).toContain('99,320');
  });

  it('names own-ledger provenance when the hot set drew on the deployment\'s own hits', () => {
    // Flag 17's evidence: a hot set built from this browser's own ledger is a different claim
    // than the scripted sessions the shipped set was measured on, and the hover says which.
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, {
        record: record({
          source: 'hot',
          installed: 17,
          offered: 17,
          fullOverflow: 98_500,
          hotSet: { offered: 17, overflow: 0, absentFromFull: 0, shipped: 17, ownRules: 5 },
        }),
        appliedLabel: 'x',
      }),
    );

    expect(html).toContain('measured hot set');
    expect(html).toContain('5 of them were measured on this browser&#x27;s own hit ledger');
  });

  it('does not cry stale on a clean hot set', () => {
    const html = renderToStaticMarkup(
      createElement(RuleSourceRow, {
        record: record({ hotSet: { offered: 17, overflow: 0, absentFromFull: 0, shipped: 17, ownRules: 0 } }),
        appliedLabel: 'x',
      }),
    );

    expect(html).not.toContain('stale');
    expect(html).toContain('mini-status ok');
  });
});
