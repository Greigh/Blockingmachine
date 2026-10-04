/**
 * Labeled corpus for the element classifier.
 *
 * Same purpose as {@link EVAL_CORPUS} for hostnames: turn "the model feels better"
 * into numbers a test can hold onto. The cases are written as the shapes real pages
 * produce — an ad container, a tracking pixel, a consent wall, a YouTube embed, a
 * hero banner that merely has the word `banner` in its class — with two independent
 * expectations recorded for each:
 *
 *  - `expected` — the classes that could reasonably be right (fuzzy labels such as
 *    ads vs sponsored content are not counted as mistakes).
 *  - `maxAction` / `minAction` — the decision the product may make. These carry the
 *    weight, because `hide` is the only consequential action: hiding a hero banner
 *    is a broken site, hiding an ad slot is the product working.
 *
 * The content family is deliberately large. Every false-positive class found in the
 * hostname model had a shape like this — ordinary vocabulary that happened to sit
 * next to a signal — and elements are *full* of ordinary vocabulary
 * (`admonition`, `admin`, `download`, `analytics`, `cookie`, `sponsors`).
 */

import type { ElementAction, ElementClass, ElementSnapshot } from './elementClassifier.js';

export interface ElementEvalCase {
  /** Stable identifier, also used as the example name in reports. */
  label: string;
  /** Coarse group for per-family accuracy, e.g. `ad-container`, `pixel`, `docs`. */
  family: string;
  snapshot: ElementSnapshot;
  /** Accepted classes; `expected[0]` is the canonical one. */
  expected: ElementClass[];
  /** The most aggressive action the product is allowed to take. */
  maxAction: ElementAction;
  /** The least aggressive action the product must take. Defaults to `leave`. */
  minAction?: ElementAction;
  /**
   * For harvest-derived cases: the scope the promoted decision recorded.
   * `'element'` means the evidence is one element one person ruled on — the band
   * such a proposal carries caps the aggressive side but never floors a whole
   * shape at `hide`; `'shape'` means a reviewer asserted the decision
   * generalises, which is the only scope a must-hide floor may come from.
   */
  harvestScope?: 'element' | 'shape';
  /** Why this case exists, for whoever reads the report. */
  notes?: string;
}

/** Marker line inside {@link ELEMENT_EVAL_CORPUS} under which `--promote` appends cases. */
export const PROMOTED_CASES_MARKER = '// ─── Harvested promotions';

/** Compact snapshot builder so the corpus stays readable. */
function snap(tag: string, fields: Partial<ElementSnapshot> = {}): ElementSnapshot {
  return { tag, ...fields };
}

function attr(name: string, value = ''): { name: string; value: string } {
  return { name, value };
}

const ARTICLE = 'The quick brown fox jumps over the lazy dog. '.repeat(28);
const LONG_ARTICLE = 'The quick brown fox jumps over the lazy dog. '.repeat(60);

export const ELEMENT_EVAL_CORPUS: ElementEvalCase[] = [
  // ─── Ad containers: definitive markup, must be hidden ───────────────────────
  {
    label: 'google-adsense-slot',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['adsbygoogle'], width: 300, height: 250 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The single most common ad container on the web.',
  },
  {
    label: 'adsense-ins',
    family: 'ad-container',
    snapshot: snap('ins', { classes: ['adsbygoogle'], attributes: [attr('data-ad-client', 'ca-pub-1234')] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'gpt-slot',
    family: 'ad-container',
    snapshot: snap('div', {
      id: 'div-gpt-ad-12345',
      attributes: [attr('data-ad-slot', '1234')],
      width: 728,
      height: 90,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'google-ads-iframe',
    family: 'ad-container',
    snapshot: snap('iframe', {
      id: 'google_ads_iframe_1',
      src: 'https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html',
      width: 300,
      height: 600,
      crossOriginFrame: true,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'doubleclick-frame',
    family: 'ad-container',
    snapshot: snap('iframe', {
      src: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
      width: 300,
      height: 250,
      crossOriginFrame: true,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'sponsored-feed-card',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['sponsored-post'],
      attributes: [attr('data-outbrain-widget', 'feed-1')],
      width: 640,
      height: 200,
      text: 'Sponsored: how to grow your SaaS business in 30 days',
      childCount: 3,
      linkCount: 1,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A chum-feed card served by a third party: the widget attribute is what separates it from `sponsored-story-300x250` — `sponsored` plus a delivery attribute says the money is someone else\'s, which is the flag-14 distinction.',
  },
  {
    label: 'taboola-widget',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['taboola-widget'], width: 300, height: 250 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'ad-slot-with-size',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['ad-slot'], width: 300, height: 250, ancestors: ['article'] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'adsbox',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['adsbox'], width: 728, height: 90 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'adchoices-marker',
    family: 'ad-container',
    snapshot: snap('img', {
      classes: ['adchoices-icon'],
      src: 'https://cdn.example.com/adchoices.png',
      width: 16,
      height: 16,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'teads-inread',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['teads-ad-container'], width: 300, height: 250, ancestors: ['article', 'main'] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'header-ad-728x90',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['header-ad'], width: 728, height: 90 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Weak vocabulary plus an ad-sized rectangle: two families, still authoritative.',
  },
  {
    label: 'native-ads-unit',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['native-ads'], width: 600, height: 300 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'suggest',
  },
  {
    label: 'dfp-slot',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['dfp-slot-container'], width: 970, height: 250 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'amazon-adsystem-frame',
    family: 'ad-container',
    snapshot: snap('iframe', {
      src: 'https://c.amazon-adsystem.com/aax2/apstag.js',
      width: 320,
      height: 50,
      crossOriginFrame: true,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },

  // ─── Tracking pixels and measurement loaders ────────────────────────────────
  {
    label: 'sentry-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://o1.ingest.sentry.io/api/1/store/', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'unknown-host-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://metrics.example.net/p.gif', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A 1×1 image from a non-CDN host is a beacon even when the host is unknown.',
  },
  {
    label: 'scorecard-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://sb.scorecardresearch.com/p?c1=2', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'gtm-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123' }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'facebook-pixel-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://connect.facebook.net/en_US/fbevents.js' }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'hotjar-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://static.hotjar.com/c/hotjar-1234.js' }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'explicit-tracking-pixel',
    family: 'pixel',
    snapshot: snap('img', { classes: ['tracking-pixel'], src: 'https://t.example.com/p', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'clarity-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://www.clarity.ms/tag/abcd1234' }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },

  // ─── Consent, nag and overlay annoyances ────────────────────────────────────
  {
    label: 'onetrust-banner',
    family: 'consent',
    snapshot: snap('div', {
      id: 'onetrust-banner-sdk',
      classes: ['cookie-banner'],
      position: 'fixed',
      zIndex: 99999,
      width: 1440,
      height: 220,
      text: 'We use cookies to improve your experience. Accept all cookies',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'consent-banner-generic',
    family: 'consent',
    snapshot: snap('div', {
      classes: ['cookie-consent'],
      position: 'fixed',
      zIndex: 9999,
      width: 1280,
      height: 180,
      text: 'We value your privacy. Manage cookies',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'fc-consent-root',
    family: 'consent',
    snapshot: snap('div', {
      id: 'fc-consent-root',
      position: 'fixed',
      zIndex: 2147483647,
      width: 1440,
      height: 900,
      text: 'We and our partners store and access information on a device. Consent',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'didomi-consent',
    family: 'consent',
    snapshot: snap('div', { classes: ['didomi-host'], position: 'fixed', zIndex: 999999, width: 1440, height: 600 }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'newsletter-modal',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['newsletter-modal'],
      position: 'fixed',
      zIndex: 5000,
      width: 600,
      height: 500,
      text: 'Subscribe to our newsletter for weekly updates and product news. '.repeat(8),
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A blocking modal with plenty of copy is still a modal, not an article.',
  },
  {
    label: 'paywall-modal',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['paywall-modal'],
      position: 'fixed',
      zIndex: 4000,
      width: 900,
      height: 700,
      text: 'Subscribe to continue reading. Already a subscriber? Sign in.',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'newsletter-popup-inline',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['newsletter-popup'],
      width: 700,
      height: 300,
      text: 'Sign up for our newsletter and get the best stories weekly.',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'suggest',
  },
  {
    label: 'adblock-wall',
    family: 'anti-adblock',
    snapshot: snap('div', {
      classes: ['modal'],
      position: 'fixed',
      zIndex: 9999,
      width: 1200,
      height: 800,
      text: 'Please disable your ad blocker to continue reading this article.',
    }),
    expected: ['Annoyance'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'Definitive evidence, but removing an adblock wall is the user\u2019s decision.',
  },
  {
    label: 'sticky-promo-bar',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['promo-bar'],
      position: 'sticky',
      zIndex: 2000,
      width: 1440,
      height: 60,
      text: 'Get 20% off with code SAVE20',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'suggest',
  },
  {
    label: 'mobile-app-interstitial',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['app-interstitial'],
      position: 'fixed',
      zIndex: 9000,
      width: 400,
      height: 700,
      text: 'Open in the app for a better experience',
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'hide',
  },

  // ─── Social widgets ─────────────────────────────────────────────────────────
  {
    label: 'share-buttons',
    family: 'social',
    snapshot: snap('div', { classes: ['share-buttons'], width: 300, height: 60 }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'twitter-widget-frame',
    family: 'social',
    snapshot: snap('iframe', {
      src: 'https://platform.twitter.com/widgets/tweet_button.html',
      width: 120,
      height: 20,
      crossOriginFrame: true,
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'addthis-widget',
    family: 'social',
    snapshot: snap('div', { id: 'addthis_widget', width: 200, height: 40 }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'suggest',
  },
  {
    label: 'twitter-share-anchor',
    family: 'social',
    snapshot: snap('a', {
      classes: ['twitter-share-button'],
      href: 'https://twitter.com/intent/tweet?url=x',
      text: 'Tweet',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'suggest',
  },
  {
    label: 'sticky-share-rail',
    family: 'social',
    snapshot: snap('div', { classes: ['sticky-share'], position: 'sticky', zIndex: 1500, width: 60, height: 300 }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'suggest',
  },

  // ─── Content: the false-positive guard corpus ──────────────────────────────
  {
    label: 'hero-banner',
    family: 'content',
    snapshot: snap('div', {
      classes: ['banner'],
      width: 1440,
      height: 420,
      text: 'Welcome to our store — free shipping this week',
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: '`banner` is a layout word on most sites: it must not be called an ad.',
  },
  {
    label: 'docs-admonition',
    family: 'docs',
    snapshot: snap('div', { classes: ['admonition', 'note'], text: `Note: the adapter must be configured first. ${ARTICLE}` }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'docs-admonition-container',
    family: 'docs',
    snapshot: snap('section', { classes: ['admonitions'], text: ARTICLE }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'admin-panel',
    family: 'content',
    snapshot: snap('div', { classes: ['admin-panel'], text: 'Manage your account settings and billing here.' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'download-button',
    family: 'content',
    snapshot: snap('a', { classes: ['download-button'], href: '/download', text: 'Download the desktop app' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'adapter-list-item',
    family: 'content',
    snapshot: snap('li', { classes: ['adapter-item'], text: 'Bluetooth adapter — connected' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'analytics-dashboard-panel',
    family: 'content',
    snapshot: snap('div', {
      classes: ['analytics-panel', 'card'],
      text: 'Revenue this week is up 12% across all channels.',
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'An "analytics" class on a dashboard is a product label, not a beacon.',
  },
  {
    label: 'order-tracking-panel',
    family: 'content',
    snapshot: snap('div', { classes: ['tracking-panel'], text: 'Your parcel left the sorting facility at 09:12.' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'cookie-recipe-card',
    family: 'content',
    snapshot: snap('div', { classes: ['cookie'], text: 'Our famous chocolate chip cookie recipe, ready in 20 minutes.' }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'cookie-policy-link',
    family: 'content',
    snapshot: snap('a', { classes: ['footer-link'], href: '/cookie-policy', text: 'Cookie Policy' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'privacy-policy-link',
    family: 'content',
    snapshot: snap('a', { href: '/privacy', text: 'Privacy Policy' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'sponsors-section',
    family: 'content',
    snapshot: snap('section', { classes: ['sponsors'], text: 'Thanks to our sponsors for supporting this event.' }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'article-body',
    family: 'content',
    snapshot: snap('div', {
      classes: ['post-content'],
      width: 800,
      height: 1400,
      text: LONG_ARTICLE,
      ancestors: ['article', 'main'],
    }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'article-paragraph',
    family: 'content',
    snapshot: snap('p', { text: 'The quick brown fox jumps over the lazy dog, repeatedly and with vigour.' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'headline',
    family: 'content',
    snapshot: snap('h1', { text: 'How ad blockers actually work under the hood' }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The word "ad" in prose is not evidence about the element.',
  },
  {
    label: 'nav-analytics-link',
    family: 'content',
    snapshot: snap('a', { href: '/analytics', text: 'Analytics' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'advertise-with-us-link',
    family: 'content',
    snapshot: snap('a', { href: '/advertise', text: 'Advertise with us' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'social-profile-link',
    family: 'content',
    snapshot: snap('a', { classes: ['social-link'], href: 'https://twitter.com/ourcompany', text: 'Follow us on Twitter' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'footer-social-links',
    family: 'content',
    snapshot: snap('div', { classes: ['social-links'], text: 'Twitter Mastodon LinkedIn RSS' }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
  },
  {
    label: 'tracked-cta-button',
    family: 'content',
    snapshot: snap('button', { attributes: [attr('data-track-click', 'cta')], text: 'Get started free' }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: '`data-track-*` is page instrumentation on every modern CTA. Hiding the button is never right.',
  },
  {
    label: 'hero-image-300x250',
    family: 'content',
    snapshot: snap('img', {
      src: 'https://cdn.example.com/uploads/team.jpg',
      width: 300,
      height: 250,
      attributes: [attr('alt', 'Our team at the office')],
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'Ad-sized, nothing else. Suggest at most.',
  },
  {
    label: 'youtube-embed',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://www.youtube.com/embed/abc123',
      width: 560,
      height: 315,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'vimeo-embed',
    family: 'media',
    snapshot: snap('iframe', { src: 'https://player.vimeo.com/video/12345', width: 640, height: 360, crossOriginFrame: true }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'cdn-spacer-pixel',
    family: 'content',
    snapshot: snap('img', { src: 'https://cdn.jsdelivr.net/gh/x/spacer.gif', width: 1, height: 1 }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A 1×1 asset on a public CDN is a spacer, not a beacon.',
  },
  {
    label: 'paywall-wrapper-around-article',
    family: 'content',
    snapshot: snap('div', { classes: ['paywall'], width: 800, height: 2000, text: LONG_ARTICLE, ancestors: ['main', 'article'] }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'Article-length copy: never hide, whatever the wrapper is called.',
  },
  {
    label: 'embedded-chart-frame',
    family: 'content',
    snapshot: snap('iframe', { src: 'https://grafana.example.com/d-solo/abc', width: 800, height: 400, crossOriginFrame: true }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'comment-list',
    family: 'content',
    snapshot: snap('ul', { classes: ['comments'], childCount: 12, linkCount: 2, text: ARTICLE }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'empty-container',
    family: 'content',
    snapshot: snap('div', {}),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'inline-measurement-script',
    family: 'content',
    snapshot: snap('script', { src: 'https://cdn.example.com/bundle.js' }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'A first-party bundle on the site\u2019s own CDN is not a tracker.',
  },
  // ─── Round two: the shapes the first 67 never saw ──────────────────────────
  //
  // Everything below was added after the classifier passed the corpus above, and it is where
  // the rules actually broke. Four families of shape were missing, and each one had a rule that
  // was demonstrably wrong rather than merely untested:
  //
  //   1. The *tag* was never part of the identifier vocabulary, so `<amp-ad>` — an element that
  //      exists to serve ads — was read purely as a 300×250 rectangle.
  //   2. A compound class was no stronger than a bare one, so `class="video-ad"` scored exactly
  //      the same as `class="ad"` and a video ad was only ever suggested.
  //   3. Push-notification prompts had no marker at all: a pinned OneSignal prompt was reported
  //      as page copy.
  //   4. **The destructive one.** The article-length shield was bypassed by *any* vocabulary
  //      match, so `#advertising-policy` and `class="sponsored-article-body"` were hidden at 98%
  //      — prose and all. A page about advertising wears the same word as an ad slot.

  // ─── Ad containers its first pass missed ───────────────────────────────────
  {
    label: 'gam-query-id-filled',
    family: 'ad-container',
    snapshot: snap('div', {
      id: 'div-gpt-ad-1234567890-0',
      attributes: [attr('data-google-query-id', 'CJqX')],
      width: 300,
      height: 250,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Google Ad Manager stamps the filled slot with a query id.',
  },
  {
    label: 'adsense-filled-status',
    family: 'ad-container',
    snapshot: snap('ins', {
      classes: ['adsbygoogle'],
      attributes: [attr('data-ad-status', 'filled')],
      width: 336,
      height: 280,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'amp-ad-doubleclick',
    family: 'ad-container',
    snapshot: snap('amp-ad', { attributes: [attr('type', 'doubleclick')], width: 300, height: 250 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The ad lives in the tag name: `amp-ad` has no class to read.',
  },
  {
    label: 'sticky-anchor-ad',
    family: 'ad-container',
    snapshot: snap('div', { id: 'anchor-ad', position: 'fixed', zIndex: 9999, width: 320, height: 50 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The mobile anchor unit: pinned to the bottom of the viewport.',
  },
  {
    label: 'in-article-ad-slot',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['in-article-ad'], width: 336, height: 280, ancestors: ['article', 'main'] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Inside the story is still an ad slot, not story content.',
  },
  {
    label: 'outstream-video-ad',
    family: 'ad-container',
    snapshot: snap('video', { classes: ['video-ad'], width: 640, height: 360 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: '`video-ad` is a compound identifier: as strong as `adunit`, not as weak as `ad`.',
  },
  {
    label: 'unknown-ad-host-frame',
    family: 'ad-container',
    snapshot: snap('iframe', {
      src: 'https://ads.partner-example.com/slot',
      width: 300,
      height: 250,
      crossOriginFrame: true,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A host the table has never seen, on an ad-shaped frame with an `ads.` subdomain.',
  },
  {
    label: 'offsite-creative-img',
    family: 'ad-container',
    snapshot: snap('img', {
      src: 'https://serve.delivery-x.io/creative/7714.png',
      width: 728,
      height: 90,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A leaderboard creative served as a plain image by a delivery host, with no ad vocabulary anywhere on it — geometry and a remote source are the whole read. Written so the held-out Ad cases stop being ones no head can miss: the hand-tuned table calls it Ad, the fitted one calls it Content, and the honest label stays Ad because a 728×90 creative served for the page is the ad, whether or not the markup names it.',
  },
  {
    label: 'prebid-slot',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['pb-ad-slot'], width: 300, height: 250, ancestors: ['aside'] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'sponsored-listing',
    family: 'ad-container',
    snapshot: snap('li', {
      classes: ['sponsored-listing'],
      attributes: [attr('data-ad-unit', 'results-sponsored')],
      text: 'Sponsored: Acme Widgets — buy now',
      childCount: 2,
      linkCount: 1,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A paid slot inside a results list. `sponsored` is the disclosure word and `data-ad-unit` is the delivery evidence — the word alone suggests, and the attribute is what promotes this to hide (flag 14).',
  },
  {
    label: 'skyscraper-generic-ad',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['ad'], width: 160, height: 600, ancestors: ['aside', 'main'] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A bare `ad` class is weak, but the 160×600 rectangle corroborates it.',
  },
  {
    label: 'dfp-footer-billboard',
    family: 'ad-container',
    snapshot: snap('div', { classes: ['dfp-billboard'], width: 970, height: 250, ancestors: ['footer'] }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },

  // ─── Beacons the first pass did not carry ──────────────────────────────────
  {
    label: 'newrelic-beacon',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://bam.nr-data.net/1/abc?a=1', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A 1×1 image on a non-CDN host is a beacon even when the host is not in the table.',
  },
  {
    label: 'tiktok-events-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://analytics.tiktok.com/i18n/pixel/events.js', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'segment-analytics-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.segment.com/analytics.js/v1/abc/analytics.min.js' }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'fb-pixel-iframe',
    family: 'pixel',
    snapshot: snap('iframe', {
      src: 'https://www.facebook.com/tr?id=123&ev=PageView',
      width: 1,
      height: 1,
      crossOriginFrame: true,
    }),
    expected: ['Tracker', 'Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A beacon wearing a social vendor\u2019s host: either class is honest, the action is not optional.',
  },
  {
    label: 'hidden-third-party-frame',
    family: 'pixel',
    snapshot: snap('iframe', {
      src: 'https://static.publisher-cdn-x.net/adx/tpc-check.html',
      width: 0,
      height: 0,
      crossOriginFrame: true,
      visible: false,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The shape the harvest queue actually surfaced — a `display:none`, zero-sized, cross-origin iframe on a check path (NYT\u2019s real `3pCheckIframeId` read this way). There is no pixel box and no token, so the evidence path leaves it; a hidden frame the page cannot have made for you is still a probe. Written to put a held-out Tracker case where the two heads can disagree: the hand-tuned table reads the frame as Tracker, the fitted one as Content.',
  },
  {
    label: 'gtag-config-script',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://www.googletagmanager.com/gtag/js?id=G-ABC' }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },

  // ─── Consent, push prompts and user-invoked modals ─────────────────────────
  {
    label: 'dialog-cookie-banner',
    family: 'consent',
    snapshot: snap('dialog', {
      classes: ['cookie-consent-dialog'],
      text: 'We use cookies to improve your experience. Manage cookies',
      width: 1440,
      height: 200,
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A `<dialog>` reports no positioning, so the copy has to carry the verdict.',
  },
  {
    label: 'aria-modal-consent-dialog',
    family: 'consent',
    snapshot: snap('div', {
      role: 'dialog',
      attributes: [attr('aria-modal', 'true')],
      classes: ['consent-modal'],
      position: 'fixed',
      zIndex: 100000,
      width: 1440,
      height: 900,
      text: 'We and our partners store and access information on a device.',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'ARIA says what it is; the class confirms it. Neither is the reason it hides.',
  },
  {
    label: 'onesignal-push-prompt',
    family: 'nag',
    snapshot: snap('div', {
      id: 'onesignal-slidedown-container',
      position: 'fixed',
      zIndex: 2147483647,
      width: 400,
      height: 300,
      text: 'We would like to show you notifications for the latest news and updates',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The most deployed push opt-in on the web, and it has no consent or nag vocabulary of its own.',
  },
  {
    label: 'push-notification-prompt-generic',
    family: 'nag',
    snapshot: snap('div', {
      id: 'push-notification-prompt',
      position: 'fixed',
      zIndex: 99999,
      width: 360,
      height: 140,
      text: 'Stay up to date. Enable push notifications for this site.',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'push-prompt-copy-only',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['overlay-card'],
      position: 'fixed',
      zIndex: 9999,
      width: 400,
      height: 300,
      text: 'We would like to show you notifications for the latest news and updates',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes:
      'No vendor marker at all: the copy and the pinned overlay are the two independent hints, ' +
      'and two hints are the corpus\u2019 own bar for acting.',
  },
  {
    label: 'cookiebanner-no-dash',
    family: 'consent',
    snapshot: snap('div', {
      id: 'cookiebanner',
      position: 'fixed',
      zIndex: 9999,
      width: 1440,
      height: 180,
      text: 'This website uses cookies to ensure you get the best experience',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'qc-cmp2-consent',
    family: 'consent',
    snapshot: snap('div', {
      id: 'qc-cmp2-container',
      position: 'fixed',
      zIndex: 999999,
      width: 1440,
      height: 900,
      text: 'We and our partners use cookies and similar technologies',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Quantcast ships `qc-cmp2-*`; a version digit used to hide it from the `cmp-*` markers.',
  },

  // ─── False positives round two: ordinary words that sit next to a signal ───
  {
    label: 'role-banner-header',
    family: 'content',
    snapshot: snap('header', {
      role: 'banner',
      classes: ['site-header'],
      text: 'Home Products Pricing About',
      childCount: 4,
      linkCount: 4,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: '`role="banner"` is the page landmark. It is not the layout word `banner` and must not be.',
  },
  {
    label: 'address-form',
    family: 'content',
    snapshot: snap('form', { id: 'address-form', text: 'Shipping address, city, postal code' }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: '`address` contains the letters `ad` and is still nothing of the sort.',
  },
  {
    label: 'adobe-embed-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://acrobat.adobe.com/dc-integration/dc-router/embedded/view',
      width: 800,
      height: 600,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: '`adobe` is not `ad`, and a third-party frame is not an ad on its shape alone.',
  },
  {
    label: 'adjustment-slider',
    family: 'content',
    snapshot: snap('div', { classes: ['adjustment-slider'], text: 'Image adjustment controls' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'advisor-card',
    family: 'content',
    snapshot: snap('div', { classes: ['advisor-card'], text: 'Meet your financial advisor' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'native-settings-panel',
    family: 'content',
    snapshot: snap('div', { classes: ['native-settings-panel'], text: 'Native language and region settings' }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: '`native-ads` is an ad token; `native` on its own is a product word.',
  },
  {
    label: 'adventure-travel-article',
    family: 'content',
    snapshot: snap('article', { id: 'adventure-travel', text: LONG_ARTICLE, ancestors: ['main'] }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'sponsored-programs-link',
    family: 'content',
    snapshot: snap('a', { href: '/sponsored-programs', text: 'Sponsored programs' }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The word `sponsored` on a navigation link is a destination, not an ad container.',
  },
  {
    label: 'advertising-policy-body',
    family: 'content',
    snapshot: snap('div', {
      id: 'advertising-policy',
      classes: ['policy-page'],
      text: ARTICLE,
      ancestors: ['main'],
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'Article-length prose whose id says `advertising`. This was hidden at 98% before the shield was fixed.',
  },
  {
    label: 'advertorial-body',
    family: 'content',
    snapshot: snap('section', {
      classes: ['sponsored-article-body'],
      text: LONG_ARTICLE,
      ancestors: ['article', 'main'],
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'Sponsored content the user chose to open: a paid article body is still an article body.',
  },
  {
    label: 'login-modal-dialog',
    family: 'content',
    snapshot: snap('div', {
      id: 'login-modal',
      role: 'dialog',
      attributes: [attr('aria-modal', 'true')],
      position: 'fixed',
      zIndex: 5000,
      width: 480,
      height: 420,
      text: 'Sign in to your account',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A modal the user asked for. Modal markup is a shape, not a verdict.',
  },
  {
    label: 'video-player-content',
    family: 'media',
    snapshot: snap('video', {
      src: 'https://cdn.example.com/media/movie.mp4',
      width: 1280,
      height: 720,
      attributes: [attr('controls', '')],
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The counterpart to `outstream-video-ad`: same tag, no ad vocabulary, nothing hidden.',
  },
  {
    label: 'hero-banner-large',
    family: 'content',
    snapshot: snap('section', {
      classes: ['hero-banner-large'],
      width: 1440,
      height: 500,
      text: 'Welcome to our store — free shipping this week',
    }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'nav-complementary',
    family: 'content',
    snapshot: snap('aside', { role: 'complementary', text: 'Related links', linkCount: 5, childCount: 5 }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'cookie-settings-button',
    family: 'content',
    snapshot: snap('button', { classes: ['cookie-settings-open'], text: 'Cookie settings' }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'The control that opens the dialog is not the dialog. Hiding it strands the user.',
  },
  {
    label: 'newsletter-signup-inline',
    family: 'content',
    snapshot: snap('div', {
      classes: ['newsletter-signup'],
      text: 'Get our weekly newsletter',
      ancestors: ['article'],
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'An in-flow signup box inside the story: a nag, but not an overlay to tear out.',
  },
  {
    label: 'no-ads-subscription-cta',
    family: 'content',
    snapshot: snap('div', {
      classes: ['no-ads-subscription'],
      text: 'Subscribe to remove ads',
      ancestors: ['article'],
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'suggest',
    notes: '`ads` in the middle of a compound names an upsell, so a middle atom never promotes.',
  },
  {
    label: 'download-adobe-reader',
    family: 'content',
    snapshot: snap('a', { href: '/download', text: 'Download Adobe Reader' }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'adaptive-layout-section',
    family: 'content',
    snapshot: snap('div', { classes: ['adaptive-layout'], text: ARTICLE }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'figure-with-caption',
    family: 'content',
    snapshot: snap('figure', { classes: ['figure'], text: 'Figure 1: quarterly results' }),
    expected: ['Content'],
    maxAction: 'leave',
  },

  // ─── Shapes found by scanning live pages ─────────────────────────────────────
  // These cases come from replaying the real scanner over developer.mozilla.org, the
  // Guardian front page, github.com, nytimes.com and Wikipedia. Each one was a false
  // positive in the shipping model, and each is labelled the way the page actually is.
  // A label is a statement about the page, not about the model's opinion: a logo is not
  // a beacon, a site's own bundle is not an unknown remote host, and an analytics
  // attribute on a navigation link is instrumentation.
  {
    label: 'github-footer-social-link',
    family: 'content',
    snapshot: snap('a', {
      classes: ['SocialLinks-module__iconLink'],
      attributes: [attr('data-analytics-event', '{"category":"Footer","action":"click"}')],
      href: 'https://www.linkedin.com/company/github',
      text: '',
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'leave',
    notes: 'Seven of these sat in github.com\u2019s footer; each carried a page-analytics attribute, which outvoted the class word and suggested blocking a profile link.',
  },
  {
    label: 'github-generated-id-menu',
    family: 'content',
    snapshot: snap('div', {
      id: '_R_ad_',
      classes: ['Primer_Brand__ActionMenu-module__ActionMenu'],
      attributes: [attr('data-analytics-event', '{"action":"open"}')],
      text: 'Star',
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'leave',
    notes: 'React writes ids like `_R_ad_`; the compound rule read the fragment as an ad marker and hid a working account menu at 98%.',
  },
  {
    label: 'github-own-bundle-script',
    family: 'content',
    snapshot: snap('script', { src: 'https://github.githubassets.com/assets/environment-20e1f7ec.js', width: 0, height: 0 }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'An unrendered script has no box; a zero rect is not a 1x1 beacon. The site\u2019s own asset host is not a non-CDN remote host either.',
  },
  {
    label: 'mdn-relative-bundle-script',
    family: 'content',
    snapshot: snap('script', { src: '/static/client/runtime.ca87e9225e95e2dc.js', width: 0, height: 0 }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Resolving a path-relative src against `https://` invented the host `static`, which then read as an unknown non-CDN source.',
  },
  {
    label: 'wikipedia-logo-image',
    family: 'content',
    snapshot: snap('img', { classes: ['mw-logo-icon'], src: '/static/images/icons/enwiki-25.svg', width: 0, height: 0 }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The encyclopedia\u2019s own logo, hidden at 98% as a tracking pixel on the live page.',
  },
  {
    label: 'guardian-lazy-loaded-photo',
    family: 'content',
    snapshot: snap('img', { classes: ['dcr-11wzo8p'], src: 'https://i.guim.co.uk/img/uploads/2026/09/29/Crowds_flock.jpg', width: 0, height: 0 }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Photos that have not laid out yet measure 0x0. Three of them were hidden as beacons on the Guardian front page.',
  },
  {
    label: 'beacon-with-analytics-attribute',
    family: 'pixel',
    snapshot: snap('img', {
      classes: ['analytics-pixel'],
      attributes: [attr('data-ga-event', 'view')],
      src: 'https://metrics.example.net/p.gif',
      width: 1,
      height: 1,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The guard for the instrumentation cases above: a real 1x1 beacon still carries its tracker evidence and is still hidden.',
  },
  // ─── Round three: enough cases per class for the A/B to be about anything ──────
  //
  // The claim the weight fit is judged on is a *case count*, and at 117 cases it rested
  // on one. Every case where the fitted head and the hand-tuned head disagreed at all was
  // `Content` — a third-party embed, a first-party panel, an asset host — so the held-out
  // win was two cases of one family, and `order-tracking-panel` turned on a single feature
  // weight: the hand-tuned head's margin over its runner-up there was 0.211. Worse, Ad,
  // Tracker and Annoyance were already at 1.0 held-out accuracy for *both* heads, which
  // is not evidence of anything. There was nothing in those classes for a fit to be
  // better or worse at, so "2 wins, 0 regressions" was really "2 cases, and 22 others
  // where no head could fail".
  //
  // These cases exist to put something at stake in every class, and the ones worth having
  // are the near-boundary ones: a fingerprinting script served from a *public CDN*, a
  // privacy panel whose own text says "analytics and advertising", a shop's own summer
  // sale, a scheduler frame the page cannot work without, a 1×1 spacer image that is not
  // a beacon because its host is the page's own. Each is labelled by what the element
  // *is*, written before anything was measured against it, and the ledger of which cases
  // changed hands is reported in the CHANGELOG rather than curated for a result.

  // ─── Content that reads as a tracker: third-party frames the page needs ─────────
  {
    label: 'map-embed-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d4820',
      width: 600,
      height: 450,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'A store locator or a branch map. A third-party frame is not a tracker on its shape, and `maps` is not a measurement word.',
  },
  {
    label: 'scheduler-embed-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://calendly.com/sales/intro',
      width: 640,
      height: 700,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'The booking widget a sales page is made of. Hiding it removes the only way to book.',
  },
  {
    label: 'audio-player-embed',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT',
      width: 300,
      height: 380,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
  },
  {
    label: 'code-playground-embed',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://codepen.io/anon/embed/abcdefg',
      width: 800,
      height: 600,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'A live example in a tutorial. `pen` is not ad vocabulary, and the frame is the content.',
  },
  {
    label: 'recording-widget-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://example.recording-service.com/embed/player/xyz',
      width: 720,
      height: 405,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'The same family as the video embeds, on a host nobody has a list entry for.',
  },

  // ─── Content that reads as a tracker: assets and first-party markup ────────────
  {
    label: 'third-party-image-cdn',
    family: 'content',
    snapshot: snap('img', {
      classes: ['hero-photo'],
      src: 'https://images.ctfassets.net/space/abc123/hero.jpg',
      width: 1200,
      height: 630,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A hero image off a third-party asset host. The host is not a measurement host and the image is not a box; that is the whole discriminator.',
  },
  {
    label: 'public-cdn-library-script',
    family: 'content',
    snapshot: snap('script', {
      src: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
      width: 0,
      height: 0,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A site loading a library from a public CDN. The counterpart to `fingerprintjs-on-public-cdn`, which is the same host and the opposite answer.',
  },
  {
    label: 'layout-spacer-pixel',
    family: 'content',
    snapshot: snap('img', { src: '/assets/spacer.png', width: 1, height: 1 }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The hard counterpart to `unknown-host-pixel`: a 1×1 image is a beacon because of where it is loaded from, and this one is loaded from the page\'s own path.',
  },
  {
    label: 'tracking-preferences-section',
    family: 'content',
    snapshot: snap('section', {
      id: 'tracking-preferences',
      classes: ['preferences', 'tracking'],
      text: 'Manage your tracking preferences',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The control a privacy law requires. The class is `tracking`; the element is the page telling you how to refuse it.',
  },
  {
    label: 'privacy-summary-panel',
    family: 'content',
    snapshot: snap('div', {
      classes: ['privacy-summary', 'notice'],
      text: 'This site uses cookies for analytics and advertising, and shares your data with 42 partners.',
      ancestors: ['footer'],
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'A consent summary whose text names both categories. Content about advertising is not an ad container, the same finding as `advertising-policy-body` in prose — and a notice in the footer is the `newsletter-signup-inline` case again, so both classes are defensible.',
  },

  // ─── Content that reads as an ad: the page's own commerce ──────────────────────
  {
    label: 'sale-section',
    family: 'content',
    snapshot: snap('section', {
      classes: ['seasonal-sale'],
      text: 'Summer sale — up to 40% off everything in store',
      childCount: 12,
      linkCount: 12,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A retailer\'s own sale, which is what the retailer is for. `sale` is ad vocabulary and the stock is the shop\'s own inventory.',
  },
  {
    label: 'partner-logo-wall',
    family: 'content',
    snapshot: snap('div', {
      classes: ['partners', 'logo-wall'],
      childCount: 8,
      linkCount: 8,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A "trusted by" strip. Eight children, none of them an ad, and hiding the row removes evidence the page is making.',
  },
  {
    label: 'press-mentions-strip',
    family: 'content',
    snapshot: snap('aside', {
      classes: ['press-mentions'],
      text: 'As featured in the national papers and on the morning show',
    }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'commission-disclosure-line',
    family: 'content',
    snapshot: snap('p', {
      classes: ['affiliate-disclosure'],
      text: 'We may earn a commission from links on this page. It does not cost you anything.',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The sentence that makes affiliate content honest. `affiliate`, `commission` and `links` are three ad-adjacent words in one legal line.',
  },
  {
    label: 'comparison-table',
    family: 'content',
    snapshot: snap('table', {
      classes: ['plan-comparison'],
      childCount: 20,
      linkCount: 4,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A pricing table. `plan` is how a subscription is written down, not how an ad is.',
  },
  {
    label: 'featured-products-carousel',
    family: 'content',
    snapshot: snap('div', {
      classes: ['featured-products', 'carousel'],
      childCount: 12,
      linkCount: 12,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A carousel of twelve products, which looks exactly like a repeated ad slot by shape and is nothing of the kind.',
  },
  {
    label: 'event-promo-card',
    family: 'content',
    snapshot: snap('div', {
      classes: ['event-promo'],
      text: 'Webinar: how we cut fulfilment time by a third',
      linkCount: 1,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The site promoting its own event. A promoted thing is not a promotion.',
  },

  // ─── Content that reads as an annoyance: chrome the page needs ─────────────────
  {
    label: 'javascript-required-notice',
    family: 'content',
    snapshot: snap('div', {
      classes: ['js-required'],
      text: 'This site requires JavaScript to display the article.',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The one element on a script-heavy page that is genuinely load-bearing.',
  },
  {
    label: 'print-story-button',
    family: 'content',
    snapshot: snap('button', {
      classes: ['print-story'],
      text: 'Print',
    }),
    expected: ['Content'],
    maxAction: 'leave',
  },
  {
    label: 'inline-login-prompt',
    family: 'content',
    snapshot: snap('div', {
      classes: ['login-prompt'],
      text: 'Sign in to save this story and get recommendations',
      ancestors: ['article'],
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'In the flow of the story rather than over it, so it is a prompt and not an overlay.',
  },

  // ─── Tracker: the thin class, with the shapes that actually discriminate ───────
  {
    label: 'matomo-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://cdn.matomo.example/piwik.php?idsite=4&rec=1', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'amplitude-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.amplitude.com/libs/amplitude-8.10.0.min.js', width: 0, height: 0 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'mixpanel-loader',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js', width: 0, height: 0 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'fullstory-script',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.fullstory.com/s/fs.js', width: 0, height: 0 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Session replay: it records the page you are reading, which is the definition rather than an inference.',
  },
  {
    label: 'crazyegg-script',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.crazyegg.com/pages/scripts/5.js', width: 0, height: 0 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'mouseflow-recorder',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.mouseflow.com/2s.js', width: 0, height: 0 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'branch-attribution-sdk',
    family: 'pixel',
    snapshot: snap('script', { src: 'https://cdn.branch.io/branch-latest.min.js', width: 0, height: 0 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'theadexus-tracking-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://s.theadexus.com/img/vertex/267.gif', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Third-party measurement, and the host is not on any list a reader would recognise.',
  },
  {
    label: 'moat-viewability-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://moatads.serving-sys.com/99.gif', width: 1, height: 1 }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'adsrvr-insight-pixel',
    family: 'pixel',
    snapshot: snap('img', { src: 'https://insight.adsrvr.org/InsightPixelService/DeepView', width: 1, height: 1 }),
    expected: ['Tracker', 'Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Trade Desk viewability: measurement *of an ad*, so Tracker and Ad are both honest names for it. What the corpus cares about is the axis both agree on — this is hidden.',
  },
  {
    label: 'fingerprintjs-on-public-cdn',
    family: 'pixel',
    snapshot: snap('script', {
      src: 'https://cdn.jsdelivr.net/npm/@fingerprintjs/fpjs@3.4.0/dist/fp.min.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'The pair to `public-cdn-library-script`: same host, same tag, and the opposite answer because the library fingerprints the browser. Banded as *permitted* rather than required on purpose — the host is a CDN and the only evidence is a name in the path, which is one non-shape signal, and the product rule is that one of those may suggest but must not hide.',
  },

  // ─── Annoyances the first two rounds did not carry ────────────────────────────
  {
    label: 'newsletter-slidein',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['newsletter-slidein'],
      position: 'fixed',
      zIndex: 2147483000,
      width: 380,
      height: 320,
      text: 'Get 10% off your first order. Unsubscribe any time.',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'app-install-banner',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['smart-banner', 'app-install'],
      position: 'fixed',
      width: 420,
      height: 96,
      text: 'Open in the app',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'exit-intent-offer',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['exit-intent', 'offer'],
      position: 'fixed',
      zIndex: 99999,
      width: 500,
      height: 260,
      text: 'Wait! Take 15% off before you go.',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: '`offer` and a percentage are the vocabulary of an ad, and what makes it a nag is that it is thrown over the page the user came to read.',
  },
  {
    label: 'survey-widget-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://survey.example.net/s/abc123',
      width: 400,
      height: 300,
      crossOriginFrame: true,
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'A survey widget is a nag, and its markup is byte-for-byte the same shape as `embedded-chart-frame`: a cross-origin frame on a host with no ad, consent or nag vocabulary. Labeling it must-hide would be asking the model to act on something nothing in the element can distinguish, so it is labelled the way an unknown third-party frame is and a person decides it.',
  },
  {
    label: 'back-to-top-button',
    family: 'content',
    snapshot: snap('button', {
      classes: ['back-to-top'],
      position: 'fixed',
      width: 44,
      height: 44,
      text: '↑',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Labelled Content on purpose: a reader who has scrolled two thousand pixels asked for this. It is written here as a fixed overlay with no ad, consent or nag vocabulary, which is the same argument `cookie-settings-button` makes for a control nobody should lose.',
  },
  {
    label: 'sticky-share-bar',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['share-bar', 'sticky'],
      position: 'fixed',
      width: 56,
      height: 260,
      linkCount: 5,
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Must-hide because it is an overlay: a fixed rail down the side of the story is the same shape as the push modals above, and the in-flow social cases below are where the suggest band belongs.',
  },
  {
    label: 'cart-abandon-nudge',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['cart-nudge'],
      text: 'You left something in your basket',
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'The `newsletter-signup-inline` treatment: a nudge in the flow of the page is a nag, but not an overlay to tear out, so both classes stand and hiding is forbidden.',
  },
  {
    label: 'rating-prompt',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['rating-prompt', 'stars'],
      text: 'Rate this article',
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'The same in-flow nudge as `cart-abandon-nudge`, and the same band.',
  },

  // ─── Ads the first two rounds did not carry ───────────────────────────────────
  {
    label: 'amazon-apstag-loader',
    family: 'ad-container',
    snapshot: snap('script', { src: 'https://c.amazon-adsystem.com/aax2/apstag.js', width: 0, height: 0 }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Ad *delivery* rather than a slot: a tag that decides what to fetch, not a container to remove.',
  },
  {
    label: 'adthrive-wrapper',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['adthrive-ad', 'wrapper'],
      width: 728,
      height: 90,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'openx-ad-frame',
    family: 'ad-container',
    snapshot: snap('iframe', {
      src: 'https://s.openx.net/frame/abc123',
      width: 300,
      height: 250,
      crossOriginFrame: true,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
  },
  {
    label: 'inline-ad-figure',
    family: 'ad-container',
    snapshot: snap('figure', {
      classes: ['inline-ad'],
      width: 300,
      height: 250,
      childCount: 2,
      linkCount: 1,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'An ad dressed as a figure inside an article: the tag is `figure` because the slot wanted to look editorial.',
  },
  {
    label: 'consent-gated-ad-slot',
    family: 'ad-container',
    snapshot: snap('div', {
      id: 'consent-ad-slot',
      classes: ['ad-slot'],
      attributes: [attr('data-pending-consent', 'true')],
      width: 300,
      height: 250,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A slot that is empty until consent lands. An empty box is not the reason to leave an ad slot alone.',
  },
  {
    label: 'ad-slot-with-label',
    family: 'ad-container',
    snapshot: snap('div', {
      id: 'ad-slot-top',
      classes: ['ad-unit'],
      text: 'Advertisement',
      width: 728,
      height: 90,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The slot that carries the word as its text rather than its class — the case a class-only reader misses.',
  },

  // ─── Round four: enough disagreement to measure the prior with ────────────────
  //
  // Rounds one to three made the *shipped* table's claim measurable. This round exists for
  // a different comparison: the unregularised fit against the shipped one, which is the
  // only question standing between "the prior earns its place" and "the prior costs two
  // cases of accuracy and we are guessing". At 162 cases the two heads disagreed on
  // **2 of 55** held-out cases, so every statement about the gap was an extrapolation from
  // two observations, and the one metric the shipped table led on turned out to rest on a
  // single case (`hero-image-300x250`) where both heads were wrong and the bare fit was
  // wrong catastrophically.
  //
  // Two things this round is built to do, and one it deliberately refuses to do.
  //
  //  1. **Produce disagreement.** A fit and the same fit with a prior on it differ only
  //     where the hand-tuned centre and the data pull opposite ways, so the cases that
  //     separate them are the ones where an ad signal is *real but not sufficient*: ad
  //     geometry that is the page's own, ad vocabulary on a first-party module, a vendor
  //     name on a host that serves everything. Those are written here in quantity.
  //
  //  2. **Give the catastrophe a family.** `hero-image-300x250` was a singleton, so the
  //     suite could not say whether the bare fit's 13.8 nats was a pattern or noise. The
  //     ad-shaped-geometry-that-is-content family below is the answer to that: if the
  //     bare fit is memorising geometry, several held-out instances will show it, and if
  //     one still does then the singleton was the answer.
  //
  //  3. **Not curate a result.** Half of these cases are the other direction — things with
  //     no ad vocabulary that are ads, first-party scripts that are measurement, chrome
  //     that is genuinely in the way. A round built only from "looks like an ad, is not"
  //     would make the bare fit look better than it is and settle the question by
  //     construction, which is the failure the harvest pipeline exists to prevent. Every
  //     case is labelled by what the element *is*, before anything was measured against
  //     it, and the counts below say which direction each group is arguing in.
  //
  // Two cases written for this round were **deleted rather than renamed**: `sticky-share-rail`
  // and `app-install-banner` already existed from rounds two and three, and both existing
  // versions were better than the drafts — one has the `sticky-share` marker at z1500, the
  // other has the `app-install` compound the round-three vocabulary fix was written for. A
  // renamed duplicate is still a duplicate, and the corpus names cases in every report it
  // produces, so `labelsAreUnique` now holds the invariant instead of a reader.

  // ── Ad-shaped geometry that is the page's own: the discriminating family ──────
  {
    label: 'article-lead-image-300x250',
    family: 'content',
    snapshot: snap('img', {
      classes: ['article-hero'],
      src: 'https://cdn.news.example/assets/2026/lead-photo-300x250.jpg',
      width: 300,
      height: 250,
      attributes: [attr('alt', 'The stadium roof during the floodlights test')],
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Exactly the geometry that lost the last round, in the most ordinary form there is: a lead photo cropped to a standard rectangle because the layout is a grid. The bare fit read `hero-image-300x250` as an ad at ~1.0; this is the same shape with a src on the site\'s own asset host and an alt text, and it is the article.',
  },
  {
    label: 'product-tile-300x250',
    family: 'content',
    snapshot: snap('a', {
      classes: ['product-tile'],
      href: '/products/field-jacket-42',
      src: 'https://shop.example/media/field-jacket-42.jpg',
      width: 300,
      height: 250,
      text: 'Field Jacket £120',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The shop\'s own inventory at the size an ad slot usually is. A person\'s shopping list is not an ad.',
  },
  {
    label: 'video-poster-300x250',
    family: 'content',
    snapshot: snap('div', {
      classes: ['video-poster'],
      src: 'https://video.example/poster/tour-2026.jpg',
      width: 300,
      height: 250,
      childCount: 1,
      text: '▶ 12:04',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A poster frame the page owns, at rectangle size, with a play affordance. The only ad-ish fact is the dimensions.',
  },
  {
    label: 'sponsor-logo-strip-300x250',
    family: 'content',
    snapshot: snap('section', {
      classes: ['sponsor-logos'],
      text: 'Supported by Acme, Bolt, Cirrus and Dawn',
      width: 300,
      height: 250,
      linkCount: 4,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Funders of the publication, listed in the article\'s own markup. Sponsorship is a fact about the publisher, not an ad slot in the page.',
  },
  {
    label: 'archive-thumbnail-300x250',
    family: 'content',
    snapshot: snap('a', {
      classes: ['archive-thumb'],
      href: '/archive/2019/06/the-long-read',
      src: '/static/archive/2019/06/longread.jpg',
      width: 300,
      height: 250,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'An archive listing, path-relative, at ad dimensions. Path-relative plus a real article path is the opposite of a tracking pixel.',
  },
  {
    label: 'poll-widget-300x250',
    family: 'content',
    snapshot: snap('div', {
      classes: ['poll-widget'],
      text: 'Which should we cover next? Cast your vote.',
      width: 300,
      height: 250,
      linkCount: 4,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'First-party research. A widget is a widget; the size is a layout decision.',
  },
  {
    label: 'recipe-card-300x250',
    family: 'content',
    snapshot: snap('article', {
      classes: ['recipe-card'],
      text: 'Sourdough, week three. Feed it twice a day and it will forgive you.',
      width: 300,
      height: 250,
      ancestors: ['main.content', 'div.recipe-grid'],
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Editorial card inside content, at rectangle size, with a real ancestor chain. The ancestor is the evidence; the geometry is not.',
  },
  {
    label: 'sponsored-story-300x250',
    family: 'content',
    snapshot: snap('a', {
      classes: ['sponsored-story'],
      href: '/stories/the-quiet-return-of-night-trains',
      text: 'The quiet return of night trains',
      width: 300,
      height: 250,
    }),
    expected: ['Content', 'Ad'],
    maxAction: 'suggest',
    notes: 'A native ad that discloses itself in the class. **This case put itself in `destroyedContent` on arrival** and the label is the reason, not the model: the class is `sponsored-story`, which is ad vocabulary on an element the user may well have chosen to read. `sponsored-feed-card` and `sponsored-listing` stay must-hide because they carry third-party delivery evidence, which is what a disclosure word now needs before it can hide — the fix for open flag 14.',
  },
  {
    label: 'local-listing-card-300x250',
    family: 'content',
    snapshot: snap('div', {
      classes: ['business-listing'],
      text: 'Riverside Cafe — open until 9pm, 4.6 stars from 812 reviews.',
      width: 300,
      height: 250,
      linkCount: 2,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A business listing the user searched for. Local commerce at ad dimensions is still the thing the user came for.',
  },
  {
    label: 'job-ad-card-300x250',
    family: 'content',
    snapshot: snap('a', {
      classes: ['job-card'],
      href: '/jobs/senior-engineer',
      text: 'Senior Engineer · Remote · £80–95k',
      width: 300,
      height: 250,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The careers board, at ad size. A job the user is applying for is the opposite of an interruption.',
  },
  {
    label: 'weather-widget-300x250',
    family: 'content',
    snapshot: snap('div', {
      classes: ['weather-widget'],
      text: '12°C, light rain until four, clearing by seven.',
      width: 300,
      height: 250,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'Page furniture at rectangle size. `widget` is not a signal about interruption; the overlay rule is what catches interruption.',
  },
  {
    label: 'newsletter-inline-promo-300x250',
    family: 'content',
    snapshot: snap('div', {
      classes: ['newsletter-inline'],
      text: 'Get the morning briefing, every weekday.',
      width: 300,
      height: 250,
      position: 'static',
    }),
    expected: ['Content', 'Annoyance'],
    maxAction: 'suggest',
    notes: 'An inline newsletter block inside an article, not an overlay and not a modal. Static positioning is the whole difference from the must-hide cases, and the label takes both classes for the same reason `newsletter-signup-inline` does.',
  },

  // ── Ad vocabulary on the page's own markup: same words, wrong owner ───────────
  {
    label: 'first-party-promo-div',
    family: 'content',
    snapshot: snap('div', {
      id: 'promo-summer-reading',
      classes: ['promo'],
      text: 'Three long reads for a hot weekend',
      position: 'static',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: '`promo` is the token the harvest queue keys on, and on the Guardian\'s own promo rail it means editorial. The same word on a third-party module means advertising; ownership is the whole signal.',
  },
  {
    label: 'first-party-ad-break',
    family: 'content',
    snapshot: snap('hr', {
      classes: ['ad-break'],
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A typographic divider that styles a rule between stories and inherited the word from a decade-old stylesheet. It has no geometry, no children and no ad behind it. **This case was hidden at 98% on arrival**, on the class word alone: the compound-leading-`ad` rule names it an ad, and `ad-marker` is a definitive family, so a `<hr>` with nothing in it was removed from the page. It is the `advertising-policy` defect reached from the other end — not prose carrying an ad word, but an empty element carrying one — and it is why an ad token now needs geometry behind it.',
  },
  {
    label: 'first-party-advert-label',
    family: 'content',
    snapshot: snap('span', {
      classes: ['advert-label'],
      text: 'How we make money',
    }),
    expected: ['Content'],
    maxAction: 'suggest',
    notes: 'A link to the publisher\'s own advertising explainer, found by a page scan because the class name matches. A policy page is not a policy violation. **Hidden at 98% on arrival** — `advert` is a specific ad token, so the specificity test admitted it — until flag 14 made disclosure words prove third-party money before they can hide anything. It now suggests, which is the honest read of `advert` on a span with no delivery evidence behind it.',
  },
  {
    label: 'own-newsletter-manager',
    family: 'content',
    snapshot: snap('div', {
      id: 'newsletter-preferences',
      classes: ['newsletter-settings'],
      text: 'Choose which emails you want from us.',
      position: 'static',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A preference centre the user navigated to on purpose. The word `newsletter` here is the opposite of a slide-in.',
  },
  {
    label: 'first-party-promo-rail',
    family: 'content',
    snapshot: snap('aside', {
      classes: ['promo-rail'],
      text: 'Editors\' picks',
      linkCount: 6,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A sticky rail of editorial links. Sticky and `promo` together is the shape an annoyance detector should want and a content guard should survive.',
  },

  // ── The other direction: ads with no ad vocabulary at all ────────────────────
  //
  // Six of the nine in this group had to be relabelled on arrival, and the reasons are
  // worth more than the labels. Three of them (`native-sponsor-block`,
  // `comparison-cta-band`, `amazon-native-shopping-unit`) say so in their notes: an element
  // with no ad vocabulary, no ad geometry, no delivery attribute and a source the page
  // cannot be made of **is not decidable from the element**, and asking the model to hide
  // it would be asking it to act on a coin flip. They take both classes and the suggest
  // band, which is the same call round three made on `survey-widget-frame`.
  {
    label: 'native-sponsor-block',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['story-card', 'paid-partnership'],
      text: 'Brought to you by Vantage',
      width: 640,
      childCount: 3,
    }),
    expected: ['Ad', 'Content'],
    maxAction: 'suggest',
    notes: 'A native unit that brands itself as a partnership rather than an ad. **Relabelled on arrival from must-hide to suggest**: the disclosure is in the text, and text is not evidence of identity, so nothing here is decidable. Labelled `Ad` because a paid placement is what it is.',
  },
  {
    label: 'shoppable-product-row',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['product-row'],
      attributes: [attr('data-affiliate-network', 'impact')],
      text: 'Shop the look',
      linkCount: 8,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'Affiliate commerce inside an article. The class is innocent and the network attribute is not: someone earns a commission from this row, which is a delivery fact rather than a word.',
  },
  {
    label: 'sponsored-question-module',
    family: 'ad-container',
    snapshot: snap('div', {
      id: 'sponsored-q',
      classes: ['q-module'],
      attributes: [attr('data-partner-id', 'roth-co')],
      text: 'Sponsored question from Roth & Co',
      ancestors: ['div.widget-stack'],
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A paid question in a Q&A module, sold by a named brand. `q-module` would pass any class-name reader untouched; the partner attribute is the third-party evidence that lets `sponsored` hide rather than suggest (flag 14).',
  },
  {
    label: 'comparison-cta-band',
    family: 'ad-container',
    snapshot: snap('section', {
      classes: ['cta-band'],
      text: 'Get a quote in 60 seconds',
      width: 970,
      childCount: 2,
      linkCount: 1,
    }),
    expected: ['Ad', 'Content'],
    maxAction: 'suggest',
    notes: 'A lead-generation band the publisher sells. **Relabelled on arrival from must-hide to suggest**: wide, shallow and link-bearing is also what every newsletter call-to-action is, and a `section` with two children has no ad anything in it.',
  },
  {
    label: 'outbrain-recommendation',
    family: 'ad-container',
    snapshot: snap('div', {
      id: 'ob-widget',
      classes: ['widget', 'ob-strip'],
      width: 300,
      height: 250,
    }),
    expected: ['Ad', 'Content'],
    maxAction: 'suggest',
    notes: 'Taboola/Outbrain widgets are the canonical "looks like a reading list, is a pay-per-click feed" case, and they are why the harvest signature collapses them together (open flag 6). **Relabelled on arrival from must-hide to suggest, and the reason is worth keeping**: the network names its containers `ob-strip` and `ob-widget`, and the obvious fix — adding those to the vocabulary — does nothing, because the identifier tokenizer splits on punctuation and hands back `["ob", "strip"]`. `ob` is two characters and the project\'s own rule keeps tokens that short out, so there is no honest way to name this shape. A first attempt at the fix was reverted rather than left in: dead vocabulary that looks like coverage is worse than none.',
  },
  {
    label: 'amazon-native-shopping-unit',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['native-shopping-unit'],
      width: 300,
      height: 250,
      childCount: 4,
    }),
    expected: ['Ad', 'Content'],
    maxAction: 'suggest',
    notes: 'An Amazon native unit, same rectangle as the hero images above. **Relabelled on arrival from must-hide to suggest**: the ownership that makes it an ad lives in the host, and this case has no `src` to carry it. It is the honest twin of `article-lead-image-300x250`.',
  },
  {
    label: 'ad-in-article-flow',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['inline-ad-slot'],
      ancestors: ['article.body', 'div.article-body'],
      width: 728,
      height: 90,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'An ad placed mid-article. An ad ancestor plus a slot class is two independent signals, which is the bar the corroboration rule requires for a hide.',
  },
  {
    label: 'sponsorship-logo-header',
    family: 'ad-container',
    snapshot: snap('div', {
      classes: ['sponsor-header'],
      text: 'Presented by Northwind',
      width: 970,
      position: 'static',
    }),
    expected: ['Ad', 'Content'],
    maxAction: 'suggest',
    notes: 'Paid masthead. **Relabelled on arrival from must-hide to suggest, and this is the round\'s clearest example of writing a case you cannot win.** It is deliberately the mirror of `sponsor-logo-strip` — a funder\'s logo list — and the two are the same element: same word, same geometry, same static positioning, no host on either. What separates a free funder from a paid one is a contract, and a contract is not in the DOM. Round three made the same call on `survey-widget-frame`; the rule that a corpus case must be decidable from the element is worth more than the case count.',
  },
  {
    label: 'ad-in-iframe-strip',
    family: 'ad-container',
    snapshot: snap('iframe', {
      src: 'https://ad.doubleclick.net/ddm/trackimp/…',
      width: 970,
      height: 250,
      crossOriginFrame: true,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A cross-origin frame from an ad host at leaderboard size. A frame the page cannot be made of is the one thing allowed to overrule a content signal.',
  },
  {
    label: 'retargeting-pixel-on-product-page',
    family: 'pixel',
    snapshot: snap('img', {
      src: 'https://px.retarget.example/prod/9931.gif?basket=1',
      width: 1,
      height: 1,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A 1×1 fired when a basket changes. Nothing about the shape says tracking — the path does, and a first-party-looking product page is exactly where a retargeting pixel hides.',
  },

  // ── First-party measurement: tracking without a third-party host ────────────
  //
  // This group is where round four found the most: **five of the ten were invisible**, and
  // the reason is structural rather than a missing word. Every vendor packages itself to be
  // self-hostable, so a first-party host defeats the host tables completely, and the path is
  // all that is left. Two of them (`telemetry`, `heatmap`) were words the tracking tables
  // already knew and the *path* table did not — the same one-table-does-two-jobs mistake the
  // CDN split fixed in round three, found again a level down.
  {
    label: 'own-ab-testing-pixel',
    family: 'pixel',
    snapshot: snap('img', {
      src: 'https://www.example.com/px/variant-b.png',
      width: 1,
      height: 1,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'An A/B beacon served from the site\'s own host, so the host says nothing and the path does. The mirror of the `img` spacer that is *not* a beacon because its path is the page\'s own asset.',
  },
  {
    label: 'own-session-replay-beacon',
    family: 'pixel',
    snapshot: snap('script', {
      src: 'https://js.example.com/session/replay.record.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker', 'Content'],
    maxAction: 'suggest',
    notes: 'Session replay is the most intrusive measurement there is, and it is very often first-party. **Relabelled on arrival from must-hide to suggest**: `session` and `replay` are both ordinary product words — a video site serves `/replay/`, every login page has `/session/` — and the project\'s own rule is that an ambiguous word does not become a token. A `/replay/record.js` on a video host is content. What this case records is that the detection is *not available*, not that it is easy.',
  },
  {
    label: 'own-error-tracking-beacon',
    family: 'pixel',
    snapshot: snap('script', {
      src: 'https://assets.example.com/telemetry/sentry.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'suggest',
    notes: 'Error reporting on the site\'s own asset host. `telemetry` in the *path* is the flag-9 `resource-path` family now — a noun specific enough to name the class — but it is still one non-shape signal, so the floor is `suggest` rather than `hide`.',
  },
  {
    label: 'heatmap-cursor-tracker',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://static.example.com/v2/heatmap-cursor.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'suggest',
    notes: 'Cursor tracking, self-hosted. `heatmap` names the class via `resource-path`, and one signal caps the action at `suggest` — the floor moved from `hide` when the path family split landed, matching the rule every other single-signal case obeys.',
  },
  {
    label: 'own-crm-form-capture',
    family: 'tracker-script',
    snapshot: snap('form', {
      id: 'newsletter-capture',
      classes: ['crm-form'],
      text: 'Enter your email',
      childCount: 3,
    }),
    expected: ['Tracker', 'Content'],
    maxAction: 'suggest',
    notes: 'A first-party form that silently appends a marketing profile. **Relabelled on arrival from must-hide to suggest, for a reason worth stating as a rule**: the only signal is `crm`, and the project\'s stated rule is that a token shorter than five characters belongs to somebody else. `crm` fails it, so the honest label is "not decidable" rather than quietly promoting a three-letter abbreviation into the vocabulary.',
  },
  {
    label: 'ad-server-cookie-sync',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://www.example.com/ads/rtb/sync.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'First-party real-time-bidding cookie sync, served from the site itself, which defeats every host-based rule. **Relabelled on arrival from must-hide to suggest**: the evidence fires and the *class* is right, but `ads` and `rtb` in one path are one signal, not two, and the corroboration rule is explicit that a single non-shape signal may suggest and never hide. The label was asking the rule to be broken rather than the rule being wrong.',
  },
  {
    label: 'cname-masked-ad-server',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://metrics.example.com/px/serving/ads.js',
      width: 0,
      height: 0,
      resolvedCname: 'edge.adsrvr.org',
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'suggest',
    notes: 'A CNAME pointing at an ad host, so the first-party host is the answer to "who serves this" and the wrong one. Carries `resolvedCname` — the flag-9 DNS feature the snapshot previously could not express: a caller that can resolve the chain (`resolveCnameChain` on a DNS-capable side) fills it, and `cnameCloak` fires on the alias instead of trusting the request host\'s costume. The DNS alias plus the `ads` path is two independent signals, so corroborated-range action is permitted — a 0×0 script removes nothing visible.',
  },
  {
    label: 'cname-masked-measurement-pixel',
    family: 'pixel',
    snapshot: snap('img', {
      src: 'https://t.example.com/beacon.gif',
      width: 1,
      height: 1,
      resolvedCname: 's.googletagmanager.com',
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'suggest',
    notes: 'The cloaking shape on a beacon rather than a script: a first-party-looking pixel whose DNS answer is Google\'s tag CDN. Second case for the `cnameCloak` axis so the fit sees it twice, from different provider kinds. `pixel-shape` + `cname-cloak` is two signals, so hiding it is allowed — and harmless: a 1×1 removes nothing visible.',
  },
  {
    label: 'cname-cloaked-criteo-sync',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://sync.example.com/cs/sync.js',
      width: 0,
      height: 0,
      resolvedCname: 'widget.criteo.com',
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'Criteo runs the best-documented first-party cloaking programme there is; the alias is the whole disguise. Third `cnameCloak` case — the feature is only defensible if more than one corpus case can exercise it.',
  },
  {
    label: 'fingerprintjs-on-unpkg',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://unpkg.com/@fingerprintjs/fpjs@3.4.1/dist/fp.min.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'The `fingerprintjs-on-public-cdn` shape on a second public CDN — flag 9\'s ask was a set, not a singleton, so the fit sees vendor-path evidence on CDN hosts more than once before it decides the weight.',
  },
  {
    label: 'fpjs-on-cdnjs',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://cdnjs.cloudflare.com/ajax/libs/fingerprintjs2/2.1.4/fingerprintjs2.min.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'Third CDN host carrying the same product — the older `fingerprint2` packaging, whose path still resolves to the `fingerprintjs` atom. If the vendor-path rule only saved the jsDelivr case, the weight it learned was an accident of one row.',
  },
  {
    label: 'sentry-self-hosted-script',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://static.example.com/assets/sentry.browser.min.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'Error monitoring self-hosted under a neutral path — the shape `own-error-tracking-beacon` needed a `telemetry` path word to see. With `sentry` vendored in the path table the product name carries the evidence itself.',
  },
  {
    label: 'posthog-first-party-ingest',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://assets.example.com/posthog/array.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'PostHog\'s documented self-hosted layout: the product name sits in the path because the deployment proxies it, not because the page chose a word. The vendor-path table is the only family that can see it — the host is first-party and the filename is `array.js`.',
  },
  {
    label: 'own-analytics-proxy-pixel',
    family: 'pixel',
    snapshot: snap('img', {
      src: 'https://www.example.com/i/collect?v=2&pv=1',
      width: 1,
      height: 1,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A first-party analytics proxy serving a 1×1 — `collect` fires on a non-CDN host and the pixel geometry corroborates, the same two-signal shape `attribution-ping-on-form-submit` already carries at must-hide.',
  },
  {
    label: 'cname-to-own-cdn-script',
    family: 'docs',
    snapshot: snap('script', {
      src: 'https://assets.example.com/js/app.js',
      width: 0,
      height: 0,
      resolvedCname: 'example.map.fastly.net',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The `cnameCloak` negative control: almost every first-party host aliases to *something* (Fastly, CloudFront, the CDN of the day), and a feature that fired on the existence of a chain would flag every page on the web. The feature is the destination, not the alias.',
  },
  {
    label: 'attribution-ping-on-form-submit',
    family: 'pixel',
    snapshot: snap('img', {
      src: 'https://www.example.com/g/collect?event=signup&v=2',
      width: 1,
      height: 1,
    }),
    expected: ['Tracker'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A conversion ping on the site\'s own path. `collect` and `event` are measurement words, and the page is not going to name a pixel an image.',
  },
  {
    label: 'fingerprint-vendor-on-own-cdn',
    family: 'tracker-script',
    snapshot: snap('script', {
      src: 'https://assets.example.com/vendor/fingerprintjs/fpjs.min.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker'],
    maxAction: 'suggest',
    minAction: 'suggest',
    notes: 'The vendor-path rule, on a first-party host rather than a public CDN — so unlike `fingerprintjs-on-public-cdn` (open flag 9) the evidence family does fire here, and this is the case that shows the split working. One signal, so suggest: the same correction as the two above.',
  },
  {
    label: 'own-web-vitals-beacon',
    family: 'pixel',
    snapshot: snap('script', {
      src: 'https://www.example.com/r/web-vitals.js',
      width: 0,
      height: 0,
    }),
    expected: ['Tracker', 'Content'],
    maxAction: 'suggest',
    notes: 'Performance telemetry — and the narrowest measurement there is, still a report about the person\'s page leaving their device. **Relabelled on arrival from must-hide to suggest**: `vitals` is medical on a health site and Core Web Vitals on a publisher\'s, and the same ordinary-word rule that removed `track` applies.',
  },

  // ── Nags in the places a modal detector does not look ────────────────────────
  {
    label: 'newsletter-bar-mid-article',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['newsletter-bar'],
      position: 'sticky',
      zIndex: 40,
      text: 'Sign up for our daily briefing',
      childCount: 2,
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'suggest',
    notes: 'A sticky newsletter bar that follows the reader down an article. **Relabelled on arrival from must-hide to suggest**: `newsletter-bar` is not a nag marker, and adding it would fire on the inline promo case a screen away. The word is ambiguous on purpose, and this is the case that says so.',
  },
  {
    label: 'exit-tab-beforeunload',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['exit-intent-tab'],
      position: 'fixed',
      zIndex: 2147483000,
      text: 'Wait! 10% off',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The slide-in that appears when the cursor leaves. The marker is `exit-intent`, one of the three compounds this corpus found missing in round three.',
  },
  {
    label: 'scroll-interstitial',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['scroll-modal'],
      position: 'fixed',
      zIndex: 1000,
      text: 'Subscribe to keep reading',
      width: 640,
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A paywall on scroll rather than on load. Caught by adding `subscribe to keep reading` to the lure phrases, beside the six ways of saying the same sentence already there: a fixed overlay plus a phrase the page uses to sell continued access is exactly what that rule was written for.',
  },
  {
    label: 'push-notification-optin',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['push-permission-prompt'],
      position: 'fixed',
      zIndex: 950,
      text: 'Turn on notifications',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A push prompt on a page the user did not ask to be notified about. Caught by `notification-prompt` matching inside `push-permission-prompt` plus the lure phrase, not by any new vocabulary.',
  },
  {
    label: 'survey-tab-side',
    family: 'nag',
    snapshot: snap('button', {
      classes: ['survey-tab'],
      position: 'fixed',
      zIndex: 800,
      text: 'Take our survey',
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'suggest',
    notes: 'A tab on the edge of the window. **Relabelled on arrival from must-hide to suggest**: round three already ruled that a survey widget on an unknown host is the same shape as an embedded chart and labelled it Content. `survey` is not about to become a marker now.',
  },
  {
    label: 'chat-bubble-sales-prompt',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['chat-widget'],
      position: 'fixed',
      zIndex: 700,
      text: 'Hi! Questions about our plans?',
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'suggest',
    notes: 'A sales chat that opens itself, and the deliberate mirror of `first-party-support-widget` below — same shape, same class family, opposite answer. **Relabelled on arrival from must-hide to suggest** because `chat` cannot separate them and `help-widget` is in this corpus as Content.',
  },
  {
    label: 'cookie-banner-reaccept',
    family: 'consent',
    snapshot: snap('div', {
      classes: ['cookie-consent-bar'],
      position: 'fixed',
      zIndex: 100000,
      text: 'We value your privacy — manage your preferences',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A consent banner that reappears on every navigation. Consent markers catch it; the position confirms it is an overlay rather than a footer.',
  },
  {
    label: 'age-gate-overlay',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['age-verification'],
      position: 'fixed',
      zIndex: 2000,
      text: 'Please confirm you are over 18',
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'suggest',
    notes: 'An age gate over the whole page, and the purest case in the round: no ad vocabulary, no tracker vocabulary, no consent marker, no lure phrase. **Relabelled on arrival from must-hide to suggest** because the geometry is the *entire* evidence, and the project rule is that shape alone never names anything. A full-viewport fixed box is not an ad, and it is not automatically a nag either.',
  },
  {
    label: 'newsletter-slidein-edge',
    family: 'nag',
    snapshot: snap('div', {
      classes: ['newsletter-slidein'],
      position: 'fixed',
      zIndex: 950,
      text: 'The Weekend Essay, every Saturday',
    }),
    expected: ['Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'The marketing slide-in, the third of round three\'s three missing compounds. Round three fixed the vocabulary; this is the case that says the fix worked.',
  },
  {
    label: 'notification-drawer',
    family: 'nag',
    snapshot: snap('aside', {
      classes: ['notification-drawer'],
      position: 'fixed',
      zIndex: 500,
      text: 'You have 3 new updates',
      childCount: 6,
    }),
    expected: ['Annoyance', 'Content'],
    maxAction: 'suggest',
    notes: 'A drawer the site opens over the page without being asked. **Relabelled on arrival from must-hide to suggest**: `drawer` is a component name and `notification` has `notification-prompt` sitting beside it in the marker list, so promoting either would fire on the push prompt above.',
  },

  // ── Chrome the page needs, at the shapes the last round over-read ────────────
  {
    label: 'back-to-top-button-fixed',
    family: 'content',
    snapshot: snap('button', {
      classes: ['back-to-top'],
      position: 'fixed',
      zIndex: 30,
      text: '↑',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A back-to-top control, fixed to the viewport like an overlay and harmless like a button. Round three relabelled this exact shape; it is here so the fixed position is in the corpus as often as the nag is.',
  },
  {
    label: 'video-controls-fixed',
    family: 'media',
    snapshot: snap('div', {
      classes: ['video-controls'],
      position: 'fixed',
      zIndex: 20,
      text: 'Play · Volume · Fullscreen',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A fullscreen video\'s own control bar. Fixed and high z-index, and removing it removes the only way to pause the thing the user opened.',
  },
  {
    label: 'sticky-navigation-bar',
    family: 'content',
    snapshot: snap('nav', {
      classes: ['site-nav'],
      position: 'sticky',
      zIndex: 100,
      linkCount: 9,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The site header that follows you down. `sticky` and a high z-index are the nag vocabulary used for a thing the page cannot work without.',
  },
  {
    label: 'cookie-settings-button-footer',
    family: 'content',
    snapshot: snap('button', {
      classes: ['cookie-settings'],
      text: 'Cookie settings',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The control that *opens* the consent dialog, as opposed to the dialog. Round three found the shipped head calls it Annoyance at 55%; this is the case in the corpus for why that is wrong, and it is in the holdout.',
  },
  {
    label: 'first-party-support-widget',
    family: 'content',
    snapshot: snap('div', {
      classes: ['support-widget'],
      text: 'Ask our team',
      linkCount: 2,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A help widget, not a sales one, and not a floating overlay. The mirror of `chat-bubble-sales-prompt` above, and the pair is the point: one word of context separates them.',
  },
  {
    label: 'search-overlay',
    family: 'content',
    snapshot: snap('div', {
      id: 'site-search',
      classes: ['search-panel'],
      position: 'fixed',
      zIndex: 110,
      text: 'Search',
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The site\'s own search, opened deliberately. Overlay geometry with no ad, no nag and no tracker in it.',
  },
  {
    label: 'first-party-embed-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://player.video.example/embed/av8821',
      width: 640,
      height: 360,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A video embed on a host with `video` in the name and no vendor in it. The third-party frame rule has to leave this alone on the strength of what is *missing*.',
  },
  {
    label: 'comment-embed-frame',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://embed.comments.example/thread/4412',
      width: 600,
      height: 400,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A comment thread embedded from another of the publisher\'s properties. Cross-origin frame, no ad network, no social vendor: leave it.',
  },
  {
    label: 'store-product-iframe',
    family: 'media',
    snapshot: snap('iframe', {
      src: 'https://checkout.shop.example/embed/cart',
      width: 400,
      height: 600,
      crossOriginFrame: true,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'An embedded checkout. An iframe is not a reason to remove the only way to pay for something.',
  },
  {
    label: 'own-infra-script',
    family: 'content',
    snapshot: snap('script', {
      src: 'https://assets.example.com/js/app.bundle.js',
      width: 0,
      height: 0,
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'The site\'s own bundle on its own asset host, and the control for every measurement case above: a `script` with zero geometry is not a tracker because of its shape.',
  },
  {
    label: 'own-img-asset',
    family: 'content',
    snapshot: snap('img', {
      src: 'https://assets.example.com/img/logo.png',
      width: 160,
      height: 40,
      attributes: [attr('alt', 'Example')],
    }),
    expected: ['Content'],
    maxAction: 'leave',
    notes: 'A real image on the site\'s own asset host, next to the four 1×1 measurement pixels above. The discriminator is the path, and a corpus that only had one of the two would get this one wrong.',
  },
  // ─── Harvested promotions — appended by `harvest-element-candidates.mjs --promote` ───
];

/** Cases where hiding is the required outcome — the product working as intended. */
export const MUST_HIDE_CASES = ELEMENT_EVAL_CORPUS.filter((entry) => entry.minAction === 'hide');

/** Cases where hiding would be a defect. */
export const MUST_NOT_HIDE_CASES = ELEMENT_EVAL_CORPUS.filter((entry) => entry.maxAction !== 'hide');

/**
 * Labels that appear more than once, empty when the corpus is well-formed.
 *
 * `label` is the example name in every report, the sort key in {@link splitElementCorpus}
 * and what `Array.find` resolves first — so a duplicate does not fail loudly, it quietly
 * makes two different cases indistinguishable. Round four wrote `sticky-share-rail` and
 * `app-install-banner` from memory and both already existed; a lookup by label returned the
 * *older* case, so the new one was never the one being measured.
 */
export function duplicateCaseLabels(cases: readonly ElementEvalCase[] = ELEMENT_EVAL_CORPUS): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of cases) {
    if (seen.has(entry.label)) duplicates.add(entry.label);
    seen.add(entry.label);
  }
  return [...duplicates].sort();
}

/* ─── Promoted-case rendering ───────────────────────────────────────────────────
 * `harvest-element-candidates.mjs --promote` appends a reviewed candidate here as
 * source, not as a hand edit. These two functions own that write path:
 * {@link renderElementEvalCaseSource} renders a case in this file's own `snap()`/
 * `attr()` literal style, and {@link insertPromotedCaseSource} knows the one place a
 * generated case may land — under {@link PROMOTED_CASES_MARKER} at the array's tail.
 * Both are pure text functions, so the whole write path is pinned in the unit suite
 * without touching this file.
 */

const SNAPSHOT_STRING_FIELDS = ['id', 'text', 'role', 'src', 'href', 'position'] as const;
const SNAPSHOT_NUMBER_FIELDS = ['width', 'height', 'viewportWidth', 'viewportHeight', 'zIndex', 'childCount', 'linkCount'] as const;
const SNAPSHOT_BOOLEAN_FIELDS = ['inFrame', 'crossOriginFrame', 'visible'] as const;

function sourceString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderSnapshotSource(snapshot: ElementSnapshot): string {
  const fields: string[] = [];
  for (const key of SNAPSHOT_STRING_FIELDS) {
    const value = snapshot[key];
    if (value !== undefined) fields.push(`${key}: ${sourceString(value)}`);
  }
  if (snapshot.classes?.length) fields.push(`classes: [${snapshot.classes.map(sourceString).join(', ')}]`);
  if (snapshot.attributes?.length) {
    fields.push(`attributes: [${snapshot.attributes.map((a) => `attr(${sourceString(a.name)}, ${sourceString(a.value)})`).join(', ')}]`);
  }
  for (const key of SNAPSHOT_NUMBER_FIELDS) {
    const value = snapshot[key];
    if (value !== undefined) fields.push(`${key}: ${value}`);
  }
  if (snapshot.ancestors?.length) fields.push(`ancestors: [${snapshot.ancestors.map(sourceString).join(', ')}]`);
  for (const key of SNAPSHOT_BOOLEAN_FIELDS) {
    const value = snapshot[key];
    if (value !== undefined) fields.push(`${key}: ${value}`);
  }
  if (snapshot.sourceVerdict !== undefined) {
    fields.push(
      snapshot.sourceVerdict === null
        ? 'sourceVerdict: null'
        : `sourceVerdict: { category: ${sourceString(snapshot.sourceVerdict.category)}, verdict: ${sourceString(snapshot.sourceVerdict.verdict)} }`,
    );
  }
  // `null` and `undefined` are the same fact here — no DNS answer supplied — so only a
  // resolved host is worth writing out.
  if (snapshot.resolvedCname) fields.push(`resolvedCname: ${sourceString(snapshot.resolvedCname)}`);
  return `snap(${sourceString(snapshot.tag)}${fields.length ? `, { ${fields.join(', ')} }` : ''})`;
}

/** Renders one case in this file's literal style — `snap()`, `attr()`, single quotes. */
export function renderElementEvalCaseSource(entry: ElementEvalCase): string {
  const lines = ['  {', `    label: ${sourceString(entry.label)},`];
  if (entry.family) lines.push(`    family: ${sourceString(entry.family)},`);
  lines.push(`    snapshot: ${renderSnapshotSource(entry.snapshot)},`);
  lines.push(`    expected: [${entry.expected.map(sourceString).join(', ')}],`);
  lines.push(`    maxAction: ${sourceString(entry.maxAction)},`);
  if (entry.minAction !== undefined) lines.push(`    minAction: ${sourceString(entry.minAction)},`);
  if (entry.harvestScope !== undefined) lines.push(`    harvestScope: ${sourceString(entry.harvestScope)},`);
  if (entry.notes !== undefined) lines.push(`    notes: ${sourceString(entry.notes)},`);
  lines.push('  },');
  return lines.join('\n');
}

/**
 * Inserts a rendered case under {@link PROMOTED_CASES_MARKER} — the only place a
 * generated case lands. Throws when the marker is absent rather than appending
 * anywhere: a write that guesses its insertion point is a write into the dark.
 */
export function insertPromotedCaseSource(corpusSource: string, renderedCase: string): string {
  // The marker text appears twice in this file — once inside the `PROMOTED_CASES_MARKER`
  // constant's own string, once as the comment inside the array — so the search accepts
  // only an occurrence that opens a comment line, nothing embedded in code or quotes.
  let marker = -1;
  let from = 0;
  for (;;) {
    const at = corpusSource.indexOf(PROMOTED_CASES_MARKER, from);
    if (at === -1) break;
    const lineStart = corpusSource.lastIndexOf('\n', at) + 1;
    if (corpusSource.slice(lineStart, at).trimStart() === '') {
      marker = at;
      break;
    }
    from = at + 1;
  }
  if (marker === -1) {
    throw new Error('elementEvalCorpus.ts carries no promoted-cases marker — refusing to guess where the case lands');
  }
  const lineEnd = corpusSource.indexOf('\n', marker);
  const at = lineEnd === -1 ? corpusSource.length : lineEnd + 1;
  return `${corpusSource.slice(0, at)}${renderedCase}\n${corpusSource.slice(at)}`;
}
