/**
 * Embedded Mini-AI Element Classifier — the second surface of the model.
 *
 * {@link MiniAiClassifier} answers "how much do I trust this hostname?" from a URL
 * string. This answers the adjacent question the browser extension actually needs
 * to act on: **"is this DOM element an ad, a tracker, an annoyance, or content?"**
 * It reads a plain {@link ElementSnapshot} — no DOM, no `window`, no network — so
 * the identical model runs in a content script, a service worker, a Node test, or
 * the Electron app.
 *
 * The design rules are the ones that fixed the URL model's false-positive classes,
 * applied to a surface where the cost of being wrong is higher:
 *
 *  1. **Evidence is grouped into families.** A verdict is confident only when
 *     independent families agree; see {@link assessElementEvidence}.
 *  2. **One weak signal is a lead, not a finding.** `class="banner"` is a hero
 *     banner on a thousand sites and an ad slot on one. It can be *shown*, never
 *     acted on by itself.
 *  3. **Hiding destroys content, so the asymmetry is explicit.** Only definitive
 *     evidence earns {@link ElementAction} `hide`; anything that reads as
 *     substantial page copy is pinned to `leave` no matter how ad-shaped it is.
 *  4. **A bare word is not a fact.** Identifiers are split into atoms on camelCase
 *     and punctuation first, so `admonition`, `download`, `adapter`, `header` and
 *     `shadow` can never match `ad` — the same class of bug that made
 *     `akamai.external.web.us-east-1.prod.diagnostic.networking.aws.dev` read as
 *     malware because its leftmost label happened to be a vendor name.
 *
 * The model also composes with the URL model: pass `sourceVerdict` on a snapshot
 * and the host classifier's opinion of the element's source becomes corroborating
 * evidence, so the two surfaces share one consistent picture of the page.
 *
 * @packageDocumentation
 * @beta
 */

import { ELEMENT_FITTED_WEIGHTS } from './elementWeights.generated.js';
import type { MiniAiFeatureContribution } from './types.js';

/** What an element is, from the filtering engine's point of view. */
export const ELEMENT_CLASSES = ['Ad', 'Tracker', 'Annoyance', 'Content'] as const;
export type ElementClass = (typeof ELEMENT_CLASSES)[number];

/**
 * What the caller may do about it.
 *
 * - `hide` — definitive evidence; a cosmetic filter is safe to install.
 * - `suggest` — plausible but not certain; show it to the user, do not act alone.
 * - `leave` — content, or nothing actionable.
 */
export const ELEMENT_ACTIONS = ['hide', 'suggest', 'leave'] as const;
export type ElementAction = (typeof ELEMENT_ACTIONS)[number];

/** What a resource-bearing attribute points at. */
export const ELEMENT_SOURCE_KINDS = ['ad-network', 'measurement', 'social', 'cdn', 'none'] as const;
export type ElementSourceKind = (typeof ELEMENT_SOURCE_KINDS)[number];

/**
 * Independent evidence families.
 *
 * **Definitive** families are self-evident: a page does not load a document from
 * `doubleclick.net` by accident, and `data-ad-slot` exists for exactly one reason.
 * The remaining families describe *shape* — things a legitimate element exhibits by
 * accident (`<div class="banner">`, a 300×250 hero image, a fixed overlay).
 */
export type ElementEvidenceFamily =
  | 'user-choice'
  | 'ad-marker'
  | 'ad-weak-marker'
  | 'layout-marker'
  | 'ad-attribute'
  | 'ad-network'
  | 'ad-ancestor'
  | 'measurement'
  | 'anti-adblock'
  | 'consent-marker'
  | 'social-embed'
  | 'weak-marker'
  | 'nag-marker'
  | 'lure-copy'
  | 'ad-size'
  | 'overlay-shape'
  | 'pixel-shape'
  | 'third-party-frame'
  | 'url-path';

const DEFINITIVE_FAMILIES: ReadonlySet<ElementEvidenceFamily> = new Set<ElementEvidenceFamily>([
  'user-choice',
  'ad-marker',
  'ad-attribute',
  'ad-network',
  'ad-ancestor',
  'measurement',
  'anti-adblock',
  'social-embed',
  'pixel-shape',
]);

/** A snapshot of one DOM element, produced by the caller and never mutated here. */
export interface ElementSnapshot {
  /** Lowercased tag name (`div`, `iframe`, `ins`, …). */
  tag: string;
  id?: string;
  classes?: readonly string[];
  /** Attribute name/value pairs, already filtered of values a caller cannot send. */
  attributes?: ReadonlyArray<{ name: string; value: string }>;
  /** Rendered text, truncated by the caller. Never treated as evidence of identity. */
  text?: string;
  role?: string;
  /** Resource URL (`src`, `data-src`, `poster`, …). */
  src?: string;
  /** Link target. Weak evidence only — a link *to* an ad domain is not an ad. */
  href?: string;
  width?: number;
  height?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  /** Computed `position` (`fixed`, `sticky`, `absolute`, `static`, …). */
  position?: string;
  zIndex?: number;
  /** Ancestor chain, nearest first, as `tag` or `tag.class` strings. */
  ancestors?: readonly string[];
  childCount?: number;
  linkCount?: number;
  /** True when the element lives inside a frame. */
  inFrame?: boolean;
  /** True when the element's frame is cross-origin from the top document. */
  crossOriginFrame?: boolean;
  visible?: boolean;
  /** Verdict from {@link MiniAiClassifier} for the element's source host, when known. */
  sourceVerdict?: { category: string; verdict: string } | null;
}

/** Numeric feature vector, one entry per evidence dimension. */
export interface ElementFeatureVector {
  adStrongToken: number;
  adWeakToken: number;
  trackerStrongToken: number;
  trackerWeakToken: number;
  consentStrongMarker: number;
  consentWeakToken: number;
  socialStrongMarker: number;
  socialWeakToken: number;
  dataAdAttribute: number;
  dataTrackerAttribute: number;
  adHostMatch: number;
  measureHostMatch: number;
  socialHostMatch: number;
  urlPathToken: number;
  thirdPartyFrame: number;
  passiveSource: number;
  pixelGeometry: number;
  adSizeGeometry: number;
  overlayGeometry: number;
  lureText: number;
  antiAdblockText: number;
  ancestorAd: number;
  contentText: number;
  semanticContainer: number;
  userTuneBias: number;
}

export type ElementFeatureName = keyof ElementFeatureVector;

/** What was actually seen, so callers can explain themselves and group elements. */
export interface ElementEvidenceDetails {
  adTokens: string[];
  trackerTokens: string[];
  consentMarkers: string[];
  socialMarkers: string[];
  weakTokens: string[];
  /** Host of the element's resource attribute, when it has one. */
  sourceHost: string | null;
  sourceKind: ElementSourceKind;
  sourceAttribute: string | null;
  /** Matched IAB size label, e.g. `300x250`. */
  adSize: string | null;
  /**
   * The identifier that carried the ad evidence, for display: the vocabulary token when
   * one matched, otherwise the field the compound-edge rule matched in. `ad-slot-container`
   * is more use to a user than the atom `ad` the rule found inside it.
   */
  adMatchedOn: string | null;
  /** Rendered box of a pixel-shaped element, e.g. `1×1`. Never a zero-box. */
  pixelBox: string | null;
  /** Ad delivery attribute that matched, e.g. `data-ad-slot`. */
  adAttribute: string | null;
  /**
   * Analytics attribute the page put on the element, e.g. `data-analytics-event`.
   * Reported so a UI can say *why* an attribute did not count: on its own it is page
   * instrumentation, and it only becomes tracker evidence on an element that is already
   * tracker-flavoured (see `trackerFlavoured` in the analysis below).
   */
  trackerAttribute: string | null;
  antiAdblockPhrase: string | null;
  lurePhrase: string | null;
  /** Newsletter/paywall compound marker that matched, if any. */
  nagMarker: string | null;
  /** Layout vocabulary that ads borrow (`banner`, `promo`) — corroborating only. */
  layoutTokens: string[];
  /** Ancestor marker that flagged the element, if any. */
  ancestorMarker: string | null;
  textLength: number;
  /** Share of the viewport the element occupies, 0–1. */
  viewportCoverage: number;
  urlPathTokens: string[];
}

export interface ElementFeatureAnalysis {
  features: ElementFeatureVector;
  families: ElementEvidenceFamily[];
  details: ElementEvidenceDetails;
}

export interface ElementEvidenceAssessment {
  families: ElementEvidenceFamily[];
  definitive: ElementEvidenceFamily[];
  supporting: ElementEvidenceFamily[];
  tier: 'corroborated' | 'single-signal' | 'model-only';
  /** Most the evidence can justify acting on. */
  maxAction: ElementAction;
  /**
   * True when the evidence actually *names* a class. Shape-only families (a
   * standard ad rectangle, a fixed overlay, a bare cross-origin frame) describe how
   * an element is drawn, not what it is, so on their own they name nothing.
   */
  named: boolean;
  /** Ceiling for reported confidence, so a guess cannot read as a fact. */
  maxConfidence: number;
  /**
   * True when the element looks like substantial page copy. Such an element is
   * never hidden on supporting evidence alone, because hiding it is how a filter
   * list breaks a site.
   */
  contentShield: boolean;
  /**
   * True when the element is long-form prose that no *resource* evidence contradicts —
   * an article body, a policy page, or an advertorial. Vocabulary alone can never
   * overrule this, because a page about advertising wears the same word as an ad slot,
   * so such an element is reported as content and never hidden.
   */
  proseShield: boolean;
}

export interface ElementPrediction {
  elementClass: ElementClass;
  action: ElementAction;
  /** 0–100, capped by the evidence assessment. */
  confidence: number;
  classProbabilities: Record<ElementClass, number>;
  corroboration: ElementEvidenceAssessment['tier'];
  evidenceFamilies: ElementEvidenceFamily[];
  /**
   * The evidence that could justify acting on its own. `evidenceFamilies` is the full
   * list; these two say which of them carried the verdict, so a UI can show the user the
   * signals rather than only the conclusion.
   */
  definitiveFamilies: ElementEvidenceFamily[];
  supportingFamilies: ElementEvidenceFamily[];
  /** Details of what matched — for UI display and for user-feedback keys. */
  evidence: ElementEvidenceDetails;
  /** `exact` is tag+token; `token` generalizes across sites. */
  signature: { exact: string; token: string | null };
  topContributions: MiniAiFeatureContribution[];
  reasons: string[];
  inferenceTimeMs: number;
}

export interface MiniAiElementClassifierOptions {
  maxFeedbackEntries?: number;
  maxCacheSize?: number;
  enableCache?: boolean;
  /**
   * Weight set for the statistical head. Defaults to the shipped table; the fitting
   * harness passes alternatives so a candidate can be measured end to end through the
   * same decision path rather than only on its own log-loss.
   */
  weights?: ElementWeightSet;
}

// ─── Vocabulary tables ────────────────────────────────────────────────────────

/**
 * Strong ad-container vocabulary — compound or brand tokens that exist to serve
 * ads. A single match is definitive, so the list is deliberately conservative:
 * every entry is a token you can grep for in an ad blocker's own filter lists.
 */
export const ELEMENT_AD_STRONG_TOKENS: readonly string[] = [
  'adsbygoogle',
  'adsbox',
  'adslot',
  'adslots',
  'adunit',
  'adunits',
  'adcontainer',
  'adwrapper',
  'adplace',
  'adplacement',
  'adzone',
  'adserver',
  'adservice',
  'advert',
  'adverts',
  'advertisement',
  'advertisements',
  'advertising',
  'gpt',
  'dfp',
  'pubads',
  'prebid',
  'adchoices',
  'sponsored',
  // Ad networks, as they appear in the class/id of their embed containers.
  'doubleclick',
  'googlesyndication',
  'googleadservices',
  'googleads',
  'amazonadsystem',
  'adnxs',
  'adsrvr',
  'criteo',
  'taboola',
  'outbrain',
  'mgid',
  'revcontent',
  'sharethrough',
  'teads',
  'pubmatic',
  'rubiconproject',
  'sovrn',
  'spotxchange',
  'yieldmo',
  'bidswitch',
  'smartadserver',
  'adform',
  'casalemedia',
  'openx',
  'districtm',
  'adyoulike',
  'loopme',
  'moatads',
  'doubleverify',
  'adsafeprotected',
  'innity',
  'sekindo',
  'zergnet',
  'nativeads',
  'plista',
  'emediate',
  'flashtalking',
  'sizmek',
  'zedo',
  'adroll',
] as const;

/**
 * Ambiguous ad vocabulary. `banner`, `leaderboard` and `rectangle` are layout
 * words as often as ad words, and `ad`/`ads` alone is the weakest signal on a
 * page. Supporting evidence only.
 */
export const ELEMENT_AD_WEAK_TOKENS: readonly string[] = [
  'ad',
  'ads',
  'adbox',
  'bannerad',
  'textads',
  'mpu',
] as const;

/**
 * Layout vocabulary that ads borrow. Every one of these is also an ordinary page
 * element — a hero banner, a promotional section, a sponsors strip — so a match
 * corroborates but never names a class. `class="banner"` on its own must never be
 * enough to call an element an ad.
 */
export const ELEMENT_LAYOUT_TOKENS: readonly string[] = [
  'banner',
  'banners',
  'leaderboard',
  'skyscraper',
  'billboard',
  'halfpage',
  'rectangle',
  'promo',
  'promos',
  'promotion',
  'promotions',
  'sponsor',
  'sponsors',
  'infeed',
] as const;

/**
 * Tracking vocabulary specific enough to stand alone. `analytics`, `pixel` and
 * `tracking` are deliberately absent — they are ordinary product words
 * (`class="analytics-panel"` is a dashboard, `class="tracking-panel"` is an order
 * tracker) and live in {@link ELEMENT_TRACKER_WEAK_TOKENS} instead.
 */
export const ELEMENT_TRACKER_STRONG_TOKENS: readonly string[] = [
  'gtag',
  'googletagmanager',
  'googletagservices',
  'googleanalytics',
  'fbq',
  'fbevents',
  'facebookpixel',
  'hotjar',
  'clarity',
  'matomo',
  'piwik',
  'plausible',
  'fullstory',
  'mouseflow',
  'mixpanel',
  'amplitude',
  'heapanalytics',
  'newrelic',
  'bugsnag',
  'logrocket',
  'datadoghq',
  'segmentio',
  'telemetry',
  'tracker',
  'trackers',
  'beacon',
  'beacons',
  'spypixel',
  'trackingpixel',
] as const;

export const ELEMENT_TRACKER_WEAK_TOKENS: readonly string[] = [
  'analytics',
  'pixel',
  'pixels',
  'stats',
  'statistics',
  'metrics',
  'tracking',
  // `track` was here and is deliberately not any more: it is the same ordinary product
  // word the comment above warns about. `tracking` and `trackers` are what a page that
  // means measurement writes, and one word is enough to tell them apart.
  'conversion',
  'conversions',
  'attribution',
  'measurement',
  'impression',
  'impressions',
] as const;

/** Compound consent/CMP markers — matched against the raw identifier string. */
export const ELEMENT_CONSENT_STRONG_MARKERS: readonly string[] = [
  'cookie-consent',
  'cookie_consent',
  'cookieconsent',
  'cookie-notice',
  'cookie_notice',
  'cookienotice',
  'cookie-banner',
  'cookie_banner',
  'cookiebanner',
  'consent-banner',
  'consent_banner',
  'consent-notice',
  'consent_modal',
  'consent-modal',
  'gdpr-banner',
  'gdpr_banner',
  'gdpr-consent',
  'gdpr-modal',
  'ccpa-banner',
  'ccpa-notice',
  'sp_message',
  'sp-message',
  'fc-consent',
  'cmp-banner',
  'cmp-container',
  'cmp-wrapper',
  'cmpwrapper',
  'onetrust',
  'optanon',
  'cookiebot',
  'didomi',
  'quantcast',
  'truste',
  'iubenda',
  'klaro',
  'osano',
  'cookieyes',
  'termly',
  // Quantcast Choice ships its container as `qc-cmp2-*`, which the `cmp-*` entries
  // above do not match because of the version digit.
  'qc-cmp',
] as const;

/**
 * Single consent words. `class="cookie"` is a recipe page's cookie card as often
 * as it is a consent bar, so these are supporting evidence only.
 */
export const ELEMENT_CONSENT_WEAK_TOKENS: readonly string[] = [
  'cookie',
  'cookies',
  'consent',
  'gdpr',
  'ccpa',
  'cmp',
  'privacy',
] as const;

/** Newsletter/paywall/subscribe nags: compound markers, matched raw. */
export const ELEMENT_NAG_MARKERS: readonly string[] = [
  'newsletter-modal',
  'newsletter-popup',
  'newsletter-signup',
  'newsletter-slidein',
  'newsletter-slide-in',
  'app-interstitial',
  'app-install',
  'appinstall',
  'exit-intent',
  'exitintent',
  'subscribe-modal',
  'subscribe-popup',
  'signup-modal',
  'signup-wall',
  'paywall',
  'paywall-modal',
  'subscriber-wall',
  'registration-wall',
  'email-capture',
  'emailcapture',
  // Push-notification opt-ins. Shaped like a nag, and the vendors name their own
  // container, so an id is enough to identify one the copy does not.
  'onesignal',
  'push-prompt',
  'pushprompt',
  'push-notification',
  'pushnotification',
  'notification-prompt',
  'webpushr',
  'pushengage',
  'izooto',
] as const;

/** Social share/embed compounds. Vendor names count; bare brands do not. */
export const ELEMENT_SOCIAL_STRONG_MARKERS: readonly string[] = [
  'share-buttons',
  'share_buttons',
  'sharebuttons',
  'share-button',
  'sharebar',
  'share-bar',
  'social-share',
  'social_share',
  'socialshare',
  'addthis',
  'sharethis',
  'addtoany',
  'fb-like',
  'facebook-like',
  'twitter-share',
  'twitter-tweet',
  'linkedin-share',
  'pinterest-share',
  'whatsapp-share',
  'reddit-share',
  'telegram-share',
  'sticky-share',
] as const;

export const ELEMENT_SOCIAL_WEAK_TOKENS: readonly string[] = [
  'share',
  'sharing',
  'social',
  'follow',
  'followus',
] as const;

/**
 * Adblock-wall copy. These phrases are unambiguous: a page only says this when it
 * has detected a blocker.
 */
export const ELEMENT_ANTI_ADBLOCK_PHRASES: readonly string[] = [
  'disable your ad blocker',
  'disable your adblocker',
  'disable adblock',
  'disable your adblock',
  'ad blocker detected',
  'adblocker detected',
  'adblock detected',
  'turn off your ad blocker',
  'turn off adblock',
  'please disable adblock',
  'using an ad blocker',
  'you are using an adblocker',
  'support us by disabling',
  'whitelist us',
  'allow ads on this site',
] as const;

/** Subscription/consent call-to-action copy. Supporting evidence only. */
export const ELEMENT_LURE_PHRASES: readonly string[] = [
  'accept all cookies',
  'accept cookies',
  'we value your privacy',
  'manage cookies',
  'manage preferences',
  'we use cookies',
  'this site uses cookies',
  'subscribe to our newsletter',
  'sign up for our newsletter',
  'join our newsletter',
  'get the newsletter',
  'subscribe now',
  'subscribe today',
  'unlock this article',
  'continue reading',
  'become a member',
  'subscribe to continue',
  'already a subscriber',
  'create a free account',
  'sign up to continue',
  'enable notifications',
  'turn on notifications',
  // Push-notification opt-ins, as they are actually worded. These identify a prompt's
  // *purpose*; whether that is enough to hide it is a separate question, answered where
  // the evidence is weighed (a prompt named by its own markup is definitive, one known
  // only by its copy is not).
  'show you notifications',
  'receive notifications',
  'notifications for the latest',
  'want to receive notifications',
] as const;

/** IAB standard ad dimensions, in CSS pixels. */
export const IAB_AD_SIZES: ReadonlyArray<{ w: number; h: number; label: string }> = [
  { w: 300, h: 250, label: '300x250' },
  { w: 336, h: 280, label: '336x280' },
  { w: 728, h: 90, label: '728x90' },
  { w: 970, h: 90, label: '970x90' },
  { w: 970, h: 250, label: '970x250' },
  { w: 160, h: 600, label: '160x600' },
  { w: 120, h: 600, label: '120x600' },
  { w: 300, h: 600, label: '300x600' },
  { w: 320, h: 50, label: '320x50' },
  { w: 320, h: 100, label: '320x100' },
  { w: 468, h: 60, label: '468x60' },
  { w: 234, h: 60, label: '234x60' },
  { w: 120, h: 240, label: '120x240' },
  { w: 180, h: 150, label: '180x150' },
  { w: 125, h: 125, label: '125x125' },
  { w: 250, h: 250, label: '250x250' },
  { w: 240, h: 400, label: '240x400' },
  { w: 580, h: 400, label: '580x400' },
  { w: 750, h: 200, label: '750x200' },
];

/**
 * Host → what loading from it means. Matched on registrable suffix, so
 * `pagead2.googlesyndication.com` and `securepubads.g.doubleclick.net` both land.
 *
 * Only *resource* attributes are consulted, never `href`: a link **to** an ad
 * network's own site (a publisher's "Advertise with us" footer link, or a news
 * article about DoubleClick) is content, not an ad.
 */
export const ELEMENT_SOURCE_HOST_KINDS: Readonly<Record<string, ElementSourceKind>> = {
  'doubleclick.net': 'ad-network',
  'googlesyndication.com': 'ad-network',
  'googleadservices.com': 'ad-network',
  'googletagservices.com': 'ad-network',
  'googletagmanager.com': 'measurement',
  'google-analytics.com': 'measurement',
  'amazon-adsystem.com': 'ad-network',
  'adnxs.com': 'ad-network',
  'adsrvr.org': 'ad-network',
  'criteo.com': 'ad-network',
  'criteo.net': 'ad-network',
  'taboola.com': 'ad-network',
  'outbrain.com': 'ad-network',
  'mgid.com': 'ad-network',
  'revcontent.com': 'ad-network',
  'sharethrough.com': 'ad-network',
  'teads.tv': 'ad-network',
  'pubmatic.com': 'ad-network',
  'rubiconproject.com': 'ad-network',
  'magnite.com': 'ad-network',
  'openx.net': 'ad-network',
  'casalemedia.com': 'ad-network',
  '33across.com': 'ad-network',
  'sovrn.com': 'ad-network',
  'lijit.com': 'ad-network',
  'spotxchange.com': 'ad-network',
  'spotx.tv': 'ad-network',
  'yieldmo.com': 'ad-network',
  'bidswitch.net': 'ad-network',
  'turn.com': 'ad-network',
  'mathtag.com': 'ad-network',
  'crwdcntrl.net': 'ad-network',
  'bluekai.com': 'ad-network',
  'demdex.net': 'ad-network',
  'everesttech.net': 'ad-network',
  'omtrdc.net': 'measurement',
  '2o7.net': 'measurement',
  'scorecardresearch.com': 'measurement',
  'quantserve.com': 'measurement',
  'comscore.com': 'measurement',
  'moatads.com': 'measurement',
  'doubleverify.com': 'measurement',
  'adsafeprotected.com': 'measurement',
  'chartbeat.com': 'measurement',
  'parsely.com': 'measurement',
  'permutive.com': 'measurement',
  'narrative.io': 'measurement',
  'hotjar.com': 'measurement',
  'mouseflow.com': 'measurement',
  'fullstory.com': 'measurement',
  'clarity.ms': 'measurement',
  'mixpanel.com': 'measurement',
  // Mixpanel serves its library from `cdn.mxpnl.com`, so the brand entry above never fired
  // for the loader that is actually on the page.
  'mxpnl.com': 'measurement',
  'amplitude.com': 'measurement',
  'heapanalytics.com': 'measurement',
  'segment.io': 'measurement',
  'segment.com': 'measurement',
  'sentry.io': 'measurement',
  'sentry-cdn.com': 'measurement',
  'bugsnag.com': 'measurement',
  'logrocket.com': 'measurement',
  'newrelic.com': 'measurement',
  'nr-data.net': 'measurement',
  'optimizely.com': 'measurement',
  'crazyegg.com': 'measurement',
  'statcounter.com': 'measurement',
  'kissmetrics.com': 'measurement',
  'branch.io': 'measurement',
  'adjust.com': 'measurement',
  'kochava.com': 'measurement',
  'dynamicyield.com': 'measurement',
  'richrelevance.com': 'measurement',
  'bounceexchange.com': 'measurement',
  'quantummetric.com': 'measurement',
  'contentsquare.net': 'measurement',
  // The Facebook pixel loader is measurement; the plugins host is the social widget.
  'connect.facebook.net': 'measurement',
  'web.facebook.com': 'social',
  'platform.twitter.com': 'social',
  'addthis.com': 'social',
  'sharethis.com': 'social',
  'addtoany.com': 'social',
  'disqus.com': 'social',
  'embed.reddit.com': 'social',
  'platform.instagram.com': 'social',
  'cdn.jsdelivr.net': 'cdn',
  'cdnjs.cloudflare.com': 'cdn',
  'unpkg.com': 'cdn',
};

/**
 * Ordinary ad/consent keywords inside a resource path — supporting evidence only.
 *
 * Suppressed when the host is a known CDN, a measurement host or an ad network, because a
 * path says nothing there: jsDelivr and friends serve every library there is, so
 * `analytics` in a path can be a charting package. That suppression is right for this
 * table and wrong for {@link ELEMENT_URL_PATH_VENDOR_PATH_TOKENS}, which is why the two
 * are separate tables rather than one list with a rule attached to some of its entries.
 */
export const ELEMENT_URL_PATH_TOKENS: readonly string[] = [
  'ads',
  'ad',
  'adserver',
  'pagead',
  'adframe',
  'advertisement',
  'analytics',
  'collect',
  'beacon',
  'pixel',
  // `track` was here and is deliberately not any more. In a *path* it is almost never
  // measurement: `/embed/track/<id>` is a song, `/track/<id>` is a parcel or a race result,
  // and `track` is a repository branch. It named an annoyance and hid an embedded music
  // player at 62% — the same ordinary-word trap the tracker vocabulary has to avoid.
  'tracking',
  'consent',
  'cookie',
  'cmp',
] as const;

/**
 * Tracking *products* named in a resource path, counted on any host.
 *
 * A vendor's own name is not an ordinary word and does not stop being evidence because a
 * CDN served the file: `fingerprintjs` is in that path because the library is
 * FingerprintJS, and a CDN that hosts both `chart.js` and `@fingerprintjs/fpjs` says
 * nothing about which one it just handed over. This is what `fingerprintjs-on-public-cdn`
 * in the corpus is about — a fingerprinting script the model could not see at all, because
 * the only evidence that identifies it was suppressed by a rule written for `chart.js`.
 *
 * One such atom is still a single non-shape signal, so it can suggest and never hides: the
 * split widens what the model can *name*, not what it is allowed to do.
 */
export const ELEMENT_URL_PATH_VENDOR_PATH_TOKENS: readonly string[] = [
  'gtm',
  'gtag',
  'fingerprintjs',
  'fpjs',
] as const;

/** Consent markers that are CMP vendor names rather than generic English words. */
const CONSENT_VENDOR_MARKERS: ReadonlySet<string> = new Set([
  'onetrust',
  'optanon',
  'cookiebot',
  'didomi',
  'quantcast',
  'truste',
  'iubenda',
  'klaro',
  'osano',
  'cookieyes',
  'termly',
  'sp_message',
  'sp-message',
  'fc-consent',
  'cmp-banner',
  'cmp-container',
  'cmp-wrapper',
  'cmpwrapper',
]);

const AD_ATTRIBUTE_NAMES: readonly string[] = [
  'data-ad-slot',
  'data-ad-client',
  'data-ad-unit',
  'data-adunit',
  'data-ad-format',
  'data-adtest',
  'data-ad-status',
  'data-adsbygoogle-status',
  'data-google-query-id',
  'data-ad-position',
  'data-ad-index',
  'data-sponsored',
] as const;

const AD_ATTRIBUTE_PREFIXES: readonly string[] = [
  'data-ad-',
  'data-ads-',
  'data-advert',
  'data-gpt-',
  'data-criteo-',
  'data-taboola-',
  'data-outbrain-',
  'data-prebid',
] as const;

const TRACKER_ATTRIBUTE_NAMES: readonly string[] = [
  'data-track',
  'data-tracking',
  'data-track-event',
  'data-track-click',
  'data-analytics',
  'data-gtm',
  'data-fbq',
  'data-ga-event',
] as const;

const TRACKER_ATTRIBUTE_PREFIXES: readonly string[] = [
  'data-track-',
  'data-tracking-',
  'data-analytics-',
  'data-ga-',
  'data-gtm-',
  'data-fbq-',
] as const;

/** Resource-bearing attributes, in the order they are consulted. */
const SOURCE_ATTRIBUTES: readonly string[] = [
  'src',
  'data-src',
  'data-lazy-src',
  'data-original',
  'poster',
  'srcset',
] as const;

/** Tags that load something and hold no readable copy. */
const PASSIVE_TAGS: ReadonlySet<string> = new Set([
  'script', 'img', 'iframe', 'link', 'embed', 'object', 'ins', 'video', 'audio', 'source',
]);

/**
 * Tags whose box on the page is their own. A `<script>` has no rendered box at all —
 * its rect is 0×0 whether it is a beacon or the site's own bundle — so geometry from
 * one says nothing about tracking. Only these tags can be a pixel *by shape*.
 */
const PIXEL_SHAPED_TAGS: ReadonlySet<string> = new Set([
  'img', 'image', 'iframe', 'frame', 'embed', 'object', 'input', 'svg', 'canvas', 'video', 'picture',
]);

/**
 * Ids a framework wrote, not an author. React emits `_R_ad_` and `:r3:`, Radix and MUI
 * emit prefixed ids, and none of them carries meaning: the fragments are positional.
 * A live GitHub page carried `id="_R_ad_"` on its account menu, which the compound rule
 * read as an ad marker and hid at 98%.
 */
const GENERATED_ID_LIKE = /^(?:_r_|:r[a-z0-9]*:|radix-|mui-|headlessui-|downshift-|react-select)/i;

/** Tags/roles that mean "this is where the article lives". */
const SEMANTIC_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'article', 'main', 'section', 'aside', 'details', 'figure',
]);
const SEMANTIC_ROLES: ReadonlySet<string> = new Set([
  'main', 'article', 'region', 'feed', 'document', 'paragraph', 'heading', 'list', 'listitem',
]);

/** Tags that can hold page copy (used for the content shield). */
const TEXT_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'p', 'span', 'li', 'dd', 'dt', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'article', 'main', 'section', 'aside', 'figcaption', 'td', 'th', 'label', 'em', 'strong', 'small',
]);

/** Above this much copy an element is treated as content and never auto-hidden. */
const CONTENT_SHIELD_TEXT_LENGTH = 400;
/**
 * Above this much copy the element is the page itself. Vocabulary in a class or id cannot
 * make it something to act on; only a resource the page cannot be made of can.
 */
const ARTICLE_LENGTH_TEXT = 1000;
const MAX_TEXT_SCAN = 4000;
const MAX_TOKENS_PER_FIELD = 60;
const MAX_ANCESTORS = 24;

// Precomputed lookup sets: matching runs per hover, so the tables are compiled once.
const AD_STRONG_SET = new Set(ELEMENT_AD_STRONG_TOKENS);
const AD_WEAK_SET = new Set(ELEMENT_AD_WEAK_TOKENS);
const LAYOUT_SET = new Set(ELEMENT_LAYOUT_TOKENS);
const TRACKER_STRONG_SET = new Set(ELEMENT_TRACKER_STRONG_TOKENS);
const TRACKER_WEAK_SET = new Set(ELEMENT_TRACKER_WEAK_TOKENS);
const CONSENT_WEAK_SET = new Set(ELEMENT_CONSENT_WEAK_TOKENS);
const SOCIAL_WEAK_SET = new Set(ELEMENT_SOCIAL_WEAK_TOKENS);
const URL_PATH_TOKEN_SET = new Set(ELEMENT_URL_PATH_TOKENS);
const URL_PATH_VENDOR_SET = new Set(ELEMENT_URL_PATH_VENDOR_PATH_TOKENS);
const AD_ATTRIBUTE_NAME_SET = new Set(AD_ATTRIBUTE_NAMES);
const TRACKER_ATTRIBUTE_NAME_SET = new Set(TRACKER_ATTRIBUTE_NAMES);
const SOURCE_ATTRIBUTE_SET = new Set(SOURCE_ATTRIBUTES);
const HOST_KIND_ENTRIES: ReadonlyArray<[string, ElementSourceKind]> = Object.entries(ELEMENT_SOURCE_HOST_KINDS);

// ─── Text helpers ─────────────────────────────────────────────────────────────

function squish(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

/**
 * Splits an identifier into atoms on punctuation **and** camelCase boundaries.
 *
 * This is why `admonition`, `download`, `adapter`, `header` and `adsContainer`
 * behave correctly: only the last produces the atom `ad`, and a word that merely
 * contains those letters produces nothing. Identifier vocabulary is only
 * meaningful at atom boundaries.
 */
export function tokenizeElementIdentifier(value: string): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const bounded = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const out: string[] = [];
  for (const atom of bounded.toLowerCase().split(/[^a-z0-9]+/)) {
    if (atom.length === 0) continue;
    out.push(atom);
    if (out.length >= MAX_TOKENS_PER_FIELD) break;
  }
  return out;
}

function firstMatchingToken(tokens: readonly string[], table: ReadonlySet<string>): string | null {
  for (const token of tokens) {
    if (table.has(token)) return token;
  }
  return null;
}

function firstMatchingMarker(raw: string, markers: readonly string[]): string | null {
  for (const marker of markers) {
    if (marker.length > 0 && raw.includes(marker)) return marker;
  }
  return null;
}

function firstMatchingPhrase(text: string, phrases: readonly string[]): string | null {
  if (text.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    if (phrase.length > 0 && haystack.includes(phrase)) return phrase;
  }
  return null;
}

/** Registrable-suffix match against the curated host table. */
export function matchSourceHostKind(host: string): ElementSourceKind {
  if (!host) return 'none';
  const clean = host.toLowerCase().replace(/^www\./, '');
  for (const [suffix, kind] of HOST_KIND_ENTRIES) {
    if (clean === suffix || clean.endsWith(`.${suffix}`)) return kind;
  }
  return 'none';
}

/** Host of a resource URL, or null when unparseable. */
export function hostOfUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  for (const candidate of trimmed.split(',').slice(0, 4)) {
    const cleaned = candidate.trim().split(/\s+/)[0];
    // A path-relative reference points at the page's own origin, and there is no host
    // in it to read. Assuming `https://` and stripping the leading slash did not fail —
    // it *succeeded*, and invented a domain: `/static/client/runtime.js` resolved to the
    // host `static`, `/w/load.php` to `w`. Those invented hosts then read as remote,
    // non-CDN sources, which turned first-party scripts and Wikipedia's own logo into
    // tracking beacons. Protocol-relative `//cdn.example/a.js` is different: it does
    // name a host, and keeps working.
    const isRelative = cleaned.startsWith('//') === false && /^(?:\/|\.{1,2}\/|[?#])/.test(cleaned);
    if (isRelative) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)
      ? cleaned
      : `https://${cleaned.replace(/^\/+/, '')}`;
    try {
      const url = new URL(withScheme);
      if (url.hostname) return url.hostname.toLowerCase();
    } catch {
      // Not a URL (relative path, fragment) — try the next candidate.
    }
  }
  return null;
}

function pathTokensOf(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://placeholder.invalid/${raw.replace(/^\.?\//, '')}`,
    );
    const atoms: string[] = [];
    for (const token of tokenizeElementIdentifier(`${url.pathname} ${url.search}`)) {
      // Both tables are searched here, not just the ordinary-word one: this function
      // reports what a path *says*, and which of the two rules a given atom then answers to
      // is decided by the caller. Filtering on one table here is what made a vendor name
      // invisible the moment it was given its own rule.
      if (URL_PATH_TOKEN_SET.has(token) || URL_PATH_VENDOR_SET.has(token)) atoms.push(token);
      if (atoms.length >= 8) break;
    }
    return atoms;
  } catch {
    return [];
  }
}

// ─── Snapshot normalization & feature extraction ──────────────────────────────

function sanitizeTag(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

function sanitizeIdentifier(value: unknown, max = 240): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max).toLowerCase();
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value > 100000 ? 100000 : value;
}

function matchedAdSize(width?: number, height?: number): string | null {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return null;
  for (const size of IAB_AD_SIZES) {
    if (Math.abs(width - size.w) <= 3 && Math.abs(height - size.h) <= 3) return size.label;
  }
  return null;
}

/** Normalizes a snapshot field-by-field so nothing downstream sees raw input. */
export function normalizeElementSnapshot(snapshot: ElementSnapshot | null | undefined): ElementSnapshot {
  const input = (snapshot ?? {}) as ElementSnapshot;

  const attributes: Array<{ name: string; value: string }> = [];
  if (Array.isArray(input.attributes)) {
    for (const entry of input.attributes.slice(0, 48)) {
      if (!entry || typeof entry.name !== 'string') continue;
      attributes.push({
        name: entry.name.toLowerCase().slice(0, 64),
        value: typeof entry.value === 'string' ? entry.value.slice(0, 512) : '',
      });
    }
  }

  const classes: string[] = [];
  if (Array.isArray(input.classes)) {
    for (const cls of input.classes.slice(0, 32)) {
      if (typeof cls === 'string' && cls.length > 0) classes.push(cls.slice(0, 120));
    }
  }

  const ancestors: string[] = [];
  if (Array.isArray(input.ancestors)) {
    for (const ancestor of input.ancestors.slice(0, MAX_ANCESTORS)) {
      if (typeof ancestor === 'string' && ancestor.length > 0) ancestors.push(ancestor.slice(0, 160).toLowerCase());
    }
  }

  return {
    tag: sanitizeTag(input.tag),
    id: sanitizeIdentifier(input.id),
    classes,
    attributes,
    text: squish(input.text, MAX_TEXT_SCAN),
    role: sanitizeIdentifier(input.role, 64),
    src: typeof input.src === 'string' ? input.src.slice(0, 2048) : undefined,
    href: typeof input.href === 'string' ? input.href.slice(0, 2048) : undefined,
    width: toPositiveNumber(input.width),
    height: toPositiveNumber(input.height),
    viewportWidth: toPositiveNumber(input.viewportWidth),
    viewportHeight: toPositiveNumber(input.viewportHeight),
    position: sanitizeIdentifier(input.position, 32),
    zIndex: typeof input.zIndex === 'number' && Number.isFinite(input.zIndex) ? input.zIndex : undefined,
    ancestors,
    childCount: toPositiveNumber(input.childCount),
    linkCount: toPositiveNumber(input.linkCount),
    inFrame: input.inFrame === true,
    crossOriginFrame: input.crossOriginFrame === true,
    visible: input.visible !== false,
    sourceVerdict: input.sourceVerdict ?? null,
  };
}

/** Extracts the numeric feature vector from a snapshot. */
export function extractElementFeatures(snapshot: ElementSnapshot): ElementFeatureVector {
  return analyzeElement(snapshot).features;
}

/**
 * Full analysis: numeric features plus the human-readable details behind them.
 * Callers that only need the vector should use {@link extractElementFeatures}.
 */
export function analyzeElement(snapshot: ElementSnapshot): ElementFeatureAnalysis {
  const el = normalizeElementSnapshot(snapshot);

  // The tag is an author's identifier too, and purpose-built elements say what they are in
  // it: `<amp-ad>` exists to serve ads. Atom matching keeps the tags `address`-like words can
  // appear in — and `header`, `aside`, `figure` — out of the vocabulary entirely.
  // A framework-generated id is not an author's identifier: nobody chose its words, and
  // its fragments are positional. It contributes no vocabulary at all, which is what keeps
  // `id="_R_ad_"` (React, on GitHub's account menu) from reading as an ad compound while
  // `in-article-ad` and `video-ad` keep promoting exactly as they always did.
  const semanticId = el.id && !GENERATED_ID_LIKE.test(el.id) ? el.id : '';

  const tokens: string[] = [
    ...tokenizeElementIdentifier(el.tag),
    ...tokenizeElementIdentifier(semanticId),
  ];
  for (const cls of el.classes ?? []) {
    for (const token of tokenizeElementIdentifier(cls)) tokens.push(token);
    if (tokens.length >= MAX_TOKENS_PER_FIELD * 2) break;
  }
  const boundedTokens = tokens.slice(0, MAX_TOKENS_PER_FIELD * 2);

  const rawIdentifier = `${semanticId} ${(el.classes ?? []).join(' ')}`.toLowerCase();

  // Attribute-level evidence.
  let adAttribute: string | null = null;
  let trackerAttribute: string | null = null;
  let sourceValue: string | null = null;
  let sourceAttribute: string | null = null;
  let titleText = '';

  for (const attribute of el.attributes ?? []) {
    if (!adAttribute) {
      if (AD_ATTRIBUTE_NAME_SET.has(attribute.name)) adAttribute = attribute.name;
      else if (AD_ATTRIBUTE_PREFIXES.some((prefix) => attribute.name.startsWith(prefix))) adAttribute = attribute.name;
    }
    if (!trackerAttribute) {
      if (TRACKER_ATTRIBUTE_NAME_SET.has(attribute.name)) trackerAttribute = attribute.name;
      else if (TRACKER_ATTRIBUTE_PREFIXES.some((prefix) => attribute.name.startsWith(prefix))) trackerAttribute = attribute.name;
    }
    if (!sourceValue && SOURCE_ATTRIBUTE_SET.has(attribute.name) && attribute.value.length > 0) {
      sourceValue = attribute.value;
      sourceAttribute = attribute.name;
    }
    if (attribute.name === 'title' || attribute.name === 'aria-label') {
      titleText += ` ${attribute.value}`;
    }
  }

  const resourceUrl = sourceValue ?? el.src ?? '';
  const sourceHost = hostOfUrl(resourceUrl);
  const sourceKind = sourceHost ? matchSourceHostKind(sourceHost) : 'none';
  const urlPathTokens = resourceUrl ? pathTokensOf(resourceUrl) : [];

  // Token evidence.
  // A bare `ad` atom is genuinely ambiguous — sites abbreviate "admin" and "address" that way —
  // so on its own it stays weak. A *compound* identifier that leads or ends with it is not
  // ambiguous: `video-ad`, `ad-slot` and `anchor-ad` exist to name an ad, and a cosmetic filter
  // matches them exactly the same way. Position is the whole guard: `no-ads-subscription` names
  // an upsell rather than an ad, so a middle atom never promotes.
  const compoundAdField =
    [semanticId, ...(el.classes ?? [])].find((field) => {
      const atoms = tokenizeElementIdentifier(field);
      if (atoms.length < 2) return false;
      const edges = [atoms[0], atoms[atoms.length - 1]];
      return edges.includes('ad') || edges.includes('ads');
    }) ?? null;
  const adStrongFromVocabulary = firstMatchingToken(boundedTokens, AD_STRONG_SET);
  const adStrong = adStrongFromVocabulary ?? (compoundAdField ? 'ad' : null);
  const adWeak = firstMatchingToken(boundedTokens, AD_WEAK_SET);
  const layoutWord = firstMatchingToken(boundedTokens, LAYOUT_SET);
  const trackerStrong = firstMatchingToken(boundedTokens, TRACKER_STRONG_SET);
  const trackerWeak = firstMatchingToken(boundedTokens, TRACKER_WEAK_SET);
  const consentStrong = firstMatchingMarker(rawIdentifier, ELEMENT_CONSENT_STRONG_MARKERS);
  const consentWeak = firstMatchingToken(boundedTokens, CONSENT_WEAK_SET);
  const nagMarker = firstMatchingMarker(rawIdentifier, ELEMENT_NAG_MARKERS);
  const socialStrong = firstMatchingMarker(rawIdentifier, ELEMENT_SOCIAL_STRONG_MARKERS);
  const socialWeak = firstMatchingToken(boundedTokens, SOCIAL_WEAK_SET);

  // Ancestor evidence: the nearest ancestor carrying ad or consent markup.
  let ancestorMarker: string | null = null;
  for (const ancestor of el.ancestors ?? []) {
    const strongToken = firstMatchingToken(tokenizeElementIdentifier(ancestor), AD_STRONG_SET);
    const marker = firstMatchingMarker(ancestor, ELEMENT_NAG_MARKERS) ?? firstMatchingMarker(ancestor, ELEMENT_CONSENT_STRONG_MARKERS);
    if (strongToken || marker) {
      ancestorMarker = ancestor.slice(0, 120);
      break;
    }
  }

  // Copy evidence.
  const text = el.text ?? '';
  const textLength = text.length;
  const scanText = `${text} ${titleText}`;
  const antiAdblockPhrase = firstMatchingPhrase(scanText, ELEMENT_ANTI_ADBLOCK_PHRASES);
  const lurePhrase = firstMatchingPhrase(scanText, ELEMENT_LURE_PHRASES);

  // Geometry evidence.
  const width = el.width;
  const height = el.height;
  const adSize = matchedAdSize(width, height);
  const area = width !== undefined && height !== undefined ? width * height : undefined;
  // A beacon is a rendered box of a few pixels. Two things disqualify a candidate that
  // is not one. A zero-area box is the *absence* of geometry — an unrendered `<script>`,
  // a lazy image that has not laid out yet, a collapsed ad slot — and reading it as
  // "1×1" was the single largest source of false positives on live pages: four of five
  // sampled sites had their own scripts, photos and logos hidden at 98% for it. And a
  // tag with no box of its own can never be a pixel whatever its rect says.
  const hasRenderedBox = area !== undefined && area > 0;
  const isPixel =
    hasRenderedBox && PIXEL_SHAPED_TAGS.has(el.tag) && (width as number) <= 4 && (height as number) <= 4;
  const pixelBox = isPixel ? `${width}×${height}` : null;
  const viewportArea = (el.viewportWidth ?? 0) * (el.viewportHeight ?? 0);
  const viewportCoverage = area !== undefined && viewportArea > 0 ? Math.min(1, area / viewportArea) : 0;
  const fixedLike = el.position === 'fixed' || el.position === 'sticky';
  const highZ = typeof el.zIndex === 'number' && el.zIndex >= 1000;
  const overlayGeometry = fixedLike && (highZ || viewportCoverage >= 0.15);

  // Invisibility counts as frame evidence because it is read from *style* in the confirm
  // pass — a `display:none` iframe carrying a sized-and-hidden beacon is the classic
  // hidden tracker, and NYT's own `/ads/tpc-check.html` frame is exactly that shape
  // (declared 0×0, `display:none`, cross-origin). A zero *rect* is not the same claim and
  // is deliberately not used here.
  const thirdPartyFrame =
    el.tag === 'iframe' && sourceHost !== null && (sourceKind !== 'none' || el.crossOriginFrame === true || el.visible === false);
  const passiveSource = PASSIVE_TAGS.has(el.tag) && sourceHost !== null;
  // A pixel-sized image is a beacon when something says so: a tracking token, a known
  // measurement/ad host, or any non-CDN remote host (a spacer lives on the site's
  // own CDN, a pixel lives on an analytics domain).
  const pixelEvidence =
    isPixel &&
    (trackerStrong !== null || trackerWeak !== null || (sourceHost !== null && sourceKind !== 'cdn'));

  // Content evidence: copy-bearing shapes.
  const linkDensity =
    el.childCount !== undefined && el.childCount > 0
      ? Math.min(1, (el.linkCount ?? 0) / Math.max(1, el.childCount))
      : 0;
  const textDensity = Math.min(1, textLength / 240);
  const contentScore = Math.max(
    TEXT_CONTAINER_TAGS.has(el.tag) ? textDensity * 0.9 : textDensity * 0.5,
    textLength >= CONTENT_SHIELD_TEXT_LENGTH && linkDensity < 0.5 ? 0.8 : 0,
  );
  const semanticContainer =
    SEMANTIC_CONTAINER_TAGS.has(el.tag) || SEMANTIC_ROLES.has(el.role ?? '')
      ? 1
      : (el.ancestors ?? []).some((ancestor) => {
          const base = ancestor.split('.')[0].replace(/[^a-z]/g, '');
          return base === 'article' || base === 'main';
        })
        ? 0.6
        : 0;

  // The URL model's opinion of the source, when the caller supplies one.
  const sourceVerdictCategory = el.sourceVerdict?.category ?? '';
  const sourceVerdictMalicious = el.sourceVerdict?.verdict === 'malicious';
  const adHostMatch = sourceKind === 'ad-network' || sourceVerdictCategory === 'Advertising' || sourceVerdictMalicious ? 1 : 0;
  const measureHostMatch = sourceKind === 'measurement' || sourceVerdictCategory === 'Telemetry/Analytics' ? 1 : 0;
  const socialHostMatch = sourceKind === 'social' ? 1 : 0;

  // `data-track-*` and `data-analytics-*` are the page labelling its *own* element for
  // analytics, and every modern page puts one on nearly every link and button. Read as
  // evidence on its own, the attribute says "the page measures clicks here" — not "this
  // loads a tracker" — and on github.com it was the entire difference between leaving a
  // footer profile link alone and reporting it as a Tracker for the user to block. So it
  // counts where the element is already tracker-flavoured (tracking vocabulary, a
  // measurement host, beacon or frame shape) and is neutral otherwise. The interaction
  // is written out here rather than left to the fit because the corpus can only carry a
  // handful of examples of one attribute, and a weight that thin is the prior talking.
  const trackerFlavoured =
    trackerStrong !== null ||
    trackerWeak !== null ||
    measureHostMatch === 1 ||
    pixelEvidence ||
    thirdPartyFrame;

  const features: ElementFeatureVector = {
    adStrongToken: adStrong ? 1 : 0,
    adWeakToken: adWeak ? 1 : 0,
    trackerStrongToken: trackerStrong ? 1 : 0,
    trackerWeakToken: trackerWeak ? 1 : 0,
    consentStrongMarker: consentStrong ? 1 : 0,
    consentWeakToken: consentWeak ? 1 : 0,
    socialStrongMarker: socialStrong ? 1 : 0,
    socialWeakToken: socialWeak ? 1 : 0,
    dataAdAttribute: adAttribute ? 1 : 0,
    dataTrackerAttribute: trackerAttribute && trackerFlavoured ? 1 : 0,
    adHostMatch,
    measureHostMatch,
    socialHostMatch,
    urlPathToken: urlPathTokens.length > 0 ? Math.min(1, urlPathTokens.length / 2) : 0,
    thirdPartyFrame: thirdPartyFrame ? 1 : 0,
    passiveSource: passiveSource ? 1 : 0,
    pixelGeometry: isPixel ? 1 : 0,
    adSizeGeometry: adSize ? 1 : 0,
    overlayGeometry: overlayGeometry ? 1 : 0,
    lureText: lurePhrase ? 1 : 0,
    antiAdblockText: antiAdblockPhrase ? 1 : 0,
    ancestorAd: ancestorMarker ? 1 : 0,
    contentText: contentScore,
    semanticContainer,
    userTuneBias: 0,
  };

  const families: ElementEvidenceFamily[] = [];
  const add = (family: ElementEvidenceFamily): void => {
    if (!families.includes(family)) families.push(family);
  };

  if (adStrong) add('ad-marker');
  if (adAttribute) add('ad-attribute');
  if (adHostMatch) add('ad-network');
  if (ancestorMarker) add('ad-ancestor');
  if (trackerStrong || measureHostMatch) add('measurement');
  if (antiAdblockPhrase) add('anti-adblock');
  if (consentStrong) add('consent-marker');
  if (nagMarker) add('nag-marker');
  if (socialStrong || socialHostMatch) add('social-embed');
  if (lurePhrase) add('lure-copy');
  if (adSize) add('ad-size');
  if (overlayGeometry) add('overlay-shape');
  if (pixelEvidence) add('pixel-shape');
  if (thirdPartyFrame) add('third-party-frame');
  // Only ad and social vocabulary counts as a weak *family*. A bare consent word
  // (`class="cookie"` on a recipe page) and a bare tracking word
  // (`class="analytics-panel"` on a dashboard) are ordinary product vocabulary, so
  // they stay model-only signals that can never be acted on.
  if (adWeak) add('ad-weak-marker');
  if (layoutWord) add('layout-marker');
  if (socialWeak) add('weak-marker');
  // Two different questions about a resource path, kept apart because they have different
  // answers. An *ordinary* word in a path is evidence only when the host leaves the path
  // meaningful (`sourceKind === 'none'`); a *vendor* name in a path is evidence whatever
  // the host, because the name is the product. Both are still one non-shape signal, so
  // either can suggest and neither can hide.
  const genericPathToken = firstMatchingToken(urlPathTokens, URL_PATH_TOKEN_SET);
  const vendorPathToken = firstMatchingToken(urlPathTokens, URL_PATH_VENDOR_SET);
  const pathSaysSomething =
    genericPathToken !== null
      ? sourceKind === 'none' && !adStrong && !adAttribute
      : vendorPathToken !== null;
  if (pathSaysSomething && sourceVerdictCategory === '') add('url-path');

  return {
    features,
    families,
    details: {
      adTokens: [adStrong, adWeak].filter((token): token is string => Boolean(token)),
      layoutTokens: [layoutWord].filter((token): token is string => Boolean(token)),
      trackerTokens: [trackerStrong, trackerWeak].filter((token): token is string => Boolean(token)),
      consentMarkers: [consentStrong, consentWeak].filter((token): token is string => Boolean(token)),
      socialMarkers: [socialStrong, socialWeak].filter((token): token is string => Boolean(token)),
      weakTokens: [adStrong, adWeak, layoutWord, consentStrong, consentWeak, socialStrong, socialWeak].filter(
        (token): token is string => Boolean(token),
      ),
      sourceHost,
      sourceKind,
      sourceAttribute,
      adSize,
      adMatchedOn: adStrongFromVocabulary ?? compoundAdField,
      pixelBox,
      adAttribute,
      trackerAttribute,
      antiAdblockPhrase,
      lurePhrase,
      nagMarker,
      ancestorMarker,
      textLength,
      viewportCoverage: Math.round(viewportCoverage * 1000) / 1000,
      urlPathTokens,
    },
  };
}

// ─── Evidence assessment ──────────────────────────────────────────────────────

export interface EvidenceAssessmentInput {
  families: ElementEvidenceFamily[];
  details: ElementEvidenceDetails;
  features: ElementFeatureVector;
}

function isConsentVendorMarker(marker: string | null): boolean {
  return marker !== null && CONSENT_VENDOR_MARKERS.has(marker);
}

/**
 * Decides how much the evidence can justify — the gate that keeps a guess from
 * reading as a fact, and keeps one weak signal from hiding a hero banner.
 */
export function assessElementEvidence(analysis: EvidenceAssessmentInput): ElementEvidenceAssessment {
  const { families, details, features } = analysis;

  // "Shaped" means the element behaves like a banner: pinned over the viewport, or
  // talking the user into something. Consent and nag markup is only definitive when
  // it is shaped — `class="cookie"` on a recipe page is neither.
  const shaped = features.overlayGeometry === 1 || features.lureText === 1;
  const consentDefinitive =
    isConsentVendorMarker(details.consentMarkers[0] ?? null) ||
    (features.consentStrongMarker === 1 && shaped);
  const nagDefinitive = families.includes('nag-marker') && shaped;

  const definitive: ElementEvidenceFamily[] = [];
  const supporting: ElementEvidenceFamily[] = [];

  for (const family of families) {
    if (family === 'consent-marker') {
      (consentDefinitive ? definitive : supporting).push(family);
    } else if (family === 'nag-marker') {
      (nagDefinitive ? definitive : supporting).push(family);
    } else if (DEFINITIVE_FAMILIES.has(family)) {
      definitive.push(family);
    } else {
      supporting.push(family);
    }
  }

  // Substantial copy with no definitive evidence is content, whatever shape it has.
  const contentShield = features.contentText >= 0.5 && definitive.length === 0;

  // An element this long is the page itself, not a unit inside it. Two things overrule that.
  //
  // A *pinned overlay* is not the page — it sits on top of it — so a modal carrying pages of
  // copy is still a nag, which is exactly what a walled newsletter or paywall modal does.
  //
  // And evidence a page cannot be *made of*: an ad delivery attribute, or a resource served by
  // an ad network. Vocabulary cannot, and treating it as if it could was destructive — a policy
  // page about advertising carries the same class word as an ad slot, so `#advertising-policy`
  // and a `sponsored-article-body` were both hidden outright, prose and all.
  const intrinsicResource = definitive.some(
    (family) => family === 'ad-attribute' || family === 'ad-network',
  );
  const proseShield =
    details.textLength >= ARTICLE_LENGTH_TEXT &&
    !intrinsicResource &&
    features.overlayGeometry !== 1;

  let tier: ElementEvidenceAssessment['tier'];
  let maxAction: ElementAction;
  let maxConfidence: number;

  if (definitive.length > 0) {
    tier = 'corroborated';
    maxAction = 'hide';
    maxConfidence = 98;
  } else if (supporting.length >= 2) {
    // Two independent hints are a finding: an ad-shaped class *and* an ad-sized
    // rectangle, or a sticky bar *and* promo markup. One hint alone is not — that is
    // the line that keeps `class="banner"` from hiding a hero image.
    tier = 'corroborated';
    maxAction = 'hide';
    maxConfidence = 84;
  } else if (supporting.length === 1) {
    tier = 'single-signal';
    maxAction = 'suggest';
    maxConfidence = isShapeOnlyFamily(supporting[0]) ? 52 : 58;
  } else {
    tier = 'model-only';
    maxAction = 'leave';
    maxConfidence = 45;
  }

  if (contentShield && maxAction === 'hide') {
    maxAction = 'suggest';
    maxConfidence = Math.min(maxConfidence, 70);
  }
  if (details.textLength >= CONTENT_SHIELD_TEXT_LENGTH && definitive.length === 0) {
    maxAction = 'leave';
    maxConfidence = Math.min(maxConfidence, 55);
  }
  // Hiding an article-length element removes what the user came to read, so such an
  // element is only ever suggested.
  if (proseShield && maxAction === 'hide') {
    maxAction = 'suggest';
    maxConfidence = Math.min(maxConfidence, 70);
  }
  // An adblock wall is definitive evidence, but whether to hide it is the user's
  // call: removing it changes what the site is willing to show them at all.
  if (details.antiAdblockPhrase && maxAction === 'hide') {
    maxAction = 'suggest';
    maxConfidence = Math.min(maxConfidence, 95);
  }

  const named =
    definitive.length > 0 ||
    supporting.length >= 2 ||
    (supporting.length === 1 && !isShapeOnlyFamily(supporting[0]));

  if (!named) {
    // Nothing here names a class, so there is nothing to suggest either: a shape
    // alone is reported as content, with the shape itself left in `reasons`.
    maxAction = 'leave';
  }

  return {
    families,
    definitive,
    supporting,
    tier,
    maxAction,
    maxConfidence,
    contentShield,
    proseShield,
    named,
  };
}

/**
 * Families that describe geometry, provenance or shared layout vocabulary rather
 * than purpose. A 300×250 hero image and a 300×250 ad slot are the same rectangle, a
 * cross-origin frame is a YouTube embed as often as an ad, and `banner` is a hero
 * section as often as an ad slot. These corroborate, but never name a class.
 */
function isShapeOnlyFamily(family: ElementEvidenceFamily): boolean {
  return (
    family === 'ad-size' ||
    family === 'overlay-shape' ||
    family === 'third-party-frame' ||
    family === 'url-path' ||
    family === 'layout-marker'
  );
}

// ─── Model ────────────────────────────────────────────────────────────────────

export type ElementClassWeights = { bias: number } & Record<ElementFeatureName, number>;

/** One weight vector per class, in {@link ELEMENT_CLASSES} order. */
export type ElementWeightSet = Record<ElementClass, ElementClassWeights>;

/**
 * The original hand-written weight vectors, one per class.
 *
 * Kept for two reasons: it is the control the fitted weights are measured against, and
 * it is the centre of the Gaussian prior the fit is pulled back toward — which is what
 * makes fitting 104 parameters from ~70 labelled elements safe rather than absurd
 * ({\@link fitElementWeights}). Every feature appears in every vector so contributions stay
 * comparable across classes, exactly as in the domain model.
 */
export const ELEMENT_HAND_TUNED_WEIGHTS: ElementWeightSet = {
  Ad: {
    bias: -1.5,
    adStrongToken: 14,
    adWeakToken: 3.5,
    trackerStrongToken: -3,
    trackerWeakToken: -1,
    consentStrongMarker: -3,
    consentWeakToken: -0.5,
    socialStrongMarker: -3,
    socialWeakToken: -0.5,
    dataAdAttribute: 14,
    dataTrackerAttribute: -1,
    adHostMatch: 13,
    measureHostMatch: -3,
    socialHostMatch: -2,
    urlPathToken: 2.5,
    thirdPartyFrame: 2,
    passiveSource: 0.5,
    pixelGeometry: -2,
    adSizeGeometry: 4,
    overlayGeometry: 1,
    lureText: -1,
    antiAdblockText: -2,
    ancestorAd: 4,
    contentText: -7,
    semanticContainer: -5,
    userTuneBias: 5,
  },
  Tracker: {
    bias: -2,
    adStrongToken: -3,
    adWeakToken: -0.5,
    trackerStrongToken: 13,
    trackerWeakToken: 4,
    consentStrongMarker: -1,
    consentWeakToken: -0.3,
    socialStrongMarker: -2,
    socialWeakToken: -0.5,
    dataAdAttribute: -2,
    // Sits with `trackerWeakToken`, not with `trackerStrongToken`. A `data-track-*` or
    // `data-analytics-*` attribute is the page labelling its own element for analytics,
    // and modern sites put one on every link and button; measured on github.com it was
    // the whole difference between leaving a social profile link alone and suggesting
    // it be blocked. The word "tracker" in a class name is a claim about the element;
    // this attribute is a claim about the page's instrumentation.
    dataTrackerAttribute: 4,
    adHostMatch: -3,
    measureHostMatch: 13,
    socialHostMatch: -2,
    urlPathToken: 2.5,
    thirdPartyFrame: 3,
    passiveSource: 1.5,
    pixelGeometry: 7,
    adSizeGeometry: -3,
    overlayGeometry: -1,
    lureText: -1.5,
    antiAdblockText: -2,
    ancestorAd: 3,
    contentText: -7,
    semanticContainer: -5,
    userTuneBias: 5,
  },
  Annoyance: {
    bias: -2.5,
    adStrongToken: -2,
    adWeakToken: 0.5,
    trackerStrongToken: -3,
    trackerWeakToken: -1,
    consentStrongMarker: 13,
    consentWeakToken: 3,
    socialStrongMarker: 9,
    socialWeakToken: 1,
    dataAdAttribute: -3,
    dataTrackerAttribute: -1,
    adHostMatch: -4,
    measureHostMatch: -3,
    socialHostMatch: 8,
    urlPathToken: 2,
    thirdPartyFrame: 1.5,
    passiveSource: 0,
    pixelGeometry: -4,
    adSizeGeometry: -2,
    overlayGeometry: 6,
    lureText: 8,
    antiAdblockText: 11,
    ancestorAd: 1,
    contentText: -6,
    semanticContainer: -3,
    userTuneBias: 5,
  },
  Content: {
    bias: 2,
    adStrongToken: -12,
    adWeakToken: -3.5,
    trackerStrongToken: -8,
    trackerWeakToken: -2,
    consentStrongMarker: -8,
    consentWeakToken: -2,
    socialStrongMarker: -6,
    socialWeakToken: -1,
    dataAdAttribute: -10,
    dataTrackerAttribute: -2,
    adHostMatch: -10,
    measureHostMatch: -9,
    socialHostMatch: -6,
    urlPathToken: -2,
    thirdPartyFrame: -1.5,
    passiveSource: -0.5,
    pixelGeometry: -3,
    adSizeGeometry: -3,
    overlayGeometry: -2.5,
    lureText: -6,
    antiAdblockText: -8,
    ancestorAd: -3,
    contentText: 9,
    semanticContainer: 4,
    userTuneBias: -5,
  },
};

/**
 * The weights the classifier actually uses: fit from the labelled element corpus by
 * `scripts/fit-element-weights.mjs`, with {@link ELEMENT_HAND_TUNED_WEIGHTS} as the
 * centre of the prior. See {@link ELEMENT_FITTED_PROVENANCE} for the run that produced
 * them and the held-out measurement that justifies them over the table they replaced.
 *
 * A build artifact, not a source of truth: change the corpus or the feature set and it
 * must be regenerated. `element-weights-fit.test.ts` re-fits from the corpus and fails if
 * these numbers drift from it.
 */
export const ELEMENT_MODEL_WEIGHTS: ElementWeightSet = ELEMENT_FITTED_WEIGHTS;

const FEATURE_LABELS: Record<ElementFeatureName, string> = {
  adStrongToken: 'Ad container markup',
  adWeakToken: 'Ambiguous ad vocabulary',
  trackerStrongToken: 'Tracking markup',
  trackerWeakToken: 'Ambiguous tracking vocabulary',
  consentStrongMarker: 'Consent/CMP markup',
  consentWeakToken: 'Consent vocabulary',
  socialStrongMarker: 'Social share widget',
  socialWeakToken: 'Social vocabulary',
  dataAdAttribute: 'Ad delivery attribute',
  dataTrackerAttribute: 'Tracking attribute',
  adHostMatch: 'Ad network source',
  measureHostMatch: 'Measurement network source',
  socialHostMatch: 'Social embed source',
  urlPathToken: 'Ad-shaped resource path',
  thirdPartyFrame: 'Third-party frame',
  passiveSource: 'Remote passive resource',
  pixelGeometry: 'Pixel geometry',
  adSizeGeometry: 'Standard ad dimensions',
  overlayGeometry: 'Fixed overlay geometry',
  lureText: 'Subscription/consent copy',
  antiAdblockText: 'Adblock-wall copy',
  ancestorAd: 'Inside an ad container',
  contentText: 'Page copy',
  semanticContainer: 'Article/main container',
  userTuneBias: 'Your previous decisions',
};

/**
 * Linear model + softmax, the one place a weight set is turned into probabilities.
 * `weights` defaults to the shipped table; the fitting harness passes candidate sets so
 * it can score them through exactly the code path that ships.
 */
export function softmaxFor(
  features: ElementFeatureVector,
  weights: ElementWeightSet = ELEMENT_MODEL_WEIGHTS,
): Record<ElementClass, number> {
  const scores: Record<ElementClass, number> = { Ad: 0, Tracker: 0, Annoyance: 0, Content: 0 };
  let max = -Infinity;

  for (const cls of ELEMENT_CLASSES) {
    const vector = weights[cls];
    let score = vector.bias;
    for (const name of Object.keys(vector) as Array<keyof ElementClassWeights>) {
      if (name === 'bias') continue;
      const value = features[name];
      if (value) score += vector[name] * value;
    }
    scores[cls] = score;
    if (score > max) max = score;
  }

  const denominator = ELEMENT_CLASSES.reduce((sum, cls) => sum + Math.exp(scores[cls] - max), 0);
  const probabilities = { Ad: 0, Tracker: 0, Annoyance: 0, Content: 0 } as Record<ElementClass, number>;
  for (const cls of ELEMENT_CLASSES) {
    probabilities[cls] = Math.round((Math.exp(scores[cls] - max) / denominator) * 10000) / 10000;
  }
  return probabilities;
}

/**
 * Policy adjustment: definitive evidence outranks the statistical score.
 *
 * The statistical model can be dragged toward the wrong class when a strong marker
 * and a content shape coexist (an ad container holding a lot of empty markup, say).
 * When the evidence names a class outright, that class wins and its probability is
 * raised to reflect it — the same role `adjustThreatCategory()` plays for hostnames.
 */
export function adjustElementClass(
  probabilities: Record<ElementClass, number>,
  analysis: EvidenceAssessmentInput,
): { elementClass: ElementClass; classProbabilities: Record<ElementClass, number> } {
  const { families } = analysis;

  // The implied class comes from families, not raw features: a feature is a
  // measurement, a family is a conclusion. `pixelGeometry` on a CDN spacer is not
  // the `pixel-shape` family, and must not force a Tracker verdict.
  const has = (family: ElementEvidenceFamily): boolean => families.includes(family);
  let implied: ElementClass | null = null;

  // A user decision is not a nudge on the logits — it is a ruling. A `hide` decision
  // says "this is not content", so the model's only remaining job is to say *which*
  // kind, chosen among the three actionable classes. Without this, a structural prior
  // such as "this is inside an <aside>" (a −5 on Ad) can outvote the person who is
  // looking at the element.
  if (has('user-choice')) {
    let best: ElementClass = 'Annoyance';
    for (const cls of ['Ad', 'Tracker', 'Annoyance'] as const) {
      if (probabilities[cls] > probabilities[best]) best = cls;
    }
    implied = best;
  } else if (has('ad-marker') || has('ad-attribute') || has('ad-network') || has('ad-ancestor')) {
    implied = 'Ad';
  } else if (has('anti-adblock') || has('consent-marker') || has('nag-marker') || has('social-embed')) {
    implied = 'Annoyance';
  } else if (has('measurement') || has('pixel-shape')) {
    implied = 'Tracker';
  }

  if (!implied) {
    let winner: ElementClass = 'Content';
    for (const cls of ELEMENT_CLASSES) {
      if (probabilities[cls] > probabilities[winner]) winner = cls;
    }
    return { elementClass: winner, classProbabilities: probabilities };
  }

  const adjusted = { ...probabilities };
  const floor = 0.78;
  if (adjusted[implied] < floor) {
    const remaining = 1 - floor;
    let otherTotal = 0;
    for (const cls of ELEMENT_CLASSES) if (cls !== implied) otherTotal += probabilities[cls];
    for (const cls of ELEMENT_CLASSES) {
      adjusted[cls] = cls === implied
        ? floor
        : otherTotal > 0
          ? Math.round((probabilities[cls] / otherTotal) * remaining * 10000) / 10000
          : 0;
    }
  }

  const total = ELEMENT_CLASSES.reduce((sum, cls) => sum + adjusted[cls], 0);
  if (total > 0) {
    for (const cls of ELEMENT_CLASSES) adjusted[cls] = Math.round((adjusted[cls] / total) * 10000) / 10000;
  }
  return { elementClass: implied, classProbabilities: adjusted };
}

// ─── Explanations ─────────────────────────────────────────────────────────────

function cleanHost(host: string | null): string {
  return host ? host.replace(/^www\./, '') : '';
}

type ReasonKind =
  | 'ad-attribute'
  | 'ad-network'
  | 'ad-marker'
  | 'ad-weak'
  | 'layout'
  | 'ancestor'
  | 'ad-size'
  | 'measurement-host'
  | 'tracker-token'
  | 'pixel'
  | 'anti-adblock'
  | 'consent'
  | 'nag'
  | 'social'
  | 'overlay'
  | 'lure'
  | 'frame'
  | 'copy'
  | 'no-evidence'
  | 'user'
  | 'tier';

/**
 * Explanation order per class: lead with the evidence that class actually rests on.
 * A cookie banner is explained by its consent markup, not by the word `banner` in a
 * class name, which is only corroborating detail.
 */
const REASON_PRIORITY: Record<ElementClass, readonly ReasonKind[]> = {
  Ad: ['user', 'ad-attribute', 'ad-network', 'ad-marker', 'ancestor', 'ad-weak', 'ad-size', 'layout', 'frame', 'tier'],
  Tracker: ['user', 'measurement-host', 'pixel', 'tracker-token', 'frame', 'ad-marker', 'tier'],
  Annoyance: ['user', 'anti-adblock', 'consent', 'nag', 'social', 'overlay', 'lure', 'ad-weak', 'frame', 'tier'],
  Content: ['user', 'copy', 'ad-size', 'layout', 'no-evidence', 'ad-weak', 'frame', 'tier'],
};

function buildReasons(
  elementClass: ElementClass,
  assessment: ElementEvidenceAssessment,
  details: ElementEvidenceDetails,
  features: ElementFeatureVector,
): string[] {
  const candidates: Array<{ kind: ReasonKind; text: string }> = [];
  const push = (kind: ReasonKind, text: string): void => {
    candidates.push({ kind, text });
  };
  const host = cleanHost(details.sourceHost);
  const has = (family: ElementEvidenceFamily): boolean => assessment.families.includes(family);

  if (features.dataAdAttribute === 1) {
    push('ad-attribute', 'Element carries an ad delivery attribute (data-ad-*).');
  }
  if (features.adStrongToken === 1) {
    push('ad-marker', `Ad container markup ("${details.adTokens[0] ?? 'ad'}").`);
  } else if (features.adWeakToken === 1) {
    push('ad-weak', `Ad-shaped class or id ("${details.adTokens[0] ?? 'ad'}").`);
  }
  if (details.layoutTokens.length > 0) {
    push('layout', `Layout vocabulary that ads also use ("${details.layoutTokens[0]}").`);
  }
  if (details.sourceKind === 'ad-network') {
    push('ad-network', `Loads from a known ad network (${host}).`);
  } else if (details.sourceKind === 'measurement') {
    push('measurement-host', `Loads from a known measurement network (${host}).`);
  } else if (details.sourceKind === 'social') {
    push('social', `Social embed from ${host}.`);
  }
  if (features.trackerStrongToken === 1) {
    push('tracker-token', `Tracking markup ("${details.trackerTokens[0] ?? 'tracker'}").`);
  }
  if (has('consent-marker')) {
    push('consent', `Cookie/consent banner markup ("${details.consentMarkers[0]}").`);
  }
  if (has('nag-marker')) {
    push('nag', `Newsletter, paywall or signup markup ("${details.nagMarker}").`);
  }
  if (has('social-embed') && details.socialMarkers.length > 0) {
    push('social', `Social share widget ("${details.socialMarkers[0]}").`);
  }
  if (features.antiAdblockText === 1) {
    push('anti-adblock', `Adblock-wall copy ("${details.antiAdblockPhrase}").`);
  }
  if (has('pixel-shape')) {
    push('pixel', `Tracking pixel geometry (${details.pixelBox ?? 'a few pixels'}).`);
  }
  if (details.adSize) {
    push('ad-size', `Standard ad dimensions (${details.adSize}).`);
  }
  if (has('third-party-frame')) {
    push(
      'frame',
      details.sourceKind === 'none'
        ? 'Cross-origin frame with no readable content.'
        : `Third-party frame from ${host}.`,
    );
  }
  if (features.overlayGeometry === 1) {
    push(
      'overlay',
      details.viewportCoverage > 0
        ? `Pinned overlay covering ${Math.round(details.viewportCoverage * 100)}% of the viewport.`
        : 'Pinned to the viewport (fixed or sticky positioning).',
    );
  }
  if (features.lureText === 1) {
    push('lure', `Subscription or consent call to action ("${details.lurePhrase}").`);
  }
  if (details.ancestorMarker) {
    push('ancestor', `Sits inside an ad container ("${details.ancestorMarker}").`);
  }
  // The user's own decision is the strongest evidence available and outranks every
  // inference above; it is also the only way a shape the model cannot name becomes
  // actionable ("this sidebar unit is an ad — hide this kind of thing everywhere").
  if (has('user-choice')) {
    push('user', `You marked elements like this ("${details.weakTokens[0] ?? 'this shape'}") as something to hide.`);
  } else if (features.userTuneBias < 0) {
    push('user', 'You marked elements like this as content — left alone.');
  }

  if (elementClass === 'Content') {
    if (details.textLength > 0) {
      push('copy', `Page copy (${details.textLength.toLocaleString('en-US')} characters) with no advertising evidence.`);
    } else {
      // An element whose own class or id carries `ad` and `banner` must not be described
      // as having no advertising evidence — the panel would be contradicting itself.
      if (details.weakTokens.length > 0) {
        const named = details.weakTokens.slice(0, 2).map((token) => `"${token}"`).join(', ');
        push('no-evidence', `Vocabulary ads also use (${named}) — nothing that names an ad on its own.`);
      } else {
        push('no-evidence', 'No advertising, tracking or nag evidence.');
      }
    }
  }

  if (assessment.tier === 'single-signal' && assessment.named) {
    push('tier', `Single weak signal ("${assessment.supporting[0] ?? 'shape'}") — not enough to act on alone.`);
  }

  const order = REASON_PRIORITY[elementClass];
  const rank = (kind: ReasonKind): number => {
    const index = order.indexOf(kind);
    return index === -1 ? order.length + 1 : index;
  };
  candidates.sort((a, b) => rank(a.kind) - rank(b.kind));
  return candidates.slice(0, 4).map((candidate) => candidate.text);
}

function buildContributions(
  features: ElementFeatureVector,
  elementClass: ElementClass,
): MiniAiFeatureContribution[] {
  const weights = ELEMENT_MODEL_WEIGHTS[elementClass];
  const contributions: MiniAiFeatureContribution[] = [];
  for (const name of Object.keys(FEATURE_LABELS) as ElementFeatureName[]) {
    const value = features[name];
    const weight = weights[name];
    if (!value || !weight) continue;
    contributions.push({
      name: FEATURE_LABELS[name],
      value,
      weight,
      impact: value * weight > 0 ? 'threat' : 'clean',
      description: FEATURE_LABELS[name],
    });
  }
  contributions.sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight));
  return contributions.slice(0, 5);
}

/** Groups an element for user feedback: an exact signature plus a generalizing token. */
export function elementSignature(snapshot: ElementSnapshot): { exact: string; token: string | null } {
  const el = normalizeElementSnapshot(snapshot);
  const details = analyzeElement(el).details;
  const token =
    details.adTokens[0] ??
    details.trackerTokens[0] ??
    details.consentMarkers[0] ??
    details.socialMarkers[0] ??
    details.layoutTokens[0] ??
    details.weakTokens[0] ??
    null;
  const tag = sanitizeTag(el.tag) || 'element';
  if (token) return { exact: `${tag}|${token}`, token };
  // Nothing recognisable matched: key on the first identifier instead of the bare
  // tag, so a decision on one `<aside>` never generalizes to every `<aside>`.
  const structural = (el.classes ?? [])[0] ?? el.id ?? '';
  return { exact: structural ? `${tag}|${tokenizeElementIdentifier(structural)[0] ?? structural}` : tag, token: null };
}

// ─── Classifier ───────────────────────────────────────────────────────────────

interface ElementCacheEntry {
  prediction: ElementPrediction;
  timestamp: number;
}

function cloneElementPrediction(prediction: ElementPrediction): ElementPrediction {
  return {
    ...prediction,
    classProbabilities: { ...prediction.classProbabilities },
    evidenceFamilies: [...prediction.evidenceFamilies],
    evidence: {
      ...prediction.evidence,
      adTokens: [...prediction.evidence.adTokens],
      trackerTokens: [...prediction.evidence.trackerTokens],
      consentMarkers: [...prediction.evidence.consentMarkers],
      socialMarkers: [...prediction.evidence.socialMarkers],
      weakTokens: [...prediction.evidence.weakTokens],
      urlPathTokens: [...prediction.evidence.urlPathTokens],
    },
    signature: { ...prediction.signature },
    topContributions: prediction.topContributions.map((item) => ({ ...item })),
    reasons: [...prediction.reasons],
  };
}

function cacheKeyFor(el: ElementSnapshot): string {
  return JSON.stringify([
    el.tag,
    el.id ?? '',
    (el.classes ?? []).join('.'),
    (el.attributes ?? []).map((attribute) => `${attribute.name}=${attribute.value}`).join('&'),
    (el.text ?? '').slice(0, 120),
    el.src ?? '',
    el.href ?? '',
    el.width ?? -1,
    el.height ?? -1,
    el.position ?? '',
    el.zIndex ?? 0,
    el.crossOriginFrame === true,
    el.visible === false,
    (el.ancestors ?? []).slice(0, 6).join('>'),
    el.sourceVerdict?.verdict ?? '',
    el.sourceVerdict?.category ?? '',
  ]);
}

function emptyDetails(): ElementEvidenceDetails {
  return {
    adTokens: [],
    layoutTokens: [],
    trackerTokens: [],
    consentMarkers: [],
    socialMarkers: [],
    weakTokens: [],
    sourceHost: null,
    sourceKind: 'none',
    sourceAttribute: null,
    adSize: null,
    adMatchedOn: null,
    pixelBox: null,
    adAttribute: null,
    trackerAttribute: null,
    antiAdblockPhrase: null,
    lurePhrase: null,
    nagMarker: null,
    ancestorMarker: null,
    textLength: 0,
    viewportCoverage: 0,
    urlPathTokens: [],
  };
}

/**
 * The element half of the embedded Mini-AI.
 *
 * Deterministic, dependency-free, and safe to call on every hover: a full
 * classification is a bounded number of set lookups plus a 4×25 matrix product.
 */
export class MiniAiElementClassifier {
  private userFeedbackMap = new Map<string, number>();
  private predictionCache = new Map<string, ElementCacheEntry>();
  private readonly maxFeedbackEntries: number;
  private readonly maxCacheSize: number;
  private readonly enableCache: boolean;
  private readonly weights: ElementWeightSet;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(options?: MiniAiElementClassifierOptions) {
    this.weights = options?.weights ?? ELEMENT_MODEL_WEIGHTS;
    this.maxFeedbackEntries =
      options?.maxFeedbackEntries && options.maxFeedbackEntries > 0
        ? Math.min(10000, options.maxFeedbackEntries)
        : 2000;
    this.maxCacheSize =
      options?.maxCacheSize && options.maxCacheSize > 0 ? Math.min(20000, options.maxCacheSize) : 5000;
    this.enableCache = options?.enableCache !== false;
  }

  /**
   * Records a user decision for an element.
   *
   * `hide` tells the model the user wants elements like this gone; `keep` says the
   * user is looking at content. The correction is stored for the element's exact
   * `tag|token` signature **and** generalized to the token alone, so a decision on
   * one site informs the same widget on another — the element-side analogue of the
   * registrable-zone generalization in {@link MiniAiClassifier}.
   */
  public tuneElementFeedback(snapshot: ElementSnapshot, action: 'hide' | 'keep' | 'reset'): void {
    const { exact, token } = elementSignature(snapshot);
    const keys = token && token !== exact ? [exact, token] : [exact];

    if (action === 'reset') {
      for (const key of keys) this.userFeedbackMap.delete(key);
      this.clearCache();
      return;
    }

    const bias = action === 'hide' ? 1 : -1;
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (this.userFeedbackMap.size >= this.maxFeedbackEntries && !this.userFeedbackMap.has(key)) {
        const oldest = this.userFeedbackMap.keys().next().value;
        if (oldest) this.userFeedbackMap.delete(oldest);
      }
      this.userFeedbackMap.delete(key);
      this.userFeedbackMap.set(key, bias);
    }
    this.clearCache();
  }

  /** Effective user bias for an element: exact signature first, token second. */
  public getElementFeedback(snapshot: ElementSnapshot): number {
    const { exact, token } = elementSignature(snapshot);
    const exactBias = this.userFeedbackMap.get(exact);
    if (exactBias !== undefined) return exactBias;
    if (token) {
      const tokenBias = this.userFeedbackMap.get(token);
      if (tokenBias !== undefined) return tokenBias;
    }
    return 0;
  }

  public deleteElementFeedback(snapshot: ElementSnapshot): boolean {
    const { exact, token } = elementSignature(snapshot);
    let removed = this.userFeedbackMap.delete(exact);
    if (token && this.userFeedbackMap.delete(token)) removed = true;
    if (removed) this.clearCache();
    return removed;
  }

  public clearElementFeedback(): void {
    this.userFeedbackMap.clear();
    this.clearCache();
  }

  public getElementFeedbackCount(): number {
    return this.userFeedbackMap.size;
  }

  public exportElementFeedback(): Record<string, number> {
    const exported = Object.create(null) as Record<string, number>;
    for (const [key, value] of this.userFeedbackMap.entries()) {
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') exported[key] = value;
    }
    return exported;
  }

  public importElementFeedback(feedback: Record<string, number>): void {
    if (!feedback || typeof feedback !== 'object') return;
    for (const [key, value] of Object.entries(feedback).slice(0, this.maxFeedbackEntries)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (this.userFeedbackMap.size >= this.maxFeedbackEntries && !this.userFeedbackMap.has(key)) {
        const oldest = this.userFeedbackMap.keys().next().value;
        if (oldest) this.userFeedbackMap.delete(oldest);
      }
      this.userFeedbackMap.delete(key);
      this.userFeedbackMap.set(key, Math.max(-1, Math.min(1, value)));
    }
    this.clearCache();
  }

  public clearCache(): void {
    this.predictionCache.clear();
  }

  public getCacheStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.predictionCache.size,
      hitRate: total > 0 ? Math.round((this.cacheHits / total) * 1000) / 1000 : 0,
    };
  }

  /**
   * Classifies one element. Never throws, and never claims more confidence than its
   * evidence supports.
   */
  public classify(snapshot: ElementSnapshot): ElementPrediction {
    const start = performance.now();
    try {
      const el = normalizeElementSnapshot(snapshot);
      // Genuinely empty input is not "content", it is nothing: report zero confidence
      // rather than dressing the default up as a judgement.
      if (
        !el.tag &&
        !el.id &&
        (el.classes ?? []).length === 0 &&
        (el.attributes ?? []).length === 0 &&
        !el.text &&
        !el.src
      ) {
        return this.emptyPrediction(start);
      }
      const cacheKey = this.enableCache ? cacheKeyFor(el) : null;

      if (cacheKey) {
        const cached = this.predictionCache.get(cacheKey);
        if (cached) {
          this.cacheHits++;
          // Refresh LRU order without rebuilding the map.
          this.predictionCache.delete(cacheKey);
          this.predictionCache.set(cacheKey, cached);
          return cloneElementPrediction(cached.prediction);
        }
        this.cacheMisses++;
      }

      const analysis = analyzeElement(el);
      const userTuneBias = this.getElementFeedback(el);
      // A user decision is evidence in its own right: a positive correction is
      // definitive, and a negative one is a veto handled below.
      const families: ElementEvidenceFamily[] =
        userTuneBias > 0 && !analysis.families.includes('user-choice')
          ? [...analysis.families, 'user-choice']
          : [...analysis.families];
      const features: ElementFeatureVector = { ...analysis.features, userTuneBias };
      const input: EvidenceAssessmentInput = { families, details: analysis.details, features };

      const assessment = assessElementEvidence(input);
      const { elementClass: modelClass, classProbabilities } = adjustElementClass(
        softmaxFor(features, this.weights),
        input,
      );
      // Evidence that names nothing cannot name a class: a 300×250 hero image is not
      // "probably an ad", it is an image. Long-form prose is the same kind of statement — the
      // element is the page itself, so it is content whatever word its class happens to carry.
      let elementClass: ElementClass = assessment.named && !assessment.proseShield ? modelClass : 'Content';
      if (userTuneBias < 0) elementClass = 'Content';

      const winProbability = classProbabilities[elementClass] ?? 0;
      // For a policy decision ("nothing here names a class") the model's own Content
      // probability is meaningless — it may be 0.1% while the model leans Tracker on
      // a 1×1 spacer. Report the evidence tier's ceiling instead.
      const confidence = Math.max(
        0,
        Math.min(
          100,
          assessment.named
            ? Math.round(Math.min(winProbability * 100, assessment.maxConfidence))
            : assessment.maxConfidence,
        ),
      );

      const action: ElementAction =
        elementClass === 'Content' || userTuneBias < 0 ? 'leave' : assessment.maxAction;

      const prediction: ElementPrediction = {
        elementClass,
        action,
        confidence,
        classProbabilities,
        corroboration: assessment.tier,
        evidenceFamilies: assessment.families,
        definitiveFamilies: assessment.definitive,
        supportingFamilies: assessment.supporting,
        evidence: analysis.details,
        signature: elementSignature(el),
        topContributions: buildContributions(features, elementClass),
        reasons: buildReasons(elementClass, assessment, analysis.details, features),
        inferenceTimeMs: Math.round((performance.now() - start) * 1000) / 1000,
      };

      if (cacheKey) {
        if (this.predictionCache.size >= this.maxCacheSize) {
          const oldest = this.predictionCache.keys().next().value;
          if (oldest) this.predictionCache.delete(oldest);
        }
        this.predictionCache.set(cacheKey, { prediction, timestamp: Date.now() });
      }

      return cloneElementPrediction(prediction);
    } catch {
      // Fail-safe: an unclassifiable element is left alone, never hidden.
      return this.emptyPrediction(start);
    }
  }

  /** The fail-safe verdict: nothing known, nothing done. */
  private emptyPrediction(start: number): ElementPrediction {
    return {
      elementClass: 'Content',
      action: 'leave',
      confidence: 0,
      classProbabilities: { Ad: 0, Tracker: 0, Annoyance: 0, Content: 1 },
      corroboration: 'model-only',
      evidenceFamilies: [],
      definitiveFamilies: [],
      supportingFamilies: [],
      evidence: emptyDetails(),
      signature: { exact: 'element', token: null },
      topContributions: [],
      reasons: ['Malformed element snapshot — left alone.'],
      inferenceTimeMs: Math.round((performance.now() - start) * 1000) / 1000,
    };
  }

  /** Classifies many elements, reusing the cache and the feedback model. */
  public classifyAll(snapshots: readonly ElementSnapshot[]): ElementPrediction[] {
    return snapshots.map((snapshot) => this.classify(snapshot));
  }
}

export const globalMiniAiElementClassifier = new MiniAiElementClassifier();

/** Convenience wrapper around the shared element classifier. */
export function classifyElementWithMiniAi(snapshot: ElementSnapshot): ElementPrediction {
  return globalMiniAiElementClassifier.classify(snapshot);
}

/** Structural validation for untrusted snapshots arriving over a message port. */
export function isElementSnapshot(value: unknown): value is ElementSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ElementSnapshot;
  return typeof candidate.tag === 'string' && candidate.tag.length > 0 && candidate.tag.length <= 32;
}
