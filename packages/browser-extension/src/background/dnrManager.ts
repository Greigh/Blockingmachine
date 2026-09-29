import { Mv3Guard, MV3_LIMITS } from './mv3Guard.js';
import {
  PRIORITY_BLOCK,
  PRIORITY_EXCEPTION,
  PRIORITY_IMPORTANT_BLOCK,
  PRIORITY_IMPORTANT_EXCEPTION,
  PRIORITY_SITE_PAUSE,
  PRIORITY_USER_ALLOW,
} from '../shared/constants.js';
import { normalizeSite } from '../shared/siteControl.js';

export interface ParsedDnrCandidate {
  rawRule: string;
  pattern: string;
  isException: boolean;
  isImportant: boolean;
  priority: number;
  /**
   * When true, `pattern` is a complete DNR urlFilter (an absolute-URL rule such as
   * `|https://cdn.example.com/ads.js|`, or a domain-anchored rule that keeps a path such as
   * `||cdn.example.com/ads.js`) and must not be wrapped in the domain form `||…^`.
   */
  isUrlFilter?: boolean;
  /**
   * The sites whose requests this rule applies to, taken from the adblock `$domain=` modifier.
   * When set, the rule fires only when one of these sites (or a subdomain) initiated the request,
   * which is what makes a path-level rule safe to ship: one rule covers every listed site instead
   * of one rule per site.
   */
  initiatorDomains?: string[];
  /** Sites taken from `$domain=~…`; the rule never applies to requests they initiate. */
  excludedInitiatorDomains?: string[];
}

/**
 * Validates an absolute-URL DNR urlFilter. Chrome treats `*`, `|`, `||` and `^` as special and
 * everything else literally, so a URL filter can contain a path and a query string that a domain
 * rule cannot express.
 */
function validateUrlFilter(filter: string): string | null {
  if (filter.length > 300) return null;
  if (/\s/.test(filter)) return null;
  if (!/^\|https?:\/\/[^/|]+(?:\/[^|\s]*)?\|?$/i.test(filter)) return null;
  return filter;
}

/**
 * Validates a DNR urlFilter that keeps a path.
 *
 * Two shapes are accepted: a domain-anchored `||host/path…`, and a bare path-only `/path` rule.
 * A path-only rule carries no host of its own, so it may only be shipped with an initiator scope —
 * see {@link parseFilterRule}. A backslash never appears in a literal path and only shows up in
 * adblock regex rules, which a urlFilter cannot express, so those are rejected rather than matched
 * literally.
 */
function validatePathFilter(filter: string): string | null {
  if (filter.length > 300) return null;
  if (/\s/.test(filter)) return null;
  if (filter.includes('\\')) return null;
  if (!/^[\x20-\x7e]+$/.test(filter)) return null;

  const anchoredPath = /^\|\|[^/|]+\//.test(filter);
  const pathOnly = filter.startsWith('/') && filter.length > 1;
  if (!anchoredPath && !pathOnly) return null;
  return filter;
}

/**
 * What the user asked for, independent of any list. These rules always outrank
 * blocklist-derived rules so an explicit decision can never be overruled.
 */
export interface SiteControlOptions {
  /** Sites where blocking is paused: the page and everything it requests is allowed. */
  pausedSites?: string[];
  /** Individual third-party domains the user explicitly allowed. */
  allowedDomains?: string[];
  /** Master pause — install no blocking rules at all. */
  globalPaused?: boolean;
}

/** A DNR rule before an id has been assigned. */
export interface PlannedRule {
  priority: number;
  action: 'block' | 'allow' | 'allowAllRequests';
  /** The complete DNR urlFilter. */
  pattern: string;
  resourceTypes: string[];
  /** Sites whose requests this rule is scoped to; omitted for global rules. */
  initiatorDomains?: string[];
  /** Sites the rule is excluded from; takes precedence over `initiatorDomains`. */
  excludedInitiatorDomains?: string[];
}

/** The resource types blocklist rules apply to. */
const BLOCK_RESOURCE_TYPES = [
  'script',
  'image',
  'xmlhttprequest',
  'sub_frame',
  'media',
  'ping',
];

/**
 * `allowAllRequests` is restricted by Chrome to frame requests. When a frame
 * navigation matches, the frame *and every request it makes* is allowed, which
 * is exactly what "pause blocking on this site" needs.
 */
const FRAME_RESOURCE_TYPES = ['main_frame', 'sub_frame'];

/**
 * Modifiers whose rules must never be compiled into a plain block.
 *
 * The DNR pipeline expresses only blocking and allowing, so a rule that reshapes a request or a
 * response — rewriting query parameters, redirecting, injecting CSP, replacing the body — would
 * otherwise be silently turned into a blanket block of its whole zone. That is the one failure mode
 * worse than dropping the rule, so these are skipped outright.
 */
const NON_BLOCKING_MODIFIERS = new Set([
  'removeparam',
  'redirect',
  'csp',
  'replace',
  'header',
  'permissions',
  'urlskip',
]);

/** The name of an adblock modifier, with any `=value` stripped. */
function modifierName(modifier: string): string {
  const equals = modifier.indexOf('=');
  return equals < 0 ? modifier : modifier.slice(0, equals);
}

/**
 * Splits an adblock line into its match pattern and its modifiers.
 *
 * A `$` inside a hosts entry or a `/…/` regex is literal text rather than a modifier separator, and
 * the remainder of the line after it would otherwise be swallowed into the match pattern.
 */
function splitModifiers(line: string): { pattern: string; modifiers: string[] } {
  const separator = line.lastIndexOf('$');
  if (separator <= 0 || separator === line.length - 1) return { pattern: line, modifiers: [] };
  const modifiers = line
    .slice(separator + 1)
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return { pattern: line.slice(0, separator), modifiers };
}

/** Canonical DNR initiator domains: lower-case ASCII, optional sub-labels, no wildcards. */
const INITIATOR_DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Canonicalises one `$domain=` entry into a DNR initiator domain, or null when it cannot be
 * expressed. `*.example.com` becomes `example.com`, because DNR matches sub-domains already; a
 * pattern such as `gmx.*` has no DNR equivalent and is reported as inexpressible.
 */
function canonicalInitiatorDomain(entry: string): string | null {
  const value = entry
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  if (!value || value.length > 253) return null;
  if (value.includes('*') || value.includes('/') || value.includes(':')) return null;
  return INITIATOR_DOMAIN_REGEX.test(value) ? value : null;
}

export interface InitiatorScope {
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  /**
   * True when the rule declared initiator sites that cannot be written as a DNR domain. Applying
   * the rule regardless would carry exactly the global over-block the scope was there to prevent,
   * so the caller must skip it instead.
   */
  unexpressible: boolean;
}

/**
 * Reads the adblock `$domain=` modifier, which is the per-site scope of a rule: `domain=a.com|b.com`
 * means "only when a.com or b.com initiated the request", and `~`-prefixed entries exclude a site.
 * This is the same condition DNR calls `initiatorDomains` / `excludedInitiatorDomains`.
 */
export function parseInitiatorScope(modifiers: readonly string[]): InitiatorScope {
  const declared = modifiers.find((modifier) => modifierName(modifier) === 'domain');
  if (!declared) return { unexpressible: false };

  const includes: string[] = [];
  const excludes: string[] = [];
  let expressedAny = false;
  let inexpressibleInclude = false;

  for (const entry of declared.slice('domain='.length).split('|')) {
    const negative = entry.startsWith('~');
    const domain = canonicalInitiatorDomain(negative ? entry.slice(1) : entry);
    if (!domain) {
      // An excluded site we cannot name only widens the scope slightly; an included one we cannot
      // name would force the rule to apply everywhere, which is not acceptable.
      if (!negative) inexpressibleInclude = true;
      continue;
    }
    expressedAny = true;
    (negative ? excludes : includes).push(domain);
  }

  // A declared scope that expressed no site at all would silently become a global rule — the exact
  // over-block the modifier exists to prevent — so it is refused rather than widened.
  if (!expressedAny) return { unexpressible: true };
  if (includes.length === 0 && inexpressibleInclude) return { unexpressible: true };

  const scope: InitiatorScope = { unexpressible: false };
  if (includes.length > 0) scope.initiatorDomains = [...new Set(includes)].sort();
  if (excludes.length > 0) scope.excludedInitiatorDomains = [...new Set(excludes)].sort();
  return scope;
}

/**
 * Plans the user-authored rules. Pure — no `chrome.*` access — so the rule
 * semantics can be asserted directly in tests.
 */
export function planSiteControlRules(options: SiteControlOptions = {}): PlannedRule[] {
  const planned: PlannedRule[] = [];

  for (const candidate of options.pausedSites ?? []) {
    const site = normalizeSite(candidate);
    if (!site) continue;
    planned.push({
      priority: PRIORITY_SITE_PAUSE,
      action: 'allowAllRequests',
      pattern: `||${site}^`,
      resourceTypes: FRAME_RESOURCE_TYPES,
    });
  }

  for (const candidate of options.allowedDomains ?? []) {
    const domain = normalizeSite(candidate);
    if (!domain) continue;
    planned.push({
      priority: PRIORITY_USER_ALLOW,
      action: 'allow',
      pattern: `||${domain}^`,
      resourceTypes: BLOCK_RESOURCE_TYPES,
    });
  }

  return planned;
}

// Regex to validate syntactically compliant domain hostnames (RFC 1123)
const DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?)+$/;

const RESERVED_INFRASTRUCTURE = new Set([
  'localhost',
  'local',
  'broadcasthost',
  'home.arpa',
  'invalid',
  'test',
  'example',
  'onion'
]);

const BARE_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'org.nz',
  'net.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'org.br',
  'net.br',
  'com.cn',
  'net.cn',
  'org.cn',
  'co.in',
  'net.in',
  'org.in',
  'github.io',
  'pages.dev',
  'vercel.app',
  'cloudfront.net',
  'azurewebsites.net',
  'amazonaws.com'
]);

/** The priority a filter line earns from its exception/important modifiers. */
function priorityFor(isException: boolean, isImportant: boolean): number {
  return isException && isImportant
    ? PRIORITY_IMPORTANT_EXCEPTION
    : isImportant
    ? PRIORITY_IMPORTANT_BLOCK
    : isException
    ? PRIORITY_EXCEPTION
    : PRIORITY_BLOCK;
}

/**
 * Translates one filter line into a candidate DNR rule, or null when the line cannot be expressed
 * as a browser rule.
 *
 * Supports ABP wildcards (`||domain^`), exceptions (`@@`), `$important`, hosts entries, plain
 * domains, absolute-URL rules, path-scoped rules, and the `$domain=` per-site scope. Cosmetic
 * filters, scriptlets and DNS-only directives are handled elsewhere and rejected here.
 */
export function parseFilterRule(line: string): ParsedDnrCandidate | null {
  let clean = line.trim();
  // `!` is a comment and `[` starts a list header (`[Adblock Plus 2.0]`), which is not a rule at
  // all. Without the second check a header is only refused later, as an invalid domain.
  if (!clean || clean.startsWith('#') || clean.startsWith('!') || clean.startsWith('[')) return null;

  // 1. Strictly exclude cosmetic filters and scriptlets (handled in content/defusers)
  //
  // Kept in step with `isNetworkRule` in core's coverage report, which is the same decision made
  // for measurement rather than for compilation. Measured on the lines below: all of them were
  // *already* refused here, by the domain and modifier validation further down, because a body
  // like `example.com#$#.ad` is not a domain. These guards make the refusal intentional instead of
  // a side effect of a different check — a cosmetic rule that survives compiling is an over-block
  // on a domain the list only wanted to restyle.
  if (
    clean.includes('##') ||
    clean.includes('#@#') ||
    clean.includes('#?#') ||
    clean.includes('#%#') ||
    // AdGuard CSS injection (`#$#`), its exception (`#@$#`), and the `$@$` redirect form: applied
    // by a content script against the DOM, never against a request.
    clean.includes('#$#') ||
    clean.includes('#@$#') ||
    clean.includes('$@$') ||
    clean.includes('$$') ||
    clean.includes('+js(')
  ) {
    return null;
  }

  // 2. Strictly exclude DNS-only directives
  if (
    clean.includes('$dnsrewrite') ||
    clean.includes('$dnstype') ||
    clean.includes('$client') ||
    clean.includes('$ctag') ||
    clean.includes('.arpa')
  ) {
    return null;
  }

  // 3. Exclude raw loopback / broadcasthost hosts mappings
  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)/i.test(clean)) {
    return null;
  }

  let isException = false;
  if (clean.startsWith('@@')) {
    isException = true;
    clean = clean.substring(2).trim();
  }

  // Strip hosts file IP prefixes (0.0.0.0, 127.0.0.1)
  clean = clean.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, '');

  const { pattern: body, modifiers } = splitModifiers(clean);

  // A request- or response-reshaping modifier cannot be a block rule.
  if (modifiers.some((modifier) => NON_BLOCKING_MODIFIERS.has(modifierName(modifier)))) {
    return null;
  }

  const isImportant = modifiers.includes('important');
  const scope = parseInitiatorScope(modifiers);
  if (scope.unexpressible) return null;

  const scopeFields = {
    ...(scope.initiatorDomains ? { initiatorDomains: scope.initiatorDomains } : {}),
    ...(scope.excludedInitiatorDomains
      ? { excludedInitiatorDomains: scope.excludedInitiatorDomains }
      : {}),
  };
  const priority = priorityFor(isException, isImportant);

  // Absolute-URL rule, kept whole as a DNR urlFilter. The domain pipeline below strips everything
  // after the first `/`, which is exactly why these rules used to be thrown away instead of applied.
  if (/^\|?https?:\/\//i.test(body)) {
    const filter = validateUrlFilter(body.startsWith('|') ? body : `|${body}`);
    if (!filter) return null;
    return {
      rawRule: line.trim(),
      pattern: filter,
      isException,
      isImportant,
      priority,
      isUrlFilter: true,
      ...scopeFields,
    };
  }

  const anchored = body.startsWith('||');
  const candidate = anchored ? body.substring(2) : body;
  const hasPath = candidate.includes('/');

  if (hasPath) {
    // The path is the whole point of the rule. Collapsing `||cdn.example.com/ads.js` to a
    // whole-zone `||cdn.example.com^` block is what made these rules unsafe to ship.
    //
    // A bare `/path` rule names no host at all, so on its own it would match that path on every
    // site. Only the rule's own `$domain=` scope makes it safe per-site, so without one it is
    // dropped — which is also how the pipeline treated it before.
    if (!anchored && !scope.initiatorDomains?.length) return null;

    const filter = validatePathFilter(anchored ? `||${candidate}` : candidate);
    if (!filter) return null;

    return {
      rawRule: line.trim(),
      pattern: filter,
      isException,
      isImportant,
      priority,
      isUrlFilter: true,
      ...scopeFields,
    };
  }

  // Domain-only rule. Strip the `^` separator and everything after it (domain-anchored rules stop
  // at the end of the host) before validating the remaining string as a hostname.
  const domain = candidate.replace(/\^.*$/, '').replace(/\.+$/, '').trim().toLowerCase();

  // Validate that the remaining string is a syntactically valid domain name
  // to prevent Chrome DNR from throwing "Invalid urlFilter" on the entire batch
  if (!domain || !DOMAIN_REGEX.test(domain)) {
    return null;
  }

  // Exclude reserved infrastructure and bare public suffixes
  if (RESERVED_INFRASTRUCTURE.has(domain) || BARE_PUBLIC_SUFFIXES.has(domain)) {
    return null;
  }

  return {
    rawRule: line.trim(),
    pattern: domain,
    isException,
    isImportant,
    priority,
    ...scopeFields,
  };
}

/** True when `pattern` is `allowed` or any subdomain of it. */
function isAllowedByUser(pattern: string, allowedDomains: Set<string>): boolean {
  for (const domain of allowedDomains) {
    if (pattern === domain || pattern.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** The hostname a candidate's urlFilter is anchored to, used for the user-allowance check. */
function hostnameOf(candidate: ParsedDnrCandidate): string {
  if (!candidate.isUrlFilter) return candidate.pattern;
  const cleaned = candidate.pattern.replace(/^\|+/, '').replace(/\|+$/, '');
  try {
    return new URL(cleaned.includes('://') ? cleaned : `https://${cleaned}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A stable identity for the initiator scope a candidate carries. */
function scopeKeyOf(candidate: ParsedDnrCandidate): string {
  return `${(candidate.initiatorDomains ?? []).join('|')}!${(candidate.excludedInitiatorDomains ?? []).join('|')}`;
}

/**
 * Folds scoped variants of the same filter into a single rule.
 *
 * `initiatorDomains` names many sites on one rule, so `||a.com^$domain=x` and `||a.com^$domain=y`
 * together cost one rule rather than one each. Merging is only valid when neither variant excludes
 * an initiator: a union of includes is exactly the OR of the two scopes, whereas a union of
 * exclusions would be an AND. Variants that cannot merge keep their own rule.
 */
export function mergeScopedVariants(candidates: ParsedDnrCandidate[]): ParsedDnrCandidate[] {
  const merged = new Map<string, ParsedDnrCandidate>();

  for (const candidate of candidates) {
    const identity = `${candidate.isException ? 'EX:' : 'BL:'}${candidate.priority}:${candidate.pattern}`;
    const existing = merged.get(identity);

    if (!existing) {
      merged.set(identity, candidate);
      continue;
    }

    const canMerge =
      !existing.excludedInitiatorDomains &&
      !candidate.excludedInitiatorDomains &&
      existing.initiatorDomains &&
      candidate.initiatorDomains;

    if (canMerge) {
      existing.initiatorDomains = [
        ...new Set([...existing.initiatorDomains!, ...candidate.initiatorDomains!]),
      ].sort();
    } else {
      merged.set(`${identity}#${scopeKeyOf(candidate)}`, candidate);
    }
  }

  return [...merged.values()];
}

/** The host a block rule is anchored to, or null when it is not anchored to a single host. */
function anchoredHostOf(candidate: ParsedDnrCandidate): string | null {
  if (!candidate.isUrlFilter) return candidate.pattern;
  if (candidate.pattern.startsWith('||')) {
    const host = candidate.pattern.slice(2).split(/[/^]/)[0];
    return host && !host.includes('*') ? host.toLowerCase() : null;
  }
  if (/^\|https?:\/\//i.test(candidate.pattern)) return hostnameOf(candidate) || null;
  // A path-only rule (`/pop.js`) names no host at all.
  return null;
}

/**
 * Drops block rules that a global block of at least the same priority already covers.
 *
 * A compiled list routinely carries both `||host^` and path- or scope-narrowed variants of it. Once
 * the whole zone is blocked, a narrower rule can never be the rule that fires, so shipping it buys
 * nothing but quota — and keeping them would make precise path handling cost more rules than the
 * blunt zone collapse it replaces. Exceptions are never dropped, and a variant outranks its zone
 * block only when it is strictly more privileged (`$important`).
 */
export function dropSubsumedBlocks(candidates: ParsedDnrCandidate[]): ParsedDnrCandidate[] {
  const globalBlocks = new Map<string, number>();

  for (const candidate of candidates) {
    if (candidate.isException || candidate.isUrlFilter) continue;
    if (candidate.initiatorDomains?.length || candidate.excludedInitiatorDomains?.length) continue;
    const best = globalBlocks.get(candidate.pattern) ?? 0;
    if (candidate.priority > best) globalBlocks.set(candidate.pattern, candidate.priority);
  }

  if (globalBlocks.size === 0) return candidates;

  return candidates.filter((candidate) => {
    if (candidate.isException) return true;
    // A plain zone block *is* the coverage, never a redundant variant of it.
    if (
      !candidate.isUrlFilter &&
      !candidate.initiatorDomains &&
      !candidate.excludedInitiatorDomains
    ) {
      return true;
    }
    const host = anchoredHostOf(candidate);
    if (!host) return true;
    const coveringPriority = globalBlocks.get(host);
    return coveringPriority === undefined || candidate.priority > coveringPriority;
  });
}

export interface ListRulePlan {
  /** Rules the compiler would install, highest priority first. */
  rules: PlannedRule[];
  /** Filter lines offered to the compiler. */
  offered: number;
  /** Lines the compiler could not express as a browser rule. */
  skipped: number;
  /** Rules dropped because the user allowed their domain everywhere. */
  allowSkipped: number;
  /** Rules pruned for exceeding the MV3 safe watermark. */
  overflow: number;
  /** Rules that name at least one initiating site, so they fire per-site rather than globally. */
  scoped: number;
}

function toPlannedRule(candidate: ParsedDnrCandidate): PlannedRule {
  return {
    priority: candidate.priority,
    action: candidate.isException ? 'allow' : 'block',
    pattern: candidate.isUrlFilter ? candidate.pattern : `||${candidate.pattern}^`,
    resourceTypes: BLOCK_RESOURCE_TYPES,
    ...(candidate.initiatorDomains ? { initiatorDomains: candidate.initiatorDomains } : {}),
    ...(candidate.excludedInitiatorDomains
      ? { excludedInitiatorDomains: candidate.excludedInitiatorDomains }
      : {}),
  };
}

/**
 * Compiles a filter list into the rules the extension would install. Pure — no `chrome.*` access —
 * so the exact rule shape, including its initiator scope, can be asserted and measured directly.
 */
export function planListRules(
  ruleLines: string[],
  control: SiteControlOptions = {},
  budget: number = MV3_LIMITS.SAFE_DYNAMIC_WATERMARK,
): ListRulePlan {
  const allowedDomains = new Set(
    (control.allowedDomains ?? []).map((domain) => normalizeSite(domain)).filter(Boolean),
  );

  const candidates: ParsedDnrCandidate[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let allowSkipped = 0;

  for (const line of ruleLines) {
    const parsed = parseFilterRule(line);
    if (!parsed) {
      skipped++;
      continue;
    }

    const identity = `${parsed.isException ? 'EX:' : 'BL:'}${parsed.pattern}~${scopeKeyOf(parsed)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    // The user's explicit allowance supersedes any list rule for that domain — including a
    // path-scoped rule that happens to be anchored to that domain.
    const target = hostnameOf(parsed);
    if (!parsed.isException && target && isAllowedByUser(target, allowedDomains)) {
      allowSkipped++;
      continue;
    }

    candidates.push(parsed);
  }

  // Fold redundant variants, then sort by priority descending so high-priority rules & exceptions
  // fit first.
  const merged = dropSubsumedBlocks(mergeScopedVariants(candidates)).sort(
    (a, b) => b.priority - a.priority,
  );

  // Enforce Manifest V3 safe watermark and syntax bounds
  const { compliant, overflowCount } = Mv3Guard.boundCandidates(merged, Math.max(0, budget));

  const rules = compliant.map(toPlannedRule);

  return {
    rules,
    offered: ruleLines.length,
    skipped,
    allowSkipped,
    overflow: overflowCount,
    scoped: rules.filter((rule) => rule.initiatorDomains?.length).length,
  };
}

export class DnrManager {
  private nextRuleId = 1;

  /** Translates a single rule line into a candidate rule. */
  parseRule(line: string): ParsedDnrCandidate | null {
    return parseFilterRule(line);
  }

  /**
   * Updates dynamic DNR rules from a set of domain/adblock strings, plus the
   * user's per-site decisions (pauses and explicit domain allowances).
   * Respects browser dynamic rule quotas and prioritizes exceptions and high-priority rules.
   */
  async updateDynamicRules(ruleLines: string[], control: SiteControlOptions = {}): Promise<number> {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map((r) => r.id);

    // User-authored rules are allocated first so they survive quota trimming.
    const userRules = planSiteControlRules(control);

    // Master pause: install no rules at all. The pause is a storage-level
    // decision (see shared/siteControl), so the user's allowances survive it and
    // come back the moment blocking is resumed.
    if (control.globalPaused) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds,
          addRules: [],
        });
      } catch (err) {
        console.error('[DNR] Failed to clear dynamic rules for global pause:', err);
        throw err;
      }
      return 0;
    }

    const maxQuota =
      chrome.declarativeNetRequest?.MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES ||
      MV3_LIMITS.DEFAULT_MAX_DYNAMIC_RULES;
    const quotaCap = Math.min(MV3_LIMITS.SAFE_DYNAMIC_WATERMARK, Math.max(1000, maxQuota - 500));

    // User rules are already allocated, so the blocklist budget is what remains.
    const plan = planListRules(ruleLines, control, Math.max(0, quotaCap - userRules.length));
    if (plan.overflow > 0) {
      console.warn(
        `[Mv3Guard] Rule list exceeds safe MV3 dynamic limit (${quotaCap}). Bound ${plan.rules.length} rules, ${plan.overflow} overflow rules pruned. Use @blockingmachine/system-daemon for unlimited network-level filtering.`
      );
    }

    const actionTypes = chrome.declarativeNetRequest.RuleActionType;
    const allowAllRequests = (chrome.declarativeNetRequest?.RuleActionType?.ALLOW_ALL_REQUESTS ??
      'allowAllRequests') as chrome.declarativeNetRequest.RuleActionType;

    const addRules: chrome.declarativeNetRequest.Rule[] = [];
    let nextRuleId = 1;

    for (const planned of [...userRules, ...plan.rules]) {
      const action =
        planned.action === 'allowAllRequests'
          ? allowAllRequests
          : planned.action === 'allow'
          ? actionTypes.ALLOW
          : actionTypes.BLOCK;

      const condition: chrome.declarativeNetRequest.RuleCondition = {
        urlFilter: planned.pattern,
        resourceTypes: planned.resourceTypes as chrome.declarativeNetRequest.ResourceType[],
      };
      if (planned.initiatorDomains?.length) {
        condition.initiatorDomains = planned.initiatorDomains;
      }
      if (planned.excludedInitiatorDomains?.length) {
        condition.excludedInitiatorDomains = planned.excludedInitiatorDomains;
      }

      addRules.push({
        id: nextRuleId++,
        priority: planned.priority,
        action: { type: action },
        condition,
      });
    }

    this.nextRuleId = nextRuleId;

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules
      });
    } catch (err) {
      console.error('[DNR] Failed to apply dynamic rules batch:', err);
      throw err;
    }

    return addRules.length;
  }
}
