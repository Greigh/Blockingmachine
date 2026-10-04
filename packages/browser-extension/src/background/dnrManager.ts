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
import type { AppliedRuleSource, SiteControlDrift } from '../shared/types.js';

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

/**
 * The resource types blocklist rules apply to.
 *
 * Exported for the redundancy read: every plain host block the compiler emits carries exactly
 * this set, so the live-rules diff passes it as the baseline an unscoped block is expected to
 * hold — a rule listing strictly fewer types is the scoped one, not one of these.
 */
export const BLOCK_RESOURCE_TYPES = [
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
  /**
   * Candidate rules whose host a supplied benefit ranking could place — present only when a
   * `TierBenefitRank` was provided. Zero means the ranking had nothing to say and the budget
   * cut degenerated to list order, which the caller should report as a plain prune.
   */
  benefitRanked?: number;
}

/**
 * The measured-benefit ordering for a budget cut: maps a candidate's host to its rank in the
 * shipped tier cut, or null when no tier carries it. Lower ranks survive first; ties and
 * unranked candidates keep list order. See `TierBenefitIndex` for how the ranking is built.
 */
export type TierBenefitRank = (host: string) => number | null;

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
  benefitRank?: TierBenefitRank,
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
  // fit first. Inside a priority class a supplied benefit ranking orders the cut — the host a
  // tier measured stays ahead of one it did not — and ranks are memoised so the comparator never
  // re-parses a host for the sort.
  const merged = dropSubsumedBlocks(mergeScopedVariants(candidates));
  let benefitRanked = 0;
  if (benefitRank) {
    const rankCache = new Map<ParsedDnrCandidate, number | null>();
    const rankOf = (candidate: ParsedDnrCandidate): number | null => {
      const cached = rankCache.get(candidate);
      if (cached !== undefined) return cached;
      const host = hostnameOf(candidate);
      const rank = host ? benefitRank(host) : null;
      rankCache.set(candidate, rank);
      return rank;
    };
    merged.sort((a, b) => {
      const byPriority = b.priority - a.priority;
      if (byPriority !== 0) return byPriority;
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra === null && rb === null) return 0;
      if (ra === null) return 1;
      if (rb === null) return -1;
      return ra - rb;
    });
    for (const candidate of merged) if (rankOf(candidate) !== null) benefitRanked += 1;
  } else {
    merged.sort((a, b) => b.priority - a.priority);
  }

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
    ...(benefitRank ? { benefitRanked } : {}),
  };
}

/**
 * The list the browser will actually be given, and how that was decided.
 *
 * A rules-only hot set (`hotlist.txt`, built by `npm run build:hotlist`) carries the blocks its
 * shipped rules measured, in a fraction of the rules — with the honest bound stated in its own
 * header rather than assumed (the committed ledger-derived set holds the 17 fired rules that have a
 * line in the source list, which is 23.3% of that ledger's measured blocks, not all of them). That
 * still makes it the better answer to "this list does not fit" than the alternative — and the
 * alternative is what the browser does by default, which is to install as many rules as fit and
 * drop the rest.
 *
 * The two are not comparable in kind, which is the whole reason this is a decision rather than a
 * truncation. Pruning keeps a *prefix*: rules that happen to be high in the list, with the tail cut
 * off and no record of what went. The hot set keeps a *measured* subset, but it is a subset of the
 * traffic that produced it — a handful of scripted sessions, not the deploying user's — so on a
 * host that traffic never visited it blocks nothing at all (14.3% on the held-out checked-in
 * session). Neither is the full list. The measured one is the better default because its loss is
 * characterised, and because a prefix of a 249,000-rule file is not a default anybody would choose
 * on purpose.
 *
 * So the rule is narrow and stated rather than clever: use the hot set only when the full export
 * genuinely does not fit the budget, and fall back to today's pruning when it does not fit or when
 * no hot set was supplied. `reason` is non-null whenever the answer is not the plain full list, so
 * the caller has something to log and the popup has something to show.
 */
/**
 * The supplied hot set's own standing against the same budget — reported on every plan that was
 * offered one, whichever source won. The report that lets a deployment catch a stale set lives
 * here and not in the winning answer alone, because staleness can only be seen by comparing the
 * two lists the checker already holds.
 */
export interface HotSetStanding {
  /** Rules the hot set offered before the budget was applied. */
  offered: number;
  /** Hot rules the same budget would still prune — nonzero means it overflows too. */
  overflow: number;
  /**
   * Hot rules the full list does not carry verbatim. `selectHotList` ships only measured rules
   * that appear verbatim in the source list, so a nonzero count means the served hot set was
   * built against a different or older export — stale.
   */
  absentFromFull: number;
  /**
   * How many shipped hot lines the staleness count is over — the *denominator* of
   * `absentFromFull`, which is the shipped set's size, not the merged set's `offered`.
   */
  shipped: number;
  /**
   * Rules the merged set took from the deployment's *own* hit ledger rather than the shipped
   * file — the difference between a hot set measured on the repository's scripted sessions and
   * one measured on the traffic of the browser actually running it. Zero when the ledger had
   * nothing to contribute (no hits yet, or every fired rule absent from the current export).
   */
  ownRules: number;
}

export interface RuleSourcePlan extends ListRulePlan {
  /** Which list the rules came from. `full` is also the answer when pruning had to happen. */
  source: 'full' | 'hot';
  /**
   * The raw lines the winning source was planned from — the full export verbatim, or the merged
   * hot set (shipped lines plus the deployment's own fired rules, capped at the budget). The
   * caller installs from this rather than re-deriving it, since the merge is part of the
   * decision.
   */
  sourceLines: readonly string[];
  /** Why the hot set was chosen, or null when the full list fitted unaided. */
  reason: string | null;
  /** Rules the full export would have installed before the budget was applied, for the log. */
  fullOverflow: number;
  /** The hot set's own standing, or null when none was supplied. */
  hotSet: HotSetStanding | null;
  /**
   * Whether the installed cut was ordered by measured tier benefit rather than list order —
   * the fallback that keeps what the tiers can vouch for when the full export had to be
   * pruned. False when nothing was pruned, when the hot set won, or when the ranking had no
   * answer for any rule on the list.
   */
  tierTrimmed: boolean;
}

/**
 * Picks the list to compile: the full export when it fits, the measured hot set when it does not.
 *
 * Pure — no `chrome.*` — so the decision can be asserted directly rather than inferred from what
 * ended up installed.
 */
export function chooseRuleSource(
  fullLines: readonly string[],
  hotLines: readonly string[] | null,
  control: SiteControlOptions = {},
  budget: number = MV3_LIMITS.SAFE_DYNAMIC_WATERMARK,
  benefitRank: TierBenefitRank | null = null,
  ownRuleLines: readonly string[] | null = null,
): RuleSourcePlan {
  const full = planListRules(
    [...fullLines],
    control,
    budget,
    benefitRank ?? undefined,
  );
  const overflow = full.overflow;

  // The comparison runs on every call that was offered a hot set — the happy path included,
  // because a stale set keeps its rules while losing the list they were measured against, and
  // only holding both lists can see that. Its cost is one planning pass over a small list.
  let hot: ListRulePlan | null = null;
  let hotSet: HotSetStanding | null = null;

  // The hot input is the shipped set *plus* this browser's own fired rules, own evidence first:
  // the scripted ledger the shipped set is measured against cannot know what this machine
  // visits, and the deployment's own tally is exactly that measurement. When own evidence
  // exists the merge is capped at the budget — a measured set we ordered ourselves, so a union
  // that does not fit is a priority cut rather than the both-overflow refusal a raw shipped set
  // earns. Rules absent from the full list are kept — the shipped set has always installed what
  // it was served — and the staleness check below stays the tripwire for it.
  const carried = new Set(fullLines);
  const cap = (ownRuleLines?.length ?? 0) > 0 ? budget : Number.POSITIVE_INFINITY;
  let ownRules = 0;
  const mergedHot: string[] = [];
  if ((ownRuleLines?.length ?? 0) > 0 || (hotLines?.length ?? 0) > 0) {
    const seen = new Set<string>();
    for (const [lines, isOwn] of [
      [ownRuleLines ?? [], true],
      [hotLines ?? [], false],
    ] as const) {
      for (const line of lines) {
        if (mergedHot.length >= cap) break;
        if (seen.has(line)) continue;
        seen.add(line);
        mergedHot.push(line);
        if (isOwn) ownRules++;
      }
    }
  }

  if (mergedHot.length > 0) {
    hot = planListRules(mergedHot, control, budget);
    let absentFromFull = 0;
    for (const line of hotLines ?? []) {
      // Staleness is measured over the *shipped* set against the full export, not the merge: a
      // shipped rule the own-evidence cap displaced is still present in the list, while one the
      // export itself dropped names a set built against a different export.
      if (!carried.has(line)) absentFromFull++;
    }
    hotSet = {
      offered: hot.offered,
      overflow: hot.overflow,
      absentFromFull,
      shipped: hotLines?.length ?? 0,
      ownRules,
    };
  }

  // A cut ordered by measured benefit only counts as trimmed when the ranking placed at least
  // one rule — otherwise it kept list order after all, and calling it tier-trimmed would be
  // the same overclaim the plain-prefix reason was accused of.
  const tierTrimmed = benefitRank !== null && (full.benefitRanked ?? 0) > 0;

  if (overflow === 0) {
    return { ...full, source: 'full', sourceLines: fullLines, reason: null, fullOverflow: 0, hotSet, tierTrimmed: false };
  }

  if (!hot || !hotSet) {
    // No measured set to fall back to: the cut still answers evidence before order when a
    // benefit ranking was supplied — the tiers already measured which of these hosts matter —
    // and falls back to list order only when there is no ranking at all.
    return {
      ...full,
      source: 'full',
      sourceLines: fullLines,
      reason: tierTrimmed
        ? `no measured hot set was available, so ${overflow.toLocaleString()} rules were cut by measured tier benefit instead of list order`
        : `no measured hot set was available, so ${overflow.toLocaleString()} rules were pruned`,
      fullOverflow: overflow,
      hotSet: null,
      tierTrimmed,
    };
  }

  if (hot.overflow > 0) {
    // Both overflow. The hot set is then not a smaller list but a differently-shaped one, and
    // choosing it would trade a truncation for a truncation. Keep the full export and cut —
    // benefit-ordered when a ranking was supplied, list-ordered when not.
    return {
      ...full,
      source: 'full',
      sourceLines: fullLines,
      reason: tierTrimmed
        ? `the measured hot set also exceeded the budget (${hot.overflow.toLocaleString()} pruned from it), so the full export was cut by measured tier benefit instead`
        : `the measured hot set also exceeded the budget (${hot.overflow.toLocaleString()} pruned from it), so the full export was pruned instead`,
      fullOverflow: overflow,
      hotSet,
      tierTrimmed,
    };
  }

  const provenance =
    hotSet.ownRules > 0
      ? `the measured hot set (${hotSet.ownRules.toLocaleString()} of its rules measured on this browser's own ledger)`
      : 'the shipped measured hot set';
  return {
    ...hot,
    source: 'hot',
    sourceLines: mergedHot,
    reason: `the full export exceeded the ${budget.toLocaleString()}-rule budget by ${overflow.toLocaleString()} rules, so ${provenance} was used`,
    fullOverflow: overflow,
    hotSet,
    tierTrimmed: false,
  };
}

/**
 * Which half of the extension's rules a dynamic rule belongs to, decided by its priority.
 *
 * The two halves are installed by different parts of the extension and have to be replaceable
 * independently: the user's own decisions (a paused site, an allowed domain) live at
 * {@link PRIORITY_USER_ALLOW} and above, and every rule a compiled list produces lives below it,
 * because that is what makes an explicit decision outrank the list by construction. `planSiteControlRules`
 * only ever emits the first family and `planListRules` only ever the second, so a rule's priority is a
 * reliable statement about where it came from rather than a heuristic.
 */
export type DynamicRuleFamily = 'user' | 'list';

/** The family a rule belongs to, read from the priority the browser reports. */
export function ruleFamily(priority: number | undefined): DynamicRuleFamily {
  return (priority ?? 0) >= PRIORITY_USER_ALLOW ? 'user' : 'list';
}

/** The browser's dynamic rules, split by the family that installed them. */
export interface InstalledRuleFamilies {
  /** Rules the user's own decisions produced. */
  user: chrome.declarativeNetRequest.Rule[];
  /** Rules compiled from a list — the synced blocklist and the user's custom rules. */
  list: chrome.declarativeNetRequest.Rule[];
}

/**
 * A stable identity for one rule, used to compare what the extension would install with what the
 * browser already holds.
 *
 * Deliberately built from the fields DNR actually matches on, sorted where order is not meaningful:
 * two rules that agree on all of these are the same rule to the browser, whatever their ids are, and
 * ids are exactly what changes between two installs of the same plan.
 */
function ruleKey(
  priority: number | undefined,
  action: string,
  urlFilter: string,
  resourceTypes: readonly string[] | undefined,
): string {
  return `${priority ?? 0}|${action}|${urlFilter}|${[...(resourceTypes ?? [])].sort().join(',')}`;
}

/** The identity of a rule this extension is about to install. */
export function plannedRuleKey(rule: PlannedRule): string {
  return ruleKey(rule.priority, rule.action, rule.pattern, rule.resourceTypes);
}

/** The identity of a rule the browser is holding. */
export function installedRuleKey(rule: chrome.declarativeNetRequest.Rule): string {
  return ruleKey(
    rule.priority,
    rule.action?.type ?? '',
    rule.condition?.urlFilter ?? '',
    rule.condition?.resourceTypes as readonly string[] | undefined,
  );
}

/**
 * Whether the user's own decisions are already installed exactly as the browser reports them.
 *
 * The comparison runs in both directions on purpose. A decision with no rule behind it means the
 * user is not getting what they asked for — a pause that is not pausing — while a rule with no
 * decision behind it is blocking the user asked to allow, which is the more expensive direction to
 * be wrong in. The caller supplies the browser's reading, so this is a reconcile rather than a
 * belief: nothing here decides what the browser holds.
 *
 * A global pause is the empty case rather than a plan of its own, because that is what the pause
 * installs: no rules at all, for either family.
 */
export function userDecisionsAreInstalled(
  families: InstalledRuleFamilies,
  control: SiteControlOptions = {},
): boolean {
  const expected = (control.globalPaused ? [] : planSiteControlRules(control)).map(plannedRuleKey).sort();
  const installed = families.user.map(installedRuleKey).sort();
  return expected.length === installed.length && expected.every((key, index) => key === installed[index]);
}

/**
 * Whether every rule the user saved by hand has a rule installed for it.
 *
 * The same question as {@link userDecisionsAreInstalled}, asked of the other half of the user's own
 * state: "block this domain" from the context menu and a quarantine rule both write to storage and
 * then apply, and an apply that throws leaves the decision saved and unenforced. Unlike the pause
 * and allow decisions these are compiled by the list planner, so they arrive in the list family and
 * are invisible to a check that only looks at priorities.
 *
 * Compared on the filter rather than on the whole rule, deliberately. The planner merges and bounds,
 * so the rule a saved line ends up as depends on what else was in the batch — whereas the filter is
 * the thing the user asked for. A stricter comparison could never be satisfied for a line the
 * planner merges, and a check that can never be satisfied is a repair loop rather than a reconcile.
 *
 * A line the planner refuses outright contributes no filter, so it is not required: the rule was
 * never installable, and asking for it forever would be asking the wrong question.
 *
 * The decisions are planned *with* the caller's site control, and the call is answered by the pause
 * when there is one, because a rule that is legitimately absent must not read as a rule that failed
 * to install. A saved rule the user has since allowed the domain of is suppressed by the planner on
 * purpose, and a global pause installs nothing at all; treating either as a missing rule would make
 * this a repair that runs on every worker start and never converges.
 */
export function customRulesAreInstalled(
  families: InstalledRuleFamilies,
  customRules: readonly string[],
  control: SiteControlOptions = {},
): boolean {
  if (customRules.length === 0) return true;
  if (control.globalPaused) return true;

  const installedFilters = new Set(
    families.list.map((rule) => rule.condition?.urlFilter).filter((filter): filter is string => Boolean(filter)),
  );
  return planListRules([...customRules], control).rules.every((rule) => installedFilters.has(rule.pattern));
}

/**
 * The name a pause or allow rule is about, read back off its filter.
 *
 * Every site-control rule is planned as `||name^`, so the name is recoverable from the filter
 * rather than needing a side channel — which matters on the unexpected side, where the rule the
 * browser holds is the only record of which decision it used to be.
 */
function decisionName(pattern: string): string {
  const match = /^\|\|([^|/]+)\^$/.exec(pattern);
  return match ? match[1] : pattern;
}

const EMPTY_DRIFT_DETAILS = {
  missingPauses: [] as string[],
  missingAllowances: [] as string[],
  missingRules: [] as string[],
  unexpectedPauses: [] as string[],
  unexpectedAllowances: [] as string[],
  unexpectedRules: [] as string[],
  unexpectedBlocking: 0,
};

/**
 * Which of the user's decisions the browser is *not* enforcing, and which it is enforcing that
 * were never asked for — the detail underneath {@link userDecisionsAreInstalled} and
 * {@link customRulesAreInstalled}, named so the popup can say what drifted rather than only that
 * something did.
 *
 * A missing pause is blocking the user believes is off; an unexpected one is a page being let
 * through that they no longer pause. A missing custom rule is reported by filter because the
 * filter is the decision — the rule it was planned into is an implementation detail the planner
 * may legitimately merge. And while blocking is paused everywhere the promise is that *nothing*
 * is blocked, so any surviving list rules are reported as a count: the pause that did not clear
 * is the most consequential drift this can name.
 *
 * `null` families is an unreadable browser, answered as `known: false` rather than as agreement —
 * the popup must not report "enforced" about a state nobody has seen.
 */
export function computeSiteControlDrift(
  families: InstalledRuleFamilies | null,
  control: SiteControlOptions = {},
  customRules: readonly string[] = [],
): SiteControlDrift {
  if (!families) return { known: false, inSync: false, ...EMPTY_DRIFT_DETAILS };

  // A global pause plans nothing of its own — its expected user state is the empty set, exactly
  // as userDecisionsAreInstalled expects it.
  const planned = control.globalPaused ? [] : planSiteControlRules(control);
  const expectedKeys = new Set(planned.map(plannedRuleKey));
  const installedKeys = new Set(families.user.map(installedRuleKey));

  const missingPauses: string[] = [];
  const missingAllowances: string[] = [];
  for (const rule of planned) {
    if (installedKeys.has(plannedRuleKey(rule))) continue;
    (rule.action === 'allowAllRequests' ? missingPauses : missingAllowances).push(
      decisionName(rule.pattern),
    );
  }

  const unexpectedPauses: string[] = [];
  const unexpectedAllowances: string[] = [];
  const unexpectedRules: string[] = [];
  for (const rule of families.user) {
    if (expectedKeys.has(installedRuleKey(rule))) continue;
    const filter = rule.condition?.urlFilter ?? '';
    if (rule.action?.type === 'allowAllRequests') {
      unexpectedPauses.push(decisionName(filter));
    } else if (rule.action?.type === 'allow') {
      unexpectedAllowances.push(decisionName(filter));
    } else {
      // A rule in the user's own family that is neither a pause nor an allowance matches no
      // decision the extension can make — foreign state, and still enforced.
      unexpectedRules.push(filter);
    }
  }

  const missingRules = control.globalPaused
    ? []
    : planListRules([...customRules], control)
        .rules.filter((rule) => !families.list.some((r) => r.condition?.urlFilter === rule.pattern))
        .map((rule) => rule.pattern);

  const details = {
    missingPauses: missingPauses.sort(),
    missingAllowances: missingAllowances.sort(),
    missingRules: missingRules.sort(),
    unexpectedPauses: unexpectedPauses.sort(),
    unexpectedAllowances: unexpectedAllowances.sort(),
    unexpectedRules: unexpectedRules.sort(),
    unexpectedBlocking: control.globalPaused ? families.list.length : 0,
  };
  const inSync = Object.values(details).every((value) =>
    typeof value === 'number' ? value === 0 : value.length === 0,
  );
  return { known: true, inSync, ...details };
}

export class DnrManager {
  /** Translates a single rule line into a candidate rule. */
  parseRule(line: string): ParsedDnrCandidate | null {
    return parseFilterRule(line);
  }

  /**
   * Reads the browser's dynamic rules, split into the user's own rules and the list-derived ones.
   *
   * Returns null rather than an empty pair when the browser will not answer, because "no rules"
   * and "no reading" lead to opposite decisions: the first is a reason to install, the second is a
   * reason to leave the browser alone.
   */
  async installedFamilies(): Promise<InstalledRuleFamilies | null> {
    try {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const families: InstalledRuleFamilies = { user: [], list: [] };
      for (const rule of rules) families[ruleFamily(rule.priority)].push(rule);
      return families;
    } catch (err) {
      console.warn('[DNR] Could not read the browser\'s dynamic rules:', err);
      return null;
    }
  }

  /**
   * Updates dynamic DNR rules from a set of domain/adblock strings, plus the
   * user's per-site decisions (pauses and explicit domain allowances).
   * Respects browser dynamic rule quotas and prioritizes exceptions and high-priority rules.
   *
   * Reads the browser's current rules first, in both directions of the change:
   *
   *  - They are what gets removed, so this can never leave a rule behind that the caller did not
   *    ask for, and never remove one by guessing at an id range.
   *  - They are what is *kept* when `replaceInstalledList` is false. A service worker that has not
   *    fetched the list yet holds no lines to compile, and the destructive reading of "no lines" is
   *    to clear the blocklist and re-add nothing — turning a site pause into an unscanned browser.
   *    The installed rules from the last successful compilation are the only copy of that list the
   *    extension has, and they are a faithful one: the planner below is the same pure function that
   *    produced them. So the list family is left exactly as the browser holds it, minus the rules
   *    this call's own lines supersede, and only the user's decisions are replaced.
   */
  async updateDynamicRules(
    ruleLines: string[],
    control: SiteControlOptions = {},
    options: {
      replaceInstalledList?: boolean;
      hotRuleLines?: string[] | null;
      /**
       * Rules the deployment's own hit ledger has fired, hottest first — merged into the hot set
       * ahead of the shipped lines. This is the per-deployment half of the hot-set story: the
       * shipped set is measured on the repository's scripted sessions, and these are measured on
       * the traffic of the browser actually running it.
       */
      ownRuleLines?: string[] | null;
      /**
       * The measured-benefit ordering for the budget cut, built from the shipped tier files.
       * When a full export that overflows has no hot set — or a hot set that overflows too —
       * the cut keeps the hosts the tiers measured first rather than the file's own prefix.
       * Omitting it keeps the pre-existing list-order prune.
       */
      benefitRank?: TierBenefitRank;
      /**
       * Reports which source list the application actually installed, after it succeeds — the
       * record a surface like the popup can show instead of re-running the planner and guessing
       * at the answer a different day would give. Not called for a preserving apply
       * (`replaceInstalledList: false`): the kept rules still belong to the source that installed
       * them, so only a whole-list application gets to claim one.
       */
      onRuleSource?: (source: AppliedRuleSource) => void;
    } = {},
  ): Promise<number> {
    // The measured hot set, used only when the full export will not fit the browser's budget.
    // `null` keeps the pre-existing behaviour of pruning the full export, which is what a client
    // with no hot set to hand should get.
    const hotRuleLines = options.hotRuleLines ?? null;
    const replaceInstalledList = options.replaceInstalledList !== false;

    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const installedUserRules = existingRules.filter((rule) => ruleFamily(rule.priority) === 'user');
    const installedListRules = existingRules.filter((rule) => ruleFamily(rule.priority) === 'list');

    // User-authored rules are allocated first so they survive quota trimming.
    const userRules = planSiteControlRules(control);

    // Master pause: install no rules at all. The pause is a storage-level
    // decision (see shared/siteControl), so the user's allowances survive it and
    // come back the moment blocking is resumed. Both families go: the promise is
    // that nothing is blocked, and the tiers are silenced by the caller.
    if (control.globalPaused) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [...installedUserRules, ...installedListRules].map((rule) => rule.id),
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

    // The installed list rules this call is about to re-plan: the subset whose urlFilter the
    // caller's own lines produce (the user's custom rules, in the preserving case). Comparing on the
    // filter rather than on the whole rule is deliberate — it also retires a *stale* variant of a
    // filter the fresh plan no longer wants, such as a scoped rule whose scope was edited.
    // The list budget the *first* planning pass sees, before the preserving call's kept rules are
    // known. Deciding the source from this is deliberate: whether the full export fits is a
    // property of the export and the cap, not of what happens to be installed right now, so a
    // preserving call cannot flip the answer between one application and the next.
    const sourcePlan = chooseRuleSource(
      ruleLines,
      hotRuleLines,
      control,
      Math.max(0, quotaCap - userRules.length),
      options.benefitRank ?? null,
      options.ownRuleLines ?? null,
    );
    const sourceLines = sourcePlan.sourceLines;

    // Both of these must come from the *chosen* source, and that is a safety property rather than
    // tidiness. `ownedFilters` is the set of installed filters this call supersedes — everything
    // in it is removed from the browser and is expected to come back in `plan` — so a mismatch
    // between the two would remove rules and never reinstall them. Reading `ownedFilters` from the
    // full export while `plan` came from the hot set would retire thousands of rules and replace
    // them with the measured handful, which is a silent loss of protection rather than a visible
    // error. Same source, both sides, or nothing gets dropped on the floor.
    const ownedFilters = replaceInstalledList
      ? null
      : new Set(
          planListRules(
            [...sourceLines],
            control,
            Math.max(0, quotaCap - userRules.length),
            options.benefitRank,
          ).rules.map((rule) => rule.pattern),
        );
    const keptListRules =
      ownedFilters === null
        ? []
        : installedListRules.filter((rule) => !ownedFilters.has(rule.condition?.urlFilter ?? ''));
    const removeRuleIds = [
      ...installedUserRules.map((rule) => rule.id),
      ...(ownedFilters === null
        ? installedListRules
        : installedListRules.filter((rule) => ownedFilters.has(rule.condition?.urlFilter ?? ''))
      ).map((rule) => rule.id),
    ];

    // The blocklist budget is what remains after the user's rules *and* whatever of the last
    // compilation is being kept, so a preserving call cannot push the total past the watermark.
    // The same benefit ranking orders this plan as ordered the source decision — a trim
    // computed one way and installed another would retire rules the ranking wanted kept.
    const plan = planListRules(
      [...sourceLines],
      control,
      Math.max(0, quotaCap - userRules.length - keptListRules.length),
      options.benefitRank,
    );
    if (sourcePlan.source === 'hot') {
      // Loud, because a client silently running on a measured subset of one session's traffic is
      // protecting less than a reader of the settings screen would assume. The count is kept —
      // the hot set is the whole point, not an error — but the reason belongs in the log where
      // someone will actually see it.
      console.warn(
        `[Mv3Guard] ${sourcePlan.reason}. Installed ${plan.rules.length} of ${sourcePlan.offered} measured rules ` +
          `(the full export would have pruned ${sourcePlan.fullOverflow.toLocaleString()}). ` +
          `Protection is limited to the traffic that measurement saw.`
      );
    } else if (plan.overflow > 0) {
      console.warn(
        `[Mv3Guard] Rule list exceeds safe MV3 dynamic limit (${quotaCap}). Bound ${plan.rules.length} rules, ${plan.overflow} overflow rules ` +
          (sourcePlan.tierTrimmed
            ? 'dropped in measured-benefit order — the tiered hosts kept, the unmeasured tail cut. '
            : 'pruned. ') +
          `Use @blockingmachine/system-daemon for unlimited network-level filtering.`
      );
    }
    if (sourcePlan.hotSet && sourcePlan.hotSet.absentFromFull > 0) {
      // A stale hot set is a deployment fault, not a list problem: the builder ships only rules the
      // export carries, so absent ones mean the served pair is out of step. Warned whichever source
      // won — a full-export answer today does not fix the set that will be asked for tomorrow.
      console.warn(
        `[Mv3Guard] ${sourcePlan.hotSet.absentFromFull.toLocaleString()} of the shipped hot set's ` +
          `${sourcePlan.hotSet.shipped.toLocaleString()} rules are not in the full export it was ` +
          `served beside — it was measured against a different or older list. Rebuild it ` +
          `(npm run build:hotlist) or drop it; serving it stale answers for a list that is no ` +
          `longer there.`
      );
    }

    const actionTypes = chrome.declarativeNetRequest.RuleActionType;
    const allowAllRequests = (chrome.declarativeNetRequest?.RuleActionType?.ALLOW_ALL_REQUESTS ??
      'allowAllRequests') as chrome.declarativeNetRequest.RuleActionType;

    const addRules: chrome.declarativeNetRequest.Rule[] = [];
    let nextRuleId = keptListRules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;

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

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules
      });
    } catch (err) {
      console.error('[DNR] Failed to apply dynamic rules batch:', err);
      throw err;
    }

    // What the browser is holding now, not what this call added: the popup's fallback count is a
    // statement about installed protection, and a preserving call adds few rules while keeping
    // thousands.
    const installed = keptListRules.length + addRules.length;
    // Recorded *after* the browser accepted the batch, so a rejected apply cannot leave the popup
    // reporting a source that was never installed. Two kinds of call never report. A pause does
    // not: clearing every rule installs no source, and the record it leaves behind describes the
    // list that will return on resume. And a preserving call does not: the kept list rules still
    // belong to whichever source installed them, so "full" here would only mean "the custom rules
    // this call re-planned fit" — overwriting a real record with that would be a false claim.
    if (replaceInstalledList) {
      options.onRuleSource?.({
        source: sourcePlan.source,
        appliedAt: Date.now(),
        installed,
        offered: sourcePlan.offered,
        fullOverflow: sourcePlan.fullOverflow,
        hotSet: sourcePlan.hotSet,
        tierTrimmed: sourcePlan.tierTrimmed,
      });
    }
    return installed;
  }
}
