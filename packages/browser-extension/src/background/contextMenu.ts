/**
 * Right-click menu.
 *
 * The tree and the decision of *what an item does* are declared here as pure
 * data, so the menu can be tested without a browser. The background service
 * worker only creates the items and routes the resulting action.
 */

import { decomposeDomain } from '@blockingmachine/core/entropy';

/**
 * Chrome's context list. Declared locally as a non-empty tuple because the
 * bundled @types use a template-literal enum that a plain array cannot satisfy.
 */
export type MenuContext =
  | 'all'
  | 'page'
  | 'frame'
  | 'link'
  | 'image'
  | 'video'
  | 'audio'
  | 'selection'
  | 'editable';

export interface MenuItemSpec {
  id: string;
  title: string;
  contexts: [MenuContext, ...MenuContext[]];
  parentId?: string;
}

export const MENU_ROOT_ID = 'bm-root';

/** Where a menu action should run. */
export type MenuScope = 'frame' | 'background';

export type MenuAction =
  | 'pick_element'
  | 'block_element'
  | 'block_similar'
  | 'ai_verdict'
  | 'ai_highlight'
  | 'ai_block_all'
  | 'ai_mark_ad'
  | 'ai_mark_content'
  | 'block_domain'
  | 'block_link_domain'
  | 'block_url'
  | 'allow_site'
  | 'resume_site'
  | 'allow_domain'
  | 'toggle_pause'
  | 'copy_selector'
  | 'copy_domain'
  | 'copy_url'
  | 'copy_rule'
  | 'open_hub'
  | 'analyse_page'
  | 'show_status'
  | 'none';

export interface MenuClickInfo {
  menuItemId: string;
  pageUrl?: string;
  frameUrl?: string;
  linkUrl?: string;
  srcUrl?: string;
  selectionText?: string;
}

const PAGE_CONTEXTS: [MenuContext, ...MenuContext[]] = [
  'page',
  'frame',
  'link',
  'image',
  'video',
  'audio',
  'selection',
  'editable',
];
const LINKED_CONTEXTS: [MenuContext, ...MenuContext[]] = ['link', 'image', 'video', 'audio'];
const EVERYWHERE: [MenuContext, ...MenuContext[]] = ['all'];

/**
 * The menu tree, grouped by intent. Element-level actions come first because
 * right-clicking an ad is usually about the element itself, then domain rules,
 * then the site-wide and copy/open utilities.
 */
export const MENU_ITEMS: MenuItemSpec[] = [
  { id: MENU_ROOT_ID, title: 'Blockingmachine', contexts: EVERYWHERE },

  // ── Element ─────────────────────────────────────────────────────────────────
  { id: 'block_element', title: 'Block this element', contexts: PAGE_CONTEXTS, parentId: MENU_ROOT_ID },
  { id: 'block_similar', title: 'Block similar elements', contexts: PAGE_CONTEXTS, parentId: MENU_ROOT_ID },
  { id: 'pick_element', title: 'Pick a different element…', contexts: PAGE_CONTEXTS, parentId: MENU_ROOT_ID },

  // ── AI ──────────────────────────────────────────────────────────────────────
  // The element Mini-AI's actions. "This is an ad" / "Not an ad" are the feedback
  // loop: they teach the on-device model, so the same widget is handled correctly on
  // every other site without waiting for a list update.
  { id: 'bm-ai', title: 'AI element scan', contexts: EVERYWHERE, parentId: MENU_ROOT_ID },
  { id: 'ai_verdict', title: 'Why is this element classified this way?', contexts: PAGE_CONTEXTS, parentId: 'bm-ai' },
  { id: 'ai_highlight', title: 'Highlight everything the AI found on this page', contexts: PAGE_CONTEXTS, parentId: 'bm-ai' },
  { id: 'ai_block_all', title: 'Hide everything the AI found on this page', contexts: PAGE_CONTEXTS, parentId: 'bm-ai' },
  { id: 'ai_mark_ad', title: 'This is an ad — hide this kind', contexts: PAGE_CONTEXTS, parentId: 'bm-ai' },
  { id: 'ai_mark_content', title: 'Not an ad — never hide this', contexts: PAGE_CONTEXTS, parentId: 'bm-ai' },

  // ── Domains and URLs ────────────────────────────────────────────────────────
  { id: 'bm-block', title: 'Block a domain or URL', contexts: EVERYWHERE, parentId: MENU_ROOT_ID },
  { id: 'block_domain', title: 'Block this domain everywhere', contexts: PAGE_CONTEXTS, parentId: 'bm-block' },
  { id: 'block_link_domain', title: 'Block the linked domain', contexts: LINKED_CONTEXTS, parentId: 'bm-block' },
  { id: 'block_url', title: 'Block this exact URL', contexts: LINKED_CONTEXTS, parentId: 'bm-block' },

  // ── Allow / pause ───────────────────────────────────────────────────────────
  { id: 'bm-allow', title: 'Allow or pause', contexts: EVERYWHERE, parentId: MENU_ROOT_ID },
  { id: 'allow_site', title: 'Stop blocking on this site', contexts: PAGE_CONTEXTS, parentId: 'bm-allow' },
  { id: 'resume_site', title: 'Resume blocking on this site', contexts: PAGE_CONTEXTS, parentId: 'bm-allow' },
  { id: 'allow_domain', title: 'Allow the linked domain', contexts: LINKED_CONTEXTS, parentId: 'bm-allow' },
  { id: 'toggle_pause', title: 'Pause everywhere', contexts: EVERYWHERE, parentId: 'bm-allow' },

  // ── Copy ────────────────────────────────────────────────────────────────────
  { id: 'bm-copy', title: 'Copy', contexts: EVERYWHERE, parentId: MENU_ROOT_ID },
  { id: 'copy_selector', title: 'CSS selector', contexts: PAGE_CONTEXTS, parentId: 'bm-copy' },
  { id: 'copy_domain', title: 'Domain', contexts: PAGE_CONTEXTS, parentId: 'bm-copy' },
  { id: 'copy_url', title: 'Clean page URL', contexts: PAGE_CONTEXTS, parentId: 'bm-copy' },
  { id: 'copy_rule', title: 'Blocking rule for this domain', contexts: PAGE_CONTEXTS, parentId: 'bm-copy' },

  // ── Open / inspect ──────────────────────────────────────────────────────────
  { id: 'analyse_page', title: 'What is blocked on this page?', contexts: PAGE_CONTEXTS, parentId: MENU_ROOT_ID },
  { id: 'show_status', title: 'Shield status for this site', contexts: PAGE_CONTEXTS, parentId: MENU_ROOT_ID },
  { id: 'open_hub', title: 'Open the Blockingmachine hub', contexts: EVERYWHERE, parentId: MENU_ROOT_ID },
];

/** Where an action runs, and whether it needs the frame's element target. */
export function scopeForAction(action: MenuAction): MenuScope {
  switch (action) {
    case 'pick_element':
    case 'block_element':
    case 'block_similar':
    case 'copy_selector':
    case 'ai_verdict':
    case 'ai_highlight':
    case 'ai_block_all':
    case 'ai_mark_ad':
    case 'ai_mark_content':
      return 'frame';
    default:
      return 'background';
  }
}

const MENU_ACTION_BY_ID: Record<string, MenuAction> = {
  pick_element: 'pick_element',
  block_element: 'block_element',
  block_similar: 'block_similar',
  block_domain: 'block_domain',
  block_link_domain: 'block_link_domain',
  block_url: 'block_url',
  allow_site: 'allow_site',
  resume_site: 'resume_site',
  allow_domain: 'allow_domain',
  toggle_pause: 'toggle_pause',
  copy_selector: 'copy_selector',
  ai_verdict: 'ai_verdict',
  ai_highlight: 'ai_highlight',
  ai_block_all: 'ai_block_all',
  ai_mark_ad: 'ai_mark_ad',
  ai_mark_content: 'ai_mark_content',
  copy_domain: 'copy_domain',
  copy_url: 'copy_url',
  copy_rule: 'copy_rule',
  open_hub: 'open_hub',
  analyse_page: 'analyse_page',
  show_status: 'show_status',
};

export function actionForMenuItem(menuItemId: string): MenuAction {
  return MENU_ACTION_BY_ID[menuItemId] ?? 'none';
}

/** Strips scheme/www and any path, leaving the hostname. */
export function hostOf(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Best-effort registrable domain; good enough to build a blocking rule from.
 *
 * Reads the same suffix tables the classifier ships (`decomposeDomain` knows compound
 * ccTLDs *and* the dynamic-DNS / shared-hosting platforms), so a subdomain of a hosted
 * tenant — `evil.blogspot.com`, `user.github.io` — resolves to the tenant's name rather
 * than the platform's apex. The hand-rolled version this replaced knew `co.uk` but not
 * `blogspot.com`, and "Block the linked domain" on one could install `||blogspot.com^` —
 * a rule blocking every Blogspot site.
 */
export function registrableDomainOf(rawUrl?: string): string {
  return registrableDomainOfHost(hostOf(rawUrl));
}

/** Same suffix-table registrable form, for a caller that already has a bare hostname. */
export function registrableDomainOfHost(host?: string): string {
  if (!host) return '';
  const { sld, tld } = decomposeDomain(host.toLowerCase());
  if (!tld || sld === tld) return sld || host.toLowerCase();
  return `${sld}.${tld}`;
}

export interface ResolvedMenuAction {
  action: MenuAction;
  /** Domain the action applies to, when the action targets a domain. */
  domain?: string;
  /** Exact URL the action applies to. */
  url?: string;
}

/** Turns a menu click into a concrete action plus its target. */
export function resolveMenuClick(info: MenuClickInfo): ResolvedMenuAction {
  const action = actionForMenuItem(info.menuItemId);
  const pageDomain = registrableDomainOf(info.pageUrl || info.frameUrl);
  const linkedDomain = registrableDomainOf(info.linkUrl || info.srcUrl);

  switch (action) {
    case 'block_domain':
      return { action, domain: pageDomain };
    case 'block_link_domain':
      return { action, domain: linkedDomain };
    case 'allow_domain':
      return { action, domain: linkedDomain };
    case 'block_url':
      return { action, url: info.linkUrl || info.srcUrl };
    case 'allow_site':
    case 'resume_site':
    case 'show_status':
      // Pausing applies to the exact host, not the whole registrable domain: a
      // subdomain pause must not silently unblock its siblings.
      return { action, url: info.pageUrl || info.frameUrl };
    case 'copy_domain':
    case 'copy_rule':
      return { action, domain: pageDomain || linkedDomain };
    default:
      return { action };
  }
}

/**
 * The DNR urlFilter that blocks exactly one URL. Chrome's filter syntax accepts
 * `|` anchors, so this matches that URL and nothing else — unlike a domain rule,
 * which would take out the whole host.
 */
export function urlFilterFor(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // `href` keeps the path/query percent-encoded, which DNR urlFilters require.
    const target = url.href.replace(/#.*$/, '');
    if (target.length > 300) return null;
    return `|${target}|`;
  } catch {
    return null;
  }
}

/** A URL reduced to what is safe and useful to copy (tracking params removed). */
export function cleanUrlFor(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    const tracking = [...url.searchParams.keys()].filter((key) =>
      /^(utm_|fbclid|gclid|mc_|igshid|vero_|_hs|oly_|ref$|ref_src$)/i.test(key),
    );
    for (const key of tracking) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Formats the element model's verdict as the one-line answer the menu reports.
 * Kept here, next to the other label builders, because the menu is where a user asks
 * "why?" and the answer must be short enough to read in a toast.
 */
export function describeElementVerdict(verdict: {
  elementClass: string;
  action: string;
  confidence: number;
  corroboration: string;
  reasons?: string[];
  elementsOnPage?: number;
} | null): string {
  if (!verdict) return 'No verdict available for that element.';
  const actionWords =
    verdict.action === 'hide' ? 'safe to hide' : verdict.action === 'suggest' ? 'possible — confirm first' : 'not acted on';
  const reason = verdict.reasons && verdict.reasons.length > 0 ? ` ${verdict.reasons[0]}` : '';
  const page = verdict.elementsOnPage ? ` Page total: ${verdict.elementsOnPage}.` : '';
  return `${verdict.elementClass} · ${verdict.confidence}% · ${actionWords} (${verdict.corroboration}).${reason}${page}`;
}

/** Human summary of a tab's ledger for the "what is blocked here" menu item. */
export function describeTabActivity(
  telemetry: { blockedRequests?: number; blockedDomains?: number; elementsHidden?: number } | null,
): string {
  const blocked = telemetry?.blockedRequests ?? 0;
  const domains = telemetry?.blockedDomains ?? 0;
  const hidden = telemetry?.elementsHidden ?? 0;
  if (!blocked && !hidden) return 'Nothing blocked on this page yet.';
  const parts: string[] = [];
  if (blocked) parts.push(`${blocked} request${blocked === 1 ? '' : 's'}`);
  if (domains) parts.push(`${domains} domain${domains === 1 ? '' : 's'}`);
  if (hidden) parts.push(`${hidden} hidden element${hidden === 1 ? '' : 's'}`);
  return `Blocked on this page: ${parts.join(' · ')}.`;
}
