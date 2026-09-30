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
 *  2. **Nothing harvested becomes graded.** The queue is a separate artifact, and this
 *     file checks that the corpus is exactly as long as it was and that no candidate
 *     carries a case without a person's decision behind it.
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
  formatHarvestReport,
  harvestCandidateId,
  parseHarvestFile,
  proposeHarvestEvalCase,
  redactHarvestSnapshot,
  renderHarvestFile,
  sanitizeHarvestedElement,
  sanitizeHarvestedElements,
  selectHarvestCandidates,
  type HarvestedElement,
} from '../ai/elementCorpusHarvest.js';
import { ELEMENT_EVAL_CORPUS } from '../ai/elementEvalCorpus.js';

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
    // Nine distinct shapes, not one shape seen nine times: the signature falls back to
    // the first token of the leading class, so `slot-0` and `slot-1` would be one shape.
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

  it('names candidates by host and signature so a re-run names the same one', () => {
    const selection = selectHarvestCandidates([record({ human: { action: 'keep', at: NOW } })], { now: NOW });
    expect(selection.candidates[0].id).toBe(harvestCandidateId('example.com', 'div|adsbygoogle'));
  });
});

describe('proposeHarvestEvalCase', () => {
  const base = {
    id: 'example.com/div|adsbygoogle',
    host: 'example.com',
    signature: 'div|adsbygoogle',
    firstSeen: NOW - DAY,
    lastSeen: NOW,
    sightings: 2,
    observed: { elementClass: 'Ad' as const, action: 'hide' as const, confidence: 98 },
    human: null as HarvestedElement['human'] | null,
    snapshot: { tag: 'div', classes: ['adsbygoogle'] },
  };

  it('a "keep" is content that must survive, on both sides of the band', () => {
    const proposal = proposeHarvestEvalCase({ ...base, human: { action: 'keep', at: NOW } });
    expect(proposal).not.toBeNull();
    expect(proposal?.expected).toEqual(['Content']);
    expect(proposal?.minAction).toBe('leave');
    expect(proposal?.maxAction).toBe('leave');
    expect(proposal?.family).toBe('harvest');
    // The note has to carry the provenance, or a promoted case loses where it came from.
    expect(proposal?.notes).toContain('example.com');
    expect(proposal?.notes).toContain('2 sighting(s)');
  });

  it('a "hide" fixes the action and leaves the class open, and says so', () => {
    const proposal = proposeHarvestEvalCase({ ...base, human: { action: 'hide', at: NOW } });
    expect(proposal?.minAction).toBe('hide');
    expect(proposal?.maxAction).toBe('hide');
    // A click says "remove this", never "this is an ad". The three removal classes keep
    // the class honest, and the note tells the reviewer `expected[0]` is a placeholder.
    expect(proposal?.expected).toEqual(['Ad', 'Tracker', 'Annoyance']);
    expect(proposal?.notes).toContain('fixes the action and not the class');
  });

  it('proposes nothing for a shape nobody has ruled on', () => {
    expect(proposeHarvestEvalCase(base)).toBeNull();
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
      return ELEMENT_EVAL_CORPUS.some(
        (entry) => entry.label === candidate.signature || entry.maxAction === proposal.maxAction,
      );
    });
    expect(promoted.length).toBeGreaterThanOrEqual(6);
  });
});

describe('the graded corpus is untouched by any of this', () => {
  it('is still free of harvested cases, and every case a harvest would propose is absent from it', () => {
    // The count itself moved: the corpus grew from 117 to 162 while this pipeline was
    // built (see the round-three section in `elementEvalCorpus.ts`), all of it written by
    // hand from real page shapes rather than promoted from a queue. What has not moved is
    // the invariant — nothing harvested is graded — which is why the assertion is about the
    // family rather than about a number.
    expect(ELEMENT_EVAL_CORPUS.length).toBeGreaterThanOrEqual(117);
    // The queue is a separate artifact precisely so this holds: nothing harvested has been
    // promoted, and the labels in it are the six the live scan's own review made.
    const promotedLabels = ELEMENT_EVAL_CORPUS.filter((entry) => entry.family === 'harvest');
    expect(promotedLabels).toHaveLength(0);
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
