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
  /** Why this case exists, for whoever reads the report. */
  notes?: string;
}

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
      width: 640,
      height: 200,
      text: 'Sponsored: how to grow your SaaS business in 30 days',
      childCount: 3,
      linkCount: 1,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
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
  },
  {
    label: 'sticky-share-rail',
    family: 'social',
    snapshot: snap('div', { classes: ['sticky-share'], position: 'sticky', zIndex: 1500, width: 60, height: 300 }),
    expected: ['Annoyance'],
    maxAction: 'hide',
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
      text: 'Sponsored: Acme Widgets — buy now',
      childCount: 2,
      linkCount: 1,
    }),
    expected: ['Ad'],
    maxAction: 'hide',
    minAction: 'hide',
    notes: 'A paid slot inside a results list, where the copy is prose and the class is the only marker.',
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
];

/** Cases where hiding is the required outcome — the product working as intended. */
export const MUST_HIDE_CASES = ELEMENT_EVAL_CORPUS.filter((entry) => entry.minAction === 'hide');

/** Cases where hiding would be a defect. */
export const MUST_NOT_HIDE_CASES = ELEMENT_EVAL_CORPUS.filter((entry) => entry.maxAction !== 'hide');
