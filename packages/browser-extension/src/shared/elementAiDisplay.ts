/**
 * Presentation helpers for the element Mini-AI.
 *
 * Kept pure and separate from both the picker and the popup so the same words
 * describe the same verdict everywhere, and so the wording is testable without a
 * DOM. The rule these functions follow: never state more certainty than the
 * prediction carries, and always say what the model decided to *do*.
 */

import type { ElementAction, ElementClass } from '@blockingmachine/core/element-ai';

export type ElementAiTone = 'ad' | 'tracker' | 'annoyance' | 'content';

export interface ElementAiBadge {
  tone: ElementAiTone;
  /** Short human class name, e.g. `Likely ad`. */
  label: string;
  /** What the extension is willing to do, in plain words. */
  actionLabel: string;
  /** e.g. `92% · corroborated`. */
  detail: string;
}

export interface ElementAiPredictionLike {
  elementClass: ElementClass;
  confidence: number;
  action: ElementAction;
  corroboration: string;
  reasons?: string[];
}

export function elementAiTone(elementClass: ElementClass): ElementAiTone {
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

const CLASS_LABELS: Record<ElementClass, string> = {
  Ad: 'Likely ad',
  Tracker: 'Likely tracker',
  Annoyance: 'Likely annoyance',
  Content: 'Content',
};

const ACTION_LABELS: Record<ElementAction, string> = {
  hide: 'Safe to hide',
  suggest: 'Possible — confirm first',
  leave: 'Not acted on',
};

const TIER_LABELS: Record<string, string> = {
  corroborated: 'corroborated',
  'single-signal': 'one weak signal',
  'model-only': 'no independent evidence',
};

export function elementAiBadge(prediction: ElementAiPredictionLike): ElementAiBadge {
  const tone = elementAiTone(prediction.elementClass);
  const tier = TIER_LABELS[prediction.corroboration] ?? prediction.corroboration;
  return {
    tone,
    label: CLASS_LABELS[prediction.elementClass] ?? prediction.elementClass,
    actionLabel: ACTION_LABELS[prediction.action] ?? prediction.action,
    detail: prediction.confidence > 0 ? `${prediction.confidence}% · ${tier}` : tier,
  };
}

/**
 * One line for a HUD or a list row: class, confidence, and the model's own first
 * reason, so a verdict is never just a number.
 */
export function elementAiLine(prediction: ElementAiPredictionLike): string {
  const badge = elementAiBadge(prediction);
  const reason = prediction.reasons && prediction.reasons.length > 0 ? prediction.reasons[0] : '';
  return reason ? `${badge.label} · ${badge.detail} — ${reason}` : `${badge.label} · ${badge.detail}`;
}

/**
 * One signal that fed a verdict, in the words a user reads. `definitive` rows could
 * justify acting on their own; `supporting` rows only corroborate, and `context` rows are
 * things the model looked at and did *not* count (page instrumentation).
 */
export interface ElementAiEvidenceRow {
  /** Family id as the classifier reports it, or `instrumentation` for the context row. */
  id: string;
  /** Human name, e.g. `Ad markup`. */
  label: string;
  /** The matched value when there is one, e.g. `"ad-slot"` or `doubleclick.net`. */
  detail: string;
  strength: 'definitive' | 'supporting' | 'context';
}

/**
 * Structural shape of what the classifier already puts in `prediction.evidence`. Every
 * field is optional and every read is defensive: this runs in a popup that may be talking
 * to a content script from a different build, and showing no evidence beats throwing.
 */
export interface ElementAiEvidenceDetailsLike {
  adTokens?: readonly string[];
  trackerTokens?: readonly string[];
  consentMarkers?: readonly string[];
  socialMarkers?: readonly string[];
  layoutTokens?: readonly string[];
  urlPathTokens?: readonly string[];
  adSize?: string | null;
  adMatchedOn?: string | null;
  pixelBox?: string | null;
  sourceHost?: string | null;
  adAttribute?: string | null;
  trackerAttribute?: string | null;
  antiAdblockPhrase?: string | null;
  lurePhrase?: string | null;
  nagMarker?: string | null;
  ancestorMarker?: string | null;
  viewportCoverage?: number;
}

export interface ElementAiEvidenceLike {
  evidenceFamilies?: readonly string[];
  definitiveFamilies?: readonly string[];
  supportingFamilies?: readonly string[];
  evidence?: ElementAiEvidenceDetailsLike;
}

export type ElementAiEvidenceStrength = ElementAiEvidenceRow['strength'];

const quote = (value: string | null | undefined): string => (value ? `"${value}"` : '');

/** Strong tokens precede their weak partners, so the weak one is the last. */
const lastOf = (list: readonly string[] | undefined): string | undefined =>
  list && list.length > 0 ? list[list.length - 1] : undefined;

function familyRow(family: string, details: ElementAiEvidenceDetailsLike): { label: string; detail: string } {
  switch (family) {
    case 'user-choice':
      return { label: 'Your earlier decision', detail: 'you marked this shape before' };
    case 'ad-marker':
      // Prefer the identifier that said ad over the atom the rule matched inside it.
      return { label: 'Ad markup', detail: quote(details.adMatchedOn ?? details.adTokens?.[0]) };
    case 'ad-weak-marker':
      return { label: 'Ad-shaped class', detail: quote(lastOf(details.adTokens)) };
    case 'ad-attribute':
      return { label: 'Ad delivery attribute', detail: details.adAttribute ?? '' };
    case 'ad-ancestor':
      return { label: 'Inside an ad container', detail: quote(details.ancestorMarker) };
    case 'ad-network':
      return { label: 'Served by an ad network', detail: details.sourceHost ?? '' };
    case 'ad-size':
      return { label: 'Standard ad size', detail: details.adSize ?? '' };
    case 'measurement':
      return { label: 'Measurement network', detail: details.trackerTokens?.[0] ?? details.sourceHost ?? '' };
    case 'pixel-shape':
      return { label: 'Beacon geometry', detail: details.pixelBox ?? '' };
    case 'consent-marker':
      return { label: 'Consent dialog', detail: quote(details.consentMarkers?.[0]) };
    case 'nag-marker':
      return { label: 'Newsletter or paywall nag', detail: quote(details.nagMarker) };
    case 'lure-copy':
      return { label: 'Subscription call to action', detail: quote(details.lurePhrase) };
    case 'anti-adblock':
      return { label: 'Adblock-wall copy', detail: quote(details.antiAdblockPhrase) };
    case 'social-embed':
      return { label: 'Social widget', detail: quote(details.socialMarkers?.[0]) || details.sourceHost || '' };
    case 'weak-marker':
      return { label: 'Social vocabulary', detail: quote(lastOf(details.socialMarkers)) };
    case 'layout-marker':
      return { label: 'Layout word ads also use', detail: quote(details.layoutTokens?.[0]) };
    case 'third-party-frame':
      return { label: 'Third-party frame', detail: details.sourceHost ?? 'no readable content' };
    case 'url-path':
      return { label: 'Ad-like URL path', detail: (details.urlPathTokens ?? []).join(', ') };
    default:
      // An unrecognised family still gets shown: the id is the truth, the label is a
      // convenience, and hiding either would be worse than an unpolished name.
      return { label: family.replace(/-/g, ' '), detail: '' };
  }
}

/**
 * Every signal behind a verdict, strongest first, ready to render as rows.
 *
 * The order is the model's own precedence: evidence that could justify acting alone, then
 * the corroboration, then — last and clearly marked — the analytics attribute the page put
 * on the element, which is *not* a tracking verdict. That last row exists because "why did
 * this link say Tracker?" and "why did this link not say Tracker?" are both answered by it.
 */
export function elementAiEvidenceRows(prediction: ElementAiEvidenceLike): ElementAiEvidenceRow[] {
  const details = prediction.evidence ?? {};
  const definitive = prediction.definitiveFamilies ?? [];
  const supporting = prediction.supportingFamilies ?? [];
  const known = new Set<string>([...definitive, ...supporting]);
  // A payload from an older build reports the families without their weight. List them as
  // context rather than guessing which ones carried the verdict.
  const unweighted = known.size === 0 ? (prediction.evidenceFamilies ?? []) : [];

  const rows: ElementAiEvidenceRow[] = [];
  const push = (family: string, strength: ElementAiEvidenceStrength): void => {
    const { label, detail } = familyRow(family, details);
    rows.push({ id: family, label, detail, strength });
  };

  for (const family of definitive) push(family, 'definitive');
  for (const family of supporting) push(family, 'supporting');
  for (const family of unweighted) push(family, 'context');

  if (details.trackerAttribute) {
    rows.push({
      id: 'instrumentation',
      label: 'Page analytics attribute',
      detail: `${details.trackerAttribute} — instrumentation, not a tracker`,
      strength: 'context',
    });
  }

  return rows;
}

/**
 * The same rows on one line, for a HUD that has one row of height to spend.
 * `Ad markup "ad-slot" · standard ad size 300x250`.
 */
export function elementAiEvidenceLine(
  prediction: ElementAiEvidenceLike,
  max = 2,
): string {
  const rows = elementAiEvidenceRows(prediction).filter((row) => row.strength !== 'context');
  if (rows.length === 0) return '';
  const shown = rows.slice(0, max).map((row) => {
    const label = row.label.charAt(0).toLowerCase() + row.label.slice(1);
    return row.detail ? `${label} ${row.detail}` : label;
  });
  const hidden = rows.length - shown.length;
  return hidden > 0 ? `${shown.join(' · ')} · +${hidden} more` : shown.join(' · ');
}

/** "3 likely, 2 possible" — the summary a scan button reports. */
export function elementAiScanSummary(counts: { hide: number; suggest: number }): string {
  if (counts.hide === 0 && counts.suggest === 0) return 'Nothing ad-like found on this page.';
  const parts: string[] = [];
  if (counts.hide > 0) parts.push(`${counts.hide} likely`);
  if (counts.suggest > 0) parts.push(`${counts.suggest} possible`);
  return parts.join(' · ');
}
