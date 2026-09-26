import { sanitizeDomain } from './hostname.js';
export { sanitizeDomain } from './hostname.js';
import { isIP } from 'node:net';
import { compileRuleSet } from './domainEvaluator.js';
import { isBenignCnameTarget } from './cnameResolver.js';
import { clampConfidence } from './types.js';
import type {
  AntiAdblockProviderId,
  CompactionResult,
  RuleConflictResult,
  RuleCoverageResult,
  RuleSynthesisInput,
} from './types.js';
import {
  COMPOUND_CCTLDS,
  DYNAMIC_DNS_SUFFIXES,
  FOUR_PART_PUBLIC_SUFFIXES,
  THREE_PART_PUBLIC_SUFFIXES,
} from './entropy.js';
import { detectAntiAdblock, MULTI_TENANT_PLATFORMS } from './reputation.js';

interface TrieNode {
  children: Map<string, TrieNode>;
  isWildcard: boolean;
  coveringWildcardRule?: string;
  isExact: boolean;
  coveringExactRule?: string;
}

/**
 * In-memory reverse-domain suffix trie for structural coverage lookups.
 * Provides O(K) lookup complexity (where K = domain label depth) to verify if a domain
 * is covered by wildcard or exact rules across hundreds of thousands of filter rules.
 * Hardened with memory capacity bounds and label depth protection.
 * This index does not resolve exceptions or rule modifiers. Use compileRuleSet or
 * isDomainCoveredByRules to determine whether a domain is actually blocked.
 * @beta
 */
export class RuleCoverageTrie {
  private root: TrieNode = {
    children: new Map(),
    isWildcard: false,
    isExact: false,
  };
  private ruleCount = 0;
  private readonly maxCapacity = 500_000;
  private readonly maxDepth = 32;

  public insertRule(rawRule: string): void {
    if (!rawRule || typeof rawRule !== 'string') return;
    if (this.ruleCount >= this.maxCapacity) return;

    let rule = rawRule.trim();
    if (!rule || rule.startsWith('!') || rule.startsWith('#') || rule.startsWith('@@') || rule.includes('$badfilter')) {
      return;
    }

    // Strip inline trailing comments from hosts lines (e.g. "0.0.0.0 domain.com # block")
    if (rule.startsWith('0.0.0.0') || rule.startsWith('127.0.0.1') || rule.startsWith('::1')) {
      const hashIdx = rule.indexOf('#');
      if (hashIdx > 0) rule = rule.slice(0, hashIdx).trim();
      const bangIdx = rule.indexOf('!');
      if (bangIdx > 0) rule = rule.slice(0, bangIdx).trim();
    }

    // 1. Hosts format: 0.0.0.0 domain, 127.0.0.1 domain, ::1 domain
    const hostsMatch = rule.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([a-z0-9_.-]+)/i);
    if (hostsMatch) {
      const host = sanitizeDomain(hostsMatch[1]);
      if (host) {
        this.addDomain(host, false, rule);
        this.ruleCount++;
      }
      return;
    }

    // 2. Standard ABP / AdGuard domain rule: ||domain^ or ||domain^$options
    const abpMatch = rule.match(/^\|\|([a-z0-9_.-]+)\^/i);
    if (abpMatch) {
      const ruleDomain = sanitizeDomain(abpMatch[1]);
      if (ruleDomain) {
        this.addDomain(ruleDomain, true, rule);
        this.ruleCount++;
      }
      return;
    }

    // 3. DNSMasq: address=/domain/0.0.0.0 or server=/domain/127.0.0.1
    const dnsmasqMatch = rule.match(/^(?:address|server)=\/([a-z0-9_.-]+)\//i);
    if (dnsmasqMatch) {
      const host = sanitizeDomain(dnsmasqMatch[1]);
      if (host) {
        this.addDomain(host, true, rule);
        this.ruleCount++;
      }
      return;
    }

    // 4. Unbound: local-zone: "domain" ... or local-zone: "domain." ...
    const unboundMatch = rule.match(/^local-zone:\s*"([a-z0-9_.-]+)\.?"/i);
    if (unboundMatch) {
      const host = sanitizeDomain(unboundMatch[1]);
      if (host) {
        this.addDomain(host, true, rule);
        this.ruleCount++;
      }
      return;
    }

    // 5. Pi-hole regex format: (^|\.)domain$
    const piholeMatch = rule.match(/^\(\^\|\\\.\)([a-z0-9_\\.-]+)\$$/i);
    if (piholeMatch) {
      const host = sanitizeDomain(piholeMatch[1].replace(/\\/g, ''));
      if (host) {
        this.addDomain(host, true, rule);
        this.ruleCount++;
      }
      return;
    }

    // 6. Direct wildcard: *.domain.com
    const wildcardMatch = rule.match(/^\*\.([a-z0-9_.-]+)/i);
    if (wildcardMatch) {
      const host = sanitizeDomain(wildcardMatch[1]);
      if (host) {
        this.addDomain(host, true, rule);
        this.ruleCount++;
      }
      return;
    }

    // 7. Exact raw domain match
    const rawClean = sanitizeDomain(rule);
    if (rawClean) {
      this.addDomain(rawClean, false, rule);
      this.ruleCount++;
    }
  }

  public insertRules(rules: string[]): void {
    if (!Array.isArray(rules)) return;
    const boundedRules = rules.slice(0, this.maxCapacity);
    for (const rule of boundedRules) {
      this.insertRule(rule);
    }
  }

  private addDomain(domain: string, isWildcard: boolean, rule: string): void {
    const labels = domain.split('.').filter(Boolean).reverse();
    if (labels.length === 0 || labels.length > this.maxDepth) return;
    let current = this.root;

    for (const label of labels) {
      let next = current.children.get(label);
      if (!next) {
        next = { children: new Map(), isWildcard: false, isExact: false };
        current.children.set(label, next);
      }
      current = next;
    }

    if (isWildcard) {
      current.isWildcard = true;
      if (!current.coveringWildcardRule) {
        current.coveringWildcardRule = rule;
      }
    } else {
      current.isExact = true;
      if (!current.coveringExactRule) {
        current.coveringExactRule = rule;
      }
    }
  }

  public isCovered(domain: string): RuleCoverageResult {
    const clean = sanitizeDomain(domain);
    if (!clean) return { isCovered: false };

    const labels = clean.split('.').filter(Boolean).reverse();
    let current = this.root;

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const next = current.children.get(label);
      if (!next) {
        return { isCovered: false };
      }
      current = next;

      // Wildcard rule set at this level covers all deeper subdomains
      if (current.isWildcard) {
        return { isCovered: true, coveringRule: current.coveringWildcardRule };
      }
    }

    // At the exact leaf domain, check if exact match rule was set
    if (current.isExact) {
      return { isCovered: true, coveringRule: current.coveringExactRule };
    }

    return { isCovered: false };
  }

  public get size(): number {
    return this.ruleCount;
  }

  public clear(): void {
    this.root = { children: new Map(), isWildcard: false, isExact: false };
    this.ruleCount = 0;
  }
}

/**
 * Checks if a domain is already covered by an existing set of ABP or hosts rules,
 * either via exact match or wildcard parent domain rule (e.g. ||tracker.com^ covers sub.tracker.com).
 * Honors exceptions, disabled rules, and modifiers through the compiled evaluator.
 * For repeated lookups, compile the rule set once with compileRuleSet().
 *
 * @beta
 */
export function isDomainCoveredByRules(
  domain: string,
  existingRules: string[],
): RuleCoverageResult {
  try {
    const target = sanitizeDomain(domain);
    if (!target || !Array.isArray(existingRules) || existingRules.length === 0) {
      return { isCovered: false };
    }

    const result = compileRuleSet(existingRules).evaluate(target);
    return result.verdict === 'blocked'
      ? { isCovered: true, coveringRule: result.matchingRule }
      : { isCovered: false };
  } catch {
    return { isCovered: false };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Synthesizes procedural scriptlet defusers, CSS element hiding rules, and DOM modal
 * suppressors to completely defeat anti-adblock detection and prevent scroll-lock freezes
 * across multiple vendors (Admiral, Google Funding Choices, BlockThrough, AdInPlay, Ezoic,
 * NitroPay, Snigel, and Generic Bait Defusers).
 *
 * @beta
 */
export function synthesizeAntiAdblockDefusers(
  domain?: string,
  provider?: AntiAdblockProviderId | 'generic',
): string[] {
  const defusers: string[] = [];
  const clean = domain ? sanitizeDomain(domain) : null;

  if (clean) {
    defusers.push(`||${clean}^$important`);
    defusers.push(`0.0.0.0 ${clean}`);
  }

  // 1. Admiral Anti-Adblock
  if (!provider || provider === 'admiral') {
    defusers.push('||getadmiral.com^$important');
    defusers.push('||admiraldrm.com^$important');
    defusers.push('||admiralservices.com^$important');
    defusers.push('||admiralcloud.com^$important');

    defusers.push('##+js(set, admiral, noopfn)');
    defusers.push('##+js(set, Admiral, noopfn)');
    defusers.push('##+js(set, admiral.properties.suppress, true)');
    defusers.push('##+js(abort-current-script, admiral)');

    defusers.push('##.admiral-overlay, [id^="admiral-"], [class*="admiral-"], .admiral-active');

    if (clean) {
      defusers.push(`${clean}##+js(set, admiral, noopfn)`);
      defusers.push(`${clean}##+js(abort-current-script, admiral)`);
    }
  }

  // 2. Google Funding Choices / Privacy & Messaging
  if (!provider || provider === 'google-fc') {
    defusers.push('||fundingchoicesmessages.google.com^$important');
    defusers.push('||fc.yahoo.com^$important');

    defusers.push('##+js(set, googlefc, undefined)');
    defusers.push('##+js(set, google_ad_client, undefined)');
    defusers.push('##+js(abort-current-script, googlefc)');

    defusers.push('##.fc-ab-root, .fc-dialog-container, .fc-dialog-overlay, .fc-consent-root, .fc-monetization-root');
    defusers.push('##html.fc-ab-root, body.fc-ab-root { overflow: auto !important; position: static !important; }');

    if (clean) {
      defusers.push(`${clean}##+js(set, googlefc, undefined)`);
      defusers.push(`${clean}##+js(abort-current-script, googlefc)`);
    }
  }

  // 3. BlockThrough / PageFair (BT Loader)
  if (!provider || provider === 'blockthrough') {
    defusers.push('||btloader.com^$important');
    defusers.push('||blockthrough.com^$important');
    defusers.push('||pagefair.com^$important');

    defusers.push('##+js(set, blockthrough, noopfn)');
    defusers.push('##+js(set, BT_LOADER, undefined)');
    defusers.push('##+js(abort-current-script, btloader)');
    defusers.push('##+js(abort-current-script, blockthrough)');

    defusers.push('##.bt-ad-container, [id^="bt-"], [class*="bt-ad"]');
  }

  // 4. AdInPlay (Game adblock & canvas lock)
  if (!provider || provider === 'adinplay') {
    defusers.push('||adinplay.com^$important');
    defusers.push('||adinplay.bid^$important');

    defusers.push('##+js(set, aiptag, { cmd: { display: noopfn, player: noopfn } })');
    defusers.push('##+js(set, aipPlayer, noopfn)');
    defusers.push('##+js(set, aiptag.cmd.player, noopfn)');
    defusers.push('##+js(set, aiptag.cmd.display, noopfn)');

    defusers.push('##[id^="aip-preroll"], #aip-ad-container, .aip-overlay');
  }

  // 5. Ezoic Ad-Recovery Gateway
  if (!provider || provider === 'ezoic') {
    defusers.push('||ezodn.com^$important');
    defusers.push('||ezoiccdn.com^$important');

    defusers.push('##+js(set, ezstandalone, noopfn)');
    defusers.push('##+js(abort-current-script, ezstandalone)');

    defusers.push('##.ezoic-ad, [id*="ezoic-pub-ad"], [class*="ez-wall"]');
  }

  // 6. NitroPay Ad Recovery
  if (!provider || provider === 'nitropay') {
    defusers.push('||nitropay.com^$important');

    defusers.push('##+js(set, nitropay, noopfn)');
    defusers.push('##+js(abort-current-script, nitropay)');

    defusers.push('##.nitropay-ad, [id^="nitropay-"], .nitropay-overlay');
  }

  // 7. Snigel Ad Recovery
  if (!provider || provider === 'snigel') {
    defusers.push('||snigelweb.com^$important');
    defusers.push('||snigel.com^$important');

    defusers.push('##+js(set, snigel, noopfn)');
    defusers.push('##+js(abort-current-script, snigel)');

    defusers.push('##.snigel-ad-container, [id^="snigel-"]');
  }

  // 8. Generic FuckAdBlock / BlockAdBlock / Bait & Overlay Defusers
  if (!provider || provider === 'generic') {
    defusers.push('||fuckadblock.com^$important');
    defusers.push('||blockadblock.com^$important');
    defusers.push('||antiblock.org^$important');
    defusers.push('||snack-media.com^$important');

    defusers.push('##+js(set, FuckAdBlock, noopfn)');
    defusers.push('##+js(set, BlockAdBlock, noopfn)');
    defusers.push('##+js(set, fuckAdBlock, noopfn)');
    defusers.push('##+js(set, blockAdBlock, noopfn)');
    defusers.push('##+js(set, canRunAds, true)');
    defusers.push('##+js(set, isAdBlockActive, false)');
    defusers.push('##+js(set, adblock, false)');
    defusers.push('##+js(set, adBlockDetected, false)');

    defusers.push('##.adblock-modal, .adblock-overlay, .anti-adblock-modal, #adblock-nag, .adblocker-overlay, .adblock-blocker, [class*="adblock-wall"], [id*="adblock-wall"], .sp_veil, .sp_message_container');
  }

  // Always neutralize anti-adblock scroll-lock (overflow: hidden on html/body)
  defusers.push('##html, body { overflow: auto !important; position: static !important; }');

  return Array.from(new Set(defusers));
}

/**
 * Synthesizes procedural scriptlet defusers and DOM modal suppressors to completely
 * defeat Admiral Anti-Adblock (ad recovery) paywalls and prevent scroll-lock freezes.
 * @beta
 */
export function synthesizeAdmiralDefusers(domain?: string): string[] {
  return synthesizeAntiAdblockDefusers(domain, 'admiral');
}

/**
 * Synthesizes target-specific blocking rules for detected ad/tracker/threat infrastructure.
 * Supports universal ABP syntax, AdGuard Home, Pi-hole regex, uBlock Origin, Unbound, dnsmasq, and hosts.
 * Automatically injects anti-adblock defusers when Admiral or circumvention infrastructure is detected.
 * Hardened against poisoned inputs, invalid IPs, circular CNAMEs, and injection payloads.
 *
 * @beta
 */
export function synthesizeRules(input: RuleSynthesisInput): string[] {
  try {
    if (!input || typeof input !== 'object') {
      return [];
    }

    const { domain, verdict, category, cnames, target = 'all', includeComments = false, confidence = 90 } = input;
    const cleanDomain = typeof domain === 'string' ? sanitizeDomain(domain) : null;

    if (!cleanDomain || verdict === 'clean') {
      return [];
    }

    // Ambiguous lexical noise is not a block recommendation.
    if (verdict === 'suspicious' && category === 'Unknown') {
      return [];
    }

    const safeConfidence = clampConfidence(confidence, 90);
    const isIp = isIP(cleanDomain) !== 0;
    const rules: string[] = [];

    // Target-specific formatting
    switch (target) {
      case 'adguard': {
        if (isIp) {
          rules.push(`0.0.0.0 ${cleanDomain}`);
          rules.push(`||${cleanDomain}^$important`);
        } else {
          rules.push(`||${cleanDomain}^`);
          if (category === 'Advertising' || verdict === 'ad_server') {
            rules.push(`||${cleanDomain}^$dnsrewrite=NOERROR;NODATA`);
          } else if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
            rules.push(`||${cleanDomain}^$third-party`);
          } else if (category === 'Malware/Phishing' || verdict === 'malicious') {
            rules.push(`||${cleanDomain}^$important`);
          }
        }
        if (cnames && cnames.length > 0) {
          for (const cname of cnames) {
            if (typeof cname !== 'string') continue;
            const cleanCname = sanitizeDomain(cname);
            if (cleanCname && cleanCname !== cleanDomain && !isBenignCnameTarget(cleanCname)) {
              rules.push(`||${cleanCname}^`);
            }
          }
        }
        break;
      }

      case 'pihole': {
        // Regex format for Pi-hole v5/v6: (^|\.)domain$
        if (isIp) {
          rules.push(`0.0.0.0 ${cleanDomain}`);
        } else {
          rules.push(`(^|\\.)${escapeRegex(cleanDomain)}$`);
          rules.push(`0.0.0.0 ${cleanDomain}`);
        }
        break;
      }

      case 'ublock': {
        if (isIp) {
          rules.push(`0.0.0.0 ${cleanDomain}`);
        } else {
          rules.push(`||${cleanDomain}^`);
          if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
            rules.push(`||${cleanDomain}^$third-party`);
          }
          // Provide cosmetic defuser scriptlet for ad domains
          if (category === 'Advertising' || verdict === 'ad_server') {
            rules.push(`${cleanDomain}##+js(set, adsBlocked, true)`);
          }
        }
        break;
      }

      case 'unbound': {
        rules.push(`local-zone: "${cleanDomain}" always_nxdomain`);
        break;
      }

      case 'dnsmasq': {
        rules.push(`address=/${cleanDomain}/0.0.0.0`);
        break;
      }

      case 'hosts': {
        rules.push(`0.0.0.0 ${cleanDomain}`);
        break;
      }

      case 'all':
      default: {
        if (isIp) {
          rules.push(`0.0.0.0 ${cleanDomain}`);
          rules.push(`||${cleanDomain}^$important`);
        } else {
          // Primary standard ABP rule
          if (category === 'CNAME Cloaking') {
            rules.push(`||${cleanDomain}^`);
            rules.push(`||${cleanDomain}^$third-party`);
          } else if (category === 'Advertising' || verdict === 'ad_server') {
            rules.push(`||${cleanDomain}^`);
          } else if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
            rules.push(`||${cleanDomain}^`);
            rules.push(`||${cleanDomain}^$third-party`);
          } else {
            rules.push(`||${cleanDomain}^`);
          }
        }

        // Add uncloaked rules for all resolved CNAME targets
        if (cnames && cnames.length > 0) {
          for (const cname of cnames) {
            if (typeof cname !== 'string') continue;
            const cleanCname = sanitizeDomain(cname);
            if (cleanCname && cleanCname !== cleanDomain && !isBenignCnameTarget(cleanCname)) {
              rules.push(`||${cleanCname}^`);
            }
          }
        }

        // Add standard hosts entry
        rules.push(`0.0.0.0 ${cleanDomain}`);
        break;
      }
    }

    // If domain or CNAME target is an anti-adblock provider, inject procedural defusers & modal suppressors
    const aabDomain = detectAntiAdblock(cleanDomain);
    const aabCname = cnames
      ?.filter((c): c is string => typeof c === 'string')
      .map((c) => detectAntiAdblock(c))
      .find((res) => res.detected);
    const detectedAab = aabDomain.detected ? aabDomain : aabCname;

    if (detectedAab?.detected && (target === 'all' || target === 'ublock' || target === 'adguard')) {
      rules.push(...synthesizeAntiAdblockDefusers(cleanDomain, detectedAab.provider));
    }

    const uniqueRules = Array.from(new Set(rules));

    if (includeComments) {
      const timestamp = new Date().toISOString().split('T')[0];
      const safeVerdict = String(verdict).replace(/[\r\n\0]/g, '');
      const safeCategory = String(category).replace(/[\r\n\0]/g, '');
      const comments = [
        `! [Blockingmachine AI] Verdict: ${safeVerdict} | Category: ${safeCategory} (${safeConfidence}% confidence)`,
        `! Target: ${cleanDomain} | Date: ${timestamp}`,
      ];
      return [...comments, ...uniqueRules];
    }

    return uniqueRules;
  } catch {
    return [];
  }
}

/**
 * Synthesizes an ABP/AdGuard-compatible exception/allowlist rule for false positives.
 * @beta
 */
export function synthesizeAllowlistRule(domain: string): string {
  try {
    const cleanDomain = sanitizeDomain(domain);
    if (!cleanDomain) {
      return '';
    }
    return `@@||${cleanDomain}^`;
  } catch {
    return '';
  }
}

/**
 * Determines whether a domain string is a valid parent zone eligible for wildcard compaction.
 * Protects against over-compaction onto TLDs, compound ccTLDs (e.g. .co.uk, .com.au),
 * and multi-tenant platforms (e.g. github.io, supabase.co, vercel.app), which would
 * dangerously block entire public platforms or suffix registries.
 * @beta
 */
export function isValidParentZone(parent: string): boolean {
  if (!parent || typeof parent !== 'string' || !parent.includes('.')) return false;
  const clean = parent.toLowerCase().trim();

  // Never collapse directly onto a 4-part or 3-part public suffix, compound ccTLD, or multi-tenant public platform zone
  if (
    FOUR_PART_PUBLIC_SUFFIXES.has(clean) ||
    THREE_PART_PUBLIC_SUFFIXES.has(clean) ||
    COMPOUND_CCTLDS.has(clean) ||
    DYNAMIC_DNS_SUFFIXES.has(clean) ||
    MULTI_TENANT_PLATFORMS.has(clean)
  ) {
    return false;
  }

  const parts = clean.split('.').filter(Boolean);
  if (parts.length < 2) return false;

  // If the last four labels form a 4-part public suffix, the parent zone must have at least 5 labels
  if (parts.length >= 4) {
    const lastFour = `${parts[parts.length - 4]}.${parts[parts.length - 3]}.${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (FOUR_PART_PUBLIC_SUFFIXES.has(lastFour)) {
      return parts.length >= 5;
    }
  }

  // If the last three labels form a 3-part public suffix, the parent zone must have at least 4 labels
  if (parts.length >= 3) {
    const lastThree = `${parts[parts.length - 3]}.${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (THREE_PART_PUBLIC_SUFFIXES.has(lastThree) || DYNAMIC_DNS_SUFFIXES.has(lastThree)) {
      return parts.length >= 4;
    }
  }

  // If the last two labels form a compound ccTLD or dynamic DNS / multi-tenant zone,
  // the parent zone must have at least 3 labels (e.g. 'domain.co.uk' or 'tenant.supabase.co')
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (COMPOUND_CCTLDS.has(lastTwo) || DYNAMIC_DNS_SUFFIXES.has(lastTwo) || MULTI_TENANT_PLATFORMS.has(lastTwo)) {
    return parts.length >= 3;
  }

  // Standard TLD requires at least 2 labels (e.g. 'domain.com')
  return parts.length >= 2;
}

/**
 * Clusters subdomains and collapses them into parent wildcard rules when >= threshold
 * subdomains share the same parent zone. Eliminates list bloat by 70–90%.
 * Hardened against memory bloat and over-compaction onto public cloud platforms.
 *
 * @beta
 */
export function compactSubdomainRules(domains: string[], threshold = 3): CompactionResult {
  try {
    if (!Array.isArray(domains) || domains.length === 0) {
      return {
        originalCount: 0,
        compactedCount: 0,
        compactedRules: [],
        savingsPercent: 0,
        collapsedGroups: [],
      };
    }

    const safeThreshold = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 2
      ? Math.floor(threshold)
      : 3;

    // Bound domain input size to protect memory and event loop
    const boundedDomains = domains.slice(0, 50_000);
    const sanitized = Array.from(
      new Set(
        boundedDomains
          .map((d) => sanitizeDomain(d))
          .filter((d): d is string => Boolean(d)),
      ),
    );

    if (sanitized.length === 0) {
      return {
        originalCount: 0,
        compactedCount: 0,
        compactedRules: [],
        savingsPercent: 0,
        collapsedGroups: [],
      };
    }

    // Map parent zones to their child subdomains
    const parentZoneMap = new Map<string, Set<string>>();

    for (const domain of sanitized) {
      const parts = domain.split('.').filter(Boolean);
      // Needs at least 3 labels to have a parent subdomain zone (e.g. s1.ads.tracker.com -> ads.tracker.com and tracker.com)
      if (parts.length >= 3) {
        // 1. One level up (e.g. sub.analytics.domain.com -> analytics.domain.com)
        const directParent = parts.slice(1).join('.');
        if (isValidParentZone(directParent)) {
          if (!parentZoneMap.has(directParent)) {
            parentZoneMap.set(directParent, new Set());
          }
          parentZoneMap.get(directParent)!.add(domain);
        }

        // 2. Two levels up if deeper (e.g. a.b.tracker.com -> tracker.com)
        if (parts.length >= 4) {
          const apexParent = parts.slice(2).join('.');
          if (isValidParentZone(apexParent)) {
            if (!parentZoneMap.has(apexParent)) {
              parentZoneMap.set(apexParent, new Set());
            }
            parentZoneMap.get(apexParent)!.add(domain);
          }
        }
      }
    }

    // Identify qualifying parent zones that meet the threshold
    const collapsedGroups: CompactionResult['collapsedGroups'] = [];
    const coveredSubdomains = new Set<string>();

    // Sort parent zones by length descending so most specific sub-branches collapse first
    const sortedParents = Array.from(parentZoneMap.entries())
      .filter(([, children]) => children.size >= safeThreshold)
      .sort((a, b) => b[0].split('.').length - a[0].split('.').length);

    for (const [parent, children] of sortedParents) {
      const unabsorbed = Array.from(children).filter((c) => !coveredSubdomains.has(c));
      if (unabsorbed.length >= safeThreshold) {
        collapsedGroups.push({
          parentDomain: parent,
          subdomains: unabsorbed,
          rule: `||${parent}^`,
        });
        for (const child of unabsorbed) {
          coveredSubdomains.add(child);
        }
      }
    }

    // Compile final compacted rules
    const compactedRules: string[] = [];

    // 1. Add collapsed parent rules
    for (const group of collapsedGroups) {
      compactedRules.push(group.rule);
    }

    // 2. Add remaining uncollapsed individual domains
    for (const domain of sanitized) {
      if (!coveredSubdomains.has(domain)) {
        compactedRules.push(`||${domain}^`);
      }
    }

    const uniqueCompacted = Array.from(new Set(compactedRules));
    const savingsPercent = Math.round(
      ((sanitized.length - uniqueCompacted.length) / (sanitized.length || 1)) * 100,
    );

    return {
      originalCount: sanitized.length,
      compactedCount: uniqueCompacted.length,
      compactedRules: uniqueCompacted,
      savingsPercent: Math.max(0, savingsPercent),
      collapsedGroups,
    };
  } catch {
    return {
      originalCount: 0,
      compactedCount: 0,
      compactedRules: [],
      savingsPercent: 0,
      collapsedGroups: [],
    };
  }
}

/**
 * Cross-references a proposed blocking rule against existing allowlist rules (@@...).
 * Detects if the proposed rule is shadowed by an allowlist rule and suggests an
 * override with the $important modifier.
 *
 * @beta
 */
export function checkRuleConflict(rule: string, existingAllowRules: string[]): RuleConflictResult {
  try {
    if (!rule || typeof rule !== 'string' || !Array.isArray(existingAllowRules) || existingAllowRules.length === 0) {
      return { hasConflict: false };
    }

    // Extract domain from block rule (e.g. ||tracker.com^, 0.0.0.0 tracker.com, (^|\.)tracker\.com$, address=/tracker.com/, local-zone: "tracker.com")
    let targetDomain = '';
    const trimmed = rule.trim();

    const abpMatch = trimmed.match(/^\|\|([a-z0-9_.*-]+)\^/i);
    if (abpMatch) {
      targetDomain = abpMatch[1].replace(/^\*\./, '').toLowerCase().trim();
    } else {
      const hostsMatch = trimmed.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([a-z0-9_.-]+)/i);
      if (hostsMatch) {
        targetDomain = hostsMatch[1].toLowerCase().trim();
      } else {
        const dnsmasqMatch = trimmed.match(/^(?:address|server)=\/([a-z0-9_.-]+)\//i);
        if (dnsmasqMatch) {
          targetDomain = dnsmasqMatch[1].toLowerCase().trim();
        } else {
          const unboundMatch = trimmed.match(/^local-zone:\s*"([a-z0-9_.-]+)\.?"/i);
          if (unboundMatch) {
            targetDomain = unboundMatch[1].toLowerCase().trim();
          } else {
            const piholeMatch = trimmed.match(/^\(\^\|\\\.\)([a-z0-9_\\.-]+)\$$/i);
            if (piholeMatch) {
              targetDomain = piholeMatch[1].replace(/\\/g, '').toLowerCase().trim();
            } else {
              const wildcardMatch = trimmed.match(/^\*\.([a-z0-9_.-]+)/i);
              if (wildcardMatch) {
                targetDomain = wildcardMatch[1].toLowerCase().trim();
              } else {
                targetDomain = trimmed.replace(/[$^|!#]/g, '').trim().toLowerCase();
              }
            }
          }
        }
      }
    }

    const cleanTarget = sanitizeDomain(targetDomain);
    if (!cleanTarget) {
      return { hasConflict: false };
    }

    const buildOverride = (originalRule: string, domain: string): string => {
      if (originalRule.startsWith('||')) {
        if (originalRule.includes('$')) {
          const [base, optsStr] = originalRule.split('$', 2);
          const opts = optsStr.split(',').map((o) => o.trim()).filter(Boolean);
          if (!opts.includes('important')) {
            opts.push('important');
          }
          return `${base}$${opts.join(',')}`;
        }
        return `${originalRule}$important`;
      }
      // For hosts format (0.0.0.0 domain) or Pi-hole regex, synthesize canonical ABP $important override
      return `||${domain}^$important`;
    };

    for (const rawAllow of existingAllowRules) {
      if (typeof rawAllow !== 'string' || !rawAllow.startsWith('@@')) continue;
      const allowRule = rawAllow.trim();

      // Check exact or wildcard allowlist domain: @@||domain^
      const allowAbpMatch = allowRule.match(/^@@\|\|([a-z0-9_.-]+)\^/i);
      if (allowAbpMatch) {
        const allowDomain = sanitizeDomain(allowAbpMatch[1]);
        if (allowDomain && (cleanTarget === allowDomain || cleanTarget.endsWith(`.${allowDomain}`))) {
          return {
            hasConflict: true,
            conflictingAllowRule: allowRule,
            suggestedOverrideRule: buildOverride(rule, cleanTarget),
            reason: `Proposed rule is neutralized by allowlist rule "${allowRule}". Use $important to enforce blocking.`,
          };
        }
      }

      // Direct domain allow: @@domain
      const cleanAllowCandidate = allowRule.replace(/^(?:@@\|\||@@)/, '').split('^')[0]?.split('$')[0]?.toLowerCase().trim();
      const cleanAllow = cleanAllowCandidate ? sanitizeDomain(cleanAllowCandidate) : null;
      if (cleanAllow && (cleanTarget === cleanAllow || cleanTarget.endsWith(`.${cleanAllow}`))) {
        return {
          hasConflict: true,
          conflictingAllowRule: allowRule,
          suggestedOverrideRule: buildOverride(rule, cleanTarget),
          reason: `Proposed rule is neutralized by allowlist rule "${allowRule}". Use $important to enforce blocking.`,
        };
      }
    }

    return { hasConflict: false };
  } catch {
    return { hasConflict: false };
  }
}
