import { promises as dns } from 'dns';
import { decomposeDomain } from './entropy.js';
import { classifyInfrastructure } from './reputation.js';
import type { CnameResolutionResult } from './types.js';

// Known third-party tracker CNAME cloaking destinations
export const KNOWN_CLOAKED_TARGETS: Record<string, string> = {
  'criteo.com': 'Criteo Retargeting & Ad Exchange',
  'criteo.net': 'Criteo Retargeting & Ad Exchange',
  'branch.io': 'Branch Metrics Deep Linking Tracker',
  'sc-cdn.net': 'Snapchat Ad Measurement',
  'keywee.co': 'Keywee Content Telemetry & Audience Tracker',
  'eulerian.net': 'Eulerian Data Analytics',
  'affilae.com': 'Affilae Affiliate Tracker',
  'wizaly.com': 'Wizaly Attribution Platform',
  'commandersact.com': 'Commanders Act CDP',
  'at-o.net': 'AT Internet / Piano Analytics',
  'wt-eu02.net': 'Mapp Intelligence / Webtrekk',
  'webtrekk.net': 'Webtrekk Telemetry',
  'omtrdc.net': 'Adobe Audience Manager / Experience Cloud',
  'demdex.net': 'Adobe Audience Manager',
  'everesttech.net': 'Adobe Advertising Cloud',
  '2o7.net': 'Adobe Omniture Tracking',
  'dnsdelegation.io': 'Keywee / Content Tracker Cloak',
  'exacttarget.com': 'Salesforce Marketing Cloud Telemetry',
  'actonsoftware.com': 'Act-On Marketing Automation Tracker',
  'hubspot.net': 'HubSpot Tracking Domain',
  'krux.net': 'Salesforce Krux DMP',
  'sail-horizon.com': 'Sailthru Email & Conversion Tracker',
  'bounceexchange.com': 'Wunderkind / BounceX Behavioral Tracker',
  'wunderkind.co': 'Wunderkind Behavioral Tracker',
  'yieldify.com': 'Yieldify Conversion Telemetry',
  'sl-edge.com': 'Smartlook Analytics Edge',
  'adlooxtracking.com': 'Adloox Verification & Tracking',
  's-onetag.com': 'Sharethrough Tag / Tracker',
  'awin1.com': 'Awin Affiliate Tracker',
  'linksynergy.com': 'Rakuten LinkShare Affiliate Tracker',
  'impactradius.com': 'Impact Affiliate Tracker',
  'segment.io': 'Segment Customer Data Platform',
  'pardot.com': 'Salesforce Pardot Marketing Tracker',
  'marketo.com': 'Adobe Marketo Lead Tracker',
  'appsflyer.com': 'AppsFlyer Attribution',
  'singular.net': 'Singular ROI Tracking',
  'adjust.com': 'Adjust Mobile Measurement Tracker',
  'kochava.com': 'Kochava Attribution & Analytics Engine',
  'trackcmp.net': 'ActiveCampaign Telemetry & Tracking',
  'admiraldrm.com': 'Admiral Anti-Adblock & Paywall Bypass',
  'getadmiral.com': 'Admiral Anti-Adblock & Paywall Bypass',
  'admiralservices.com': 'Admiral Anti-Adblock & Paywall Bypass',
  'admiralcloud.com': 'Admiral Anti-Adblock & Paywall Bypass',
  'carter-carrier.com': 'Admiral Anti-Adblock Dynamic Cloak',
  'whisperingwax.com': 'Admiral Anti-Adblock Dynamic Cloak',
  'chiseledcherry.com': 'Admiral Anti-Adblock Dynamic Cloak',
  'defiantdigital.com': 'Admiral Anti-Adblock Dynamic Cloak',
  'spitefulsoup.com': 'Admiral Anti-Adblock Dynamic Cloak',
  'sylvansteam.com': 'Admiral Anti-Adblock Dynamic Cloak',
  'btloader.com': 'BlockThrough Anti-Adblock Bypass',
  'blockthrough.com': 'BlockThrough Anti-Adblock Bypass',
  'pagefair.com': 'PageFair Anti-Adblock Bypass',
  'pagefair.net': 'PageFair Anti-Adblock Bypass',
  'adinplay.com': 'AdInPlay Anti-Adblock Bypass',
  'adinplay.bid': 'AdInPlay Anti-Adblock Bypass',
  'adinplay.eu': 'AdInPlay Anti-Adblock Bypass',
  'fundingchoicesmessages.google.com': 'Google Funding Choices Anti-Adblock',
  'fc.yahoo.com': 'Google Funding Choices / Yahoo Consent Anti-Adblock',
  'ezodn.com': 'Ezoic Ad-Recovery CNAME Cloak',
  'ezoiccdn.com': 'Ezoic Ad-Recovery CNAME Cloak',
  'snigelweb.com': 'Snigel Ad-Recovery CNAME Cloak',
  'bolt.playwire.com': 'Playwire Ad-Recovery CNAME Cloak',
};

/**
 * Resolves CNAME chain for a domain with safety timeout and leak-free cancellation.
 * @beta
 */
export async function resolveCnameChain(domain: string, timeoutMs = 2500): Promise<CnameResolutionResult> {
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const cnames: string[] = [];
  const ips: string[] = [];

  // Reject malformed or local/empty inputs before touching network sockets
  if (!cleanDomain || cleanDomain === 'localhost' || /[\s\r\n\0]/.test(cleanDomain)) {
    return {
      domain: cleanDomain,
      cnames,
      ips,
      hasCnameCloaking: false,
    };
  }

  const resolver = new dns.Resolver({ timeout: Math.min(timeoutMs, 2000), tries: 1 });

  const resolvePromise = (async () => {
    let current = cleanDomain;
    const visited = new Set<string>();

    // Trace CNAME chain up to 5 hops deep
    while (visited.size < 5) {
      if (visited.has(current)) break;
      visited.add(current);

      try {
        const records = await resolver.resolveCname(current);
        if (records && records.length > 0) {
          const nextTarget = records[0].toLowerCase().replace(/\.$/, '');
          cnames.push(nextTarget);
          current = nextTarget;
        } else {
          break;
        }
      } catch {
        // No further CNAME records or cancelled
        break;
      }
    }

    // Resolve A records for the final destination
    try {
      const aRecords = await resolver.resolve4(current);
      if (Array.isArray(aRecords)) {
        ips.push(...aRecords.slice(0, 4));
      }
    } catch {
      // Ignore A record resolution errors or cancelled
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      try {
        resolver.cancel();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
    timer?.unref?.();
  });

  try {
    await Promise.race([resolvePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      resolver.cancel();
    } catch {
      // ignore
    }
  }

  let hasCnameCloaking = false;
  let cloakedTarget: string | undefined;
  let knownTrackerTarget: string | undefined;

  if (cnames.length > 0) {
    cloakedTarget = cnames[cnames.length - 1];

    for (const cname of cnames) {
      for (const [providerDomain, providerName] of Object.entries(KNOWN_CLOAKED_TARGETS)) {
        if (cname === providerDomain || cname.endsWith('.' + providerDomain)) {
          knownTrackerTarget = `${providerName} (${cname})`;
          hasCnameCloaking = true;
          break;
        }
      }
      if (knownTrackerTarget) break;
    }

    if (!knownTrackerTarget && cloakedTarget) {
      const domainDecomp = decomposeDomain(cleanDomain);
      const targetDecomp = decomposeDomain(cloakedTarget);
      const isSameSite =
        Boolean(domainDecomp.sld && targetDecomp.sld && domainDecomp.sld === targetDecomp.sld && domainDecomp.tld === targetDecomp.tld);
      const infra = classifyInfrastructure(cloakedTarget);
      const isKnownCdnOrCloud = infra.safe && (infra.kind === 'cdn' || infra.kind === 'cloud');

      if (!isSameSite && !isKnownCdnOrCloud) {
        hasCnameCloaking = true;
      }
    }
  }

  return {
    domain: cleanDomain,
    cnames,
    ips,
    hasCnameCloaking,
    cloakedTarget,
    knownTrackerTarget,
  };
}
