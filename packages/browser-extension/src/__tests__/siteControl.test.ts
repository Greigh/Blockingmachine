import { describe, expect, it } from '@jest/globals';
import {
  EMPTY_SITE_CONTROL,
  badgeTextFor,
  blockRuleFor,
  countBlockedDomains,
  deriveShieldStatus,
  filterTrackers,
  formatBlockedCount,
  isDomainAllowed,
  isSitePaused,
  normalizeSite,
  normalizeSiteControl,
  normalizeSiteList,
  allowRuleFor,
  resolveSitePaused,
  ruleSourceLabel,
  setDomainAllowed,
  setGlobalPaused,
  setSitePaused,
  shieldStatusDetail,
  shieldStatusLabel,
  siteFromUrl,
  sortTrackers,
  type SiteControlState,
} from '../shared/siteControl.js';
import { planSiteControlRules } from '../background/dnrManager.js';
import {
  PRIORITY_SITE_PAUSE,
  PRIORITY_USER_ALLOW,
} from '../shared/constants.js';
import type { TrackerDetection } from '../shared/types.js';

const tracker = (domain: string, blockedCount: number): TrackerDetection => ({
  domain,
  category: 'tracker',
  blockedCount,
  firstParty: false,
});

describe('normalizeSite', () => {
  it('canonicalises hostnames, URLs, and case', () => {
    expect(normalizeSite('Example.COM')).toBe('example.com');
    expect(normalizeSite('https://Example.com/path?q=1')).toBe('example.com');
    expect(normalizeSite('  status.cursor.com  ')).toBe('status.cursor.com');
    expect(normalizeSite('.example.com.')).toBe('example.com');
  });

  it('treats www and bare host as one site', () => {
    expect(normalizeSite('www.example.com')).toBe('example.com');
    expect(normalizeSite('https://www.example.co.uk/a')).toBe('example.co.uk');
  });

  it('keeps www when it is the registrable label itself', () => {
    expect(normalizeSite('www.com')).toBe('www.com');
  });

  it('rejects anything that can never be a site key', () => {
    expect(normalizeSite('')).toBe('');
    expect(normalizeSite('   ')).toBe('');
    expect(normalizeSite(undefined)).toBe('');
    expect(normalizeSite(42)).toBe('');
    expect(normalizeSite('localhost')).toBe('');
    expect(normalizeSite('chrome://settings')).toBe('');
    expect(normalizeSite('file:///etc/hosts')).toBe('');
    expect(normalizeSite('http://')).toBe('');
    expect(normalizeSite('-bad.example.com')).toBe('');
    expect(normalizeSite('exa mple.com')).toBe('');
    expect(normalizeSite(`${'a'.repeat(250)}.com`)).toBe('');
  });

  it('extracts the pausable site from a tab URL only for web pages', () => {
    expect(siteFromUrl('https://news.example.com/story')).toBe('news.example.com');
    expect(siteFromUrl('http://example.com')).toBe('example.com');
    expect(siteFromUrl('chrome-extension://abc/popup.html')).toBeNull();
    expect(siteFromUrl('about:blank')).toBeNull();
    expect(siteFromUrl(undefined)).toBeNull();
    expect(siteFromUrl('not a url')).toBeNull();
  });
});

describe('normalizeSiteControl', () => {
  it('repairs arbitrary stored data', () => {
    expect(normalizeSiteControl(null)).toEqual(EMPTY_SITE_CONTROL);
    expect(normalizeSiteControl('nonsense')).toEqual(EMPTY_SITE_CONTROL);

    const repaired = normalizeSiteControl({
      pausedSites: ['WWW.Example.com', 'example.com', 'bad host', 7],
      allowedDomains: ['https://cdn.example.net/x'],
      globalPaused: 'yes',
    });
    expect(repaired.pausedSites).toEqual(['example.com']);
    expect(repaired.allowedDomains).toEqual(['cdn.example.net']);
    expect(repaired.globalPaused).toBe(false);
  });

  it('de-duplicates and sorts site lists', () => {
    expect(normalizeSiteList(['b.com', 'a.com', 'B.com', ''])).toEqual(['a.com', 'b.com']);
    expect(normalizeSiteList('not-an-array')).toEqual([]);
  });
});

describe('site matching', () => {
  const state: SiteControlState = {
    pausedSites: ['example.com'],
    allowedDomains: ['cdn.example.net'],
    globalPaused: false,
  };

  it('pauses a site and all of its subdomains', () => {
    expect(isSitePaused(state, 'example.com')).toBe(true);
    expect(isSitePaused(state, 'news.example.com')).toBe(true);
    expect(isSitePaused(state, 'notexample.com')).toBe(false);
    expect(isSitePaused(state, 'example.com.evil.net')).toBe(false);
  });

  it('allows a domain and its subdomains', () => {
    expect(isDomainAllowed(state, 'cdn.example.net')).toBe(true);
    expect(isDomainAllowed(state, 'static.cdn.example.net')).toBe(true);
    expect(isDomainAllowed(state, 'example.net')).toBe(false);
  });
});

describe('state transitions', () => {
  it('adds, replaces, and removes a paused site', () => {
    const paused = setSitePaused(EMPTY_SITE_CONTROL, 'https://www.example.com', true);
    expect(paused.pausedSites).toEqual(['example.com']);

    const stillPaused = setSitePaused(paused, 'example.com', true);
    expect(stillPaused.pausedSites).toEqual(['example.com']);

    expect(setSitePaused(paused, 'example.com', false).pausedSites).toEqual([]);
  });

  it('ignores nonsense input for a state change', () => {
    expect(setSitePaused(EMPTY_SITE_CONTROL, 'localhost', true)).toEqual(EMPTY_SITE_CONTROL);
    expect(setDomainAllowed(EMPTY_SITE_CONTROL, '', true)).toEqual(EMPTY_SITE_CONTROL);
  });

  it('keeps the original object untouched', () => {
    const next = setSitePaused(EMPTY_SITE_CONTROL, 'example.com', true);
    expect(EMPTY_SITE_CONTROL.pausedSites).toEqual([]);
    expect(next).not.toBe(EMPTY_SITE_CONTROL);
  });

  it('coerces the global pause flag to a boolean', () => {
    expect(setGlobalPaused(EMPTY_SITE_CONTROL, true).globalPaused).toBe(true);
    expect(
      setGlobalPaused(EMPTY_SITE_CONTROL, 'nope' as unknown as boolean).globalPaused,
    ).toBe(false);
  });
});

describe('shield status', () => {
  it('derives the most specific status and describes it', () => {
    expect(deriveShieldStatus(EMPTY_SITE_CONTROL, 'example.com')).toBe('active');

    const sitePaused = setSitePaused(EMPTY_SITE_CONTROL, 'example.com', true);
    expect(deriveShieldStatus(sitePaused, 'example.com')).toBe('site-paused');
    expect(deriveShieldStatus(sitePaused, 'other.com')).toBe('active');

    const global = setGlobalPaused(sitePaused, true);
    expect(deriveShieldStatus(global, 'example.com')).toBe('global-paused');
  });

  it('treats either pause signal as paused, so a view never contradicts itself', () => {
    // The background's convenience flag arriving before/without the list.
    expect(resolveSitePaused({ sitePaused: true, pausedSites: [] }, 'example.com')).toBe(true);
    // The list arriving without the flag.
    expect(resolveSitePaused({ sitePaused: false, pausedSites: ['example.com'] }, 'example.com')).toBe(
      true,
    );
    expect(resolveSitePaused({ sitePaused: true }, 'other.com')).toBe(true);
    expect(resolveSitePaused(null, 'example.com')).toBe(false);
    expect(resolveSitePaused({ pausedSites: ['example.com'] }, 'other.com')).toBe(false);

    // The header and the switch must agree in every combination.
    const combos = [
      { globalPaused: false, sitePaused: false, pausedSites: [] as string[] },
      { globalPaused: false, sitePaused: true, pausedSites: [] as string[] },
      { globalPaused: false, sitePaused: false, pausedSites: ['example.com'] },
      { globalPaused: false, sitePaused: true, pausedSites: ['example.com'] },
    ];
    for (const combo of combos) {
      const status = deriveShieldStatus(combo, 'example.com');
      const paused = resolveSitePaused(combo, 'example.com');
      expect(paused).toBe(status === 'site-paused');
    }
  });

  it('has a label and an explanation for every status', () => {
    expect(shieldStatusLabel('active')).toBe('Active');
    expect(shieldStatusLabel('site-paused')).toBe('Paused here');
    expect(shieldStatusLabel('global-paused')).toBe('Paused');
    expect(shieldStatusDetail('site-paused', 'example.com')).toContain('example.com');
    expect(shieldStatusDetail('global-paused')).toContain('every site');
    expect(shieldStatusDetail('active', 'example.com')).toContain('example.com');
    expect(shieldStatusDetail('active', null)).toContain('this page');
  });
});

describe('rule generation helpers', () => {
  it('builds exception and block rules only for valid domains', () => {
    expect(allowRuleFor('https://www.example.com/x')).toBe('@@||example.com^');
    expect(allowRuleFor('not a domain')).toBeNull();
    expect(blockRuleFor('example.com')).toBe('||example.com^');
    expect(blockRuleFor('')).toBeNull();
  });

  it('labels where a block came from', () => {
    expect(ruleSourceLabel('user')).toBe('Your rule');
    expect(ruleSourceLabel('list')).toBe('Blocklist');
  });
});

describe('planSiteControlRules', () => {
  it('pauses a site by allowing the frame and everything it loads', () => {
    const [rule] = planSiteControlRules({ pausedSites: ['www.example.com'] });
    expect(rule.action).toBe('allowAllRequests');
    expect(rule.pattern).toBe('||example.com^');
    expect(rule.priority).toBe(PRIORITY_SITE_PAUSE);
    expect(rule.resourceTypes).toEqual(['main_frame', 'sub_frame']);
  });

  it('allows a single domain without pausing the page', () => {
    const [rule] = planSiteControlRules({ allowedDomains: ['cdn.example.net'] });
    expect(rule.action).toBe('allow');
    expect(rule.pattern).toBe('||cdn.example.net^');
    expect(rule.priority).toBe(PRIORITY_USER_ALLOW);
    expect(rule.resourceTypes).toContain('script');
    expect(rule.resourceTypes).not.toContain('main_frame');
  });

  it('always outranks blocklist-derived priorities', () => {
    expect(PRIORITY_USER_ALLOW).toBeGreaterThan(4);
    expect(PRIORITY_SITE_PAUSE).toBeGreaterThan(PRIORITY_USER_ALLOW);
  });

  it('skips unusable entries instead of emitting invalid filters', () => {
    const planned = planSiteControlRules({
      pausedSites: ['localhost', '', 'chrome://x'],
      allowedDomains: ['not a domain'],
    });
    expect(planned).toEqual([]);
  });

  it('produces nothing when there are no decisions', () => {
    expect(planSiteControlRules()).toEqual([]);
    expect(planSiteControlRules({ globalPaused: true })).toEqual([]);
  });
});

describe('popup display helpers', () => {
  it('formats blocked counts compactly', () => {
    expect(formatBlockedCount(0)).toBe('0');
    expect(formatBlockedCount(-5)).toBe('0');
    expect(formatBlockedCount(999)).toBe('999');
    expect(formatBlockedCount(1200)).toBe('1.2k');
    expect(formatBlockedCount(15_400)).toBe('15k');
    expect(formatBlockedCount(2_500_000)).toBe('2.5M');
    expect(formatBlockedCount(Number.NaN)).toBe('0');
  });

  it('caps the badge so the icon never clips', () => {
    expect(badgeTextFor(0)).toBe('');
    expect(badgeTextFor(7)).toBe('7');
    expect(badgeTextFor(99)).toBe('99');
    expect(badgeTextFor(100)).toBe('99+');
    expect(badgeTextFor(-1)).toBe('');
  });

  it('counts distinct blocked domains', () => {
    expect(countBlockedDomains([tracker('a.com', 3), tracker('a.com', 1), tracker('b.com', 1)])).toBe(2);
    expect(countBlockedDomains([])).toBe(0);
  });

  it('filters and sorts trackers', () => {
    const list = [tracker('b.com', 1), tracker('ads.example.com', 9), tracker('a.com', 4)];

    expect(filterTrackers(list, '  EXAMPLE ').map((t) => t.domain)).toEqual(['ads.example.com']);
    expect(filterTrackers(list, '').length).toBe(3);
    expect(sortTrackers(list, 'count').map((t) => t.domain)).toEqual(['ads.example.com', 'a.com', 'b.com']);
    expect(sortTrackers(list, 'name').map((t) => t.domain)).toEqual(['a.com', 'ads.example.com', 'b.com']);
    expect(list.map((t) => t.domain)).toEqual(['b.com', 'ads.example.com', 'a.com']);
  });
});
