/**
 * Harvesting real elements into corpus candidates.
 *
 * The corpus is hand-written, and `docs/element-classifier-live-scan.md` measured what that
 * costs: 52 wrong actionable verdicts across five real pages, every one of them a shape the
 * corpus did not have. So this suite is written to pin the two properties that make the
 * harvest worth having and the one that would make it worthless if it broke:
 *
 *  1. **A model verdict is not a label.** The single most important assertion here is that
 *     an unlabelled record yields no case, however confident the model was. A pipeline that
 *     quietly adopted its own answers would grade perfectly, teach nothing, and look like
 *     the corpus growing.
 *  2. **Nothing harvested becomes graded on its own.** The queue is a separate artifact,
 *     and promotion is a person's explicit act — `--promote` refuses an undecided
 *     candidate, an unstated scope, an unnamed class — which this file pins at the
 *     planner level and in the corpus's harvest-family provenance.
 *  3. **Selection is a queue, not a sample.** Repeats collapse, stale captures drop, one
 *     host cannot fill it, and the order does not depend on the order the records arrived
 *     in — the artifact is generated and diff-checked, so an unstable order would fail CI
 *     on a machine that read the same file differently.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARVEST_TEXT_LIMIT,
  corpusCaseCoversHarvestProposal,
  formatHarvestReport,
  harvestCandidateId,
  harvestLeadingIdentifier,
  harvestProposalIsPromoted,
  parseHarvestFile,
  planHarvestPromotion,
  proposeHarvestEvalCase,
  redactHarvestSnapshot,
  renderHarvestFile,
  sanitizeHarvestedElement,
  sanitizeHarvestedElements,
  selectHarvestCandidates,
  type HarvestedElement,
} from '../ai/elementCorpusHarvest.js';
import {
  ELEMENT_EVAL_CORPUS,
  PROMOTED_CASES_MARKER,
  insertPromotedCaseSource,
  renderElementEvalCaseSource,
  type ElementEvalCase,
} from '../ai/elementEvalCorpus.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** One captured element, with only the fields a test cares about named. */
function record(fields: Partial<HarvestedElement> = {}): HarvestedElement {
  return {
    host: 'example.com',
    capturedAt: NOW - DAY,
    verdict: { elementClass: 'Ad', action: 'hide', confidence: 98 },
    snapshot: { tag: 'div', classes: ['adsbygoogle'] },
    ...fields,
  };
}

describe('redactHarvestSnapshot', () => {
  it('trims long rendered text and leaves everything the classifier reads', () => {
    const text = 'Sponsored content. '.repeat(40);
    const snapshot = {
      tag: 'div',
      classes: ['promo'],
      text,
      width: 300,
      height: 250,
      attributes: [{ name: 'data-ad-slot', value: '1' }],
    };
    const redacted = redactHarvestSnapshot(snapshot);
    expect(redacted.text).toHaveLength(HARVEST_TEXT_LIMIT);
    expect(redacted.classes).toEqual(['promo']);
    expect(redacted.width).toBe(300);
    expect(redacted.attributes).toEqual([{ name: 'data-ad-slot', value: '1' }]);
  });

  it('returns short text untouched, so a case reads as the page did', () => {
    const snapshot = { tag: 'div', text: 'Cookie Policy' };
    expect(redactHarvestSnapshot(snapshot)).toBe(snapshot);
  });
});

describe('sanitizeHarvestedElement', () => {
  it('derives the signature from the snapshot when the capture lost it', () => {
    const clean = sanitizeHarvestedElement(record());
    expect(clean?.signature).toBe('div|adsbygoogle');
    expect(clean?.host).toBe('example.com');
  });

  it('refuses anything that is not a usable capture', () => {
    // A record is only as good as its weakest field: a capture with no tag, no host, no
    // timestamp, an unknown class or a decision of `maybe` is not a case and is not stored.
    expect(sanitizeHarvestedElement({ ...record(), host: '' })).toBeNull();
    expect(sanitizeHarvestedElement({ ...record(), capturedAt: 0 })).toBeNull();
    expect(sanitizeHarvestedElement({ ...record(), snapshot: { tag: '' } })).toBeNull();
    expect(
      sanitizeHarvestedElement({ ...record(), verdict: { elementClass: 'Popup', action: 'hide', confidence: 90 } }),
    ).toBeNull();
    expect(sanitizeHarvestedElement({ ...record(), human: { action: 'maybe', at: NOW } })).toBeNull();
    expect(sanitizeHarvestedElement(null)).toBeNull();
  });

  it('accepts the two decision scopes and rejects any other, so a typo cannot widen a claim', () => {
    // `scope` is where the element-vs-shape choice is recorded; a file hand-edited with
    // `scope: 'forever'` must not read as shape scope, so anything outside the pair
    // makes the record unusable rather than silently element-scoped.
    const elementScoped = sanitizeHarvestedElement({
      ...record(),
      human: { action: 'hide', at: NOW, scope: 'element' },
    });
    expect(elementScoped?.human?.scope).toBe('element');
    const shapeScoped = sanitizeHarvestedElement({
      ...record(),
      human: { action: 'hide', at: NOW, scope: 'shape' },
    });
    expect(shapeScoped?.human?.scope).toBe('shape');
    expect(
      sanitizeHarvestedElement({ ...record(), human: { action: 'hide', at: NOW, scope: 'forever' } }),
    ).toBeNull();
  });

  it('counts the unusable records in a whole file rather than dropping them quietly', () => {
    const { records, rejected } = sanitizeHarvestedElements([record(), 'nonsense', { host: 'x' }]);
    expect(records).toHaveLength(1);
    expect(rejected).toBe(2);
  });
});

describe('selectHarvestCandidates', () => {
  it('labels nothing from the model: an undecided capture produces no case, however sure it was', () => {
    const selection = selectHarvestCandidates(
      [
        record({ verdict: { elementClass: 'Ad', action: 'hide', confidence: 98 } }),
        record({ host: 'other.example', snapshot: { tag: 'img', src: 'https://metrics.example.net/p.gif', width: 1, height: 1 } }),
      ],
      { now: NOW },
    );
    expect(selection.labelled).toBe(0);
    // Both are kept as questions — the model wants to act and nobody has ruled on it.
    expect(selection.unlabelled).toBe(2);
    for (const candidate of selection.candidates) {
      expect(candidate.human).toBeNull();
      expect(proposeHarvestEvalCase(candidate)).toBeNull();
    }
  });

  it('keeps an undecided shape the model wants to leave alone out of the queue', () => {
    const selection = selectHarvestCandidates(
      [
        record({
          host: 'blog.example',
          verdict: { elementClass: 'Content', action: 'leave', confidence: 84 },
          snapshot: { tag: 'article', classes: ['post-body'] },
        }),
      ],
      { now: NOW },
    );
    expect(selection.candidates).toHaveLength(0);
  });

  it('keeps an undecided Content shape the moment a person rules on it', () => {
    // The one case a harvest catches that a verdict-scoped queue cannot: the model was
    // already right, so nothing flagged it, and the person is the only source that would
    // have said so.
    const selection = selectHarvestCandidates(
      [
        record({
          host: 'blog.example',
          verdict: { elementClass: 'Content', action: 'leave', confidence: 84 },
          snapshot: { tag: 'div', classes: ['g-promo-slim'] },
          human: { action: 'keep', at: NOW },
        }),
      ],
      { now: NOW },
    );
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0].human).toEqual({ action: 'keep', at: NOW });
  });

  it('collapses repeat sightings into one candidate without losing a decision', () => {
    const shape = { tag: 'img', classes: ['lazy-photo'], width: 0, height: 0 };
    const selection = selectHarvestCandidates(
      [
        record({ snapshot: shape, capturedAt: NOW - 3 * DAY, human: { action: 'keep', at: NOW } }),
        record({ snapshot: shape, capturedAt: NOW - 2 * DAY }),
        record({ snapshot: shape, capturedAt: NOW - DAY }),
      ],
      { now: NOW },
    );
    expect(selection.candidates).toHaveLength(1);
    const [candidate] = selection.candidates;
    expect(candidate.sightings).toBe(3);
    expect(candidate.firstSeen).toBe(NOW - 3 * DAY);
    expect(candidate.lastSeen).toBe(NOW - DAY);
    // A later undecided sighting must not quietly discard the decision that was made.
    expect(candidate.human).toEqual({ action: 'keep', at: NOW });
    expect(selection.duplicates).toBe(2);
  });

  it('records the most assertive verdict it saw, not the most recent shrug', () => {
    const shape = { tag: 'div', classes: ['slot'] };
    const selection = selectHarvestCandidates(
      [
        record({ snapshot: shape, capturedAt: NOW - 2 * DAY, verdict: { elementClass: 'Ad', action: 'hide', confidence: 98 } }),
        record({ snapshot: shape, capturedAt: NOW - DAY, verdict: { elementClass: 'Content', action: 'leave', confidence: 84 } }),
      ],
      { now: NOW, includeUnlabelled: true },
    );
    expect(selection.candidates[0].observed).toEqual({ elementClass: 'Ad', action: 'hide', confidence: 98 });
  });

  it('drops captures past the freshness window and says how many', () => {
    const selection = selectHarvestCandidates(
      [
        record({ capturedAt: NOW - 10 * DAY, human: { action: 'keep', at: NOW } }),
        record({ capturedAt: NOW - 200 * DAY, human: { action: 'keep', at: NOW }, snapshot: { tag: 'div', classes: ['ancient'] } }),
      ],
      { now: NOW, maxAgeDays: 90 },
    );
    expect(selection.candidates).toHaveLength(1);
    expect(selection.stale).toBe(1);
  });

  it('stops one site from filling the queue, and reports what it deferred', () => {
    // Nine distinct modules, not one module seen nine times: the candidate key is the
    // signature plus the leading class, so each of these is its own entry.
    const shapes = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
    const records = shapes.map((shape) =>
      record({ host: 'noisy.example', snapshot: { tag: 'div', classes: [shape] }, human: { action: 'keep', at: NOW } }),
    );
    const selection = selectHarvestCandidates(records, { now: NOW, perHost: 3 });
    expect(selection.candidates).toHaveLength(3);
    expect(selection.capped).toBe(6);
    expect(selection.hosts).toBe(1);
  });

  it('orders the queue the same way whatever order the records arrived in', () => {
    const build = () => [
      record({ host: 'a.example', snapshot: { tag: 'div', classes: ['a-one'] }, human: { action: 'keep', at: NOW } }),
      record({ host: 'b.example', snapshot: { tag: 'div', classes: ['b-two'] }, human: { action: 'keep', at: NOW } }),
      // Unlabelled and met far more often: it outranks both on sightings, but not a decision.
      ...Array.from({ length: 4 }, () =>
        record({ host: 'c.example', snapshot: { tag: 'div', classes: ['c-three'] } }),
      ),
    ];
    const forward = selectHarvestCandidates(build(), { now: NOW });
    const reversed = selectHarvestCandidates(build().reverse(), { now: NOW });
    expect(forward.candidates.map((c) => c.id)).toEqual(reversed.candidates.map((c) => c.id));
    // A decision outranks frequency, because it is the only thing that can become a case.
    expect(forward.candidates[0].human).not.toBeNull();
    expect(forward.candidates[forward.candidates.length - 1].human).toBeNull();
  });

  it('names candidates by host, signature and leading identifier so a re-run names the same one', () => {
    const selection = selectHarvestCandidates([record({ human: { action: 'keep', at: NOW } })], { now: NOW });
    expect(selection.candidates[0].id).toBe(harvestCandidateId('example.com', 'div|adsbygoogle', 'adsbygoogle'));
    expect(selection.candidates[0].leadingIdentifier).toBe('adsbygoogle');
  });

  it('does not collapse two different modules that share a signature token', () => {
    // Flag 6's live evidence: NYT's `g-promo-slim` strip and `live-updates-promo` rail are
    // both `div|promo` to the classifier, but they are different elements with different
    // decisions owed — a merged candidate would keep only the first snapshot and count
    // the second click as a duplicate sighting of the first.
    const selection = selectHarvestCandidates(
      [
        record({ snapshot: { tag: 'div', classes: ['g-promo-slim'] }, human: { action: 'keep', at: NOW } }),
        record({ snapshot: { tag: 'div', classes: ['live-updates-promo'] }, human: { action: 'keep', at: NOW } }),
      ],
      { now: NOW },
    );
    expect(selection.candidates).toHaveLength(2);
    expect(selection.duplicates).toBe(0);
    // Same signature — the collapse the flag reported — but two separate entries now.
    expect(selection.candidates.map((candidate) => candidate.signature)).toEqual(['div|promo', 'div|promo']);
    expect(selection.candidates.map((candidate) => candidate.sightings)).toEqual([1, 1]);
    expect(new Set(selection.candidates.map((candidate) => candidate.leadingIdentifier))).toEqual(
      new Set(['g-promo-slim', 'live-updates-promo']),
    );
    // Each keeps its own decision and its own snapshot.
    for (const candidate of selection.candidates) {
      expect(candidate.human).toEqual({ action: 'keep', at: NOW });
      expect(candidate.snapshot.classes?.[0]).toBe(candidate.leadingIdentifier);
    }
  });
});

describe('proposeHarvestEvalCase', () => {
  const base = {
    id: 'example.com/div|adsbygoogle/adsbygoogle',
    host: 'example.com',
    signature: 'div|adsbygoogle',
    leadingIdentifier: 'adsbygoogle' as string | null,
    firstSeen: NOW - DAY,
    lastSeen: NOW,
    sightings: 2,
    observed: { elementClass: 'Ad' as const, action: 'hide' as const, confidence: 98 },
    human: null,
    snapshot: { tag: 'div', classes: ['adsbygoogle'] },
  };

  it('a "keep" on one element forbids hiding it, but does not pin the shape at leave', () => {
    const proposal = proposeHarvestEvalCase({ ...base, human: { action: 'keep', at: NOW } });
    expect(proposal).not.toBeNull();
    expect(proposal?.expected).toEqual(['Content']);
    // Element scope — the default a click gives — still makes hiding a defect, but one
    // element's keep cannot forbid the product ever pointing at the shape elsewhere.
    expect(proposal?.maxAction).toBe('suggest');
    expect(proposal?.minAction).toBeUndefined();
    expect(proposal?.harvestScope).toBe('element');
    expect(proposal?.family).toBe('harvest');
    // The note has to carry the provenance, or a promoted case loses where it came from.
    expect(proposal?.notes).toContain('example.com');
    expect(proposal?.notes).toContain('2 sighting(s)');
  });

  it('a "keep" at recorded shape scope pins leave on both sides of the band', () => {
    const proposal = proposeHarvestEvalCase({
      ...base,
      human: { action: 'keep', at: NOW, scope: 'shape' },
    });
    expect(proposal?.minAction).toBe('leave');
    expect(proposal?.maxAction).toBe('leave');
    expect(proposal?.harvestScope).toBe('shape');
  });

  it('a "hide" fixes the action and leaves the class open, and says so', () => {
    const proposal = proposeHarvestEvalCase({ ...base, human: { action: 'hide', at: NOW } });
    // A click says "remove this", never "this is an ad". The three removal classes keep
    // the class honest, and the note tells the reviewer `expected[0]` is a placeholder.
    expect(proposal?.expected).toEqual(['Ad', 'Tracker', 'Annoyance']);
    expect(proposal?.maxAction).toBe('hide');
    expect(proposal?.notes).toContain('the class');
  });

  it('a "hide" click on one element cannot raise the must-hide count on its own', () => {
    // Flag 7's verify: a single element's hide is element-scope evidence, so the proposal
    // floors at `suggest` — the element must be identified, not the shape removed.
    const oneSighting = { ...base, sightings: 1, human: { action: 'hide' as const, at: NOW } };
    const proposal = proposeHarvestEvalCase(oneSighting);
    expect(proposal?.minAction).toBe('suggest');
    expect(proposal?.maxAction).toBe('hide');
    expect(proposal?.harvestScope).toBe('element');
    // Promoting it explicitly — a reviewer records shape scope on the decision — is the
    // only path that produces a must-hide floor.
    const promoted = proposeHarvestEvalCase({
      ...oneSighting,
      human: { action: 'hide' as const, at: NOW, scope: 'shape' as const },
    });
    expect(promoted?.minAction).toBe('hide');
    expect(promoted?.maxAction).toBe('hide');
    expect(promoted?.harvestScope).toBe('shape');
  });

  it('proposes nothing for a shape nobody has ruled on', () => {
    expect(proposeHarvestEvalCase(base)).toBeNull();
  });
});

describe('corpusCaseCoversHarvestProposal', () => {
  // One candidate standing in for a real queue entry, and a shape-scoped `keep`
  // proposal (leave–leave) to match written cases against.
  const candidate = {
    id: 'example.com/div|promo/g-promo-slim',
    host: 'example.com',
    signature: 'div|promo',
    leadingIdentifier: 'g-promo-slim' as string | null,
    firstSeen: NOW - DAY,
    lastSeen: NOW,
    sightings: 1,
    observed: { elementClass: 'Content' as const, action: 'leave' as const, confidence: 84 },
    human: { action: 'keep' as const, at: NOW, scope: 'shape' as const },
    snapshot: { tag: 'div', classes: ['g-promo-slim'] },
  };
  const proposal = {
    label: 'harvest-x',
    family: 'harvest',
    snapshot: candidate.snapshot,
    expected: ['Content' as const],
    maxAction: 'leave' as const,
    minAction: 'leave' as const,
  };
  const corpusCase = (fields: Partial<ElementEvalCase>): ElementEvalCase => ({
    label: 'case',
    family: 'content',
    snapshot: { tag: 'div', classes: ['g-promo-slim'] },
    expected: ['Content'],
    maxAction: 'leave',
    minAction: 'leave',
    ...fields,
  });

  it('matches a written case on signature and leading identifier together', () => {
    expect(corpusCaseCoversHarvestProposal(corpusCase({}), candidate, proposal)).toBe(true);
  });

  it('does not let a case written for one module close a different module’s review', () => {
    // Flag 6's cost, pinned: `event-promo-card` retired both NYT promo modules *and* the
    // Guardian's, because matching stopped at `div|promo`. A case carrying a different
    // leading identifier no longer covers this candidate.
    const otherModule = corpusCase({ snapshot: { tag: 'div', classes: ['live-updates-promo'] } });
    expect(corpusCaseCoversHarvestProposal(otherModule, candidate, proposal)).toBe(false);
  });

  it('falls back to the bare signature when the case names no identifier', () => {
    // A case whose signature token comes from the *tag* itself (`amp-ad`, the corpus's
    // `amp-ad-doubleclick` shape) carries no class or id — it generalises to every module
    // under its signature, which is the flag's "a promoted case still covers the shapes
    // it actually generalises to".
    const tagTokenCase = corpusCase({ snapshot: { tag: 'amp-ad', width: 300, height: 250 } });
    expect(harvestLeadingIdentifier(tagTokenCase.snapshot)).toBeNull();
    const ampCandidate = {
      ...candidate,
      signature: 'amp-ad|ad',
      leadingIdentifier: 'some-amp-wrapper',
      snapshot: { tag: 'amp-ad', classes: ['some-amp-wrapper'] },
    };
    expect(corpusCaseCoversHarvestProposal(tagTokenCase, ampCandidate, proposal)).toBe(true);
  });

  it('does not cover a nameless candidate from a case that names a module', () => {
    const bare = { ...candidate, leadingIdentifier: null, snapshot: { tag: 'div' } };
    expect(corpusCaseCoversHarvestProposal(corpusCase({}), bare, proposal)).toBe(false);
  });

  it('matches the band by containment: a stronger written case drains a weaker claim', () => {
    // Element-scoped keep proposes `leave`–`suggest`; the leave-only corpus case forbids
    // more than the click claimed, so it covers.
    const elementProposal = { ...proposal, minAction: undefined, maxAction: 'suggest' as const };
    expect(corpusCaseCoversHarvestProposal(corpusCase({}), candidate, elementProposal)).toBe(true);
    // The reverse direction does not: a `leave`–`suggest` corpus case cannot cover a
    // leave-only claim — the corpus asserts less than the reviewer recorded.
    const weakerCase = corpusCase({ minAction: undefined, maxAction: 'suggest' });
    expect(corpusCaseCoversHarvestProposal(weakerCase, candidate, proposal)).toBe(false);
  });

  it('harvestProposalIsPromoted reports the queue flag against the real corpus', () => {
    expect(harvestProposalIsPromoted(candidate, proposal, [])).toBe(false);
    expect(harvestProposalIsPromoted(candidate, proposal, [corpusCase({})])).toBe(true);
  });
});

describe('planHarvestPromotion', () => {
  // A labelled candidate standing in for a reviewed queue entry — on a shape the real
  // corpus does not cover, so the "already covered" refusal is tested on its own terms.
  // The planner's job is to say no loudly: every refusal below is a promotion the script
  // must not guess at.
  const labelled = (fields: Partial<HarvestedElement> = {}) =>
    selectHarvestCandidates(
      [record({ snapshot: { tag: 'div', classes: ['harvest-review-target'] }, ...fields })],
      { now: NOW },
    ).candidates[0];
  const hide = labelled({ human: { action: 'hide', at: NOW } });
  const keep = labelled({ human: { action: 'keep', at: NOW, scope: 'element' } });

  it('refuses a candidate nobody has ruled on', () => {
    const unlabelled = selectHarvestCandidates([record()], { now: NOW }).candidates[0];
    expect(() => planHarvestPromotion(unlabelled, ELEMENT_EVAL_CORPUS)).toThrow(/no human decision/);
  });

  it('needs an explicit scope when the record states none', () => {
    expect(() => planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { classes: ['Ad'] })).toThrow(/--scope/);
    expect(() => planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { scope: 'module', classes: ['Ad'] })).toThrow(
      /--scope must be 'element' or 'shape'/,
    );
  });

  it('uses the recorded scope, and refuses a flag that disagrees with it', () => {
    const scoped = labelled({ human: { action: 'hide', at: NOW, scope: 'shape' } });
    const plan = planHarvestPromotion(scoped, ELEMENT_EVAL_CORPUS, { classes: ['Ad'] });
    expect(plan.scope).toBe('shape');
    expect(plan.entry.minAction).toBe('hide');
    expect(plan.entry.harvestScope).toBe('shape');
    expect(() =>
      planHarvestPromotion(scoped, ELEMENT_EVAL_CORPUS, { scope: 'element', classes: ['Ad'] }),
    ).toThrow(/the record says scope 'shape'/);
  });

  it('floors an element-scoped hide at suggest — one click cannot pin the whole shape', () => {
    const plan = planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { scope: 'element', classes: ['Tracker'] });
    expect(plan.scope).toBe('element');
    expect(plan.entry).toMatchObject({
      family: 'harvest',
      expected: ['Tracker'],
      minAction: 'suggest',
      maxAction: 'hide',
      harvestScope: 'element',
    });
  });

  it('makes a hide name its class, and narrows expected to what was named', () => {
    expect(() => planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { scope: 'element' })).toThrow(/--class/);
    expect(() =>
      planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { scope: 'element', classes: ['Content'] }),
    ).toThrow(/removal classes/);
    const plan = planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, {
      scope: 'element',
      classes: ['Ad', 'Annoyance'],
    });
    expect(plan.entry.expected).toEqual(['Ad', 'Annoyance']);
  });

  it('refuses --class on a keep — the decision already fixed the class to Content', () => {
    expect(() => planHarvestPromotion(keep, ELEMENT_EVAL_CORPUS, { classes: ['Ad'] })).toThrow(/keep decision/);
    const plan = planHarvestPromotion(keep, ELEMENT_EVAL_CORPUS);
    expect(plan.entry.expected).toEqual(['Content']);
    expect(plan.entry.maxAction).toBe('suggest');
  });

  it('refuses to promote what the corpus already covers', () => {
    const covering: ElementEvalCase = {
      label: 'already-there',
      family: 'content',
      snapshot: { tag: 'div', classes: ['harvest-review-target'] },
      expected: ['Ad'],
      maxAction: 'hide',
      minAction: 'hide',
    };
    expect(() =>
      planHarvestPromotion(hide, [covering], { scope: 'shape', classes: ['Ad'] }),
    ).toThrow(/already covered by corpus case 'already-there'/);
  });

  it('checks the label is free and is a corpus slug', () => {
    const taken = ELEMENT_EVAL_CORPUS[0].label;
    expect(() =>
      planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { scope: 'element', classes: ['Ad'], label: taken }),
    ).toThrow(/already exists/);
    expect(() =>
      planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, { scope: 'element', classes: ['Ad'], label: 'Not A Slug' }),
    ).toThrow(/corpus slug/);
    const plan = planHarvestPromotion(hide, ELEMENT_EVAL_CORPUS, {
      scope: 'element',
      classes: ['Ad'],
      label: 'my-promoted-case',
      note: 'checked against the live page',
    });
    expect(plan.entry.label).toBe('my-promoted-case');
    expect(plan.entry.notes).toContain('checked against the live page');
  });
});

describe('renderElementEvalCaseSource / insertPromotedCaseSource', () => {
  const entry: ElementEvalCase = {
    label: 'harvest-example-com-div',
    family: 'harvest',
    snapshot: {
      tag: 'iframe',
      id: '3pCheckIframeId',
      src: "https://ad.example/it's-here.html",
      width: 0,
      height: 0,
      inFrame: true,
      crossOriginFrame: true,
      visible: false,
    },
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'suggest',
    harvestScope: 'element',
    notes: "A person's decision",
  };

  it('renders the file’s own snap() literal style, escaping quotes', () => {
    const rendered = renderElementEvalCaseSource(entry);
    expect(rendered).toContain("label: 'harvest-example-com-div'");
    expect(rendered).toContain("family: 'harvest'");
    expect(rendered).toContain(
      "snap('iframe', { id: '3pCheckIframeId', src: 'https://ad.example/it\\'s-here.html', width: 0, height: 0, inFrame: true, crossOriginFrame: true, visible: false })",
    );
    expect(rendered).toContain("expected: ['Tracker']");
    expect(rendered).toContain("maxAction: 'hide'");
    expect(rendered).toContain("minAction: 'suggest'");
    expect(rendered).toContain("harvestScope: 'element'");
    expect(rendered).toContain("notes: 'A person\\'s decision'");
  });

  it('omits the fields a case does not set', () => {
    const minimal = renderElementEvalCaseSource({
      label: 'x',
      family: 'x',
      snapshot: { tag: 'div' },
      expected: ['Content'],
      maxAction: 'leave',
    });
    expect(minimal).not.toMatch(/minAction|harvestScope|notes/);
    expect(minimal).toContain("snap('div')");
  });

  it('carries a resolved CNAME through the rendered literal', () => {
    // The feature's whole evidence would otherwise be silently dropped by the harvest write
    // path — a promoted case re-read later would have lost the field its verdict relied on.
    const rendered = renderElementEvalCaseSource({
      label: 'x',
      family: 'x',
      snapshot: { tag: 'img', src: 'https://metrics.example.com/p.gif', resolvedCname: 'adroll.com' },
      expected: ['Tracker'],
      maxAction: 'suggest',
    });
    expect(rendered).toContain("resolvedCname: 'adroll.com'");
  });

  it('appends the case under the corpus marker, inside the array', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'ai', 'elementEvalCorpus.ts'), 'utf8');
    const inserted = insertPromotedCaseSource(source, renderElementEvalCaseSource(entry));
    const markerAt = inserted.indexOf(PROMOTED_CASES_MARKER);
    const caseAt = inserted.indexOf("label: 'harvest-example-com-div'");
    const arrayClose = inserted.indexOf('\n];', markerAt);
    expect(markerAt).toBeGreaterThan(-1);
    expect(caseAt).toBeGreaterThan(markerAt);
    expect(caseAt).toBeLessThan(arrayClose);
  });

  it('refuses to insert where the marker is missing rather than guessing', () => {
    expect(() => insertPromotedCaseSource('const a = [];\n', 'x')).toThrow(/marker/);
  });
});

describe('the harvest file format', () => {
  it('round-trips records and keeps the comment header', () => {
    const records = [record({ human: { action: 'keep', at: NOW } }), record({ host: 'b.example' })];
    const text = renderHarvestFile(records, 'A note\n\nAnd another line.');
    // Blank lines in a comment header are dropped rather than written as bare `#`, so the
    // header does not fill up with empty comment lines.
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(2);
    const parsed = parseHarvestFile(text);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.rejected).toBe(0);
    expect(parsed.comments).toEqual(['A note', 'And another line.']);
    expect(parsed.records[0].human).toEqual({ action: 'keep', at: NOW });
  });

  it('redacts on write, so a file cannot hold more of a page than the classifier reads', () => {
    const text = renderHarvestFile([
      record({ snapshot: { tag: 'div', text: 'Article body. '.repeat(200) } }),
    ]);
    const parsed = parseHarvestFile(text);
    expect(parsed.records[0].snapshot.text).toHaveLength(HARVEST_TEXT_LIMIT);
  });

  it('skips a corrupt line and keeps the records around it', () => {
    const good = JSON.stringify(record());
    const parsed = parseHarvestFile([good, '{not json', JSON.stringify({ host: 'x' }), good].join('\n'));
    expect(parsed.records).toHaveLength(2);
    expect(parsed.rejected).toBe(2);
  });
});

describe('the committed live-scan harvest', () => {
  // The pipeline is only worth anything if it runs on data nobody wrote for it. These
  // records are the five live pages the model got wrong, and the artifact is generated
  // from them by `npm run harvest:elements`, so the numbers below are the measurement.
  const file = readFileSync(join(process.cwd(), 'src', 'ai', 'data', 'element-harvest.jsonl'), 'utf8');
  const { records } = parseHarvestFile(file);

  it('reads the real capture, with every record decided by a person', () => {
    expect(records.length).toBeGreaterThanOrEqual(11);
    expect(records.every((entry) => entry.human !== undefined)).toBe(true);
  });

  it('surfaces the spurious hides the live scan found, as shapes already in the corpus', () => {
    const selection = selectHarvestCandidates(records, { now: Date.parse('2026-09-30T12:00:00.000Z') });
    // The four shapes the model hid outright and the two it merely flagged are all present
    // as candidates; six of them are the cases the scan's fixes added to the corpus.
    expect(selection.candidates.length).toBeGreaterThanOrEqual(9);
    const promoted = selection.candidates.filter((candidate) => {
      const proposal = proposeHarvestEvalCase(candidate);
      if (!proposal) return false;
      return harvestProposalIsPromoted(candidate, proposal, ELEMENT_EVAL_CORPUS);
    });
    expect(promoted.length).toBeGreaterThanOrEqual(6);
  });

  it('queues NYT’s two `div|promo` modules as two candidates — flag 6’s verify', () => {
    const selection = selectHarvestCandidates(records, { now: Date.parse('2026-09-30T12:00:00.000Z') });
    const promos = selection.candidates.filter(
      (candidate) => candidate.host === 'nytimes.com' && candidate.signature === 'div|promo',
    );
    // `.g-promo-slim` and `.live-updates-promo` are different modules that share the
    // signature token. Before the key carried the leading identifier they were one
    // candidate with two sightings and the second click read as a duplicate of the first.
    expect(promos.map((candidate) => candidate.leadingIdentifier).sort()).toEqual([
      'g-promo-slim',
      'live-updates-promo',
    ]);
    expect(promos.map((candidate) => candidate.sightings)).toEqual([1, 1]);
    // And neither is retired by `event-promo-card`, whose leading class is `event-promo`:
    // a case written for one module does not close another module's review.
    for (const promo of promos) {
      const proposal = proposeHarvestEvalCase(promo);
      expect(proposal).not.toBeNull();
      expect(harvestProposalIsPromoted(promo, proposal!, ELEMENT_EVAL_CORPUS)).toBe(false);
    }
  });
});

describe('the graded corpus is untouched by the pipeline itself', () => {
  it('carries no harvested case unless a person promoted it with a recorded scope', () => {
    // The count itself moved: the corpus grew from 117 to 162 to 220 to 222 while this pipeline
    // was built (see the round-three and round-four sections in `elementEvalCorpus.ts`).
    // Promotion no longer happens by hand — `--promote` writes the case — but the write
    // is still a review, not a pipeline: nothing harvested is graded unless a person ran
    // that command, and the case it writes must carry the scope it asserted.
    expect(ELEMENT_EVAL_CORPUS.length).toBeGreaterThanOrEqual(117);
    const promoted = ELEMENT_EVAL_CORPUS.filter((entry) => entry.family === 'harvest');
    for (const entry of promoted) {
      // A promoted case without a recorded scope is a case that bypassed the review path —
      // `harvestScope` is the provenance the planner insists on before it renders anything.
      expect(entry.harvestScope).toBeDefined();
    }
  });
});

describe('formatHarvestReport', () => {
  it('says what the run did and what it will not do', () => {
    const selection = selectHarvestCandidates(
      [record({ human: { action: 'keep', at: NOW } }), record({ capturedAt: NOW - 400 * DAY })],
      { now: NOW },
    );
    const report = formatHarvestReport(selection);
    expect(report).toContain('1 labelled, 0 unlabelled');
    expect(report).toContain('1 stale capture(s)');
    expect(report).toContain("a person's decision is the only label");
    expect(report).toContain('not graded');
  });
});
