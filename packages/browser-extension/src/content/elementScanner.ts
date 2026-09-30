/**
 * Page scanner for the element Mini-AI.
 *
 * Turns "the model classifies one element" into "the extension finds the ads on
 * this page for you". It runs in two passes on purpose:
 *
 *  1. **Cheap pass.** {@link isCandidateElement} filters the document down to nodes
 *     that could plausibly matter, then each one is snapshotted *without* computed
 *     style — the one read that forces layout for the whole document.
 *  2. **Confirmation pass.** Only elements the cheap pass found evidence for, and
 *     only up to a fixed budget, are re-snapshotted with computed style so fixed
 *     overlays (consent walls, modals) can be told apart from inline markup.
 *
 * The clusters it produces are grouped by the classifier's own signature token, and
 * each group's selector goes through the shared cosmetic-rule validator before it is
 * ever offered as something to block.
 */

import {
  MiniAiElementClassifier,
  type ElementClass,
  type ElementPrediction,
  type ElementSnapshot,
} from '@blockingmachine/core/element-ai';
import { validateCosmeticSelector } from '../shared/cosmeticRules.js';
import { elementAiEvidenceRows, elementAiLine, type ElementAiEvidenceRow } from '../shared/elementAiDisplay.js';
import { isCandidateElement, snapshotElement } from './elementSnapshot.js';
import { BM_UI_ATTRIBUTE, isOwnUi } from './pageToast.js';
import { createSelectorEngine, type SelectorEngine } from './selectorEngine.js';

export interface ElementAiCandidate {
  element: Element;
  prediction: ElementPrediction;
  /**
   * The snapshot the verdict was actually computed from.
   *
   * The two-pass scan builds a cheap snapshot and may replace it with a
   * computed-style one, so a harvest that re-read the element afterwards could
   * record facts the model never saw. Keeping the snapshot means a captured
   * element describes the same evidence as the verdict beside it.
   */
  snapshot: ElementSnapshot;
}

export interface ElementAiGroup {
  /** Signature token when there is one, else the exact signature. */
  key: string;
  selector: string;
  matches: number;
  elementClass: ElementClass;
  /** How many candidates on the page carry this signature. */
  count: number;
  /** Highest confidence seen in the group. */
  confidence: number;
  label: string;
  reason: string;
  /**
   * The signals behind the group's verdict, strongest first, already worded for a user.
   * Carried here rather than re-derived in the popup: the popup never sees the element,
   * and a second implementation of "what counts as evidence" is a second thing to drift.
   */
  evidence: ElementAiEvidenceRow[];
}

export interface ElementAiScanResult {
  candidates: ElementAiCandidate[];
  groups: ElementAiGroup[];
  /** How many nodes were examined and classified, for the diagnostics line. */
  scanned: number;
  hideCount: number;
  suggestCount: number;
}

export interface ElementScannerOptions {
  classifier?: MiniAiElementClassifier;
  engine?: SelectorEngine;
  /** Hard cap on nodes examined. */
  maxNodes?: number;
  /** Hard cap on elements given the computed-style confirmation pass. */
  maxConfirmations?: number;
  /** Hard cap on clusters considered for blocking. */
  maxGroups?: number;
}

const HIGHLIGHT_CONTAINER_ID = 'bm-ai-highlights';

const DEFAULT_MAX_NODES = 8000;
const DEFAULT_MAX_CONFIRMATIONS = 250;
const DEFAULT_MAX_GROUPS = 12;
const MAX_HIGHLIGHTS = 60;

const TONE_COLOURS: Record<string, { border: string; background: string; chip: string }> = {
  ad: { border: '#f97316', background: 'rgba(249, 115, 22, 0.10)', chip: '#f97316' },
  tracker: { border: '#a855f7', background: 'rgba(168, 85, 247, 0.10)', chip: '#a855f7' },
  annoyance: { border: '#14b8a6', background: 'rgba(20, 184, 166, 0.10)', chip: '#14b8a6' },
  content: { border: '#64748b', background: 'rgba(100, 116, 139, 0.08)', chip: '#64748b' },
};

function toneOf(elementClass: ElementClass): string {
  switch (elementClass) {
    case 'Ad':
      return 'ad';
    case 'Tracker':
      return 'tracker';
    case 'Annoyance':
      return 'annoyance';
    default:
      return 'content';
  }
}

export class ElementAiScanner {
  private readonly classifier: MiniAiElementClassifier;
  private readonly engine: SelectorEngine;
  private readonly maxNodes: number;
  private readonly maxConfirmations: number;
  private readonly maxGroups: number;
  private highlightContainer: HTMLElement | null = null;
  private lastResult: ElementAiScanResult | null = null;

  constructor(options: ElementScannerOptions = {}) {
    this.classifier = options.classifier ?? new MiniAiElementClassifier();
    this.engine = options.engine ?? createSelectorEngine();
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    this.maxConfirmations = options.maxConfirmations ?? DEFAULT_MAX_CONFIRMATIONS;
    this.maxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
  }

  public getClassifier(): MiniAiElementClassifier {
    return this.classifier;
  }

  public lastScan(): ElementAiScanResult | null {
    return this.lastResult;
  }

  /** Classifies one live element exactly as the scanner would. */
  public classifyElement(element: Element, computed = true): ElementPrediction {
    return this.classifier.classify(snapshotElement(element, { computed, ancestors: true }));
  }

  public scan(root: ParentNode = document): ElementAiScanResult {
    const candidates: ElementAiCandidate[] = [];
    let scanned = 0;
    let confirmations = 0;

    let nodes: Element[] = [];
    try {
      nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    } catch {
      nodes = [];
    }

    for (const node of nodes) {
      if (scanned >= this.maxNodes) break;
      scanned++;
      if (isOwnUi(node)) continue;
      if (!isCandidateElement(node)) continue;

      let snapshot = snapshotElement(node, { computed: false, ancestors: true });
      let prediction = this.classifier.classify(snapshot);

      // Confirm with computed style when the cheap pass found *something* — the
      // missing piece it could not see is overlay geometry.
      const hasEvidence = prediction.evidenceFamilies.length > 0;
      const couldBeOverlay = !prediction.evidenceFamilies.includes('overlay-shape');
      if (hasEvidence && couldBeOverlay && confirmations < this.maxConfirmations) {
        confirmations++;
        snapshot = snapshotElement(node, { computed: true, ancestors: true });
        prediction = this.classifier.classify(snapshot);
      }

      if (prediction.action === 'leave' || prediction.elementClass === 'Content') continue;
      candidates.push({ element: node, prediction, snapshot });
    }

    const deduped = this.dropNestedDuplicates(candidates);
    const groups = this.groupCandidates(deduped);
    const result: ElementAiScanResult = {
      candidates: deduped,
      groups,
      scanned,
      hideCount: deduped.filter((candidate) => candidate.prediction.action === 'hide').length,
      suggestCount: deduped.filter((candidate) => candidate.prediction.action === 'suggest').length,
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Drops a candidate that is nested inside another candidate of the same class:
   * the outer container is the thing worth acting on, and highlighting both is noise.
   */
  private dropNestedDuplicates(candidates: ElementAiCandidate[]): ElementAiCandidate[] {
    const kept: ElementAiCandidate[] = [];
    for (const candidate of candidates) {
      const covered = kept.some(
        (existing) =>
          existing.prediction.elementClass === candidate.prediction.elementClass &&
          existing.element !== candidate.element &&
          existing.element.contains(candidate.element),
      );
      if (!covered) kept.push(candidate);
    }
    return kept;
  }

  private groupCandidates(candidates: ElementAiCandidate[]): ElementAiGroup[] {
    const byKey = new Map<string, ElementAiCandidate[]>();
    for (const candidate of candidates) {
      if (candidate.prediction.action !== 'hide') continue;
      const key = candidate.prediction.signature.token ?? candidate.prediction.signature.exact;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(candidate);
      else byKey.set(key, [candidate]);
    }

    const groups: ElementAiGroup[] = [];
    for (const [key, bucket] of byKey) {
      const sample = bucket[0];
      const selector = this.selectorForGroup(sample.element, sample.prediction.signature.token);
      if (!selector) continue;
      const matches = countMatches(selector);
      const validation = validateCosmeticSelector(selector, matches);
      if (!validation.ok) continue;
      groups.push({
        key,
        selector,
        matches,
        elementClass: sample.prediction.elementClass,
        count: bucket.length,
        confidence: Math.max(...bucket.map((candidate) => candidate.prediction.confidence)),
        label: sample.prediction.reasons[0] ?? `${sample.prediction.elementClass} elements`,
        reason: elementAiLine(sample.prediction),
        evidence: elementAiEvidenceRows(sample.prediction),
      });
    }

    return groups
      .sort((a, b) => b.count * b.confidence - a.count * a.confidence)
      .slice(0, this.maxGroups);
  }

  /**
   * The selector a group would be blocked with. Prefers the shared signature token —
   * that is the whole point of grouping — and falls back to the verified unique
   * selector for the sample element.
   */
  public selectorForGroup(element: Element, token: string | null): string | null {
    if (token && token.length > 1 && element.classList && element.classList.contains(token)) {
      const selector = `.${escapeClassToken(token)}`;
      if (countMatches(selector) > 0) return selector;
    }
    if (element.id) {
      const selector = `#${escapeClassToken(element.id)}`;
      if (countMatches(selector) > 0) return selector;
    }
    const generated = this.engine.generate(element);
    return generated.selector;
  }

  /** Draws outlines over every actionable candidate. Purely decorative. */
  public highlight(result: ElementAiScanResult | null = this.lastResult): number {
    this.clearHighlights();
    if (!result || result.candidates.length === 0) return 0;

    const container = document.createElement('div');
    container.id = HIGHLIGHT_CONTAINER_ID;
    container.setAttribute(BM_UI_ATTRIBUTE, 'ai-highlights');
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483644',
    });

    let drawn = 0;
    for (const candidate of result.candidates) {
      if (drawn >= MAX_HIGHLIGHTS) break;
      const rect = candidate.element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;

      const tone = TONE_COLOURS[toneOf(candidate.prediction.elementClass)];
      const outline = document.createElement('div');
      Object.assign(outline.style, {
        position: 'fixed',
        top: `${Math.round(rect.top)}px`,
        left: `${Math.round(rect.left)}px`,
        width: `${Math.round(rect.width)}px`,
        height: `${Math.round(rect.height)}px`,
        border: `${candidate.prediction.action === 'hide' ? 2 : 1}px dashed ${tone.border}`,
        background: tone.background,
        borderRadius: '3px',
        boxSizing: 'border-box',
      });

      const chip = document.createElement('span');
      chip.textContent =
        candidate.prediction.action === 'hide'
          ? `${candidate.prediction.elementClass} ${candidate.prediction.confidence}%`
          : `${candidate.prediction.elementClass}? ${candidate.prediction.confidence}%`;
      Object.assign(chip.style, {
        position: 'absolute',
        top: '-16px',
        left: '0',
        font: '10px/16px system-ui, -apple-system, sans-serif',
        color: '#0b1220',
        background: tone.chip,
        padding: '0 6px',
        borderRadius: '3px',
        whiteSpace: 'nowrap',
      });
      outline.appendChild(chip);
      container.appendChild(outline);
      drawn++;
    }

    if (drawn > 0) {
      document.documentElement.appendChild(container);
      this.highlightContainer = container;
    }
    return drawn;
  }

  public clearHighlights(): void {
    this.highlightContainer?.remove();
    this.highlightContainer = null;
    document.getElementById(HIGHLIGHT_CONTAINER_ID)?.remove();
  }
}

function countMatches(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** Escapes a class/id token for use in a selector, tolerating odd characters. */
function escapeClassToken(token: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(token);
  return token.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

export { countMatches };
