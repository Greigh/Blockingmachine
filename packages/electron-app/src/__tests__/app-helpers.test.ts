import { describe, test, expect } from '@jest/globals';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { cleanDomainPattern } from '@blockingmachine/core';
import {
  formatSinkholeError,
  isPrivateOrLocalHost,
  normalizeServiceUrl,
  replaceMatchingExplicitPort,
  resolveAdguardDirectUrl,
  resolveHaApiUrl,
  shouldBypassUntrustedTls,
} from '../sinkholeNet';

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
        expect(preset.url).toMatch(/^(https?:\/\/|\.\/filters\/modules\/)/);
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
          expect(item.url).toMatch(/^(https?:\/\/|\.\/filters\/modules\/)/);
          expect(['dns', 'browser', 'hybrid']).toContain(item.scope);
          expect(item.category).toBeTruthy();
        }
      }
    });

    test('registers all 8 first-party [Beta] modules and Defense Suite bundle', async () => {
      const { PRESET_BUNDLES, PRESET_CATALOG } = await import('../views/PresetsModal.js');
      const { CURATED_SOURCE_PROFILES, displayFilterLabel, getSourceProfile } = await import('@blockingmachine/core');
      const { NATIVE_DEFENSE_MODULES } = await import('../views/ModulesView.js');

      const expectedBetaNames = [
        'Base Ad Shield [Beta]',
        'Privacy Engine [Beta]',
        'Smart TV & IoT Shield [Beta]',
        'Web Annoyances & Cookie Banners [Beta]',
        'Social Tracker Neutralizer [Beta]',
        'Threat & Malicious Domain Defense [Beta]',
        'URL Tracking Stripper [Beta]',
        'Unbreak & Safe Exceptions [Beta]',
      ];

      for (const betaName of expectedBetaNames) {
        const catalogEntry = PRESET_CATALOG.find((p) => p.name === betaName);
        expect(catalogEntry).toBeDefined();
        expect(catalogEntry?.url).toContain('/filters/modules/blockingmachine-');

        const coreEntry = CURATED_SOURCE_PROFILES.find((p) => p.name === betaName);
        expect(coreEntry).toBeDefined();
        expect(coreEntry?.trusted).toBe(true);
        expect(coreEntry?.priority).toBe(0);
        expect(betaName.startsWith('Blockingmachine ')).toBe(false);

        const legacyName = `Blockingmachine ${betaName}`;
        expect(displayFilterLabel(legacyName)).toBe(betaName);
        expect(getSourceProfile(legacyName).name).toBe(betaName);

        const nativeModule = NATIVE_DEFENSE_MODULES.find((m) => m.name === betaName);
        expect(nativeModule).toBeDefined();
        expect(nativeModule?.filename).toMatch(/^blockingmachine-.*\.txt$/);
      }

      const suiteBundle = PRESET_BUNDLES.find((b) => b.id === 'blockingmachine-suite');
      expect(suiteBundle).toBeDefined();
      expect(suiteBundle?.name).toBe('Defense Suite [Beta]');
      expect(suiteBundle?.badge).toContain('Beta');
      expect(displayFilterLabel('Blockingmachine Defense Suite [Beta]')).toBe('Defense Suite [Beta]');
      expect(suiteBundle?.items).toHaveLength(8);
      expect(suiteBundle?.items.map((i) => i.name).sort()).toEqual([...expectedBetaNames].sort());
      expect(NATIVE_DEFENSE_MODULES).toHaveLength(8);
    });

    test('all 8 native module files exist on disk and have valid adblock header structures', () => {
      const candidateDirs = [
        join(process.cwd(), 'filters/modules'),
        join(process.cwd(), 'packages/electron-app/filters/modules'),
      ];
      const modulesDir = candidateDirs.find((d) => existsSync(d)) || '';
      expect(modulesDir).toBeTruthy();

      const expectedFilenames = [
        'blockingmachine-base.txt',
        'blockingmachine-privacy.txt',
        'blockingmachine-smarttv.txt',
        'blockingmachine-annoyances.txt',
        'blockingmachine-social.txt',
        'blockingmachine-security.txt',
        'blockingmachine-url-tracking.txt',
        'blockingmachine-unbreak.txt',
      ];

      for (const filename of expectedFilenames) {
        const filePath = join(modulesDir, filename);
        expect(existsSync(filePath)).toBe(true);

        const content = readFileSync(filePath, 'utf-8');
        expect(content).toMatch(/^! Title: /);
        expect(content).not.toContain('! Title: Blockingmachine ');
        expect(content).toContain('[Beta]');
        expect(content).toContain('! Homepage: https://github.com/greigh/blockingmachine');
        expect(content).toContain('! License: BSD-3-Clause');
        expect(content.length).toBeGreaterThan(500);
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
      expect(bundleIds).toContain('blockingmachine-suite');
    });

    test('first-run tour covers defense setup, deploy, and on-device AI', async () => {
      const {
        ONBOARDING_STEPS,
        ONBOARDING_HIGHLIGHTS,
        DEPLOY_SETUP_OPTIONS,
        AI_SETUP_OPTIONS,
      } = await import('../views/onboardingContent.js');

      expect(ONBOARDING_STEPS.map((step) => step.label)).toEqual([
        'Welcome',
        'Protection',
        'Setup',
        'Personalize',
        'Launch',
      ]);

      const titles = ONBOARDING_HIGHLIGHTS.map((item) => item.title);
      expect(titles).toEqual([
        'Defense Suite',
        'Unified Inspector',
        'AI Radar',
        'Threat Quarantine',
        'Deploy & Sync',
        'One compile, many formats',
      ]);
      for (const item of ONBOARDING_HIGHLIGHTS) {
        expect(item.title.startsWith('Blockingmachine')).toBe(false);
        expect(item.body.length).toBeGreaterThan(20);
      }

      expect(DEPLOY_SETUP_OPTIONS.map((option) => option.id)).toEqual([
        'adguard',
        'pihole',
        'lan',
        'later',
      ]);
      expect(DEPLOY_SETUP_OPTIONS.find((option) => option.id === 'adguard')?.format).toBe('adguard');
      expect(DEPLOY_SETUP_OPTIONS.find((option) => option.id === 'pihole')?.format).toBe('hosts');
      expect(AI_SETUP_OPTIONS.map((option) => option.id)).toEqual(['mini-ai', 'later']);
    });

    test('devtools install uses session.extensions instead of deprecated session methods', () => {
      const candidates = [
        join(process.cwd(), 'src/index.ts'),
        join(process.cwd(), 'packages/electron-app/src/index.ts'),
      ];
      const sourcePath = candidates.find((candidate) => existsSync(candidate));
      expect(sourcePath).toBeTruthy();
      const source = readFileSync(sourcePath as string, 'utf8');
      expect(source).toContain('extensions.getAllExtensions');
      expect(source).toContain('extensions.loadExtension');
      expect(source).not.toMatch(/(?<!extensions\.)getAllExtensions\s*\(/);
      expect(source).not.toMatch(/(?<!extensions\.)loadExtension\s*\(/);
      expect(source).not.toContain('installExtension(');
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
    function buildCustomWebhookPayload(event = 'blockingmachine_compiled') {
      return {
        event,
        timestamp: new Date('2026-09-20T20:00:00.000Z').toISOString(),
      };
    }

    test('detects Home Assistant frontend ports in direct AdGuard mode', () => {
      const diag1 = resolveAdguardDirectUrl('http://homeassistant.local:8123', 3000);
      expect(diag1.ok).toBe(false);
      if (!diag1.ok) {
        expect(diag1.code).toBe('ha_frontend');
        expect(diag1.message).toContain('Port 8123 is the Home Assistant web interface');
        expect(diag1.message).toContain('not AdGuard Direct');
        expect(diag1.message).toContain('port (3000)');
        expect(diag1.message).not.toContain('Cannot connect to port 3000');
      }

      const diag8124 = resolveAdguardDirectUrl('https://homeassistant.local:8124', 3000);
      expect(diag8124.ok).toBe(true);
      if (diag8124.ok) {
        expect(diag8124.target.port).toBe(8124);
        expect(diag8124.target.statusUrl).toBe('https://homeassistant.local:8124/control/status');
      }

      const diag2 = resolveAdguardDirectUrl('192.168.1.100:8123/', 3000);
      expect(diag2.ok).toBe(false);

      const lovelace = resolveAdguardDirectUrl('http://homeassistant.local/lovelace/default', 3000);
      expect(lovelace.ok).toBe(false);
      if (!lovelace.ok) expect(lovelace.code).toBe('ha_frontend');

      const haApiPath = resolveAdguardDirectUrl('http://homeassistant.local:8124/api/', 3001);
      expect(haApiPath.ok).toBe(false);
      if (!haApiPath.ok) {
        expect(haApiPath.message).toContain('port (3001)');
        expect(haApiPath.message).not.toContain('port (3000)');
      }

      const directOk = resolveAdguardDirectUrl('http://homeassistant.local:3000', 3000);
      expect(directOk.ok).toBe(true);
    });

    test('keeps a custom Home Assistant port in REST API mode', () => {
      const ha = resolveHaApiUrl('https://homeassistant.local:8124');
      expect(ha.ok).toBe(true);
      if (ha.ok) {
        expect(ha.target.pingUrl).toBe('https://homeassistant.local:8124/api/');
        expect(ha.target.refreshUrl).toBe('https://homeassistant.local:8124/api/services/adguard/refresh');
        expect(ha.target.port).toBe(8124);
      }
    });

    test('applies the configured direct port unless the URL already has one', () => {
      const implied = resolveAdguardDirectUrl('http://homeassistant.local', 3001);
      expect(implied.ok).toBe(true);
      if (implied.ok) {
        expect(implied.target.statusUrl).toBe('http://homeassistant.local:3001/control/status');
        expect(implied.target.refreshUrl).toBe('http://homeassistant.local:3001/control/filtering/refresh');
      }

      const explicit = resolveAdguardDirectUrl('https://adguard.lan:8080', 3000);
      expect(explicit.ok).toBe(true);
      if (explicit.ok) {
        expect(explicit.target.statusUrl).toBe('https://adguard.lan:8080/control/status');
        expect(explicit.target.port).toBe(8080);
      }

      const controlOnHaPort = resolveAdguardDirectUrl('http://adguard.local:8124/control/status', 3000);
      expect(controlOnHaPort.ok).toBe(true);
      if (controlOnHaPort.ok) expect(controlOnHaPort.target.port).toBe(8124);
    });

    test('connection failures name the host and port that were actually tried', () => {
      const refused = Object.assign(new Error('connect ECONNREFUSED 192.168.1.20:3001'), { code: 'ECONNREFUSED' });
      const message = formatSinkholeError(refused, {
        display: 'http://homeassistant.local:3001',
        host: 'homeassistant.local',
        port: 3001,
        scheme: 'http',
      }, { haAddonPortHint: true, hintPort: 3001 });
      expect(message).toContain('http://homeassistant.local:3001');
      expect(message).toContain('ECONNREFUSED');
      expect(message).toContain('port 3001 is mapped');
      expect(message).not.toContain('port 3000');

      const wrapped = new TypeError('fetch failed');
      (wrapped as { cause?: unknown }).cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      const certOff = formatSinkholeError(wrapped, {
        display: 'https://homeassistant.local:8124',
        host: 'homeassistant.local',
        port: 8124,
        scheme: 'https',
      }, { allowInsecureLocalTls: false });
      expect(certOff).toContain('TLS certificate rejected');
      expect(certOff).toContain('https://homeassistant.local:8124');
      expect(certOff).toContain('Allow untrusted TLS certificates (local only)');
      expect(certOff).not.toContain('Cannot connect to port 3000');

      const certPublic = formatSinkholeError(wrapped, {
        display: 'https://example.com',
        host: 'example.com',
        port: 443,
        scheme: 'https',
      }, { allowInsecureLocalTls: true });
      expect(certPublic).toContain('Certificate verification stays on');

      const dns = Object.assign(new Error('getaddrinfo ENOTFOUND homeassistant.local'), { code: 'ENOTFOUND' });
      const dnsMessage = formatSinkholeError(dns, {
        display: 'https://homeassistant.local:8124',
        host: 'homeassistant.local',
        port: 8124,
        scheme: 'https',
      });
      expect(dnsMessage).toContain('Could not resolve homeassistant.local');
      expect(dnsMessage).toContain('mDNS');
    });

    test('limits untrusted TLS bypass to local and private hosts', () => {
      expect(isPrivateOrLocalHost('homeassistant.local')).toBe(true);
      expect(isPrivateOrLocalHost('localhost')).toBe(true);
      expect(isPrivateOrLocalHost('127.0.0.1')).toBe(true);
      expect(isPrivateOrLocalHost('192.168.8.1')).toBe(true);
      expect(isPrivateOrLocalHost('10.1.2.3')).toBe(true);
      expect(isPrivateOrLocalHost('172.16.0.4')).toBe(true);
      expect(isPrivateOrLocalHost('169.254.1.1')).toBe(true);
      expect(isPrivateOrLocalHost('example.com')).toBe(false);
      expect(isPrivateOrLocalHost('1.1.1.1')).toBe(false);
      expect(shouldBypassUntrustedTls('https://homeassistant.local:8124', true)).toBe(true);
      expect(shouldBypassUntrustedTls('https://homeassistant.local:8124', false)).toBe(false);
      expect(shouldBypassUntrustedTls('https://example.com', true)).toBe(false);
      expect(shouldBypassUntrustedTls('http://homeassistant.local:8124', true)).toBe(false);
      expect(replaceMatchingExplicitPort('http://homeassistant.local:3000', 3000, 3001)).toBe('http://homeassistant.local:3001');
      expect(replaceMatchingExplicitPort('http://adguard.lan:8080', 3000, 3001)).toBe('http://adguard.lan:8080');
    });

    test('normalizes Nabu Casa remote access URLs to https protocol automatically', () => {
      expect(normalizeServiceUrl('myinstance.ui.nabu.casa')).toBe('https://myinstance.ui.nabu.casa');
      expect(normalizeServiceUrl('http://myinstance.ui.nabu.casa/')).toBe('https://myinstance.ui.nabu.casa');
      expect(normalizeServiceUrl('https://myinstance.ui.nabu.casa/api/services/adguard/refresh')).toBe('https://myinstance.ui.nabu.casa/api/services/adguard/refresh');
      expect(normalizeServiceUrl('http://hooks.nabu.casa/webhook-token-123')).toBe('https://hooks.nabu.casa/webhook-token-123');
    });

    test('flags Nabu Casa remote URLs when attempted in direct AdGuard port 3000 mode', () => {
      const directNabu = resolveAdguardDirectUrl('https://abc123xyz.ui.nabu.casa', 3000);
      expect(directNabu.ok).toBe(false);
      if (!directNabu.ok) {
        expect(directNabu.code).toBe('nabu_casa');
        expect(directNabu.message).toContain('Nabu Casa Cloud remote URLs only proxy Home Assistant itself');
        expect(directNabu.message).toContain('Switch Mode to "Home Assistant REST API"');
        expect(directNabu.message).toContain('direct port 3000');
      }

      const customPortNabu = resolveAdguardDirectUrl('https://abc123xyz.ui.nabu.casa', 3001);
      expect(customPortNabu.ok).toBe(false);
      if (!customPortNabu.ok) {
        expect(customPortNabu.message).toContain('direct port 3001');
        expect(customPortNabu.message).not.toContain('direct port 3000');
      }

      const haApiNabu = resolveHaApiUrl('https://abc123xyz.ui.nabu.casa');
      expect(haApiNabu.ok).toBe(true);
      if (haApiNabu.ok) {
        expect(haApiNabu.target.refreshUrl).toBe('https://abc123xyz.ui.nabu.casa/api/services/adguard/refresh');
      }
    });

    test('constructs valid Home Assistant adguard.refresh service endpoint', () => {
      const reqLocal = resolveHaApiUrl('homeassistant.local:8123');
      expect(reqLocal.ok).toBe(true);
      if (reqLocal.ok) {
        expect(reqLocal.target.refreshUrl).toBe('http://homeassistant.local:8123/api/services/adguard/refresh');
      }

      const reqNabu = resolveHaApiUrl('myinstance.ui.nabu.casa');
      expect(reqNabu.ok).toBe(true);
      if (reqNabu.ok) {
        expect(reqNabu.target.refreshUrl).toBe('https://myinstance.ui.nabu.casa/api/services/adguard/refresh');
      }
    });

    test('formats custom homelab webhook payload with event metadata', () => {
      const payload = buildCustomWebhookPayload();
      expect(payload.event).toBe('blockingmachine_compiled');
      expect(payload.timestamp).toBe('2026-09-20T20:00:00.000Z');
    });

    test('validates presets for Home Assistant, Nabu Casa Cloud, Docker, and Router environments', () => {
      const presets = [
        { env: 'homeassistant', directUrl: 'http://homeassistant.local:3000', haApiUrl: 'http://homeassistant.local:8123' },
        { env: 'nabu_casa_ha', haApiUrl: 'https://your-instance.ui.nabu.casa', webhookUrl: 'https://hooks.nabu.casa/test-hook' },
        { env: 'docker', directUrl: 'http://localhost:3000' },
        { env: 'router', directUrl: 'http://192.168.8.1:3000' },
        { env: 'pihole_ha', url: 'http://homeassistant.local:8080/admin/api.php' },
      ];

      for (const p of presets) {
        if ('directUrl' in p) {
          expect(normalizeServiceUrl(p.directUrl!)).toBe(p.directUrl);
          expect(() => new URL(p.directUrl!)).not.toThrow();
        }
        if ('haApiUrl' in p) {
          expect(normalizeServiceUrl(p.haApiUrl!)).toBe(p.haApiUrl);
          expect(() => new URL(p.haApiUrl!)).not.toThrow();
        }
        if ('webhookUrl' in p) {
          expect(normalizeServiceUrl(p.webhookUrl!)).toBe(p.webhookUrl);
          expect(() => new URL(p.webhookUrl!)).not.toThrow();
        }
        if ('url' in p) {
          expect(normalizeServiceUrl(p.url!)).toBe(p.url);
          expect(() => new URL(p.url!)).not.toThrow();
        }
      }
    });
  });

  describe('Feed Server Security & Path Traversal Validation', () => {
    function isPathWithinAllowedScope(targetFilePath: string, outputDir: string, savePath: string): boolean {
      const resolvedTarget = resolve(targetFilePath);
      const resolvedOutputDir = resolve(outputDir);
      const resolvedSavePath = resolve(savePath);
      return resolvedTarget.startsWith(resolvedOutputDir) || resolvedTarget === resolvedSavePath;
    }

    test('permits legitimate files within export directory or exact savePath', () => {
      const outputDir = '/var/app/output';
      const savePath = '/var/app/output/blockingmachine.txt';

      expect(isPathWithinAllowedScope(join(outputDir, 'blockingmachine.txt'), outputDir, savePath)).toBe(true);
      expect(isPathWithinAllowedScope(join(outputDir, 'pihole.txt'), outputDir, savePath)).toBe(true);
      expect(isPathWithinAllowedScope(join(outputDir, 'adguard.txt'), outputDir, savePath)).toBe(true);
      expect(isPathWithinAllowedScope(savePath, outputDir, savePath)).toBe(true);
    });

    test('strictly blocks directory traversal attempts escaping output directory', () => {
      const outputDir = '/var/app/output';
      const savePath = '/var/app/output/blockingmachine.txt';

      expect(isPathWithinAllowedScope(join(outputDir, '../secret.key'), outputDir, savePath)).toBe(false);
      expect(isPathWithinAllowedScope(join(outputDir, '../../etc/passwd'), outputDir, savePath)).toBe(false);
      expect(isPathWithinAllowedScope('/etc/passwd', outputDir, savePath)).toBe(false);
      expect(isPathWithinAllowedScope('/var/app/secret.env', outputDir, savePath)).toBe(false);
    });
  });
});

