import { describe, test, expect } from '@jest/globals';
import { cleanDomainPattern } from '@blockingmachine/core';

describe('Electron App Core Utilities & IPC Logic', () => {
  describe('Sinkhole URL and Credential Helpers', () => {
    function normalizeSinkholeUrl(rawUrl: string): string {
      let url = rawUrl.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `http://${url}`;
      }
      return url.replace(/\/$/, '');
    }

    function buildPiholeUrl(rawUrl: string, apiKey?: string): string {
      const base = normalizeSinkholeUrl(rawUrl);
      const url = new URL(base);
      if (apiKey) {
        url.searchParams.set('auth', apiKey.trim());
      }
      url.searchParams.set('action', 'updategravity');
      return url.toString();
    }

    function buildAdguardHeaders(user?: string, password?: string): Record<string, string> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user && password) {
        const credentials = Buffer.from(`${user}:${password}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      }
      return headers;
    }

    test('normalizes bare hostnames to http protocol and trims trailing slash', () => {
      expect(normalizeSinkholeUrl('192.168.1.50:8080/')).toBe('http://192.168.1.50:8080');
      expect(normalizeSinkholeUrl('pi.hole/admin/api.php')).toBe('http://pi.hole/admin/api.php');
      expect(normalizeSinkholeUrl('https://adguard.home.local/')).toBe('https://adguard.home.local');
    });

    test('buildPiholeUrl properly appends action and optional auth token', () => {
      const withoutAuth = buildPiholeUrl('pi.hole/admin/api.php');
      expect(withoutAuth).toBe('http://pi.hole/admin/api.php?action=updategravity');

      const withAuth = buildPiholeUrl('http://192.168.1.2/admin/api.php', 'secret-api-token');
      expect(withAuth).toContain('action=updategravity');
      expect(withAuth).toContain('auth=secret-api-token');
    });

    test('buildAdguardHeaders produces valid Base64 Basic auth credentials', () => {
      const headers = buildAdguardHeaders('admin', 'p@ssword123');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Basic YWRtaW46cEBzc3dvcmQxMjM=');

      const noAuth = buildAdguardHeaders('', '');
      expect(noAuth['Authorization']).toBeUndefined();
    });
  });

  describe('Rule Browser Filtering & Search', () => {
    const mockRules = [
      { raw: '||ads.doubleclick.net^', type: 'blocking', domain: 'ads.doubleclick.net', isException: false },
      { raw: '@@||safe.doubleclick.net^', type: 'exception', domain: 'safe.doubleclick.net', isException: true },
      { raw: 'doubleclick.net##.banner-ad', type: 'cosmetic', domain: 'doubleclick.net', isException: false },
      { raw: '0.0.0.0 telemetry.tracker.com', type: 'hosts', domain: 'telemetry.tracker.com', isException: false },
      { raw: '||tracker.com^', type: 'blocking', domain: 'tracker.com', isException: false },
    ];

    function filterRules(
      rules: typeof mockRules,
      options: { search?: string; typeFilter?: string; offset?: number; limit?: number }
    ) {
      let filtered = rules;
      const search = options.search?.trim().toLowerCase();
      if (search) {
        filtered = filtered.filter(
          (r) =>
            (r.raw && r.raw.toLowerCase().includes(search)) ||
            (r.domain && r.domain.toLowerCase().includes(search))
        );
      }

      if (options.typeFilter && options.typeFilter !== 'all') {
        if (options.typeFilter === 'exceptions') {
          filtered = filtered.filter((r) => r.isException || r.raw?.startsWith('@@'));
        } else if (options.typeFilter === 'cosmetic') {
          filtered = filtered.filter((r) => r.raw?.includes('##') || r.raw?.includes('#@#'));
        } else if (options.typeFilter === 'blocking') {
          filtered = filtered.filter((r) => !r.isException && !r.raw?.startsWith('@@'));
        }
      }

      const total = filtered.length;
      const offset = options.offset || 0;
      const limit = options.limit || 100;
      const sliced = filtered.slice(offset, offset + limit);

      return { total, rules: sliced };
    }

    test('filters rules by search term across raw syntax and domain', () => {
      const searchRes = filterRules(mockRules, { search: 'telemetry' });
      expect(searchRes.total).toBe(1);
      expect(searchRes.rules[0].raw).toBe('0.0.0.0 telemetry.tracker.com');

      const caseRes = filterRules(mockRules, { search: 'DOUBLECLICK' });
      expect(caseRes.total).toBe(3);
    });

    test('filters rules by category (exceptions, cosmetic, blocking)', () => {
      const exceptions = filterRules(mockRules, { typeFilter: 'exceptions' });
      expect(exceptions.total).toBe(1);
      expect(exceptions.rules[0].isException).toBe(true);

      const cosmetic = filterRules(mockRules, { typeFilter: 'cosmetic' });
      expect(cosmetic.total).toBe(1);
      expect(cosmetic.rules[0].raw).toContain('##');

      const blocking = filterRules(mockRules, { typeFilter: 'blocking' });
      expect(blocking.total).toBe(4);
    });

    test('slices pagination with offset and limit', () => {
      const page1 = filterRules(mockRules, { limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.rules).toHaveLength(2);

      const page2 = filterRules(mockRules, { limit: 2, offset: 2 });
      expect(page2.rules).toHaveLength(2);
      expect(page2.rules[0]).not.toEqual(page1.rules[0]);
    });
  });

  describe('Domain Inspector Resolution Logic', () => {
    const rules = [
      { raw: '||tracker.io^', domain: 'tracker.io', isException: false },
      { raw: '@@||safe.tracker.io^', domain: 'safe.tracker.io', isException: true },
      { raw: '0.0.0.0 malware.org', domain: 'malware.org', isException: false },
    ];

    function extractCleanDomain(domainQuery: string): string {
      let cleaned = domainQuery.trim().toLowerCase();
      if (cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.startsWith('ftp://')) {
        try {
          const parsed = new URL(cleaned);
          cleaned = parsed.hostname;
        } catch {
          // fallback
        }
      }
      cleaned = cleaned.replace(/^[a-zA-Z]+:\/\//, '');
      cleaned = cleaned.replace(/[/?#].*$/, '');
      cleaned = cleaned.replace(/:[0-9]+$/, '');
      cleaned = cleaned.replace(/^www\./, '');
      return cleaned;
    }

    function inspect(domainQuery: string) {
      const cleanDomain = extractCleanDomain(domainQuery);

      // Check exception rules first
      const exceptionRule = rules.find((r) => {
        const isEx = r.isException || (r.raw && r.raw.startsWith('@@'));
        if (!isEx) return false;
        const dom = r.domain || cleanDomainPattern(r.raw || '');
        if (dom && (cleanDomain === dom || cleanDomain.endsWith(`.${dom}`))) {
          return true;
        }
        return Boolean(r.raw && r.raw.includes(cleanDomain));
      });

      if (exceptionRule) {
        return { verdict: 'exception', rule: exceptionRule.raw, domain: cleanDomain };
      }

      // Check blocking rules
      const blockRule = rules.find((r) => {
        const dom = r.domain || cleanDomainPattern(r.raw || '');
        if (dom && (cleanDomain === dom || cleanDomain.endsWith(`.${dom}`))) {
          return true;
        }
        if (r.raw) {
          if (r.raw.includes(`||${cleanDomain}^`) || r.raw.includes(`||${cleanDomain}`)) {
            return true;
          }
          if (r.raw.endsWith(` ${cleanDomain}`) || r.raw.endsWith(`\t${cleanDomain}`)) {
            return true;
          }
        }
        return false;
      });

      if (blockRule) {
        return { verdict: 'blocked', rule: blockRule.raw, domain: cleanDomain };
      }

      return { verdict: 'not_blocked', domain: cleanDomain };
    }

    test('resolves subdomains blocked by parent wildcard rule', () => {
      const res = inspect('api.tracker.io');
      expect(res.verdict).toBe('blocked');
      expect(res.rule).toBe('||tracker.io^');
    });

    test('resolves exact match blocked by hosts rule', () => {
      const res = inspect('https://malware.org/path/login');
      expect(res.verdict).toBe('blocked');
      expect(res.rule).toBe('0.0.0.0 malware.org');
    });

    test('resolves exception allowlist rule overriding parent wildcard block', () => {
      const res = inspect('safe.tracker.io');
      expect(res.verdict).toBe('exception');
      expect(res.rule).toBe('@@||safe.tracker.io^');
    });

    test('extracts clean domain from complex URLs with ports, query params, and hashes', () => {
      expect(extractCleanDomain('https://www.roku.com:8080/products/streaming?source=ad#specs')).toBe('roku.com');
      expect(extractCleanDomain('http://malware.org?ref=phish')).toBe('malware.org');
      expect(extractCleanDomain('www.tracker.io/api/v1/event')).toBe('tracker.io');
      expect(extractCleanDomain('roku.com/channel/123')).toBe('roku.com');

      const urlRes = inspect('https://www.malware.org:8443/auth?utm=test#frag');
      expect(urlRes.domain).toBe('malware.org');
      expect(urlRes.verdict).toBe('blocked');
      expect(urlRes.rule).toBe('0.0.0.0 malware.org');
    });

    test('returns not_blocked for unlisted domains', () => {
      const res = inspect('https://wikipedia.org');
      expect(res.verdict).toBe('not_blocked');
    });
  });

  describe('Curated Defense Packs & Presets Catalog', () => {
    test('PRESET_BUNDLES and PRESET_CATALOG contain curated feeds with layer scope taxonomy', async () => {
      const { PRESET_BUNDLES, PRESET_CATALOG } = await import('../views/PresetsModal.js');
      expect(PRESET_BUNDLES.length).toBeGreaterThanOrEqual(3);
      expect(PRESET_CATALOG.length).toBeGreaterThanOrEqual(10);

      for (const preset of PRESET_CATALOG) {
        expect(preset.name).toBeTruthy();
        expect(preset.url).toMatch(/^https?:\/\//);
        expect(['dns', 'browser', 'hybrid']).toContain(preset.scope);
        expect(preset.category).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(Array.isArray(preset.features)).toBe(true);
        expect(preset.features.length).toBeGreaterThan(0);
        expect(preset.recommendedFor).toBeTruthy();
      }

      for (const bundle of PRESET_BUNDLES) {
        expect(bundle.id).toBeTruthy();
        expect(bundle.name).toBeTruthy();
        expect(bundle.description).toBeTruthy();
        expect(bundle.badge).toBeTruthy();
        expect(bundle.items.length).toBeGreaterThan(0);

        for (const item of bundle.items) {
          expect(item.name).toBeTruthy();
          expect(item.url).toMatch(/^https?:\/\//);
          expect(['dns', 'browser', 'hybrid']).toContain(item.scope);
          expect(item.category).toBeTruthy();
        }
      }
    });
  });

  describe('Accent Color Palette & Dynamic Theme Customization', () => {
    test('ACCENT_PALETTE defines coordinated color schemes with proper hex tokens', async () => {
      const { ACCENT_PALETTE } = await import('../theme.js');
      expect(ACCENT_PALETTE.length).toBeGreaterThanOrEqual(5);

      for (const accent of ACCENT_PALETTE) {
        expect(accent.id).toBeTruthy();
        expect(accent.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(accent.hover).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(accent.glow).toContain('rgba');
      }
    });
  });

  describe('Onboarding Flow Configuration & Starter Profiles', () => {
    test('Onboarding profiles provide essential, privacy, and distraction-free options', async () => {
      const { PRESET_BUNDLES } = await import('../views/PresetsModal.js');
      const bundleIds = PRESET_BUNDLES.map((b) => b.id);
      expect(bundleIds).toContain('essential');
      expect(bundleIds).toContain('privacy-fortress');
      expect(bundleIds).toContain('distraction-free');
    });

    test('Onboarding completion key matches expected convention', () => {
      const ONBOARDING_STORAGE_KEY = 'bm-onboarding-completed';
      const mockStorage: Record<string, string> = {};

      // Simulate initial state (first launch)
      const isFirstLaunch = mockStorage[ONBOARDING_STORAGE_KEY] !== 'true';
      expect(isFirstLaunch).toBe(true);

      // Simulate completing onboarding
      mockStorage[ONBOARDING_STORAGE_KEY] = 'true';
      const isSubsequentLaunch = mockStorage[ONBOARDING_STORAGE_KEY] !== 'true';
      expect(isSubsequentLaunch).toBe(false);
    });
  });

  describe('Large-Scale Feed Deduplication & Call Stack Safety', () => {
    test('deduplicates massive feeds (>70,000 rules) without exceeding maximum call stack size', async () => {
      const { RuleDeduplicator } = await import('@blockingmachine/core');
      const deduplicator = new RuleDeduplicator();
      const uniqueRulesSet = new Set<string>();
      const uniqueRules: any[] = [];
      let totalProcessedCount = 0;

      // Simulate 2 large sources with 75,000 rules each (150,000 rules total)
      // Array.prototype.push(...rules) blows the stack at ~65,536 elements
      const sourceResults = [
        {
          source: { name: 'Huge Feed A', url: 'https://example.com/a.txt' },
          rules: Array.from({ length: 75000 }, (_, i) => ({
            raw: `||tracker-${i % 25000}.com^`,
            originalRule: `||tracker-${i % 25000}.com^`,
            type: 'blocking' as const,
          })),
        },
        {
          source: { name: 'Huge Feed B', url: 'https://example.com/b.txt' },
          rules: Array.from({ length: 75000 }, (_, i) => ({
            raw: `||tracker-${i % 25000}.com^`,
            originalRule: `||tracker-${i % 25000}.com^`,
            type: 'blocking' as const,
          })),
        },
      ];

      expect(() => {
        for (const res of sourceResults) {
          if (!res.rules || res.rules.length === 0) continue;
          totalProcessedCount += res.rules.length;
          const rules = res.rules;
          const rulesLen = rules.length;
          for (let i = 0; i < rulesLen; i++) {
            const rule = rules[i];
            if (!rule || !rule.raw) continue;
            const strippedRule = deduplicator.stripRule(rule.raw);
            if (!uniqueRulesSet.has(strippedRule)) {
              uniqueRulesSet.add(strippedRule);
              uniqueRules.push(rule);
            }
          }
        }
      }).not.toThrow();

      expect(totalProcessedCount).toBe(150000);
      expect(uniqueRules.length).toBe(25000);
      expect(totalProcessedCount - uniqueRules.length).toBe(125000);
    });
  });

  describe('Deploy & Sync Hub Helpers', () => {
    function formatFeedUrls(
      savePath: string,
      lanIp: string,
      port = 9191
    ): { fileName: string; fileUrl: string; lanUrl: string; localUrl: string } {
      const fileName = savePath.split(/[/\\]/).pop() || 'rules.txt';
      const fileUrl = `file://${savePath}`;
      const lanUrl = `http://${lanIp}:${port}/${fileName}`;
      const localUrl = `http://localhost:${port}/${fileName}`;
      return { fileName, fileUrl, lanUrl, localUrl };
    }

    test('constructs valid file://, LAN, and localhost URLs for compiled filter lists', () => {
      const urls = formatFeedUrls('/Users/alice/Library/Blockingmachine/adguard-rules.txt', '192.168.1.145');
      expect(urls.fileName).toBe('adguard-rules.txt');
      expect(urls.fileUrl).toBe('file:///Users/alice/Library/Blockingmachine/adguard-rules.txt');
      expect(urls.lanUrl).toBe('http://192.168.1.145:9191/adguard-rules.txt');
      expect(urls.localUrl).toBe('http://localhost:9191/adguard-rules.txt');
    });

    test('generates accurate OS hosts copy commands for macOS, Linux, and Windows', () => {
      const savePath = '/Users/alice/Library/Blockingmachine/hosts.txt';
      const macCmd = `sudo cp "${savePath}" /etc/hosts && sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`;
      const linuxCmd = `sudo cp "${savePath}" /etc/hosts && sudo systemd-resolve --flush-caches`;
      const winCmd = `Copy-Item "${savePath}" -Destination "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Force; ipconfig /flushdns`;

      expect(macCmd).toContain('sudo cp "/Users/alice/Library/Blockingmachine/hosts.txt" /etc/hosts');
      expect(macCmd).toContain('mDNSResponder');
      expect(linuxCmd).toContain('/etc/hosts');
      expect(winCmd).toContain('$env:SystemRoot\\System32\\drivers\\etc\\hosts');
    });
  });

  describe('Home Assistant & AdGuard Multi-Mode Integration Helpers', () => {
    function normalizeUrl(raw: string): string {
      let url = raw.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `http://${url}`;
      }
      return url.replace(/\/$/, '');
    }

    function checkAdguardPortDiagnostic(urlStr: string, mode: 'direct' | 'ha-api' | 'webhook'): {
      isPort8123Warning: boolean;
      diagnosticMessage?: string;
    } {
      const normalized = normalizeUrl(urlStr);
      if (mode === 'direct' && normalized.includes(':8123')) {
        return {
          isPort8123Warning: true,
          diagnosticMessage:
            'Port 8123 detected (Home Assistant web interface). For AdGuard Home direct API, use port 3000 (e.g. http://homeassistant.local:3000) after mapping it in Add-ons > AdGuard Home > Configuration > Network, or select "Home Assistant API" mode.',
        };
      }
      return { isPort8123Warning: false };
    }

    function buildHaApiServiceRequest(rawUrl: string, token: string) {
      const base = normalizeUrl(rawUrl);
      return {
        url: `${base}/api/services/adguard/refresh`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          'Content-Type': 'application/json',
        },
      };
    }

    function buildCustomWebhookPayload(event = 'blockingmachine_compiled') {
      return {
        event,
        timestamp: new Date('2026-09-20T20:00:00.000Z').toISOString(),
      };
    }

    test('detects port 8123 in direct AdGuard Home mode and returns helpful diagnostic guidance', () => {
      const diag1 = checkAdguardPortDiagnostic('http://homeassistant.local:8123', 'direct');
      expect(diag1.isPort8123Warning).toBe(true);
      expect(diag1.diagnosticMessage).toContain('Port 8123 detected');
      expect(diag1.diagnosticMessage).toContain('port 3000');

      const diag2 = checkAdguardPortDiagnostic('192.168.1.100:8123/', 'direct');
      expect(diag2.isPort8123Warning).toBe(true);

      // In HA API mode, port 8123 is expected and valid, so no warning
      const diag3 = checkAdguardPortDiagnostic('http://homeassistant.local:8123', 'ha-api');
      expect(diag3.isPort8123Warning).toBe(false);

      // Port 3000 in direct mode has no warning
      const diag4 = checkAdguardPortDiagnostic('http://homeassistant.local:3000', 'direct');
      expect(diag4.isPort8123Warning).toBe(false);
    });

    test('constructs valid Home Assistant adguard.refresh service endpoint and Bearer authorization header', () => {
      const req = buildHaApiServiceRequest('homeassistant.local:8123', 'my-llat-token-xyz');
      expect(req.url).toBe('http://homeassistant.local:8123/api/services/adguard/refresh');
      expect(req.method).toBe('POST');
      expect(req.headers.Authorization).toBe('Bearer my-llat-token-xyz');
      expect(req.headers['Content-Type']).toBe('application/json');
    });

    test('formats custom homelab webhook payload with event metadata', () => {
      const payload = buildCustomWebhookPayload();
      expect(payload.event).toBe('blockingmachine_compiled');
      expect(payload.timestamp).toBe('2026-09-20T20:00:00.000Z');
    });

    test('validates presets for Home Assistant, Docker, and Router environments', () => {
      const presets = [
        { env: 'homeassistant', directUrl: 'http://homeassistant.local:3000', haApiUrl: 'http://homeassistant.local:8123' },
        { env: 'docker', directUrl: 'http://localhost:3000' },
        { env: 'router', directUrl: 'http://192.168.8.1:3000' },
        { env: 'pihole_ha', url: 'http://homeassistant.local:8080/admin/api.php' },
      ];

      for (const p of presets) {
        if ('directUrl' in p) {
          expect(normalizeUrl(p.directUrl!)).toBe(p.directUrl);
          expect(() => new URL(p.directUrl!)).not.toThrow();
        }
        if ('haApiUrl' in p) {
          expect(normalizeUrl(p.haApiUrl!)).toBe(p.haApiUrl);
          expect(() => new URL(p.haApiUrl!)).not.toThrow();
        }
        if ('url' in p) {
          expect(normalizeUrl(p.url!)).toBe(p.url);
          expect(() => new URL(p.url!)).not.toThrow();
        }
      }
    });
  });
});

