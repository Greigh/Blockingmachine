import { promises as dns } from 'node:dns';
import { normalizeHostname, trimTrailingDots } from './hostname.js';
import { decomposeDomain, DYNAMIC_DNS_SUFFIXES } from './entropy.js';
import { KNOWN_CLOAKED_TARGETS } from './cloakTargets.js';
import {
  classifyInfrastructure,
  detectAntiAdblock,
  getDbLists,
  hostnameHasToken,
  isSameBrandEcosystem,
} from './reputation.js';
import type { CnameResolutionResult } from './types.js';
export { KNOWN_CLOAKED_TARGETS } from './cloakTargets.js';


/**
 * Recognized non-tracker SaaS customer service, ticketing, authentication, status page,
 * headless CMS, documentation, transactional email, and hosting CNAME endpoints.
 * These are legitimate operational third-party aliases that must never be flagged as CNAME cloaking.
 */
export const BENIGN_SAAS_CNAMES: ReadonlySet<string> = new Set([
  // Customer Support, Helpdesks & Ticketing
  'zendesk.com', 'freshdesk.com', 'statuspage.io', 'intercom.help', 'intercom.io',
  'helpscout.net', 'helpscout.com', 'desk.com', 'uservoice.com', 'atlassian.net',
  'jira.com', 'confluence.cloud', 'salesforce.com', 'force.com', 'ladesk.com',
  'kayako.com', 'groovehq.com', 'kustomer.com', 'frontapp.com', 'crisp.chat',
  'gorgias.com', 'tawk.to', 'livechatinc.com', 'zopim.com', 'drift.com',
  'hubspot.com', 'service-now.com',

  // Status Pages & Incident Management
  'betteruptime.com', 'incident.io', 'status.io', 'statuspal.io', 'instatus.com',
  'pagerduty.com', 'hund.io', 'statuskit.com', 'sorryapp.com',

  // Documentation, Knowledge Bases & Headless CMS
  'readme.io', 'gitbook.io', 'gitbook.com', 'mintlify.app', 'mintlify.com',
  'notion.site', 'notion.so', 'docusaurus.io', 'helpjuice.com', 'archbee.io',
  'docsy.dev', 'ghost.io', 'ghost.org', 'substack.com', 'medium.com',
  'hashnode.network', 'hashnode.dev', 'super.so',

  // Website Builders & E-Commerce Storefronts
  'shopify.com', 'myshopify.com', 'bigcommerce.com', 'webflow.com', 'webflow.io',
  'squarespace.com', 'squarespace-cdn.com', 'wix.com', 'wixsite.com', 'framer.com',
  'framer.app', 'framer.website', 'carrd.co', 'unbounce.com', 'instapage.com',
  'leadpages.net', 'clickfunnels.com', 'kajabi.com', 'mykajabi.com', 'podia.com',
  'teachable.com', 'thinkific.com', 'gumroad.com', 'ecwid.com', 'woocommerce.com',

  // Cloud Hosting, PaaS & Serverless Functions
  'vercel.app', 'vercel-dns.com', 'netlify.app', 'netlify.com', 'pages.dev',
  'workers.dev', 'cloudflare.net', 'github.io', 'gitlab.io', 'fastly.net',
  'fastlylb.net', 'akamaiedge.net', 'akadns.net', 'cloudfront.net',
  'awsglobalaccelerator.com', 'azureedge.net', 'trafficmanager.net',
  'azurewebsites.net', 'cloudapp.net', 'appspot.com', 'herokuapp.com',
  'herokudns.com', 'fly.dev', 'railway.app', 'render.com', 'onrender.com',
  'kinsta.cloud', 'wpengine.com', 'pantheonsite.io', 'supabase.co',

  // Identity Providers & Enterprise SSO
  'okta.com', 'oktapreview.com', 'auth0.com', 'onelogin.com', 'pingidentity.com',
  'duosecurity.com', 'login.microsoftonline.com', 'cognito.amazonaws.com',
  'clerk.dev', 'clerk.accounts.dev', 'stytch.com', 'kinde.com', 'workos.com',

  // Transactional Email & Messaging Delivery
  'sendgrid.net', 'mailgun.org', 'postmarkapp.com', 'sparkpostmail.com',
  'smtp.com', 'mailchimp.com', 'mandrillapp.com', 'amazonses.com',
  'constantcontact.com', 'convertkit.com', 'klaviyo.com', 'brevo.com', 'sendinblue.com',

  // HR, Applicant Tracking & Job Portals
  'greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com', 'ashbyhq.com',
  'bamboohr.com', 'smartrecruiters.com', 'jobvite.com', 'workable.com',
  'jazzhr.com', 'recruitee.com', 'personio.com', 'breezy.hr',

  // Unified Communications & Scheduling
  'zoom.us', 'webex.com', 'slack.com', 'teams.microsoft.com', 'calendly.com',
  'cal.com', 'chilipiper.com', 'acuityscheduling.com', 'miro.com', 'figma.com',
  'airtable.com',

  // Payment Gateways & Banking Portals
  'stripe.com', 'stripe.network', 'braintreegateway.com', 'paypal.com',
  'square.site', 'squareup.com', 'adyen.com', 'checkout.com', 'plaid.com',
]);

/**
 * Subdomain label pattern specifically indicative of tracking, telemetry, or ad measurement delegation.
 */
export const TRACKING_SUBDOMAIN_PATTERN =
  /^(?:track(?:er|ing)?|analytics?|telemetry|metrics?|pixel|tagmanager|adserver|adclick|stats?|beacon|collector|log(?:ger|s)?|event(?:s)?|audience|segment|visitor|affiliate|partner-tracking|conversion|attribution)(?:[-._0-9]|$)/i;

/**
 * Checks if a domain has any subdomain labels dedicated to telemetry, tracking, or advertising.
 */
export function isTrackingSubdomain(domain: string): boolean {
  if (!domain || typeof domain !== 'string') return false;
  const labels = domain.toLowerCase().split('.');
  if (labels.length < 2) return false;
  // Check all subdomain labels before the registrable zone
  const decomp = decomposeDomain(domain);
  if (decomp.subdomains && decomp.subdomains.length > 0) {
    return decomp.subdomains.some((lbl) => TRACKING_SUBDOMAIN_PATTERN.test(lbl));
  }
  return false;
}

/**
 * Checks if a domain or hostname contains recognized advertising or tracking keyword tokens.
 */
function hasTrackingOrAdTokens(domain: string): boolean {
  if (!domain || typeof domain !== 'string') return false;
  const lower = domain.toLowerCase();
  for (const token of getDbLists().suspiciousAdTokens) {
    if (hostnameHasToken(lower, token)) return true;
  }
  for (const token of getDbLists().suspiciousTrackerTokens) {
    if (hostnameHasToken(lower, token)) return true;
  }
  return false;
}

/**
 * Checks if a CNAME destination is an explicitly recognized benign SaaS endpoint, multi-tenant host, or safe CDN.
 */
export function isBenignCnameTarget(target: string): boolean {
  if (!target || typeof target !== 'string') return false;
  const lower = trimTrailingDots(target.toLowerCase().trim());
  if (!lower) return false;

  // Never benign if it has tracking/ad tokens or is a known cloaked/ad target
  if (hasTrackingOrAdTokens(lower)) return false;
  for (const providerDomain of Object.keys(KNOWN_CLOAKED_TARGETS)) {
    if (lower === providerDomain || lower.endsWith('.' + providerDomain)) return false;
  }

  const aab = detectAntiAdblock(lower);
  if (aab.detected) return false;

  const infra = classifyInfrastructure(lower);
  if (infra.adNetwork || infra.kind === 'tracker-network') return false;

  // 1. Direct or parent benign SaaS match
  for (const saas of BENIGN_SAAS_CNAMES) {
    if (lower === saas || lower.endsWith('.' + saas)) return true;
  }

  // 2. Direct or parent multi-tenant hosting match
  for (const suffix of DYNAMIC_DNS_SUFFIXES) {
    if (lower === suffix || lower.endsWith('.' + suffix)) return true;
  }

  // 3. Infrastructure classification safe match
  if (infra.safe && (infra.kind === 'cdn' || infra.kind === 'cloud' || infra.kind === 'vendor')) {
    return true;
  }

  return false;
}

interface CnameCacheEntry {
  result: CnameResolutionResult;
  expiresAt: number;
}

const CNAME_CACHE_MAX_SIZE = 1024;
const CNAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cnameCache = new Map<string, CnameCacheEntry>();
// Entries are wrapped so ownership checks compare a plain object, not a promise.
const inFlightResolutions = new Map<string, { promise: Promise<CnameResolutionResult> }>();
let cacheGeneration = 0;

function cloneResolution(result: CnameResolutionResult): CnameResolutionResult {
  return { ...result, cnames: [...result.cnames], ips: [...result.ips] };
}

function isMissingDnsRecord(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ENODATA' || error.code === 'ENOTFOUND';
}

/**
 * Returns current cache size and in-flight resolution count for telemetry and memory diagnostics.
 */
export function getCnameCacheStats(): { size: number; inFlight: number } {
  return {
    size: cnameCache.size,
    inFlight: inFlightResolutions.size,
  };
}

/**
 * Resets the CNAME resolution in-memory cache and in-flight request tracker.
 * Useful for test suites and memory hygiene in long-lived server processes.
 */
export function clearCnameCache(): void {
  cacheGeneration++;
  cnameCache.clear();
  inFlightResolutions.clear();
}

/**
 * Resolves CNAME chain for a domain with safety timeout, dual-stack IPv4/IPv6 address lookup,
 * in-flight request deduplication, and leak-free cancellation.
 *
 * Implements strict zero false-positive protection:
 * - Exonerates intra-brand corporate aliases (e.g. login.microsoft.com -> live.com).
 * - Exonerates multi-tenant and serverless web hosting platforms (Vercel, Netlify, Shopify, etc.).
 * - Exonerates verified CDNs, cloud infrastructure, and customer service SaaS endpoints.
 * - Requires tracking/ad intent or known tracker match before flagging cross-domain CNAMEs as cloaking.
 * @beta
 */
export async function resolveCnameChain(domain: string, timeoutMs = 2500): Promise<CnameResolutionResult> {
  const cleanDomain = normalizeHostname(domain);
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.min(30_000, Math.floor(timeoutMs))) : 2500;
  const requestKey = `${cleanDomain}|${budgetMs}`;
  const generation = cacheGeneration;
  const cnames: string[] = [];
  const ips: string[] = [];

  // Check in-memory cache hit
  const cached = cnameCache.get(cleanDomain);
  if (cached && Date.now() < cached.expiresAt) {
    // Refresh LRU access
    cnameCache.delete(cleanDomain);
    cnameCache.set(cleanDomain, cached);
    return cloneResolution(cached.result);
  }
  if (cached) cnameCache.delete(cleanDomain);

  // Reject malformed, local, single-label, IPv4/IPv6, or empty inputs before touching network sockets
  if (
    !cleanDomain ||
    cleanDomain === 'localhost' ||
    !cleanDomain.includes('.') ||
    /[\s\r\n\0]/.test(cleanDomain) ||
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanDomain) ||
    cleanDomain.includes(':')
  ) {
    const fastResult: CnameResolutionResult = {
      domain: cleanDomain,
      cnames,
      ips,
      hasCnameCloaking: false,
      isExternalCname: false,
    };
    if (cnameCache.size >= CNAME_CACHE_MAX_SIZE) {
      const oldestKey = cnameCache.keys().next().value;
      if (oldestKey !== undefined) cnameCache.delete(oldestKey);
    }
    cnameCache.set(cleanDomain, {
      result: cloneResolution(fastResult),
      expiresAt: Date.now() + CNAME_CACHE_TTL_MS,
    });
    return fastResult;
  }

  // Check in-flight promise sharing (stampede prevention)
  const existingEntry = inFlightResolutions.get(requestKey);
  if (existingEntry) {
    return cloneResolution(await existingEntry.promise);
  }

  const resolutionTask = (async (): Promise<CnameResolutionResult> => {
    const resolver = new dns.Resolver({ timeout: Math.min(budgetMs, 2000), tries: 1 });
    let stopped = false;
    let timedOut = false;
    let cacheable = true;

    const resolvePromise = (async () => {
      let current = cleanDomain;
      const visited = new Set<string>();

      // Trace CNAME chain up to 8 hops deep to protect against circular DNS loops
      while (!stopped && visited.size < 8) {
        if (visited.has(current)) break;
        visited.add(current);

        try {
          const records = await resolver.resolveCname(current);
          if (stopped) return;
          if (records && records.length > 0) {
            const nextTarget = trimTrailingDots(records[0].toLowerCase().trim());
            if (!nextTarget || visited.has(nextTarget)) break;
            cnames.push(nextTarget);
            current = nextTarget;
          } else {
            break;
          }
        } catch (error) {
          if (!isMissingDnsRecord(error)) cacheable = false;
          // No further CNAME records or network cancellation
          break;
        }
      }

      if (stopped) return;

      // Resolve IPv4 (A) and IPv6 (AAAA) records in parallel
      const resolvedIps = new Set<string>();
      await Promise.allSettled([
        (async () => {
          try {
            const aRecords = await resolver.resolve4(current);
            if (Array.isArray(aRecords)) {
              for (const ip of aRecords.slice(0, 4)) {
                resolvedIps.add(ip);
              }
            }
          } catch (error) {
            if (!isMissingDnsRecord(error)) cacheable = false;
            // Ignore A record resolution failure
          }
        })(),
        (async () => {
          try {
            const aaaaRecords = await resolver.resolve6(current);
            if (Array.isArray(aaaaRecords)) {
              for (const ip of aaaaRecords.slice(0, 4)) {
                resolvedIps.add(ip);
              }
            }
          } catch (error) {
            if (!isMissingDnsRecord(error)) cacheable = false;
            // Ignore AAAA record resolution failure
          }
        })(),
      ]);

      if (!stopped) ips.push(...resolvedIps);
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        stopped = true;
        timedOut = true;
        try {
          resolver.cancel();
        } catch {
          // ignore
        }
        resolve();
      }, budgetMs);
      timer?.unref?.();
    });

    try {
      await Promise.race([resolvePromise, timeoutPromise]);
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        resolver.cancel();
      } catch {
        // ignore
      }
    }

    let hasCnameCloaking = false;
    let isExternalCname = false;
    let cloakedTarget: string | undefined;
    let knownTrackerTarget: string | undefined;

    if (cnames.length > 0) {
      cloakedTarget = cnames[cnames.length - 1];

      // 1. Inspect ALL hops in the CNAME chain for known cloaking trackers, ad networks, or anti-adblock bypassers
      for (const cname of cnames) {
        // A. Match against explicit KNOWN_CLOAKED_TARGETS
        for (const [providerDomain, providerName] of Object.entries(KNOWN_CLOAKED_TARGETS)) {
          if (cname === providerDomain || cname.endsWith('.' + providerDomain)) {
            knownTrackerTarget = `${providerName} (${cname})`;
            hasCnameCloaking = true;
            break;
          }
        }
        if (knownTrackerTarget) break;

        // B. Match against Anti-Adblock circumvention detection
        const aab = detectAntiAdblock(cname);
        if (aab.detected) {
          knownTrackerTarget = `${aab.reason || 'Anti-adblock evasion network'} (${cname})`;
          hasCnameCloaking = true;
          break;
        }

        // C. Match against Infrastructure ad or tracker networks
        const infra = classifyInfrastructure(cname);
        if (infra.adNetwork || infra.kind === 'tracker-network') {
          knownTrackerTarget = `${infra.reason || 'Advertising/Tracker Network'} (${cname})`;
          hasCnameCloaking = true;
          break;
        }
      }

      // 2. If no explicit tracking match was found, evaluate domain relationships and exonerate safe architectures
      if (!knownTrackerTarget && cloakedTarget) {
        const target = cloakedTarget;
        const domainDecomp = decomposeDomain(cleanDomain);
        const targetDecomp = decomposeDomain(target);

        // Same site check: matching SLD and TLD (e.g. static.example.com -> cdn.example.com)
        const isSameSite = Boolean(
          domainDecomp.sld &&
          targetDecomp.sld &&
          domainDecomp.sld === targetDecomp.sld &&
          domainDecomp.tld === targetDecomp.tld
        );

        // Corporate brand ecosystem check (e.g. login.microsoft.com -> login.live.com)
        const isSameBrand = isSameBrandEcosystem(cleanDomain, target);

        // Multi-tenant web hosting check (e.g. custom.com -> portfolio.vercel.app or shops.myshopify.com)
        const isMultiTenantHosting = Array.from(DYNAMIC_DNS_SUFFIXES).some(
          (suffix) => target === suffix || target.endsWith('.' + suffix)
        );

        // Benign SaaS helpdesk / ticketing check (e.g. support.mycompany.com -> mycompany.zendesk.com)
        const isBenignSaaS = isBenignCnameTarget(target);

        // Infrastructure classification
        const infra = classifyInfrastructure(target);
        const isKnownSafeInfra = infra.safe && (infra.kind === 'cdn' || infra.kind === 'cloud' || infra.kind === 'vendor');

        if (isSameSite || isSameBrand) {
          // Intra-site or intra-brand delegation is completely safe
          hasCnameCloaking = false;
          isExternalCname = false;
        } else if (isMultiTenantHosting || isBenignSaaS || isKnownSafeInfra) {
          // Recognized benign third-party platform or safe infrastructure
          hasCnameCloaking = false;
          isExternalCname = true;
        } else {
          // Unclassified cross-domain CNAME: only flag as cloaking if tracking or ad indicators exist
          isExternalCname = true;
          const originIsTracking = isTrackingSubdomain(cleanDomain);
          const targetIsTracking = hasTrackingOrAdTokens(target);

          if (originIsTracking || targetIsTracking) {
            hasCnameCloaking = true;
            knownTrackerTarget = `Unclassified third-party tracking CNAME (${target})`;
          } else {
            // Legitimate external host, partner service, or unlisted SaaS (ZERO FALSE POSITIVES)
            hasCnameCloaking = false;
          }
        }
      }
    }

    const result: CnameResolutionResult = {
      domain: cleanDomain,
      cnames,
      ips,
      hasCnameCloaking,
      isExternalCname,
      cloakedTarget,
      knownTrackerTarget,
    };

    // Partial timeout results must not suppress a subsequent complete lookup.
    if (timedOut || !cacheable || generation !== cacheGeneration) return result;

    // Cache the result in LRU bounded memory
    if (cnameCache.size >= CNAME_CACHE_MAX_SIZE) {
      const oldestKey = cnameCache.keys().next().value;
      if (oldestKey !== undefined) {
        cnameCache.delete(oldestKey);
      }
    }
    cnameCache.set(cleanDomain, {
      result: cloneResolution(result),
      expiresAt: Date.now() + CNAME_CACHE_TTL_MS,
    });

    return result;
  })();

  const inFlightEntry = { promise: resolutionTask };
  inFlightResolutions.set(requestKey, inFlightEntry);
  try {
    return cloneResolution(await resolutionTask);
  } finally {
    if (inFlightResolutions.get(requestKey) === inFlightEntry) {
      inFlightResolutions.delete(requestKey);
    }
  }
}
