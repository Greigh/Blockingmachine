/**
 * Turning the page into harvest records.
 *
 * The element corpus is hand-written, and `docs/element-classifier-live-scan.md` is the
 * measurement of what that costs: running the shipping scanner over five real pages
 * produced 52 wrong actionable verdicts, and not one of the shapes involved was a shape
 * the corpus had. This module is the capture half of the fix — it turns elements on the
 * page the user is actually looking at into records the corpus queue can be built from.
 *
 * Two entry points, and the difference between them is the whole point:
 *
 *  - {@link captureScannedElements} runs after a scan the user asked for. Every candidate
 *    the model would act on is recorded with the verdict it got, and **without a label**.
 *    That is deliberate: an unlabelled capture is a question ("the model wants to hide
 *    this, on this site, and nobody has ruled on it"), and it is the only kind of record
 *    that can be produced without a person.
 *  - {@link captureDecision} runs when the user says `hide` or `keep` about an element.
 *    The record carries that decision, which is the only label the pipeline accepts
 *    (`packages/core/src/ai/elementCorpusHarvest.ts`), so this is where labelled
 *    candidates actually come from.
 *
 * Both record the **host and not the URL**: a path is personal, a corpus is not. The
 * rendered text is left to the core-side redaction, which is applied to every record
 * before it is stored, so a record cannot sit on disk holding more of the page than the
 * classifier reads.
 *
 * Capture is not free, so it is bounded twice: a page scan harvests at most
 * {@link MAX_SCANNED_PER_SCAN} elements (the scan's own `maxNodes` already caps the
 * document, and this caps what is copied out of it), and a decision harvests one.
 */

import {
  elementSignature,
  type ElementPrediction,
  type ElementSnapshot,
} from '@blockingmachine/core/element-ai';
import type { HarvestedElement } from '@blockingmachine/core/element-harvest';
import { snapshotElement } from './elementSnapshot.js';
import type { ElementAiCandidate } from './elementScanner.js';

/** Elements copied out of one page scan. A scan can find hundreds; a queue needs a sample. */
export const MAX_SCANNED_PER_SCAN = 12;

export interface CaptureContext {
  /** `location.hostname` — never the full URL. */
  host: string;
  /** Epoch ms of capture, injected so a test does not depend on the clock. */
  now: number;
}

/** One record for one element, with the verdict the model gave it. */
export function captureElement(
  snapshot: ElementSnapshot,
  prediction: ElementPrediction,
  context: CaptureContext,
  human?: HarvestedElement['human'],
): HarvestedElement {
  return {
    host: context.host,
    capturedAt: context.now,
    signature: elementSignature(snapshot).exact,
    verdict: {
      elementClass: prediction.elementClass,
      action: prediction.action,
      confidence: prediction.confidence,
    },
    snapshot,
    ...(human ? { human } : {}),
  };
}

/**
 * Records the elements a page scan would act on, unlabelled.
 *
 * The candidates are already de-duplicated by the scanner (nested duplicates dropped,
 * clusters grouped), so this is a sample of distinct shapes rather than a sample of
 * nodes — a page with forty of the same ad slot contributes one record, which is why the
 * first N by confidence are taken rather than the first N found.
 */
export function captureScannedElements(
  candidates: readonly ElementAiCandidate[],
  context: CaptureContext,
  limit = MAX_SCANNED_PER_SCAN,
): HarvestedElement[] {
  return [...candidates]
    .sort((a, b) => b.prediction.confidence - a.prediction.confidence)
    .slice(0, Math.max(0, limit))
    .map((candidate) => captureElement(candidate.snapshot, candidate.prediction, context));
}

/**
 * Records an element a person just ruled on.
 *
 * `action` is the picker's own vocabulary — `hide` teaches the shape must be removed,
 * `keep` teaches it is content — so it maps straight onto the harvest decision. The
 * element is snapshotted here rather than taken from a scan because a decision is usually
 * about something the scan never flagged, which is the more interesting capture of the two.
 */
export function captureDecision(
  element: Element,
  prediction: ElementPrediction,
  action: 'hide' | 'keep',
  context: CaptureContext,
): HarvestedElement {
  const snapshot = snapshotElement(element, { computed: false, ancestors: true });
  return captureElement(snapshot, prediction, context, { action, at: context.now });
}
