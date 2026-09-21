import { promises as dns } from 'dns';

export interface CnameResolutionResult {
  domain: string;
  cnames: string[];
  ips: string[];
  hasCnameCloaking: boolean;
  cloakedTarget?: string;
  knownTrackerTarget?: string;
}

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
  'segment.io': 'Segment Customer Data Platform',
  'pardot.com': 'Salesforce Pardot Marketing Tracker',
  'marketo.com': 'Adobe Marketo Lead Tracker',
  'appsflyer.com': 'AppsFlyer Attribution',
  'singular.net': 'Singular ROI Tracking',
  'adjust.com': 'Adjust Mobile Measurement Tracker',
  'kochava.com': 'Kochava Attribution & Analytics Engine',
};

/**
 * Resolves CNAME chain for a domain with safety timeout.
 */
export async function resolveCnameChain(domain: string, timeoutMs = 2500): Promise<CnameResolutionResult> {
  const cleanDomain = domain.toLowerCase().trim();
  const cnames: string[] = [];
  const ips: string[] = [];

  const resolvePromise = (async () => {
    let current = cleanDomain;
    const visited = new Set<string>();

    // Trace CNAME chain up to 5 hops deep
    while (visited.size < 5) {
      if (visited.has(current)) break;
      visited.add(current);

      try {
        const records = await dns.resolveCname(current);
        if (records && records.length > 0) {
          const nextTarget = records[0].toLowerCase().replace(/\.$/, '');
          cnames.push(nextTarget);
          current = nextTarget;
        } else {
          break;
        }
      } catch {
        // No further CNAME records
        break;
      }
    }

    // Resolve A records for the final destination
    try {
      const aRecords = await dns.resolve4(current);
      if (Array.isArray(aRecords)) {
        ips.push(...aRecords.slice(0, 4));
      }
    } catch {
      // Ignore A record resolution errors
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer?.unref?.();
  });

  try {
    await Promise.race([resolvePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  let hasCnameCloaking = false;
  let cloakedTarget: string | undefined;
  let knownTrackerTarget: string | undefined;

  if (cnames.length > 0) {
    hasCnameCloaking = true;
    cloakedTarget = cnames[cnames.length - 1];

    for (const cname of cnames) {
      for (const [providerDomain, providerName] of Object.entries(KNOWN_CLOAKED_TARGETS)) {
        if (cname.includes(providerDomain)) {
          knownTrackerTarget = `${providerName} (${cname})`;
          break;
        }
      }
      if (knownTrackerTarget) break;
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
