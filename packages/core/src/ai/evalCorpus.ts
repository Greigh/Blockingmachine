/**
 * Labeled evaluation corpus for the Mini-AI classifier.
 *
 * This exists so "make the model better" is a measurable claim instead of a
 * guess. Every entry states the labels that are acceptable answers for that
 * domain — most specific first — plus the family it belongs to, so the report
 * can separate the failure that actually hurts (flagging something clean) from
 * the failure that merely annoys (missing a tracker).
 *
 * Ground-truth rules used when building this list:
 *
 *  - **A clean entry is a domain a user would never want blocked**: a site's own
 *    hostname, a cloud/CDN/DNS/CA/government/university endpoint, or a device
 *    vendor's service. If any of these is flagged, an ordinary site breaks, so
 *    they are the highest-value negatives.
 *  - **A nuisance entry is third-party ad or measurement infrastructure**, the
 *    thing a blocker exists to stop. Ads and analytics genuinely overlap
 *    (DoubleClick reports conversions, Criteo retargets), so those entries list
 *    both labels and either is accepted.
 *  - **Malware entries are constructed to published phishing and DGA patterns**
 *    rather than being live malware hosts: live blocklists are ephemeral and
 *    citing one would make this corpus rot. They are labeled `malware` because
 *    the *pattern* must be caught, and each one carries a note.
 */

import type { ThreatCategory } from './types.js';

export type EvalFamily =
  /** Cloud, CDN, DNS, CA, vendor, institutional infrastructure. */
  | 'infra'
  /** Ordinary websites and consumer services: the strongest negatives. */
  | 'consumer'
  | 'device'
  | 'ad'
  | 'telemetry'
  | 'malware'
  | 'dga';

/**
 * What a name-shape classifier can be held responsible for.
 *
 * `lexical` — the hostname itself carries the evidence (a token, a shape, a lure
 * phrase, a version of a brand). The model must catch these; missing one is a
 * model defect.
 *
 * `list-dependent` — the hostname is ordinary-looking and only a curated list can
 * know what it does (`comscore.com`, `bat.bing.com`, `33across.com`). Expecting a
 * fingerprint model to guess these is expecting it to memorize a blocklist; the
 * correct fix is list coverage, so these are reported separately instead of
 * being averaged into the model's score.
 */
export type ClassifierSignal = 'lexical' | 'list-dependent';

export interface EvalCase {
  domain: string;
  /** Acceptable categories, most preferred first. */
  expected: ThreatCategory[];
  family: EvalFamily;
  /** Only meaningful for non-clean expectations; defaults to `lexical`. */
  signal?: ClassifierSignal;
  note?: string;
}

const CLEAN: ThreatCategory[] = ['Clean'];
const AD: ThreatCategory[] = ['Advertising'];
const TELEMETRY: ThreatCategory[] = ['Telemetry/Analytics'];
const ADS_OR_TELEMETRY: ThreatCategory[] = ['Advertising', 'Telemetry/Analytics'];
const TELEMETRY_OR_ADS: ThreatCategory[] = ['Telemetry/Analytics', 'Advertising'];
const MALWARE: ThreatCategory[] = ['Malware/Phishing'];
/** Ad-shaped names on abuse TLDs: the verdict must be non-clean, either label. */
const NUISANCE_OR_MALWARE: ThreatCategory[] = [
  'Advertising',
  'Telemetry/Analytics',
  'Malware/Phishing',
];
const infra = (domain: string, note?: string): EvalCase => ({
  domain,
  expected: CLEAN,
  family: 'infra',
  note,
});
const consumer = (domain: string): EvalCase => ({ domain, expected: CLEAN, family: 'consumer' });
const device = (domain: string): EvalCase => ({ domain, expected: CLEAN, family: 'device' });
const ad = (domain: string): EvalCase => ({ domain, expected: AD, family: 'ad' });
const adOrTelemetry = (domain: string): EvalCase => ({
  domain,
  expected: ADS_OR_TELEMETRY,
  family: 'ad',
});
/** An ad network whose name gives a classifier nothing to work with. */
const adByListOnly = (domain: string, note: string): EvalCase => ({
  domain,
  expected: ADS_OR_TELEMETRY,
  family: 'ad',
  signal: 'list-dependent',
  note,
});
const telemetry = (domain: string, note?: string): EvalCase => ({
  domain,
  expected: TELEMETRY,
  family: 'telemetry',
  note,
});
const telemetryOrAd = (domain: string, note?: string): EvalCase => ({
  domain,
  expected: TELEMETRY_OR_ADS,
  family: 'telemetry',
  note,
});
/** A measurement service whose name gives a classifier nothing to work with. */
const telemetryByListOnly = (domain: string, note: string): EvalCase => ({
  domain,
  expected: TELEMETRY,
  family: 'telemetry',
  signal: 'list-dependent',
  note,
});
const malware = (domain: string, note: string): EvalCase => ({
  domain,
  expected: MALWARE,
  family: 'malware',
  note,
});
const dga = (domain: string, note: string): EvalCase => ({
  domain,
  expected: NUISANCE_OR_MALWARE,
  family: 'dga',
  note,
});

export const EVAL_CORPUS: EvalCase[] = [
  // ─── Verified infrastructure (must never be flagged) ───────────────────────
  infra('d111111abcdef8.cloudfront.net'),
  infra('d2c8vfjl1f.execute-api.us-east-2.amazonaws.com'),
  infra('bucket-name.s3.us-east-1.amazonaws.com'),
  infra('on.aws', 'AWS-owned gTLD space'),
  infra('lgn5pbvv--prod.lambda-url.us-east-1.on.aws'),
  infra('akamai.external.web.us-east-1.prod.diagnostic.networking.aws.dev', 'previously a false positive'),
  infra('a104-118-1-1.deploy.static.akamaitechnologies.com'),
  infra('e1234.dscx.akamaiedge.net'),
  infra('microsoft.akamaized.net', 'vendor name as a label on another vendor zone'),
  infra('apple.akamaized.net'),
  infra('my-project-12345.firebaseapp.com'),
  infra('some-app-name.up.railway.app'),
  infra('myapp.herokuapp.com'),
  infra('acme-v02.api.letsencrypt.org'),
  infra('x1.c.lencr.org'),
  infra('ocsp.digicert.com'),
  infra('ocsp.pki.goog'),
  infra('time.nist.gov'),
  infra('0.pool.ntp.org'),
  infra('dns.google'),
  infra('one.one.one.one'),
  infra('dns.quad9.net'),
  infra('cdn.jsdelivr.net'),
  infra('unpkg.com'),
  infra('fonts.gstatic.com'),
  infra('www.googleapis.com'),
  infra('storage.googleapis.com'),
  infra('lh3.googleusercontent.com'),
  infra('login.microsoftonline.com'),
  infra('graph.microsoft.com'),
  infra('blob.core.windows.net'),
  infra('waws-prod-blu-179.eastus.cloudapp.azure.com'),
  infra('onedscolprdcus09.centralus.cloudapp.azure.com'),
  infra('detectportal.firefox.com'),
  infra('www.msftconnecttest.com'),
  infra('captive.apple.com'),
  infra('connectivitycheck.gstatic.com'),
  infra('status.cursor.com', 'previously flagged via the s-t-a-t substring'),
  infra('api.github.com'),
  infra('objects.githubusercontent.com'),
  infra('registry.npmjs.org'),
  infra('production.cloudflare.docker.com'),
  infra('mirrors.edge.kernel.org'),
  infra('security.ubuntu.com'),
  infra('deb.debian.org'),

  // ─── Institutional / government / academic ─────────────────────────────────
  infra('nih.gov'),
  infra('cdc.gov'),
  infra('who.int'),
  infra('weather.gov'),
  infra('stats.bls.gov'),
  infra('service.transport.gov.in'),
  infra('canada.gc.ca'),
  infra('europa.eu'),
  infra('mit.edu'),
  infra('ox.ac.uk'),
  infra('stats.stanford.edu'),
  infra('acm.org'),
  infra('ietf.org'),
  infra('www.w3.org'),

  // ─── Ordinary websites and services ────────────────────────────────────────
  consumer('wikipedia.org'),
  consumer('wikimedia.org'),
  consumer('mozilla.org'),
  consumer('archive.org'),
  consumer('python.org'),
  consumer('postgresql.org'),
  consumer('nginx.org'),
  consumer('amazon.com'),
  consumer('ebay.com'),
  consumer('etsy.com'),
  consumer('shopify.com'),
  consumer('stripe.com'),
  consumer('paypal.com'),
  consumer('booking.com'),
  consumer('expedia.com'),
  consumer('airbnb.com'),
  consumer('uber.com'),
  consumer('lyft.com'),
  consumer('doordash.com'),
  consumer('instacart.com'),
  consumer('reddit.com'),
  consumer('stackoverflow.com'),
  consumer('medium.com'),
  consumer('substack.com'),
  consumer('notion.so'),
  consumer('figma.com'),
  consumer('slack.com'),
  consumer('zoom.us'),
  consumer('dropbox.com'),
  consumer('spotify.com'),
  consumer('netflix.com'),
  consumer('twitch.tv'),
  consumer('youtube.com'),
  consumer('nytimes.com'),
  consumer('bbc.co.uk'),
  consumer('theguardian.com'),
  consumer('reuters.com'),
  consumer('apnews.com'),
  consumer('weather.com'),
  consumer('espn.com'),
  consumer('nba.com'),
  consumer('mayoclinic.org'),
  consumer('zillow.com'),
  consumer('indeed.com'),
  consumer('coursera.org'),
  consumer('khanacademy.org'),
  consumer('duolingo.com'),
  consumer('github.com'),
  consumer('gitlab.com'),
  consumer('openstreetmap.org'),
  consumer('flightaware.com'),

  // ─── Device and IoT vendor services ────────────────────────────────────────
  device('diag.meethue.com'),
  device('bridge.meethue.com'),
  device('device.tplinkcloud.com'),
  device('api.smartthings.com'),
  device('mqtt.ecobee.com'),
  device('api.rach.io'),
  device('devices.sonos.com'),
  device('api.ring.com'),

  // ─── Advertising ───────────────────────────────────────────────────────────
  ad('ad.doubleclick.net'),
  ad('securepubads.g.doubleclick.net'),
  ad('googleads.g.doubleclick.net'),
  ad('pagead2.googlesyndication.com'),
  ad('partner.googleadservices.com'),
  ad('www.googleadservices.com'),
  ad('px.ads.linkedin.com'),
  ad('amazon-adsystem.com'),
  ad('adsrvr.org'),
  ad('adnxs.com'),
  adOrTelemetry('criteo.com'),
  adOrTelemetry('taboola.com'),
  adOrTelemetry('outbrain.com'),
  adOrTelemetry('pubmatic.com'),
  adOrTelemetry('rubiconproject.com'),
  adOrTelemetry('openx.net'),
  adOrTelemetry('casalemedia.com'),
  adOrTelemetry('sharethrough.com'),
  adOrTelemetry('media.net'),
  adOrTelemetry('adform.net'),
  adOrTelemetry('smartadserver.com'),
  adOrTelemetry('teads.tv'),
  adOrTelemetry('bidswitch.net'),
  adByListOnly('33across.com', 'company name carries no ad token'),
  adOrTelemetry('adroll.com'),
  adOrTelemetry('inmobi.com'),
  adOrTelemetry('applovin.com'),
  adOrTelemetry('chartboost.com'),
  adOrTelemetry('vungle.com'),
  adOrTelemetry('adcolony.com'),
  adOrTelemetry('adsterra.com'),
  adOrTelemetry('propellerads.com'),
  adOrTelemetry('exoclick.com'),
  adOrTelemetry('sovrn.com'),
  adOrTelemetry('ezoic.com'),
  adOrTelemetry('mediavine.com'),

  // ─── Measurement, analytics, and attribution ───────────────────────────────
  telemetry('ssl.google-analytics.com'),
  telemetryOrAd('www.googletagmanager.com'),
  telemetry('analytics.tiktok.com'),
  telemetryOrAd('connect.facebook.net'),
  telemetry('analytics.twitter.com', 'measurement label inside a safelisted vendor zone'),
  telemetryByListOnly('bat.bing.com', 'Bing UET tag host; no lexical signal'),
  telemetryByListOnly('clarity.ms', 'Microsoft Clarity; no lexical signal'),
  telemetry('tr.snapchat.com', 'tracker abbreviation'),
  telemetryByListOnly('ct.pinterest.com', 'Pinterest click tracker abbreviation'),
  telemetry('px.ads.linkedin.com'),
  telemetry('scorecardresearch.com'),
  telemetry('pixel.quantserve.com'),
  telemetry('chartbeat.com'),
  telemetryByListOnly('comscore.com', 'measurement company whose own name carries no signal'),
  telemetry('parsely.com'),
  telemetry('segment.io'),
  telemetry('api.mixpanel.com'),
  telemetry('api.amplitude.com'),
  telemetry('heap.io'),
  telemetry('static.hotjar.com'),
  telemetry('fullstory.com'),
  telemetryByListOnly('browser.sentry-cdn.com', 'error-reporting CDN; no lexical signal'),
  telemetry('optimizely.com'),
  telemetry('visualwebsiteoptimizer.com'),
  telemetry('crazyegg.com'),
  telemetry('luckyorange.com'),
  telemetry('static.clicky.com'),
  telemetry('statcounter.com'),
  telemetry('app.adjust.com'),
  telemetry('app.appsflyer.com'),
  telemetry('api.branch.io'),
  telemetry('kochava.com'),
  telemetry('onesignal.com'),
  telemetry('api.braze.com'),

  // ─── Phishing / credential harvesting (constructed to published patterns) ──
  malware('paypa1-security.com', 'leet-substituted brand plus a security lure'),
  malware('apple-id-verify-login.xyz', 'brand plus account-verification lure on an abuse TLD'),
  malware('paypal-login.azurewebsites.net', 'brand impersonation hosted on free cloud hosting'),
  malware('fedex-delivery-reschedule.xyz', 'delivery lure'),
  malware('citibank-online-verify.com', 'banking lure'),
  malware('ledger-device-validate.xyz', 'crypto hardware-wallet lure'),
  malware('office365-verify-account.com', 'account-verification lure'),
  malware('usps-tracking-package.com', 'delivery lure'),
  malware('metamask-seed-phrase.xyz', 'seed-phrase lure'),
  malware('xn--pple-43d.com', 'IDN homograph of apple.com'),
  malware('xn--pypal-4ve.com', 'IDN homograph of paypal.com'),

  // ─── Machine-generated names ───────────────────────────────────────────────
  dga('zq97kx24bwa-bot.xyz', 'random consonant/digit run on an abuse TLD'),
  dga('xq97kz24bwamzq.xyz', 'no vowel structure'),
  dga('vbnmqwrtplkjhfga.xyz', 'keyboard-adjacent sequence'),
  dga('8f3a9c1e7b2d4f6a.xyz', 'hex-shaped labels'),
  dga('qwrtypsdfghjklzxcvbn.top', 'abuse TLD with a consonant run'),
  dga('n4k7x2p9qw8.top', 'digit-heavy random name'),
];

/**
 * Explicit negatives that must never appear in a block recommendation, regardless
 * of how the category is graded. These are the domains whose false positives cost
 * real users the most, so they are asserted separately from the aggregate score.
 */
export const CRITICAL_NEGATIVES: string[] = [
  'amazon.com',
  'paypal.com',
  'github.com',
  'microsoft.com',
  'google.com',
  'apple.com',
  'cloudflare.com',
  'wikipedia.org',
  'login.microsoftonline.com',
  'status.cursor.com',
  'diag.meethue.com',
  'nih.gov',
  'mit.edu',
  'akamai.external.web.us-east-1.prod.diagnostic.networking.aws.dev',
];

export function casesByFamily(family: EvalFamily): EvalCase[] {
  return EVAL_CORPUS.filter((entry) => entry.family === family);
}

/** True when the hostname itself carries the evidence a classifier can see. */
export function isLexicalCase(entry: EvalCase): boolean {
  if (entry.expected.includes('Clean')) return true;
  return (entry.signal ?? 'lexical') === 'lexical';
}
