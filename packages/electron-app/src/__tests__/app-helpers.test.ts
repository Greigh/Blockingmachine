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

    function inspect(domainQuery: string) {
      const cleanDomain = domainQuery
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '')
        .replace(/:[0-9]+$/, '');

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
        return { verdict: 'exception', rule: exceptionRule.raw };
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
        return { verdict: 'blocked', rule: blockRule.raw };
      }

      return { verdict: 'not_blocked' };
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

    test('returns not_blocked for unlisted domains', () => {
      const res = inspect('https://wikipedia.org');
      expect(res.verdict).toBe('not_blocked');
    });
  });
});
