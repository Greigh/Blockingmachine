import type { StoredRule } from "../RuleStore.js";
import type { SupportedFormat } from "../types.js";
import { cleanDomainPattern } from "../createMetadata.js";

/**
 * The structural minimum a rule must carry for formatting — deliberately narrower than
 * `RuleStore.StoredRule`, whose `originalRule` the formatters never read. Stores that predate
 * that field (the CLI's schema keeps only `raw`) must be able to format their rows without
 * fabricating a field they never had.
 */
export interface FormattableRule {
  raw: string;
  type: StoredRule["type"];
  isException?: boolean;
  metadata?: { enabled?: boolean };
}

/**
 * Privoxy action-file section headers.
 *
 * Privoxy evaluates an action file top-down and — unlike a Shadowrocket/Surge rule set — **the last
 * action that matches a URL wins**. A child bypass therefore has to be emitted *after* the parent
 * block it escapes. The sections are emitted by the format drivers, not by `formatPrivoxyRule`:
 * where a section begins is a document-level decision and a single rule cannot know it.
 */
export const PRIVOXY_BLOCK_SECTION = "{+block{Blockingmachine Blocklist}}";
export const PRIVOXY_BYPASS_SECTION = "{-block}";

/**
 * The record section a BIND master file needs before any policy record.
 *
 * BIND refuses to load a primary zone whose file has no SOA, so a file of bare policy records does
 * not load at all. The SOA/NS pair below is the one the BIND ARM's own RPZ example uses.
 */
export const RPZ_ZONE_PREAMBLE = [
  "$TTL 3600",
  "@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )",
  "@ IN NS localhost.",
].join("\n");

/**
 * The null zone file every `bind-null` stanza points at, and its contents.
 *
 * A null zone is a zone with an SOA and an NS and no other data, which BIND answers authoritatively
 * for every name beneath the origin. One file serves any number of origins — verified on BIND
 * 9.20.29, where two unrelated zones loaded from this same file side by side.
 *
 * **What it answers, precisely, because it is not quite what people expect.** A subdomain gets
 * NXDOMAIN, but the *apex* gets NOERROR with an empty answer, because the apex exists (it has the
 * SOA and NS) and only its children are absent. So `ad.doubleclick.net` fails to resolve while
 * `doubleclick.net` returns NODATA. In practice both fail to give a client an address, and NODATA at
 * the apex is a weaker signal than NXDOMAIN — a client that treats NODATA as "exists, no A record"
 * behaves differently from one that treats NXDOMAIN as "blocked". RPZ has no such asymmetry, which
 * is the substantive reason to prefer it when the choice is open.
 */
export const BIND_NULL_ZONE_FILE = "db.blockingmachine.null";

export const BIND_NULL_ZONE_CONTENTS = [
  "$TTL 86400",
  "@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )",
  "@ IN NS localhost.",
].join("\n");

/** A stored rule must represent one enabled input line. */
export function isExportableRule(rule: FormattableRule): boolean {
  return !!rule?.raw?.trim() && rule.metadata?.enabled !== false &&
    !/[\r\n\u0085\u2028\u2029]/.test(rule.raw);
}

const COSMETIC_MARKER = /#(?:@?(?:#|\?#|\$#|\$\?#|%#)|[.,])|\$\$/;

/**
 * The comment prefix a format's own syntax uses.
 *
 * A DNS master file (BIND) is not `named.conf`: it holds resource records, and its comment
 * character is `;` — `#` is a parse error there, not a comment.
 */
export function exportCommentPrefix(format: SupportedFormat): string {
  if (format === "adguard" || format === "abp" || format === "all") return "! ";
  if (format === "bind") return "; ";
  // `#`, not `;`, and the difference is not cosmetic. `bind` emits a *zone file*, where `;` is a
  // comment; `bind-null` emits a *named.conf fragment*, and BIND's ARM is explicit that "the
  // semicolon (;) character cannot start a comment, unlike in a zone file" — there it ends a
  // statement. Caught by `named-checkconf`, which rejected the `;`-commented fragment outright.
  if (format === "bind-null") return "# ";
  return "# ";
}

/** An inert line recording an exception, in the target format's own comment syntax. */
export function formatExceptionComment(
  rule: FormattableRule,
  format: SupportedFormat,
  overridden = false,
): string {
  const label = overridden ? "EXCEPTION OVERRIDDEN BY $important" : "EXCEPTION";
  return `${exportCommentPrefix(format)}${label}: ${rule.raw}`;
}

export function isException(rule: FormattableRule): boolean {
  return !!rule && !!(
    rule.isException || rule.type === "unblocking" || rule.type === "exception" ||
    rule.raw.trim().startsWith("@@") || /#@(?:#|\?#|%#|\$#|\$\?#)/.test(rule.raw)
  );
}

/** Cosmetic selectors and scriptlet arguments may contain literal dollar signs. */
export function getNetworkModifiers(rule: FormattableRule): string[] {
  if (COSMETIC_MARKER.test(rule.raw)) return [];
  const dollarIndex = rule.raw.indexOf("$");
  return dollarIndex < 0 ? [] : rule.raw.slice(dollarIndex + 1).split(",").map(mod => mod.trim().toLowerCase());
}

const BROWSER_ONLY_TYPES = new Set([
  "cosmetic",
  "css",
  "extended-css",
  "html",
  "html-filtering",
  "scriptlet",
  "parameter",
  "transform",
  "javascript",
  "csp",
  "redirect",
  "replace",
  "removeheader",
  "permissions",
]);

export function isBrowserOnlyRule(rule: FormattableRule): boolean {
  if (!isExportableRule(rule)) return true;
  if (COSMETIC_MARKER.test(rule.raw) || BROWSER_ONLY_TYPES.has(rule.type)) return true;
  if (rule.raw.split("$")[0].includes("/")) return true;

  // Every other option narrows, rewrites, or changes the request semantics and
  // cannot be represented by an unconditional domain sinkhole.
  return getNetworkModifiers(rule).some(mod => mod !== "important" && mod !== "badfilter");
}

export function getDnsDomain(rule: FormattableRule): string | undefined {
  if (isBrowserOnlyRule(rule) || getNetworkModifiers(rule).includes("badfilter")) return undefined;
  return cleanDomainPattern(rule.raw) || undefined;
}

export function formatAdguardRule(rule: FormattableRule): string {
  if (!isExportableRule(rule)) return "";
  const raw = rule.raw.trim();

  // If rule is already valid ABP / AdGuard syntax, preserve as-is
  if (
    raw.startsWith("||") ||
    raw.startsWith("@@") ||
    raw.startsWith("|") ||
    raw.startsWith("!") ||
    raw.startsWith("[") ||
    raw.includes("##") ||
    raw.includes("#@#") ||
    raw.includes("#?#") ||
    raw.includes("#$#") ||
    raw.includes("#%#") ||
    raw.includes("$$")
  ) {
    return raw;
  }

  // Convert hosts file rules (0.0.0.0 domain or 127.0.0.1 domain) to ABP syntax
  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/.test(raw)) {
    const domain = cleanDomainPattern(raw);
    if (domain) {
      return isException(rule) ? `@@||${domain}^` : `||${domain}^`;
    }
  }

  // Convert bare domain rules to ABP syntax
  const cleanDomain = cleanDomainPattern(raw);
  if (cleanDomain && cleanDomain === raw.toLowerCase()) {
    return isException(rule) ? `@@||${cleanDomain}^` : `||${cleanDomain}^`;
  }

  return raw;
}

export function formatRuleForType(
  rule: FormattableRule,
  format: SupportedFormat,
): string {
  if (!isExportableRule(rule)) return "";
  switch (format) {
    case "hosts":
      return formatHostsRule(rule);
    case "dnsmasq":
      return formatDnsmasqRule(rule);
    case "unbound":
      return formatUnboundRule(rule);
    case "bind":
      return formatBindRule(rule);
    case "bind-null":
      return formatBindNullRule(rule);
    case "privoxy":
      return formatPrivoxyRule(rule);
    case "shadowrocket":
      return formatShadowrocketRule(rule);
    case "domains":
      if (isException(rule)) {
        if (!getDnsDomain(rule)) return "";
        return `# EXCEPTION: ${rule.raw}`;
      }
      return getDnsDomain(rule) || "";
    case "plain":
      return rule.raw;
    case "adguard":
    case "abp":
      return formatAdguardRule(rule);
    case "all":
      return rule.raw;
    default:
      return rule.raw;
  }
}

function formatHostsRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `0.0.0.0 ${domain}`;
}

function formatDnsmasqRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `address=/${domain}/0.0.0.0`;
}

function formatUnboundRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `  local-zone: "${domain}" always_nxdomain`;
}

function formatBindRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return formatExceptionComment(rule, "bind");
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  // One `zone { type master; file … }` stanza per blocked domain cannot work: BIND refuses a
  // primary zone whose file holds no SOA, and no single file can serve 100k different origins. The
  // artifact is therefore a Response Policy Zone, where the records *are* the list. `CNAME .` is
  // RPZ's documented NXDOMAIN policy, and because the name is relative it is rewritten against the
  // RPZ origin — which is exactly how BIND recovers the name being blocked.
  return `${domain} CNAME .`;
}

/**
 * The RPZ records that block one domain and everything under it.
 *
 * **Two records, not one, and the second is the whole point.** A bare QNAME trigger
 * (`ads.example.com CNAME .`) matches *that name only* — the RPZ draft is explicit: *"To control
 * the policy for both a name and its subdomains, two policy RRsets must be used, one for the domain
 * itself and another for a wildcard subdomain."* Verified against BIND 9.20.29 rather than assumed:
 * with only the bare record, `ad.doubleclick.net` still resolved; adding `*.doubleclick.net CNAME .`
 * made the same query return NXDOMAIN.
 *
 * Without the wildcard this format silently under-blocked, and it disagreed with every other format
 * in the project — `local-zone: "ads.example.com"` (Unbound), `address=/ads.example.com/0.0.0.0`
 * (dnsmasq) and `DOMAIN-SUFFIX,ads.example.com,REJECT` (Shadowrocket) all match the domain *and its
 * subdomains*, because the source rule `||ads.example.com^` means both. The wildcard is what makes
 * BIND agree with the list it was generated from.
 *
 * Exported because the two RPZ emission paths — the exporter and the advanced formatter — have to
 * make this pair together or they drift, which is the same bug twice.
 */
export function bindRpzBlockRecords(domain: string): string[] {
  return [`${domain} CNAME .`, `*.${domain} CNAME .`];
}

/**
 * The RPZ records that exempt one child and everything under it.
 *
 * The wildcard matters for the same reason it does on the block side: an exception written as
 * `@@||child.parent.example^` releases the child *and its subdomains* in every other format, so
 * emitting only the bare passthru would release `child.parent.example` while re-blocking
 * `sub.child.parent.example` through the parent's wildcard.
 *
 * Correctness of the combination rests on the draft's "Domain Name Matching" precedence rule — *"an
 * exact name match is better than one involving a wildcard"* — so a bare passthru on the child beats
 * the parent's `*.parent.example` block, while a name one level deeper falls through to the wildcard
 * and is blocked, which is the intended answer either way.
 */
export function bindRpzPassthruRecords(subdomain: string): string[] {
  return [`${subdomain} CNAME rpz-passthru.`, `*.${subdomain} CNAME rpz-passthru.`];
}

/**
 * One `zone` stanza for a domain, pointing every blocked origin at the same shared null file.
 *
 * The `bind-null` mechanism, and it is the *opposite* trade to RPZ: the file never changes, so
 * updating the blocklist means reloading named rather than regenerating and re-copying a zone, and
 * `named.conf` grows by one line per blocked domain. `file` is shared deliberately — BIND serves any
 * number of origins from one master file, which is what makes a 3-line file able to stand in for
 * 100,000 domains.
 */
function formatBindNullRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    // No stanza can release a child of an authoritative zone — BIND answers the parent before
    // any forward or policy lookup is consulted (proved on a live 9.20.x `named`: forward-zone,
    // forward-zone-with-forwarders and RPZ-passthru variants all still answer the parent's
    // NXDOMAIN). The only mechanism that works is an `NS` delegation inside the parent's own
    // zone data, which a shared file cannot express. `NOT HONOURED` is in the label so the line
    // cannot be misread as the honoured comment other formats emit for the same rule.
    return `${exportCommentPrefix("bind-null")}EXCEPTION NOT HONOURED: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `zone "${domain}" { type master; file "${BIND_NULL_ZONE_FILE}"; };`;
}

function formatPrivoxyRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return formatExceptionComment(rule, "privoxy");
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  // The leading dot is the whole mechanism: a bare host in a Privoxy action file matches that host
  // only, while `.example.com` matches the domain and every subdomain of it.
  return `.${domain}`;
}

function formatShadowrocketRule(rule: FormattableRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  // `DOMAIN-SUFFIX`, not `DOMAIN`: the blocklist is keyed by registrable domain, and `DOMAIN`
  // matches that exact host only — every subdomain of a blocked domain would sail straight
  // through. `DOMAIN-SUFFIX` is what Shadowrocket and Surge users mean by a domain block.
  return `DOMAIN-SUFFIX,${domain},REJECT`;
}
