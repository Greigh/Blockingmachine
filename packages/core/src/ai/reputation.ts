import { calculateShannonEntropy, decomposeDomain } from './entropy.js';
import type { ThreatCategory } from './types.js';

/**
 * Registrable-domain and hostname-suffix reputation for the embedded classifier.
 * Suffix groups are the maintenance point: add a parent zone, not one-off hosts.
 * @beta
 */

export const HIGH_ABUSE_TLDS = new Set([
  'top', 'xyz', 'buzz', 'click', 'fit', 'rest', 'tk', 'cf', 'gq', 'ml', 'ga',
  'work', 'cam', 'surf', 'loan', 'racing', 'icu', 'gdn', 'vip', 'monster',
]);

/** Delimited ad-tech tokens. Short or generic words match only on label boundaries. */
export const SUSPICIOUS_AD_TOKENS = [
  'ad', 'ads', 'adserver', 'adservice', 'adnxs', 'adform', 'adtech',
  'doubleclick', 'googleadservices', 'googlesyndication', 'moatads', 'amazon-adsystem',
  'bid', 'bidder', 'bidding', 'rtb', 'dsp', 'ssp',
  'popunder', 'popcash', 'propeller', 'propellerads', 'outbrain', 'taboola', 'mgid',
  'revcontent', 'criteo', 'pubmatic', 'rubiconproject', 'openx', 'casalemedia', 'smartadserver',
  'adsystem', 'adtrack', 'advert', 'advertising', 'adzerk', 'adblade',
] as const;

/**
 * Tracker tokens. `stat` is intentionally absent: it is a prefix of `status`
 * and was matching product status hosts.
 */
export const SUSPICIOUS_TRACKER_TOKENS = [
  'pixel', 'beacon', 'collect', 'telemetry', 'analytics', 'tracker', 'tracking',
  'click', 'conversion', 'attribution', 'affiliate', 'stats', 'counter',
  'scorecardresearch', 'quantserve', 'branch', 'appsflyer', 'adjust', 'mixpanel',
  'segment', 'amplitude', 'sentry', 'datadoghq', 'hotjar', 'fullstory',
  'clarity', 'mouseflow', 'optimizely', 'newrelic', 'heapanalytics',
  'googleanalytics', 'google-analytics', 'googletagmanager', 'googletagservices',
] as const;

/** One hit on these names is enough to call a host an ad or tracker network. */
export const SPECIFIC_NETWORK_TOKENS = new Set<string>([
  'taboola', 'criteo', 'doubleclick', 'googleadservices', 'googlesyndication',
  'outbrain', 'moatads', 'adnxs', 'rubiconproject', 'pubmatic',
  'scorecardresearch', 'quantserve', 'googleanalytics', 'google-analytics',
  'googletagmanager', 'googletagservices', 'amazon-adsystem', 'adform',
  'casalemedia', 'smartadserver', 'propellerads', 'mgid', 'revcontent',
]);

const TELEMETRY_NAME_TOKENS = new Set<string>([
  'pixel', 'beacon', 'collect', 'telemetry', 'analytics', 'tracker', 'tracking',
  'scorecardresearch', 'quantserve', 'googleanalytics', 'google-analytics',
  'googletagmanager', 'googletagservices', 'mixpanel', 'segment', 'hotjar',
  'fullstory', 'mouseflow', 'optimizely', 'newrelic', 'sentry', 'amplitude',
  'appsflyer', 'branch', 'adjust',
]);

const AD_INTENT_LABELS = new Set([
  'ad', 'ads', 'adserver', 'adservice', 'pagead', 'doubleclick', 'banner',
  'popunder', 'preroll', 'sponsor', 'sponsors', 'adtech',
]);

const STRONG_AD_TOKENS = [
  'doubleclick', 'googleadservices', 'googlesyndication', 'adnxs',
  'criteo', 'taboola', 'outbrain', 'pubmatic', 'rubiconproject', 'moatads',
  'amazon-adsystem', 'adform', 'casalemedia', 'smartadserver', 'propellerads',
  'popunder', 'popcash', '2mdn',
] as const;

const HIGH_PROFILE_BRANDS = [
  'paypal', 'google', 'apple', 'microsoft', 'amazon', 'netflix', 'github',
  'chase', 'bankofamerica', 'wellsfargo', 'facebook', 'instagram', 'dropbox',
  'coinbase', 'binance', 'steam', 'twitter', 'discord', 'roblox',
] as const;

const PHISH_KEYWORDS = /login|verify|security|auth|update|account|support|wallet|token|claim|signin|password|secure|unlock|billing/;

const BENIGN_ENDPOINT_LABELS = new Set([
  'status', 'statuspage', 'uptime', 'health', 'healthz',
  'api', 'apis', 'cdn', 'static', 'assets',
  'update', 'updates', 'download', 'downloads', 'swupdate', 'firmware',
  'ocsp', 'crl', 'ntp', 'time', 'diag', 'diagnostics', 'setup',
]);

const STRUCTURAL_SLD_WORDS = new Set([
  'customer', 'prod', 'production', 'staging', 'stage', 'dev', 'edge', 'cdn',
  'api', 'status', 'update', 'static', 'assets', 'media', 'origin', 'cache',
  'node', 'region', 'central', 'east', 'west', 'north', 'south', 'internal',
  'service', 'services', 'app', 'apps', 'cloud', 'compute', 'storage', 'blob',
  'queue', 'gateway', 'proxy', 'device', 'devices', 'hub', 'home', 'diag',
  'diagnostics', 'firmware', 'config', 'setup', 'sync', 'backup', 'download',
  'portal', 'admin', 'mail', 'smtp', 'vpn', 'remote', 'img', 'images', 'video',
  'stream', 'push', 'notify', 'mqtt', 'azure', 'amazon', 'google', 'windows',
  'content', 'delivery', 'network',
]);

export type InfraKind =
  | 'ad-network'
  | 'tracker-network'
  | 'cloud'
  | 'cdn'
  | 'iot'
  | 'vendor'
  | 'platform'
  | 'dns'
  | 'none';

export interface InfraClassification {
  safe: boolean;
  adNetwork: boolean;
  kind: InfraKind;
  suffix?: string;
  reason: string;
}

export interface ReputationFeatures {
  brandSpoofScore: number;
  knownSafeInfra: number;
  adKeywordWeight: number;
  trackerKeywordWeight: number;
  trigramPerplexity: number;
  entropySld: number;
  sldLength: number;
  highRiskTld: number;
  punycode: number;
  consecutiveConsonants: number;
  vowelRatio: number;
}

export interface CategoryAdjustment {
  category: ThreatCategory;
  probability: number;
  policyReason?: string;
}

interface SuffixGroup {
  kind: InfraKind;
  reason: (suffix: string) => string;
  suffixes: readonly string[];
}

const AD_NETWORK_SUFFIXES = [
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  '2mdn.net',
  'adnxs.com',
  'adnxs.net',
  'adsrvr.org',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'pubmatic.com',
  'rubiconproject.com',
  'casalemedia.com',
  'openx.net',
  'openx.com',
  'smartadserver.com',
  'moatads.com',
  'adform.net',
  'adform.com',
  'mgid.com',
  'revcontent.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'serving-sys.com',
  'adsafeprotected.com',
  'doubleverify.com',
  'teads.tv',
  'sharethrough.com',
  'contextweb.com',
  'bidswitch.net',
  'rlcdn.com',
  'adservice.google.com',
  'ads.google.com',
  'pagead2.googlesyndication.com',
] as const;

const TRACKER_NETWORK_SUFFIXES = [
  'google-analytics.com',
  'googleanalytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'analytics.google.com',
  'scorecardresearch.com',
  'quantserve.com',
  'branch.io',
  'app.link',
  'appsflyer.com',
  'adjust.com',
  'adjust.io',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'sentry.io',
  'nr-data.net',
  'newrelic.com',
  'optimizely.com',
  'chartbeat.com',
  'chartbeat.net',
  'demdex.net',
  'omtrdc.net',
  'everesttech.net',
  'bluekai.com',
  'krxd.net',
  'agkn.com',
  'tapad.com',
  'exelator.com',
  'connect.facebook.net',
  'facebook.net',
] as const;

const CLOUD_SUFFIXES = [
  // Microsoft Azure and Microsoft 365 service fabric
  'azure.com', 'azure.net', 'azureedge.net', 'azurefd.net', 'azure-api.net',
  'azurewebsites.net', 'azurecontainer.io', 'azurecr.io', 'azurestaticapps.net',
  'azure-devices.net', 'azure-automation.net', 'cloudapp.net', 'windows.net',
  'windowsazure.com', 'trafficmanager.net', 'msecnd.net', 'service.signalr.net',
  'microsoft.com', 'microsoftonline.com', 'live.com', 'office.com', 'office.net',
  'office365.com', 'sharepoint.com', 'outlook.com', 'skype.com', 'bing.com',
  'msn.com', 'windows.com', 'windowsupdate.com', 'microsoftstore.com',
  'msedge.net', 's-microsoft.com', 'msftconnecttest.com', 'msftncsi.com',
  'visualstudio.com', 'gfx.ms',
  // Amazon Web Services
  'amazonaws.com', 'amazon.com', 'cloudfront.net', 'awsstatic.com',
  'amazontrust.com', 'a2z.com', 'media-amazon.com', 'ssl-images-amazon.com',
  'amazonvideo.com', 'primevideo.com',
  // Google Cloud and Google service endpoints
  'googleapis.com', 'google.com', 'gstatic.com', 'googleusercontent.com',
  'gvt1.com', 'gvt2.com', 'gvt3.com', '1e100.net', 'appspot.com',
  'googlehosted.com', 'withgoogle.com', 'googlezip.net', 'ggpht.com',
  'gmail.com', 'youtube.com', 'ytimg.com', 'googlevideo.com', 'android.com',
  'chromium.org', 'blogger.com', 'gcr.io', 'pkg.dev', 'cloudfunctions.net',
  'run.app', 'firebaseio.com', 'firebaseapp.com', 'web.app',
] as const;

const CDN_SUFFIXES = [
  'cloudflare.com', 'cloudflare.net', 'cloudflare-dns.com',
  'fastly.net', 'fastlylb.net',
  'akamai.net', 'akamaized.net', 'akamaihd.net', 'akamaiedge.net',
  'edgekey.net', 'edgesuite.net', 'akamai.com',
  'jsdelivr.net', 'unpkg.com', 'bootstrapcdn.com', 'fontawesome.com', 'jquery.com',
  'stackpathcdn.com',
] as const;

const IOT_SUFFIXES = [
  'meethue.com', 'philips-hue.com', 'philips.com', 'signify.com',
  'nest.com', 'dropcam.com', 'ring.com', 'ecobee.com',
  'wyze.com', 'wyzecam.com', 'tplinkcloud.com', 'tplinkra.com', 'tp-link.com',
  'kasasmart.com', 'tuya.com', 'tuyaus.com', 'tuyaeu.com', 'tuyacn.com',
  'smartthings.com', 'smartthingscloud.com', 'samsung.com', 'samsungcloud.com',
  'samsungiotcloud.com', 'lg.com', 'lge.com', 'lgthinq.com', 'lgsmartthinq.com',
  'sonos.com', 'irobot.com', 'arlo.com', 'arlocloud.com', 'eufylife.com', 'eufy.com',
  'blinkforhome.com', 'immedia-semi.com', 'august.com', 'yalehome.com', 'schlage.com',
  'honeywell.com', 'resideo.com', 'lutron.com', 'leviton.com', 'control4.com',
  'lifx.co', 'nanoleaf.me', 'govee.com', 'meross.com', 'shelly.cloud',
  'aqara.com', 'xiaomi.com', 'mi.com', 'mijia.com',
  'home-assistant.io', 'nabucasa.com', 'nuki.io',
  'bosch-smarthome.com', 'home-connect.com', 'myqdevice.com', 'chamberlain.com',
  'simplisafe.com', 'wink.com', 'insteon.com', 'logitech.com',
] as const;

const VENDOR_SUFFIXES = [
  'cursor.com', 'cursor.sh',
  'github.com', 'githubassets.com', 'githubusercontent.com',
  'gitlab.com', 'bitbucket.org', 'atlassian.com', 'atlassian.net',
  'slack.com', 'slack-edge.com', 'notion.so', 'notion.site', 'notion.com',
  'linear.app', 'figma.com',
  'dropbox.com', 'dropboxapi.com', 'dropboxusercontent.com',
  'zoom.us', 'zoom.com',
  'adobe.com', 'adobecc.com', 'adobelogin.com',
  'apple.com', 'apple-cloudkit.com', 'apple-dns.net', 'cdn-apple.com',
  'icloud.com', 'mzstatic.com', 'aaplimg.com', 'apple-mapkit.com',
  'mozilla.org', 'mozilla.com', 'mozilla.net', 'firefox.com',
  'spotify.com', 'scdn.co',
  'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net',
  'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
  'reddit.com', 'redditstatic.com', 'redd.it',
  'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com',
  'wikipedia.org', 'wikimedia.org',
  'openai.com', 'oaistatic.com', 'anthropic.com',
  'paypal.com', 'paypalobjects.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'coinbase.com', 'binance.com',
  'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
  'twitter.com', 'x.com', 'twimg.com',
  'roblox.com',
] as const;

const PLATFORM_SUFFIXES = [
  'github.io', 'herokuapp.com', 'herokussl.com', 'netlify.app', 'vercel.app',
  'pages.dev', 'workers.dev', 'r2.dev', 'digitalocean.com',
  'digitaloceanspaces.com', 'ondigitalocean.com',
] as const;

const DNS_SUFFIXES = [
  'one.one.one.one', 'dns.google', 'quad9.net',
] as const;

const SUFFIX_GROUPS: readonly SuffixGroup[] = [
  {
    kind: 'cloud',
    reason: (suffix) => `Known cloud platform endpoint (${suffix}); hostname shape is not treated as malware`,
    suffixes: CLOUD_SUFFIXES,
  },
  {
    kind: 'cdn',
    reason: (suffix) => `Known content delivery network (${suffix})`,
    suffixes: CDN_SUFFIXES,
  },
  {
    kind: 'iot',
    reason: (suffix) => `Known device vendor infrastructure (${suffix})`,
    suffixes: IOT_SUFFIXES,
  },
  {
    kind: 'vendor',
    reason: (suffix) => `Known product or vendor service endpoint (${suffix})`,
    suffixes: VENDOR_SUFFIXES,
  },
  {
    kind: 'platform',
    reason: (suffix) => `Known application platform endpoint (${suffix})`,
    suffixes: PLATFORM_SUFFIXES,
  },
  {
    kind: 'dns',
    reason: (suffix) => `Known public DNS or connectivity endpoint (${suffix})`,
    suffixes: DNS_SUFFIXES,
  },
];

function buildSuffixIndex(suffixes: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const suffix of suffixes) {
    const labels = suffix.split('.');
    const keys = labels.slice(0, -1);
    for (const key of keys) {
      const existing = index.get(key);
      if (existing) {
        if (!existing.includes(suffix)) existing.push(suffix);
      } else {
        index.set(key, [suffix]);
      }
    }
  }
  return index;
}

const AD_INDEX = buildSuffixIndex(AD_NETWORK_SUFFIXES);
const TRACKER_INDEX = buildSuffixIndex(TRACKER_NETWORK_SUFFIXES);
const SAFE_INDEXES = SUFFIX_GROUPS.map((group) => ({
  group,
  index: buildSuffixIndex(group.suffixes),
}));

export function normalizeHostname(input: string): string {
  let clean = input.trim().toLowerCase();
  clean = clean.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  clean = clean.split('/')[0]?.split('?')[0]?.split('#')[0] ?? clean;
  clean = clean.split(':')[0] ?? clean;
  clean = clean.replace(/^\.+|\.+$/g, '');
  if (clean.endsWith('.')) clean = clean.slice(0, -1);
  return clean;
}

function matchIndexed(hostname: string, index: Map<string, string[]>): string | undefined {
  const labels = hostname.split('.');
  let best: string | undefined;
  for (const label of labels) {
    const candidates = index.get(label);
    if (!candidates) continue;
    for (const suffix of candidates) {
      if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
        if (!best || suffix.length > best.length) best = suffix;
      }
    }
  }
  return best;
}

export function classifyInfrastructure(domain: string): InfraClassification {
  const clean = normalizeHostname(domain);
  if (!clean) {
    return { safe: false, adNetwork: false, kind: 'none', reason: '' };
  }

  const adSuffix = matchIndexed(clean, AD_INDEX);
  if (adSuffix) {
    return {
      safe: false,
      adNetwork: true,
      kind: 'ad-network',
      suffix: adSuffix,
      reason: `Known advertising network (${adSuffix})`,
    };
  }

  const trackerSuffix = matchIndexed(clean, TRACKER_INDEX);
  if (trackerSuffix) {
    return {
      safe: false,
      adNetwork: false,
      kind: 'tracker-network',
      suffix: trackerSuffix,
      reason: `Known tracker or analytics network (${trackerSuffix})`,
    };
  }

  let best: { suffix: string; kind: InfraKind; reason: string } | undefined;
  for (const { group, index } of SAFE_INDEXES) {
    const suffix = matchIndexed(clean, index);
    if (!suffix) continue;
    if (!best || suffix.length > best.suffix.length) {
      best = { suffix, kind: group.kind, reason: group.reason(suffix) };
    }
  }

  if (best) {
    return {
      safe: true,
      adNetwork: false,
      kind: best.kind,
      suffix: best.suffix,
      reason: best.reason,
    };
  }

  return { safe: false, adNetwork: false, kind: 'none', reason: '' };
}

/**
 * Token match on label boundaries (dot or hyphen). Long network names also
 * match when concatenated inside a label (`googleanalytics`).
 */
const tokenRegexCache = new Map<string, RegExp>();

function boundaryRegex(token: string): RegExp {
  const cached = tokenRegexCache.get(token);
  if (cached) return cached;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compiled = new RegExp(`(?:^|[.\\-])${escaped}(?:[.\\-]|$)`, 'i');
  tokenRegexCache.set(token, compiled);
  return compiled;
}

export function hostnameHasToken(hostname: string, token: string): boolean {
  const host = normalizeHostname(hostname);
  const needle = token.toLowerCase();
  if (!host || !needle) return false;
  if (boundaryRegex(needle).test(host)) return true;
  if (needle.length >= 11) return host.includes(needle);
  return false;
}

export function hasStrongAdIntent(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean) return false;
  const labels = clean.split('.');
  for (const label of labels) {
    if (AD_INTENT_LABELS.has(label)) return true;
    for (const part of label.split('-')) {
      if (AD_INTENT_LABELS.has(part)) return true;
    }
  }
  return STRONG_AD_TOKENS.some((token) => hostnameHasToken(clean, token));
}

export function isTelemetryToken(token: string): boolean {
  return TELEMETRY_NAME_TOKENS.has(token.toLowerCase());
}

function computeLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return Math.abs(m - n);
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array<number>(n + 1);
  let currRow = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + cost);
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[n];
}

function isTypoSquat(token: string, brand: string): boolean {
  if (!token || token === brand) return false;
  if (Math.abs(token.length - brand.length) > 2) return false;
  const dist = computeLevenshtein(token, brand);
  if (dist <= 0 || dist > 2) return false;
  if (/\d/.test(token) && (dist === 1 || (brand.length >= 6 && dist === 2))) return true;
  if (dist === 1 && brand.length >= 7) return true;
  return false;
}

/**
 * Brand impersonation score.
 * The real brand on a non-abusive TLD is not a spoof (`paypal.com`, `login.github.com`).
 * A brand plus a credential lure on some other zone is (`paypal-login.azurewebsites.net`).
 */
export function scoreBrandSpoof(domain: string): number {
  const clean = normalizeHostname(domain);
  if (!clean || !clean.includes('.')) return 0;
  const decomposition = decomposeDomain(clean);
  const sld = decomposition.sld.toLowerCase();
  const tld = decomposition.tld.toLowerCase();
  const abuseTld = HIGH_ABUSE_TLDS.has(tld);
  const labels = clean.split('.').filter(Boolean);

  for (const brand of HIGH_PROFILE_BRANDS) {
    const registrableIsBrand = sld === brand;
    if (registrableIsBrand && !abuseTld && !clean.includes('xn--')) continue;
    if (registrableIsBrand && (abuseTld || clean.includes('xn--'))) return 1;

    // The final label is the TLD (`dns.google`), not an impersonation subdomain.
    for (const label of labels.slice(0, -1)) {
      const tokens = label.split(/[-_]/).filter(Boolean);
      const candidates = tokens.length > 1 ? [label, ...tokens] : [label];
      for (const tok of candidates) {
        if (tok === brand && !registrableIsBrand && (label === brand || PHISH_KEYWORDS.test(label))) {
          return 1;
        }
        if (isTypoSquat(tok, brand)) return 1;
      }
      if (label.includes(brand) && label !== brand && PHISH_KEYWORDS.test(label)) return 1;
    }
  }
  return 0;
}

export function isBenignServiceEndpoint(domain: string): boolean {
  const clean = normalizeHostname(domain);
  if (!clean || clean.includes('xn--')) return false;
  const infra = classifyInfrastructure(clean);
  if (infra.adNetwork || infra.kind === 'tracker-network') return false;
  if (hasStrongAdIntent(clean)) return false;
  if (scoreBrandSpoof(clean) > 0) return false;
  if (SUSPICIOUS_AD_TOKENS.some((token) => hostnameHasToken(clean, token))) return false;
  if (SUSPICIOUS_TRACKER_TOKENS.some((token) => hostnameHasToken(clean, token))) return false;

  const labels = clean.split('.').filter(Boolean);
  if (!labels.some((label) => BENIGN_ENDPOINT_LABELS.has(label))) return false;

  const decomposition = decomposeDomain(clean);
  if (HIGH_ABUSE_TLDS.has(decomposition.tld)) return false;

  const compact = decomposition.sld.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact.length >= 10) {
    const entropy = calculateShannonEntropy(compact);
    const digits = (compact.match(/\d/g) || []).length / compact.length;
    const vowels = (compact.match(/[aeiou]/g) || []).length / Math.max(1, compact.replace(/\d/g, '').length);
    if (entropy >= 3.3 && digits >= 0.15 && vowels < 0.28) return false;
  }
  return true;
}

function sldLooksStructural(sld: string): boolean {
  const parts = sld.toLowerCase().split(/[-_]/).filter(Boolean);
  return parts.some((part) => STRUCTURAL_SLD_WORDS.has(part));
}

/**
 * Malware requires a second, independent signal.
 * A random-looking cloud label or a readable parent zone is not enough.
 */
export function hasCorroboratedMalwareSignals(domain: string, features: ReputationFeatures): boolean {
  if (features.brandSpoofScore > 0) return true;
  if (features.punycode > 0 && (features.highRiskTld > 0 || features.brandSpoofScore > 0)) return true;

  const sld = decomposeDomain(normalizeHostname(domain)).sld.toLowerCase();
  if (!sld || sldLooksStructural(sld)) return false;

  const compact = sld.replace(/[^a-z0-9]/g, '');
  const sldLong = compact.length >= 10;
  const sldDga = sldLong && features.trigramPerplexity >= 0.8 && features.entropySld >= 0.4;
  if (!sldDga) return false;
  return features.highRiskTld > 0;
}

/**
 * Maps a raw model winner onto a verdict policy:
 * known networks stay threats, known infrastructure stays clean,
 * and malware requires corroborated evidence.
 */
export function adjustThreatCategory(
  domain: string,
  features: ReputationFeatures,
  category: ThreatCategory,
  probability: number,
  options?: { knownTrackerCname?: boolean; allowlisted?: boolean },
): CategoryAdjustment {
  if (options?.allowlisted) {
    return {
      category: 'Clean',
      probability: 0.99,
      policyReason: 'Verified Essential Infrastructure / Whitelisted (Protected by False Positive Guard)',
    };
  }

  const infra = classifyInfrastructure(domain);
  const adIntent = hasStrongAdIntent(domain);

  if (features.brandSpoofScore > 0) {
    return {
      category: 'Malware/Phishing',
      probability: Math.max(probability, 0.9),
      policyReason: 'Brand impersonation or typo-squatting credential harvesting pattern detected',
    };
  }

  if (options?.knownTrackerCname) {
    return {
      category: 'CNAME Cloaking',
      probability: Math.max(probability, 0.9),
    };
  }

  if (infra.kind === 'ad-network' || adIntent) {
    return {
      category: 'Advertising',
      probability: Math.max(probability, 0.9),
      policyReason: infra.reason || 'Advertising network token in hostname',
    };
  }

  if (infra.kind === 'tracker-network') {
    return {
      category: 'Telemetry/Analytics',
      probability: Math.max(probability, 0.86),
      policyReason: infra.reason,
    };
  }

  if (infra.safe || features.knownSafeInfra > 0) {
    return {
      category: 'Clean',
      probability: 0.99,
      policyReason: infra.reason || 'Verified essential infrastructure or user allowlist',
    };
  }

  if (isBenignServiceEndpoint(domain)) {
    return {
      category: 'Clean',
      probability: 0.86,
      policyReason: 'Product status, API, CDN, or update endpoint on a readable domain',
    };
  }

  if (category === 'Malware/Phishing' && !hasCorroboratedMalwareSignals(domain, features)) {
    if (features.adKeywordWeight >= 0.9) {
      return { category: 'Advertising', probability: Math.max(probability, 0.8) };
    }
    if (features.adKeywordWeight >= 0.5) {
      return { category: 'Advertising', probability };
    }
    if (features.trackerKeywordWeight >= 0.9) {
      return { category: 'Telemetry/Analytics', probability: Math.max(probability, 0.8) };
    }
    if (features.trackerKeywordWeight >= 0.5) {
      return {
        category: 'Telemetry/Analytics',
        probability: Math.min(probability, 0.62),
        policyReason: 'Weak telemetry token without a known tracking network',
      };
    }

    const sldRandom = features.trigramPerplexity >= 0.85
      && features.entropySld >= 0.45
      && features.sldLength >= 0.28
      && features.highRiskTld <= 0;
    if (sldRandom) {
      return {
        category: 'Unknown',
        probability: 0.42,
        policyReason: 'Unusual lexical shape without corroborating malicious evidence',
      };
    }
    return {
      category: 'Clean',
      probability: 0.74,
      policyReason: 'No ad, tracker, or corroborated malware signals',
    };
  }

  return { category, probability };
}

/** Confidence is already on a 0–100 scale. Clamp so the UI cannot render above 100%. */
export function clampConfidencePercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatConfidencePercent(value: number | null | undefined): string {
  return `${clampConfidencePercent(value)}%`;
}

export function verdictBadgeLabel(verdict: string): string {
  switch (verdict) {
    case 'ad_server':
      return 'AD SERVER';
    case 'tracker':
      return 'TRACKER';
    case 'malicious':
      return 'MALWARE';
    case 'suspicious':
      return 'SUSPICIOUS';
    case 'clean':
      return 'CLEAN';
    default:
      return verdict.replace(/_/g, ' ').toUpperCase();
  }
}
