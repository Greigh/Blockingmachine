/**
 * Turning a blocklist line into the host it blocks, and a rule's category into a host's
 * attribution.
 *
 * ## Why this module exists
 *
 * The desktop hub parses ~740,000 rules from a dozen publishers and knows, for every one of
 * them, **which list it came from** and therefore what kind of thing it is. It also knows which
 * hosts appear in more than one list. None of that reached the extension: the packaged tier
 * files are compiled by a script that only ever sees one deduplicated text file, so it
 * classified every host by tokenising its name against vocabulary derived from the curated
 * tier files. That is a guess, and on the hub's real list it failed to place **90% of hosts**.
 *
 * The fix is not a better guess. The hub already holds the exact answer — the publisher filed
 * the rule under a category — and simply never wrote it down. This module is the part that
 * turns each rule's category into a host's set of categories, and writes that down.
 *
 * ## Why attribution is a *set*
 *
 * A host in both EasyList and EasyPrivacy is an ad host and a tracking host, and the honest
 * answer is both. Reducing it to one category at this layer would throw away the only piece of
 * information that makes the attribution worth having; choosing between them is a statement
 * about the *tier's* purpose, so it belongs to the consumer that knows what the tiers are for.
 * `buildCategoryAttribution` therefore returns a set per host and nothing more.
 *
 * ## What the deduplication actually means here
 *
 * A host that appears in six lists is one host with six categories, not six hosts. Two lists
 * covering different hosts can also produce the same rule text only when they cover the *same*
 * host, so deduplicating on the stripped rule and unioning categories is exact rather than
 * approximate — with one exception worth stating: two rules that differ only in a modifier
 * (`||a.com^$script`, `||a.com^$image`) are distinct rules, and the host set collapses them
 * while the category union does not. That is the wanted behaviour for attribution, which is
 * about hosts.
 *
 * ## Relationship to the tier compiler's own copy
 *
 * `scripts/compile-tier-rulesets.mjs` carries its own `extractHostFromLine` and cannot import
 * this one: it is a packaging script that runs before any build, and taking a compiled
 * dependency would make `compile:tiers` refuse to run on a clean checkout. The compiler's
 * version is the same function, and a test in the extension suite pins the two against a table
 * of shapes so the duplication cannot drift — the same arrangement the ledger reader uses.
 */

import { firstIndexOfAny, stripTrailingChars } from './utils/textScan.js';

/** Directives that describe something a browser cannot express as a zone block. */
const SKIP_MODIFIERS = [
  '$dnsrewrite',
  '$dnstype',
  '$client',
  '$ctag',
  '$badfilter',
  '$removeparam',
];

/** Cosmetic-filter markers, which select page elements rather than block a request. */
const COSMETIC_MARKERS = ['##', '#@#', '#?#', '#$#', '$$', '+js(', '#%#'];

/**
 * Syntactically a zone, but blocking it would take out a whole registry.
 *
 * A short list rather than the Public Suffix List, for the same reason the compiler keeps its
 * own: this module cannot take a dependency that is not in the tree, and a blocklist shipping
 * `com` as a host is a defect the tests will catch long before it matters.
 */
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'uk', 'de', 'fr', 'ru', 'cn',
  'jp', 'br', 'in', 'au', 'pl', 'it', 'nl', 'se', 'no', 'es', 'mx', 'ch', 'at', 'be', 'dk',
  'fi', 'cz', 'gr', 'tr', 'kr', 'tw', 'hk', 'sg', 'nz', 'za', 'ar', 'cl', 'co.uk', 'org.uk',
  'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'com.br',
  'com.cn', 'com.mx', 'co.in', 'co.za', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'co.il',
  'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'co.at', 'or.at', 'com.pl', 'com.ua', 'com.ke',
  'github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'workers.dev',
  'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com', 'blogspot.com', 'wordpress.com',
]);

const DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Canonicalises a blocklist line into the host it blocks, or null when the line expresses
 * something a static tier rule cannot: an exception, a cosmetic filter, a request-type
 * modifier, a loopback mapping, or a bare public suffix.
 *
 * Understands every shape the hub emits — hosts files, ABP, dnsmasq, and Unbound — because the
 * caller may be handed any of the compiled outputs, and a line this refuses is a line nobody
 * has to explain later.
 */
export function extractHostFromRule(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let line = raw.trim();
  if (!line) return null;
  if (line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) return null;
  for (const marker of COSMETIC_MARKERS) {
    if (line.includes(marker)) return null;
  }
  for (const modifier of SKIP_MODIFIERS) {
    if (line.includes(modifier)) return null;
  }
  // Exceptions are the opposite of a block rule; a tier may only ship blocks.
  if (line.startsWith('@@')) return null;
  // Loopback and broadcast mappings, which a hosts file uses for local names.
  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)\b/i.test(line)) {
    return null;
  }

  // Already-Unbound lines can appear in a user-supplied drop-in.
  const localZone = /^local-zone:\s*"([^"]+)"/i.exec(line);
  if (localZone) line = localZone[1]!;
  const localData = /^local-data:\s*"([^\s"]+)/i.exec(line);
  if (localData) line = localData[1]!;
  const dnsmasq = /^(?:address|server)=\/([^/]+)\//i.exec(line);
  if (dnsmasq) line = dnsmasq[1]!;

  line = line
    .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, '') // hosts entry
    .replace(/^@@/, '')
    .replace(/^\|\|/, '') // ABP domain anchor
    .replace(/^\|/, '');

  // Everything from the first `$`, `^`, `|` or `/` is a modifier, terminator or path — cut
  // by index rather than by `[\^|].*$`-style regexes, which rescan a hostile run of those
  // markers quadratically. `.*` could never cross a newline, so the scan is restricted to
  // the final line segment exactly as the regexes were.
  const segmentStart = line.lastIndexOf('\n') + 1;
  const cut = firstIndexOfAny(line.slice(segmentStart), '$^|/');
  if (cut >= 0) line = line.slice(0, segmentStart + cut);
  line = stripTrailingChars(line, '.').trim().toLowerCase();

  if (!line) return null;
  // Wildcards cannot be expressed in a domain-form zone block.
  if (line.includes('*')) return null;
  // Bare hosts and anything that is not a dotted name (IPs included) are not zones.
  if (!line.includes('.')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(line) || line.includes(':')) return null;
  if (!DOMAIN_REGEX.test(line)) return null;
  // Syntactically a zone, but blocking it would take out a whole registry.
  if (PUBLIC_SUFFIXES.has(line)) return null;
  return line;
}

/**
 * One publisher's contribution: the category its list is filed under, and the rules it held.
 *
 * `name` and `url` are the list's configured identity — optional because a caller that only
 * wants the category geometry can omit them, in which case the attribution simply has no
 * provenance to report rather than a fabricated one. `error` marks a source that was
 * attempted but did not produce: its rules (if any were supplied at all) are not attributed,
 * because a failed fetch's partial output is not a thing the manifest should stand behind.
 */
export interface AttributedSource {
  /** The category the list is filed under; a rule's own `metadata.sourceInfo.category` wins. */
  category: string;
  name?: string | null;
  url?: string | null;
  error?: string | null;
  /**
   * A content revision for what was fetched, when the caller can compute one.
   *
   * The convention is `sha256:` over the source's raw rule lines sorted and newline-joined —
   * caller-computed because this module stays crypto-free (it is bundled into the browser
   * extension, where `node:crypto` does not exist). Two pulls of the same list produce the same
   * revision; "same lists, same content" and "same lists, new pull" stay distinguishable in the
   * manifest, which is otherwise impossible from name+url alone. Omit it when nothing was
   * fetched — a failed pull has no content to pin.
   */
  revision?: string | null;
  rules: ReadonlyArray<{
    raw?: string | null;
    metadata?: { sourceInfo?: { category?: unknown } | null } | null;
  } | null | undefined>;
}

/**
 * What one configured source contributed to a compilation.
 *
 * This is the manifest's answer to "what was this built from": the list's identity, the
 * categories its rules actually resolved to (which can differ from the category the list was
 * filed under, when a rule carried its own filing), and how much of it survived extraction.
 * A source whose fetch failed is listed with its `error` rather than dropped — "nine sources
 * produced this" and "nine were configured" are different statements, and only the second is
 * what a reader would assume when a category looks thin.
 */
export interface AttributionSource {
  /** The list's display name, when it gave one. */
  name?: string;
  /** Where the list was fetched from, when known. */
  url?: string;
  /** The categories its rules resolved to, in the order first seen. */
  categories: string[];
  /** Rules the source carried, including ones that named no blockable host. */
  rules: number;
  /** Distinct blockable hosts its rules produced. */
  hosts: number;
  /**
   * The content revision the caller reported for this source — a digest of the rules it carried
   * (`sha256:` over sorted raw lines by convention), so two builds of "the same list" can be told
   * apart when the list changed underneath. Absent when the caller could not pin one, which on a
   * failed fetch is always the case.
   */
  revision?: string;
  /** Set when the fetch failed: the source was attempted, not producing. */
  error?: string;
}

export interface CategoryAttribution {
  /** Every distinct host, with every category that claimed it. */
  hosts: Map<string, Set<string>>;
  /** category -> the hosts it claimed. The inverse of `hosts`, built for the file layout. */
  byCategory: Map<string, Set<string>>;
  /** Hosts more than one category claimed, which is where a consumer must choose. */
  contested: number;
  /** Rules that named no blockable host, so nothing could be said about them. */
  unusableRules: number;
  /** Categories present, whether or not they claimed anything. */
  categories: string[];
  /** The identified sources the attribution was built from, in the order they were given. */
  sources: AttributionSource[];
}

/**
 * Attributes every blockable host to every category that listed it.
 *
 * Categories are unioned rather than overwritten, which is the whole point: a host in six
 * publisher lists is one host that six publishers filed differently, and a consumer that wants
 * a single tier per host needs the full set to make that choice knowingly.
 *
 * Order of the returned map's insertion is the order hosts were first seen, so two runs over
 * the same sources produce the same iteration order and therefore the same bytes on disk.
 */
export function buildCategoryAttribution(sources: readonly AttributedSource[]): CategoryAttribution {
  const hosts = new Map<string, Set<string>>();
  const byCategory = new Map<string, Set<string>>();
  const categories: string[] = [];
  // Keyed by name+url so the same list handed in twice — once per category slice, say — is
  // still one source in the record, holding the union of what it carried.
  const records = new Map<
    string,
    {
      name?: string;
      url?: string;
      error?: string;
      revision?: string;
      rules: number;
      categories: Set<string>;
      hosts: Set<string>;
    }
  >();
  let unusableRules = 0;

  const text = (value: unknown): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || undefined;
  };
  const register = (category: string) => {
    if (!byCategory.has(category)) {
      byCategory.set(category, new Set());
      categories.push(category);
    }
  };

  for (const source of sources) {
    const name = text(source?.name);
    const url = text(source?.url);
    const error = text(source?.error);
    const rules = source?.rules ?? [];

    let record;
    if (name || url) {
      const key = `${name ?? ''}${url ?? ''}`;
      record = records.get(key);
      if (!record) {
        record = { name, url, rules: 0, categories: new Set<string>(), hosts: new Set<string>() };
        records.set(key, record);
      }
      record.rules += rules.length;
      if (error) record.error ??= error;
      // First writer wins: two slices of one list should carry the same pin, and a disagreement
      // is a fact about the inputs a reader should be able to check, not a merge artefact. A
      // failed fetch records no revision even if the caller supplies one — there is nothing
      // fetched for it to pin, and recording one would describe content that never arrived.
      const revision = text(source?.revision);
      if (revision && !error) record.revision ??= revision;
    }

    // A failed fetch is an attempt, not a contribution: recorded above so the manifest can
    // say it was tried, but none of its output is attributed — partial output is not a thing
    // the record should stand behind, and a declared category it never filed rules under is
    // not a category that was present.
    if (error) continue;

    const declared = text(source?.category) ?? 'uncategorised';
    register(declared);
    for (const rule of rules) {
      // The rule's own filing wins over the list's declared category: the parser stamps the
      // catalog's answer onto each rule, which is strictly better than a stored setting the
      // user may have edited since.
      const resolved = text(rule?.metadata?.sourceInfo?.category) ?? declared;
      register(resolved);
      record?.categories.add(resolved);
      const host = extractHostFromRule(rule?.raw);
      if (!host) {
        unusableRules += 1;
        continue;
      }
      let claimed = hosts.get(host);
      if (!claimed) {
        claimed = new Set();
        hosts.set(host, claimed);
      }
      claimed.add(resolved);
      byCategory.get(resolved)!.add(host);
      record?.hosts.add(host);
    }
  }

  let contested = 0;
  for (const claimed of hosts.values()) {
    if (claimed.size > 1) contested += 1;
  }

  return {
    hosts,
    byCategory,
    contested,
    unusableRules,
    categories,
    sources: [...records.values()].map((record) => ({
      ...(record.name ? { name: record.name } : {}),
      ...(record.url ? { url: record.url } : {}),
      categories: [...record.categories],
      rules: record.rules,
      hosts: record.hosts.size,
      ...(record.revision ? { revision: record.revision } : {}),
      ...(record.error ? { error: record.error } : {}),
    })),
  };
}

export interface CategoryAttributionManifest {
  /** Schema marker, so a consumer can refuse a file it does not understand. */
  format: 'blockingmachine-category-attribution';
  version: 1;
  /** When the compilation ran — the provenance record's "when". */
  generatedAt?: string;
  /**
   * The configured sources the compilation was built from — what a build names when it says
   * what it was built from. Empty means the caller gave no source identities, not that the
   * output had no inputs.
   */
  sources: AttributionSource[];
  /** category -> host count, so a reader can size a file before opening it. */
  counts: Record<string, number>;
  /** Distinct hosts across every category. */
  hosts: number;
  /** Hosts more than one category claimed. */
  contested: number;
  /** Rules that named no blockable host. */
  unusableRules: number;
  /** Categories that have a file, in the order they were first seen. */
  categories: string[];
  /**
   * Categories that produced no blockable host, and so have no file.
   *
   * The project's own `unbreak` module is one — it is an allowlist, so every rule in it is an
   * exception and none of them names a host a tier could block. Listing it in `categories`
   * without a file to read is how a reader ends up reporting a *missing file* for a category that
   * never had anything in it, which is a louder and less useful signal than the truth.
   */
  empty: string[];
}

export function toAttributionManifest(
  attribution: CategoryAttribution,
  options: { generatedAt?: string } = {},
): CategoryAttributionManifest {
  const counts: Record<string, number> = {};
  const categories: string[] = [];
  const empty: string[] = [];
  for (const category of attribution.categories) {
    const size = attribution.byCategory.get(category)?.size ?? 0;
    if (size === 0) {
      empty.push(category);
      continue;
    }
    counts[category] = size;
    categories.push(category);
  }
  return {
    format: 'blockingmachine-category-attribution',
    version: 1,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    sources: attribution.sources,
    counts,
    hosts: attribution.hosts.size,
    contested: attribution.contested,
    unusableRules: attribution.unusableRules,
    categories,
    empty,
  };
}

/**
 * Renders one category as a blocklist the tier compiler already knows how to read.
 *
 * `||host^` rather than a bare host because that is the shape the hub's ABP output uses and
 * the shape the compiler's own reader was written against: emitting a new format would mean
 * two readers to keep in step for no gain. Sorted, so the file is byte-identical for identical
 * attribution and a diff shows a real change rather than a reordering.
 */
export function toCategoryBlocklist(hosts: Iterable<string>): string {
  const sorted = [...hosts].sort();
  return sorted.length === 0 ? '' : `${sorted.map((host) => `||${host}^`).join('\n')}\n`;
}
