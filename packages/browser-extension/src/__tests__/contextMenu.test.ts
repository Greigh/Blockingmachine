import { describe, expect, test } from '@jest/globals';
import {
  MENU_ITEMS,
  MENU_ROOT_ID,
  actionForMenuItem,
  cleanUrlFor,
  describeElementVerdict,
  describeTabActivity,
  hostOf,
  registrableDomainOf,
  resolveMenuClick,
  scopeForAction,
  urlFilterFor,
} from '../background/contextMenu.js';

describe('menu tree', () => {
  test('has a single root and every child points at an existing parent', () => {
    const ids = new Set(MENU_ITEMS.map((item) => item.id));
    const roots = MENU_ITEMS.filter((item) => !item.parentId);

    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe(MENU_ROOT_ID);

    for (const item of MENU_ITEMS) {
      if (item.parentId) expect(ids.has(item.parentId)).toBe(true);
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.contexts.length).toBeGreaterThan(0);
    }
  });

  test('has no duplicate ids', () => {
    const ids = MENU_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('exposes the element-level actions the user asked for', () => {
    const ids = MENU_ITEMS.map((item) => item.id);
    for (const id of [
      'block_element',
      'block_similar',
      'pick_element',
      'block_domain',
      'block_link_domain',
      'block_url',
      'allow_site',
      'resume_site',
      'allow_domain',
      'toggle_pause',
      'copy_selector',
      'copy_domain',
      'copy_url',
      'copy_rule',
      'analyse_page',
      'show_status',
      'open_hub',
    ]) {
      expect(ids).toContain(id);
    }
  });

  test('restricts link-only actions to linkish contexts', () => {
    const linkedOnly = MENU_ITEMS.filter((item) =>
      ['block_link_domain', 'block_url', 'allow_domain'].includes(item.id),
    );
    expect(linkedOnly).toHaveLength(3);
    for (const item of linkedOnly) {
      expect(item.contexts).toContain('link');
      expect(item.contexts).not.toContain('page');
    }
  });
});

describe('action routing', () => {
  test('maps ids to actions and knows where each one runs', () => {
    expect(actionForMenuItem('block_element')).toBe('block_element');
    expect(actionForMenuItem('block_similar')).toBe('block_similar');
    expect(actionForMenuItem('pick_element')).toBe('pick_element');
    expect(actionForMenuItem('copy_selector')).toBe('copy_selector');
    expect(actionForMenuItem('nonsense')).toBe('none');
    expect(actionForMenuItem('bm-root')).toBe('none');

    // Element actions must run in the clicked frame; the rest live in the worker.
    expect(scopeForAction('block_element')).toBe('frame');
    expect(scopeForAction('block_similar')).toBe('frame');
    expect(scopeForAction('pick_element')).toBe('frame');
    expect(scopeForAction('copy_selector')).toBe('frame');
    expect(scopeForAction('block_domain')).toBe('background');
    expect(scopeForAction('toggle_pause')).toBe('background');
    expect(scopeForAction('open_hub')).toBe('background');
  });

  test('resolves the target of each action from the click context', () => {
    const info = {
      menuItemId: 'block_domain',
      pageUrl: 'https://news.example.co.uk/story?utm_source=x',
      linkUrl: 'https://ads.tracker.net/click',
    };

    expect(resolveMenuClick(info)).toEqual({ action: 'block_domain', domain: 'example.co.uk' });
    expect(resolveMenuClick({ ...info, menuItemId: 'block_link_domain' })).toEqual({
      action: 'block_link_domain',
      domain: 'tracker.net',
    });
    expect(resolveMenuClick({ ...info, menuItemId: 'block_url' })).toEqual({
      action: 'block_url',
      url: 'https://ads.tracker.net/click',
    });
    // Site actions carry the URL so the exact host is paused, not the whole zone.
    expect(resolveMenuClick({ ...info, menuItemId: 'allow_site' })).toEqual({
      action: 'allow_site',
      url: 'https://news.example.co.uk/story?utm_source=x',
    });
    expect(resolveMenuClick({ ...info, menuItemId: 'copy_domain' })).toEqual({
      action: 'copy_domain',
      domain: 'example.co.uk',
    });
  });

  test('never silently substitutes the page domain for a missing link target', () => {
    // Blocking the page you are looking at because an image had no `src` would
    // be a nasty surprise, so an empty target stays empty and the worker
    // reports it instead of acting.
    expect(
      resolveMenuClick({ menuItemId: 'block_link_domain', pageUrl: 'https://a.example.com/x' }),
    ).toEqual({ action: 'block_link_domain', domain: '' });
    expect(resolveMenuClick({ menuItemId: 'block_url', pageUrl: 'https://a.example.com/x' })).toEqual(
      { action: 'block_url', url: undefined },
    );
  });
});

describe('url handling', () => {
  test('extracts hosts and registrable domains', () => {
    expect(hostOf('https://News.Example.COM/a?b=1')).toBe('news.example.com');
    expect(hostOf('chrome://settings')).toBe('');
    expect(hostOf('not a url')).toBe('');

    expect(registrableDomainOf('https://news.example.co.uk/x')).toBe('example.co.uk');
    expect(registrableDomainOf('https://a.b.example.com/x')).toBe('example.com');
    expect(registrableDomainOf('https://example.com')).toBe('example.com');
    expect(registrableDomainOf('https://192.168.1.10/x')).toBe('192.168.1.10');
    expect(registrableDomainOf('')).toBe('');
  });

  test('resolves shared-hosting tenants to themselves, never the platform apex', () => {
    // Flag 51: "Block the linked domain" on a hosted tenant must install the tenant's
    // name — `||evil.blogspot.com^` — never `||blogspot.com^`, which would sink every
    // site on the platform.
    expect(registrableDomainOf('https://evil.blogspot.com/x')).toBe('evil.blogspot.com');
    expect(registrableDomainOf('https://user.github.io/page')).toBe('user.github.io');
    expect(registrableDomainOf('https://app.pythonanywhere.com/x')).toBe('app.pythonanywhere.com');
    expect(registrableDomainOf('https://shop.myshopify.com/x')).toBe('shop.myshopify.com');
    expect(registrableDomainOf('https://blogspot.com/')).toBe('blogspot.com');
    expect(
      resolveMenuClick({ menuItemId: 'block_link_domain', linkUrl: 'https://evil.blogspot.com/x' }),
    ).toEqual({ action: 'block_link_domain', domain: 'evil.blogspot.com' });
  });

  test('builds an exact-URL filter that cannot match other pages', () => {
    expect(urlFilterFor('https://cdn.example.com/ads/banner.js?v=2')).toBe(
      '|https://cdn.example.com/ads/banner.js?v=2|',
    );
    expect(urlFilterFor('https://cdn.example.com/ads/banner.js#fragment')).toBe(
      '|https://cdn.example.com/ads/banner.js|',
    );
    expect(urlFilterFor('file:///etc/hosts')).toBeNull();
    expect(urlFilterFor('')).toBeNull();
    expect(urlFilterFor(`https://example.com/${'a'.repeat(400)}`)).toBeNull();
  });

  test('strips tracking parameters from copied URLs', () => {
    expect(cleanUrlFor('https://example.com/p?utm_source=x&id=7&fbclid=abc#frag')).toBe(
      'https://example.com/p?id=7',
    );
    expect(cleanUrlFor('nonsense')).toBe('');
  });
});

describe('element AI menu actions', () => {
  test('every AI item exists, is routed, and runs in the frame', () => {
    const aiItems = MENU_ITEMS.filter((item) => item.id.startsWith('ai_'));
    expect(aiItems.map((item) => item.id).sort()).toEqual([
      'ai_block_all',
      'ai_highlight',
      'ai_mark_ad',
      'ai_mark_content',
      'ai_verdict',
    ]);

    for (const item of aiItems) {
      // A menu entry with no route is dead UI; one that runs in the background
      // cannot reach the element the user right-clicked.
      expect(actionForMenuItem(item.id)).not.toBe('none');
      expect(scopeForAction(actionForMenuItem(item.id))).toBe('frame');
      expect(item.parentId).toBe('bm-ai');
    }
  });

  test('the AI items live under a parent that exists', () => {
    const ids = new Set(MENU_ITEMS.map((item) => item.id));
    expect(ids.has('bm-ai')).toBe(true);
  });
});

describe('element verdict wording', () => {
  test('states the class, the confidence and the decision', () => {
    expect(
      describeElementVerdict({
        elementClass: 'Ad',
        action: 'hide',
        confidence: 98,
        corroboration: 'corroborated',
        reasons: ['Ad container markup ("adsbygoogle").'],
        elementsOnPage: 3,
      }),
    ).toBe('Ad · 98% · safe to hide (corroborated). Ad container markup ("adsbygoogle"). Page total: 3.');

    expect(
      describeElementVerdict({ elementClass: 'Content', action: 'leave', confidence: 45, corroboration: 'model-only' }),
    ).toBe('Content · 45% · not acted on (model-only).');

    expect(
      describeElementVerdict({ elementClass: 'Annoyance', action: 'suggest', confidence: 58, corroboration: 'single-signal' }),
    ).toBe('Annoyance · 58% · possible — confirm first (single-signal).');
  });

  test('never pretends to have a verdict it does not have', () => {
    expect(describeElementVerdict(null)).toBe('No verdict available for that element.');
  });
});

describe('page activity summary', () => {
  test('describes what the tab ledger holds', () => {
    expect(describeTabActivity(null)).toBe('Nothing blocked on this page yet.');
    expect(describeTabActivity({ blockedRequests: 0, elementsHidden: 0 })).toBe(
      'Nothing blocked on this page yet.',
    );
    expect(describeTabActivity({ blockedRequests: 1 })).toBe('Blocked on this page: 1 request.');
    expect(describeTabActivity({ blockedRequests: 12, blockedDomains: 3, elementsHidden: 2 })).toBe(
      'Blocked on this page: 12 requests · 3 domains · 2 hidden elements.',
    );
  });
});
