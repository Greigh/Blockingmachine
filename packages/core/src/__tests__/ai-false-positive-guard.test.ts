import { existsSync, readFileSync } from 'node:fs';
import { AiDetectorService } from '../ai/AiDetectorService.js';
import { globalMiniAiClassifier } from '../ai/MiniAiClassifier.js';

/**
 * False-positive guard for the Mini-AI brand-spoof / infrastructure classifier.
 *
 * Three real false-positive classes were found by sweeping ordinary network data
 * through the classifier. Each one used to produce `malicious / Malware/Phishing`
 * at 100% confidence with `critical` risk, which is the worst possible failure
 * mode for a blocker:
 *
 *  A. **A bare vendor token used as a hostname label.** Vendor names legitimately
 *     appear as labels on *other* vendors' infrastructure (AWS publishes
 *     `akamai.…aws.dev` diagnostics), and much of the brand list is ordinary
 *     English (`max`, `meta`, `target`, `discover`, `square`, `zoom`, `chase`,
 *     `wise`, `steam`, `linear`, `render`, `fly`, `bun`, `neon`).
 *  B. **A brand plus an ordinary inflection** (`bookings`, `railways`, `telegrams`,
 *     `peacocks`, `blizzards`, `outlooks`) tripping the 1-edit typosquat rule.
 *  C. **Vendor zones that were not registered as verified infrastructure**
 *     (`aws.dev`, `on.aws`).
 *
 * Impersonation now requires a second, independent signal — a credential lure,
 * a pseudo-TLD, an untrusted hosting platform, a high-abuse TLD, or punycode —
 * which is the same standard `hasCorroboratedMalwareSignals()` already applied
 * to malware classification.
 */

const scanConfig = { provider: 'mini-ai' as const, skipDns: true, bypassCache: true };

function newService(): AiDetectorService {
  return new AiDetectorService(scanConfig);
}

/** Clean/benign infrastructure: must classify exactly `clean`. */
const MUST_BE_CLEAN = [
  // The originally reported false positive.
  'akamai.external.web.us-east-1.prod.diagnostic.networking.aws.dev',
  // AWS-owned zones and regional service fabric.
  'aws.dev',
  'docs.aws.dev',
  'on.aws',
  'prod.us-east-1.on.aws',
  'lgn5pbvv--prod.lambda-url.us-east-1.on.aws',
  'foo.execute-api.us-east-1.amazonaws.com',
  'd2c8vfjl1f.execute-api.us-east-2.amazonaws.com',
  'iot.us-east-1.amazonaws.com',
  'cognito-identity.us-east-1.amazonaws.com',
  'cloudtrail.us-east-1.amazonaws.com',
  'secretsmanager.us-east-1.amazonaws.com',
  's3-1-w.amazonaws.com',
  'd111111abcdef8.cloudfront.net',
  'health.aws.amazon.com',
  'status.aws.amazon.com',
  'portal.sso.us-east-1.amazonaws.com',
  // Akamai edge fabric, including the vendor token as a label.
  'akamai.net',
  'a104-118-1-1.deploy.static.akamaitechnologies.com',
  'e1234.dscx.akamaiedge.net',
  'mmx-dc.akamai.net',
  // Cross-vendor references: a vendor's name as a label on another vendor's zone.
  'microsoft.akamaized.net',
  'google.akamaized.net',
  'netflix.akamaized.net',
  'apple.akamaized.net',
  'paypal.akamaized.net',
  '1.courier-push-apple.com.akadns.net',
  'akamai.apple.com',
  // Other clouds / vendors.
  'blob.core.windows.net',
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'www.googleapis.com',
  'storage.googleapis.com',
  'lh3.googleusercontent.com',
  'dns.google',
  'dns.quad9.net',
  'one.one.one.one',
  'acme-v02.api.letsencrypt.org',
  'x1.c.lencr.org',
  'ocsp.digicert.com',
  'pool.ntp.org',
  '0.pool.ntp.org',
  'time.cloudflare.com',
  'www.msftconnecttest.com',
  'captive.apple.com',
  'detectportal.firefox.com',
  'connectivitycheck.gstatic.com',
  // Hostname indices on a brand's own zone (brand in the registrable domain).
  'dns1.stripe.com',
  'api2.paypal.com',
  'zoom2.zoom.us',
  'web1.netflix.com',
  // Multi-tenant / platform tenants that are legitimate.
  'myapp.herokuapp.com',
  'some-app-name.up.railway.app',
  'my-project-12345.firebaseapp.com',
  'voou7v0lpaqq0xt7wimwzp4sepmqmqpr.ui.nabu.casa',
  'apple.statuspage.io',
  'status.cursor.com',
  // Institutional.
  'nih.gov',
  'cdc.gov',
  'who.int',
  'mit.edu',
];

/**
 * Known ad / analytics / tracking infrastructure. These are *correctly* flagged —
 * but never as malware, and never as critical, which is what the regressions
 * above produced.
 */
const NEVER_MALWARE = [
  'doubleclick.net',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.tiktok.com',
  'sc-static.net',
  'connect.facebook.net',
  'sentry.io',
  'bam.nr-data.net',
  'browser-intake-datadoghq.com',
  'api2.amplitude.com',
  'api.segment.io',
];

/** Brand names that are also ordinary English words, used as plain subdomains. */
const COMMON_WORD_LABELS = [
  'max', 'meta', 'target', 'discover', 'square', 'zoom', 'chase', 'wise',
  'steam', 'linear', 'render', 'neon', 'fly', 'bun', 'apple', 'ups', 'dhl',
  'pnc', 'stripe', 'oracle', 'ledger', 'gemini', 'onion', 'nova', 'atlas',
  'summit', 'forge', 'frame', 'prism', 'vector',
];

const ORDINARY_ZONES = ['example.com', 'acme-corp.net', 'mycompany.io'];

/**
 * Hostname index suffixes. `web1`, `dns2`, `node07`-style numbering is applied to
 * brand words constantly, and an appended digit is not a leetspeak substitution —
 * leetspeak (`paypa1`, `g00gle`, `app1e`) *replaces* a letter and preserves length.
 */
const BRAND_INDEX_HOSTNAMES = [
  'ups1.example.com',
  'dhl2.example.com',
  'pnc1.example.com',
  'max1.example.com',
  'meta1.example.com',
  'meta2.example.com',
  'zoom1.example.com',
  'zoom2.example.com',
  'apple1.example.com',
  'apple2.example.com',
  'steam2.example.com',
  'square2.example.com',
  'wise1.example.com',
  'jira1.example.com',
  'okta1.example.com',
  'adobe1.example.com',
  'ebay1.example.com',
  'fly1.example.com',
  'bun1.example.com',
  'neon1.example.com',
  'deno1.example.com',
  'turso1.example.com',
  'groq1.example.com',
  'sofi1.example.com',
  'amex1.example.com',
  'hulu2.example.com',
  'plex1.example.com',
  'miro1.example.com',
  'netflix1.example.com',
  'outlook2.example.com',
  'booking3.example.com',
  'railway7.example.com',
  'telegram02.example.com',
];

/** Brand + ordinary English inflection: real vocabulary, not impostors. */
const BRAND_INFLECTIONS = [
  'bookings.example.com',
  'www.bookings.example.com',
  'railways.example.com',
  'telegrams.example.com',
  'peacocks.example.com',
  'blizzards.example.com',
  'outlooks.example.com',
  'phantoms.example.com',
  'vanguards.example.com',
  'replicates.example.com',
  'robinhoods.example.com',
  'netlifys.example.com',
  'expedias.example.com',
  'postmans.example.com',
];

describe('Mini-AI false-positive guard', () => {
  describe('vendor infrastructure that references another vendor', () => {
    it('classifies AWS/Akamai diagnostic infrastructure as clean', async () => {
      const service = newService();
      const res = await service.scanDomain('akamai.external.web.us-east-1.prod.diagnostic.networking.aws.dev');
      expect(res.verdict).toBe('clean');
      expect(res.category).toBe('Clean');
      expect(res.riskLevel).toBe('none');
    });

    it.each(MUST_BE_CLEAN)('treats %s as clean', async (domain) => {
      const service = newService();
      const res = await service.scanDomain(domain);
      expect({ domain, verdict: res.verdict, risk: res.riskLevel }).toEqual({
        domain,
        verdict: 'clean',
        risk: 'none',
      });
    });
  });

  describe('known ad/tracker networks', () => {
    it.each(NEVER_MALWARE)('never calls %s malware', async (domain) => {
      const service = newService();
      const res = await service.scanDomain(domain);
      expect(res.category).not.toBe('Malware/Phishing');
      expect(res.verdict).not.toBe('malicious');
      expect(res.riskLevel).not.toBe('critical');
    });

    it('still identifies telemetry-token hostnames as telemetry, not malware', async () => {
      // `beacon` is an explicit telemetry token, so a host literally named that is
      // intentionally labelled telemetry. It must never escalate to malware.
      const service = newService();
      const res = await service.scanDomain('beacon.example.com');
      expect(res.category).toBe('Telemetry/Analytics');
      expect(res.verdict).not.toBe('malicious');
    });
  });

  describe('brand names that are also ordinary English words', () => {
    it.each(COMMON_WORD_LABELS)('treats %s.<zone> as an ordinary subdomain', async (label) => {
      const service = newService();
      for (const zone of ORDINARY_ZONES) {
        const domain = `${label}.${zone}`;
        const res = await service.scanDomain(domain);
        expect(`${domain}=${res.verdict}/${res.category}`).toBe(`${domain}=clean/Clean`);
      }
    });

    it('does not escalate a bare brand label on a normal deep hostname', async () => {
      const service = newService();
      for (const domain of ['max.edge.internal-prod.net', 'meta.cdn.acme-corp.net', 'discover.k8s.mycompany.io']) {
        const res = await service.scanDomain(domain);
        expect(`${domain}=${res.verdict}`).toBe(`${domain}=clean`);
      }
    });
  });

  describe('brand names with an ordinary inflection', () => {
    it.each(BRAND_INFLECTIONS)('treats %s as real vocabulary', async (domain) => {
      const service = newService();
      const res = await service.scanDomain(domain);
      expect(`${domain}=${res.verdict}/${res.category}`).toBe(`${domain}=clean/Clean`);
    });
  });

  describe('brand names with a hostname index', () => {
    it.each(BRAND_INDEX_HOSTNAMES)('treats %s as an ordinary hostname', async (domain) => {
      const service = newService();
      const res = await service.scanDomain(domain);
      expect(`${domain}=${res.verdict}/${res.category}`).toBe(`${domain}=clean/Clean`);
    });

    it('still catches length-preserving leetspeak substitutions', async () => {
      const service = newService();
      for (const domain of ['paypa1.com', 'g00gle.com', 'app1e.com', 'm1crosoft.com', 'amaz0n-login.xyz']) {
        const res = await service.scanDomain(domain);
        expect(`${domain}=${res.verdict}`).not.toBe(`${domain}=clean`);
      }
    });
  });

  describe('genuine impersonation is still caught', () => {
    it.each([
      // Credential lure + untrusted hosting platform.
      'paypal.workers.dev',
      'chase.firebaseapp.com',
      'apple.pages.dev',
      'metamask.glitch.me',
      // Credential lure keyword attached to the brand.
      'apple-login.xyz',
      'apple-login.statuspage.io',
      'login.paypal-verification.com',
      'paypal-login.xyz',
      // Pseudo-TLD lure.
      'paypal-com.net',
      // Leetspeak / repeated-character typosquats.
      'paypa1.com',
      'gooogle.com',
      'appple.com',
      'g00gle.com',
      'app1e.com',
      'paypa1-security.com',
      'apple-id-verify-login.xyz',
      // Short-brand combosquatting with delivery / alert lures.
      'uspsdelivery.com',
      'dhltracking.com',
      'upsparcel.com',
      'pncalert.com',
      // Punycode homograph.
      'xn--pple-43d.com',
      // A bare brand label still escalates on a high-abuse zone.
      'apple.evil-domain.xyz',
      'max.something-top.xyz',
    ])('flags %s as a threat', async (domain) => {
      const service = newService();
      const res = await service.scanDomain(domain);
      expect({ domain, verdict: res.verdict }).not.toEqual({ domain, verdict: 'clean' });
    });

    it('keeps the bare-brand-on-abuse-TLD escalation narrowly scoped to malware', async () => {
      const service = newService();
      const res = await service.scanDomain('apple.evil-domain.xyz');
      expect(res.verdict).toBe('malicious');
      expect(res.category).toBe('Malware/Phishing');
    });
  });

  describe("the project's own unbreak allowlist", () => {
    const unbreakPath = new URL('../../filters/modules/blockingmachine-unbreak.txt', import.meta.url);

    /** Exception rules the maintainers hand-authored so core sites keep working. */
    function unbreakDomains(): string[] {
      if (!existsSync(unbreakPath)) return [];
      const domains = new Set<string>();
      for (const line of readFileSync(unbreakPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('!')) continue;
        const host = trimmed
          .replace(/^@@/, '')
          .replace(/^\|{1,2}/, '')
          .split('^')[0]
          .split('$')[0]
          .replace(/\/$/, '');
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) domains.add(host.toLowerCase());
      }
      return [...domains].sort();
    }

    it('registers a non-empty fixture', () => {
      expect(unbreakDomains().length).toBeGreaterThan(10);
    });

    it('never classifies a hand-allowlisted domain as malware', async () => {
      const service = newService();
      const offenders: string[] = [];
      for (const domain of unbreakDomains()) {
        const res = await service.scanDomain(domain);
        if (res.verdict === 'malicious' || res.category === 'Malware/Phishing' || res.riskLevel === 'critical') {
          offenders.push(`${domain} -> ${res.verdict}/${res.category}/${res.riskLevel}`);
        }
      }
      // Trackers that the maintainers allowlist for functionality (Adobe omtrdc.net,
      // Demdex, Quantum Metric) may be labelled as trackers, but a malware warning on
      // a domain the product ships an exception for is always a bug.
      expect(offenders).toEqual([]);
    });
  });

  describe('feedback tuning still overrides the classifier', () => {
    it('lets a user whitelist a flagged offender', async () => {
      const service = newService();
      const domain = 'apple.evil-domain.xyz';
      const before = await service.scanDomain(domain);
      expect(before.verdict).not.toBe('clean');

      globalMiniAiClassifier.tuneDomainFeedback(domain, 'whitelist');
      expect(globalMiniAiClassifier.getDomainFeedback(domain)).toBe(-1);
      const after = await service.scanDomain(domain);
      expect(after.verdict).toBe('clean');
      expect(after.reasons.join(' ')).toMatch(/whitelist|false positive/i);
      // The user's correction also protects the rest of the zone.
      expect(service.isSafeInfrastructure(domain)).toBe(true);

      globalMiniAiClassifier.tuneDomainFeedback(domain, 'reset');
      expect(globalMiniAiClassifier.getDomainFeedback(domain)).toBe(0);
    });
  });
});
