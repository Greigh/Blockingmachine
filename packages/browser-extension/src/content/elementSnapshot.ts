/**
 * DOM → {@link ElementSnapshot} adapter.
 *
 * All of the browser-specific knowledge lives here so the classifier itself stays
 * pure and identical in tests, the desktop app and the extension. Two properties
 * matter more than completeness:
 *
 *  - **Bounded cost.** A page can hold tens of thousands of nodes; every read here
 *    is capped, and `computed: false` skips `getComputedStyle`, which is the one
 *    call that forces the engine to resolve layout for the whole document. Scans
 *    start cheap and only pay for computed styles where a cheap pass found something
 *    worth confirming.
 *  - **No fabricated evidence.** Only attributes the page actually has are
 *    reported. `href` is passed raw rather than resolved, because resolving a
 *    relative link against the current origin would make the page's own host look
 *    like a third-party source.
 */

import type { ElementSnapshot } from '@blockingmachine/core/element-ai';

/** Text beyond this is never needed: the content shield trips at 400. */
const MAX_TEXT_LENGTH = 1200;
const MAX_ATTRIBUTE_VALUE = 320;
const MAX_ATTRIBUTES = 40;
const MAX_CLASSES = 24;
const MAX_ANCESTORS = 12;
/** Above this many children, descendant counts are skipped rather than paid for. */
const MAX_CHILDREN_FOR_LINK_COUNT = 400;

/** Attributes read directly because the classifier reasons about them. */
const RESOURCE_ATTRIBUTES = ['src', 'data-src', 'data-lazy-src', 'data-original', 'poster', 'srcset'] as const;

/** Never forwarded: huge, and no signal lives in them. */
const IGNORED_ATTRIBUTES = new Set(['style', 'class', 'id', 'nonce', 'integrity']);

export interface SnapshotOptions {
  /**
   * Read computed style for `position` / `z-index` / `display`. Expensive on large
   * scans, essential for spotting fixed overlays, so it is opt-in per element.
   */
  computed?: boolean;
  /** Include the ancestor chain (used to spot an element inside an ad container). */
  ancestors?: boolean;
}

function textOf(element: Element): string {
  // `textContent` avoids the forced layout that `innerText` triggers, which matters
  // when this runs over many elements at once.
  const raw = element.textContent ?? '';
  if (raw.length === 0) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT_LENGTH ? collapsed.slice(0, MAX_TEXT_LENGTH) : collapsed;
}

function rectOf(element: Element): DOMRect | null {
  try {
    const rect = element.getBoundingClientRect();
    if (!rect) return null;
    return rect;
  } catch {
    return null;
  }
}

function ancestorChain(element: Element, limit: number): string[] {
  const chain: string[] = [];
  let node: Element | null = element.parentElement;
  while (node && chain.length < limit && node !== document.documentElement) {
    const classes = node.classList ? Array.from(node.classList).slice(0, 2) : [];
    chain.push(`${node.tagName.toLowerCase()}${classes.map((cls) => `.${cls}`).join('')}`);
    node = node.parentElement;
  }
  return chain;
}

function isVisible(element: Element, computed: CSSStyleDeclaration | null, rect: DOMRect | null): boolean {
  if (computed) {
    if (computed.display === 'none' || computed.visibility === 'hidden') return false;
    if (computed.opacity !== '' && Number(computed.opacity) === 0) return false;
    return true;
  }
  if (rect) return rect.width > 0 && rect.height > 0;
  return true;
}

/**
 * Builds the classifier's view of one live element.
 *
 * Never throws: a detached node, a shadow-root edge case or a cross-origin frame
 * all degrade to a snapshot with less information, never to an exception in the
 * middle of a page scan.
 */
export function snapshotElement(element: Element, options: SnapshotOptions = {}): ElementSnapshot {
  const withComputed = options.computed === true;
  const withAncestors = options.ancestors !== false;

  const classes: string[] = [];
  try {
    for (const cls of Array.from(element.classList ?? []).slice(0, MAX_CLASSES)) {
      if (typeof cls === 'string' && cls.length > 0) classes.push(cls);
    }
  } catch {
    // classList is unavailable on some exotic nodes — attributes below still apply.
  }

  const attributes: Array<{ name: string; value: string }> = [];
  const attributeMap = new Map<string, string>();
  try {
    for (const attribute of Array.from(element.attributes ?? []).slice(0, MAX_ATTRIBUTES)) {
      const name = attribute.name.toLowerCase();
      if (IGNORED_ATTRIBUTES.has(name)) continue;
      const value = typeof attribute.value === 'string' ? attribute.value.slice(0, MAX_ATTRIBUTE_VALUE) : '';
      attributes.push({ name, value });
      if (!attributeMap.has(name)) attributeMap.set(name, value);
    }
  } catch {
    // No attributes readable: the snapshot is still usable.
  }

  const rect = rectOf(element);
  const computed = withComputed ? safeComputedStyle(element) : null;

  let src: string | undefined;
  for (const name of RESOURCE_ATTRIBUTES) {
    const value = attributeMap.get(name);
    if (value && value.length > 0) {
      src = value;
      break;
    }
  }

  const childCount = typeof element.childElementCount === 'number' ? element.childElementCount : undefined;
  let linkCount: number | undefined;
  if (childCount !== undefined && childCount <= MAX_CHILDREN_FOR_LINK_COUNT) {
    try {
      linkCount = Math.min(element.querySelectorAll('a').length, 200);
    } catch {
      linkCount = undefined;
    }
  }

  return {
    tag: element.tagName ? element.tagName.toLowerCase() : '',
    id: element.id || undefined,
    classes,
    attributes,
    text: textOf(element),
    role: attributeMap.get('role'),
    src,
    href: attributeMap.get('href'),
    width: rect ? Math.round(rect.width) : undefined,
    height: rect ? Math.round(rect.height) : undefined,
    viewportWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
    position: computed?.position,
    zIndex: computed ? numericZIndex(computed.zIndex) : undefined,
    ancestors: withAncestors ? ancestorChain(element, MAX_ANCESTORS) : undefined,
    childCount,
    linkCount,
    inFrame: isInFrame(),
    crossOriginFrame: isCrossOriginFrame(),
    visible: isVisible(element, computed, rect),
  };
}

function numericZIndex(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function safeComputedStyle(element: Element): CSSStyleDeclaration | null {
  try {
    return window.getComputedStyle ? window.getComputedStyle(element) : null;
  } catch {
    return null;
  }
}

/** True when this script is not running in the top-level document. */
export function isInFrame(): boolean {
  try {
    return typeof window !== 'undefined' && window.top !== window.self;
  } catch {
    return true;
  }
}

/** True when the top document cannot be read from here, i.e. a cross-origin frame. */
export function isCrossOriginFrame(): boolean {
  if (!isInFrame()) return false;
  try {
    void window.top?.location.href;
    return false;
  } catch {
    return true;
  }
}

/** Cheap substring prefilter used before paying for a snapshot. */
const CANDIDATE_IDENTIFIER_PATTERN = new RegExp(
  [
    'ad', 'ads', 'advert', 'sponsor', 'banner', 'promo', 'mpu', 'infeed',
    'taboola', 'outbrain', 'criteo', 'doubleclick', 'googlesyndication', 'gpt', 'dfp', 'prebid',
    'analytic', 'track', 'pixel', 'beacon', 'telemetr', 'gtm', 'ga-', 'fbq',
    'cookie', 'consent', 'gdpr', 'ccpa', 'cmp', 'onetrust', 'didomi', 'quantcast', 'privacy',
    'paywall', 'newsletter', 'subscribe', 'signup', 'email', 'modal', 'popup', 'overlay', 'interstitial',
    'share', 'social', 'follow', 'sticky',
  ].join('|'),
  'i',
);

/**
 * True when an element is worth snapshotting at all.
 *
 * Resource-bearing nodes are always candidates (an iframe or a 1×1 image needs no
 * vocabulary to be an ad or a beacon); everything else must carry identifier
 * vocabulary that at least resembles one of the families. The pattern is
 * deliberately loose — it is a cost filter, not a decision, and the classifier it
 * feeds is cheap enough that over-including is safer than missing.
 */
export function isCandidateElement(element: Element): boolean {
  const tag = element.tagName ? element.tagName.toLowerCase() : '';
  if (tag === 'iframe' || tag === 'img' || tag === 'ins' || tag === 'script' || tag === 'embed' || tag === 'object') {
    return true;
  }
  const identifier = `${element.id ?? ''} ${typeof element.className === 'string' ? element.className : ''}`;
  if (identifier.trim().length > 0 && CANDIDATE_IDENTIFIER_PATTERN.test(identifier)) return true;
  // Ad slots are frequently declared only through attributes.
  return (
    element.hasAttribute?.('data-ad-slot') === true ||
    element.hasAttribute?.('data-ad-client') === true ||
    element.hasAttribute?.('data-ad-unit') === true ||
    element.hasAttribute?.('data-adsbygoogle-status') === true
  );
}
