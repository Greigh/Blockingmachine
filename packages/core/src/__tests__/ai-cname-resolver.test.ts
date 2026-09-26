import {
  resolveCnameChain,
  KNOWN_CLOAKED_TARGETS,
  BENIGN_SAAS_CNAMES,
  clearCnameCache,
  isSameBrandEcosystem,
  isTrackingSubdomain,
  isBenignCnameTarget,
  getCnameCacheStats,
  TRACKING_SUBDOMAIN_PATTERN,
} from '../index.js';

describe('AI CNAME Cloaking Resolver Engine', () => {
  beforeEach(() => {
    clearCnameCache();
  });

  describe('Known Cloaked Targets Dictionary', () => {
    it('contains major retargeting and ad exchange cloaks', () => {
      expect(KNOWN_CLOAKED_TARGETS['criteo.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['adsrvr.org']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['rlcdn.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['mathtag.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['adform.net']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['flashtalking.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['yieldlab.net']).toBeDefined();
    });

    it('contains attribution and mobile deep linking tracking cloaks', () => {
      expect(KNOWN_CLOAKED_TARGETS['branch.io']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['app.link']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['appsflyer.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['adjust.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['kochava.com']).toBeDefined();
    });

    it('contains Adobe, Salesforce, and enterprise marketing cloud cloaks', () => {
      expect(KNOWN_CLOAKED_TARGETS['omtrdc.net']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['demdex.net']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['adobedc.net']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['exacttarget.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['krux.net']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['marketo.com']).toBeDefined();
    });

    it('contains behavioral telemetry and session recording cloaks', () => {
      expect(KNOWN_CLOAKED_TARGETS['hotjar.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['fullstory.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['crazyegg.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['contentsquare.net']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['clarity.ms']).toBeDefined();
    });

    it('contains anti-adblock and paywall bypass circumvention domains', () => {
      expect(KNOWN_CLOAKED_TARGETS['admiraldrm.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['btloader.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['blockthrough.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['pagefair.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['adinplay.com']).toBeDefined();
      expect(KNOWN_CLOAKED_TARGETS['snigelweb.com']).toBeDefined();
    });
  });

  describe('Benign SaaS Endpoints Exemption Set', () => {
    it('contains customer service and enterprise ticketing platforms', () => {
      expect(BENIGN_SAAS_CNAMES.has('zendesk.com')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('freshdesk.com')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('statuspage.io')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('atlassian.net')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('salesforce.com')).toBe(true);
    });

    it('contains documentation, headless CMS, and website hosting endpoints', () => {
      expect(BENIGN_SAAS_CNAMES.has('readme.io')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('gitbook.io')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('mintlify.app')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('shopify.com')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('webflow.io')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('vercel.app')).toBe(true);
      expect(BENIGN_SAAS_CNAMES.has('stripe.com')).toBe(true);
    });
  });

  describe('isBenignCnameTarget Guard', () => {
    it('identifies recognized benign SaaS targets', () => {
      expect(isBenignCnameTarget('customer.zendesk.com')).toBe(true);
      expect(isBenignCnameTarget('docs.gitbook.io')).toBe(true);
      expect(isBenignCnameTarget('myproject.vercel.app')).toBe(true);
      expect(isBenignCnameTarget('shop.myshopify.com')).toBe(true);
      expect(isBenignCnameTarget('status.incident.io')).toBe(true);
      expect(isBenignCnameTarget('api.stripe.com')).toBe(true);
    });

    it('identifies recognized safe CDN and cloud infrastructure', () => {
      expect(isBenignCnameTarget('custom.cloudflare.net')).toBe(true);
      expect(isBenignCnameTarget('static.fastly.net')).toBe(true);
      expect(isBenignCnameTarget('edge.akamaiedge.net')).toBe(true);
    });

    it('returns false for unknown or suspicious targets', () => {
      expect(isBenignCnameTarget('tracker.criteo.com')).toBe(false);
      expect(isBenignCnameTarget('pixel.facebook.com')).toBe(false);
      expect(isBenignCnameTarget('random-shady-site.biz')).toBe(false);
      expect(isBenignCnameTarget('')).toBe(false);
    });
  });

  describe('Tracking Subdomain Classification', () => {
    it('identifies tracking and telemetry subdomains', () => {
      expect(isTrackingSubdomain('track.example.com')).toBe(true);
      expect(isTrackingSubdomain('tracking.retailer.com')).toBe(true);
      expect(isTrackingSubdomain('analytics.mysite.org')).toBe(true);
      expect(isTrackingSubdomain('telemetry.company.com')).toBe(true);
      expect(isTrackingSubdomain('metrics.service.io')).toBe(true);
      expect(isTrackingSubdomain('pixel.brand.com')).toBe(true);
      expect(isTrackingSubdomain('tagmanager.portal.net')).toBe(true);
      expect(isTrackingSubdomain('adserver.news.com')).toBe(true);
      expect(isTrackingSubdomain('beacon.app.co')).toBe(true);
      expect(isTrackingSubdomain('collector.events.corp.com')).toBe(true);
    });

    it('protects standard operational, business, and content subdomains', () => {
      expect(isTrackingSubdomain('blog.example.com')).toBe(false);
      expect(isTrackingSubdomain('www.example.com')).toBe(false);
      expect(isTrackingSubdomain('shop.example.com')).toBe(false);
      expect(isTrackingSubdomain('careers.example.com')).toBe(false);
      expect(isTrackingSubdomain('status.example.com')).toBe(false);
      expect(isTrackingSubdomain('api.example.com')).toBe(false);
      expect(isTrackingSubdomain('docs.example.com')).toBe(false);
      expect(isTrackingSubdomain('auth.example.com')).toBe(false);
      expect(isTrackingSubdomain('portal.example.com')).toBe(false);
      expect(isTrackingSubdomain('mail.example.com')).toBe(false);
    });

    it('matches TRACKING_SUBDOMAIN_PATTERN correctly', () => {
      expect(TRACKING_SUBDOMAIN_PATTERN.test('track')).toBe(true);
      expect(TRACKING_SUBDOMAIN_PATTERN.test('tracker')).toBe(true);
      expect(TRACKING_SUBDOMAIN_PATTERN.test('analytics')).toBe(true);
      expect(TRACKING_SUBDOMAIN_PATTERN.test('pixel')).toBe(true);
      expect(TRACKING_SUBDOMAIN_PATTERN.test('blog')).toBe(false);
      expect(TRACKING_SUBDOMAIN_PATTERN.test('status')).toBe(false);
    });
  });

  describe('Brand Ecosystem Intra-Alias Detection', () => {
    it('identifies Microsoft intra-brand alias destinations', () => {
      expect(isSameBrandEcosystem('login.microsoft.com', 'login.live.com')).toBe(true);
      expect(isSameBrandEcosystem('portal.azure.com', 'login.microsoftonline.com')).toBe(true);
    });

    it('identifies Meta / Instagram intra-brand alias destinations', () => {
      expect(isSameBrandEcosystem('instagram.com', 'static.xx.fbcdn.net')).toBe(true);
      expect(isSameBrandEcosystem('whatsapp.com', 'meta.com')).toBe(true);
    });

    it('identifies Disney streaming intra-brand alias destinations', () => {
      expect(isSameBrandEcosystem('disneyplus.com', 'media.disney-streaming.com')).toBe(true);
    });

    it('identifies Salesforce intra-brand alias destinations', () => {
      expect(isSameBrandEcosystem('app.salesforce.com', 'login.force.com')).toBe(true);
    });

    it('returns false for unrelated or third-party tracking destinations', () => {
      expect(isSameBrandEcosystem('mybrand.com', 'criteo.com')).toBe(false);
      expect(isSameBrandEcosystem('publisher.org', 'eulerian.net')).toBe(false);
      expect(isSameBrandEcosystem('news.site', 'branch.io')).toBe(false);
    });
  });

  describe('resolveCnameChain Execution & Cache Guardrails', () => {
    it('handles localhost, single labels, empty strings, and IP addresses without touching DNS', async () => {
      const resLocal = await resolveCnameChain('localhost', 500);
      expect(resLocal.domain).toBe('localhost');
      expect(resLocal.cnames).toEqual([]);
      expect(resLocal.ips).toEqual([]);
      expect(resLocal.hasCnameCloaking).toBe(false);
      expect(resLocal.isExternalCname).toBe(false);

      const resSingle = await resolveCnameChain('intranethost', 500);
      expect(resSingle.cnames).toEqual([]);
      expect(resSingle.hasCnameCloaking).toBe(false);

      const resIp = await resolveCnameChain('192.168.1.1', 500);
      expect(resIp.cnames).toEqual([]);
      expect(resIp.hasCnameCloaking).toBe(false);

      const resEmpty = await resolveCnameChain('', 500);
      expect(resEmpty.cnames).toEqual([]);
      expect(resEmpty.hasCnameCloaking).toBe(false);
    });

    it('handles IPv6 addresses and bracketed URLs without crashing', async () => {
      const resIpv6 = await resolveCnameChain('2001:db8::1', 500);
      expect(resIpv6.hasCnameCloaking).toBe(false);
      expect(resIpv6.cnames).toEqual([]);

      const resBracket = await resolveCnameChain('[::1]:8080', 500);
      expect(resBracket.hasCnameCloaking).toBe(false);
      expect(resBracket.cnames).toEqual([]);
    });

    it('sanitizes URLs with protocol, path, port, query, and trailing dot', async () => {
      const res = await resolveCnameChain('https://user:pass@localhost:8080/path?query#hash', 500);
      expect(res.domain).toBe('localhost');
      expect(res.hasCnameCloaking).toBe(false);
    });

    it('caches resolution results in memory and deduplicates in-flight calls', async () => {
      const first = await resolveCnameChain('localhost', 500);
      const second = await resolveCnameChain('localhost', 500);
      expect(first).toEqual(second);

      const stats = getCnameCacheStats();
      expect(stats.size).toBeGreaterThanOrEqual(1);

      clearCnameCache();
      const afterClear = getCnameCacheStats();
      expect(afterClear.size).toBe(0);

      const third = await resolveCnameChain('localhost', 500);
      expect(third).toEqual(first);
    });
  });
});

