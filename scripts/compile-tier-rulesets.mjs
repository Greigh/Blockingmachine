#!/usr/bin/env node

/**
 * Compile the desktop hub's active blocklist into the extension's static ruleset tiers.
 *
 * The extension ships `rules/tier_*.json` as Manifest V3 static rulesets. Left alone they
 * hold a small hand-curated baseline, which means a released extension carries ~118 rules
 * while the hub on the same machine has already compiled a six-figure blocklist. This script
 * closes that gap: at package time it compiles the hub's output into the tier files, so a
 * shipped build carries the synced list instead of the baseline.
 *
 * ## The budget is the whole problem
 *
 * A tier rule is a domain-form `||host^` block, and MV3 grants an extension only
 * `GUARANTEED_MINIMUM_STATIC_RULES` (30,000) static rules across its *enabled* rulesets.
 * The hub's list is ~117,000 domains. "Ship the full list" is therefore not achievable, and
 * a script that pretended otherwise would either silently drop most of the input or produce
 * an extension Chrome refuses to load. So this compiler:
 *
 *   - keeps the total across all four tiers at or below the guaranteed budget, which is the
 *     invariant `verify-mv3-compliance.mjs` enforces, and which guarantees that enabling any
 *     combination of tiers can never fail for lack of rule budget;
 *   - fills each tier up to its share, then **redistributes unused capacity** to the tiers
 *     that still have candidates, so a thin category does not waste the budget;
 *   - reports exactly what was included and what overflowed, per tier, every run.
 *
 * Disabled rulesets do not consume budget, so the tiers are genuinely additive — but the
 * extension enables them at runtime, and `updateEnabledRulesets()` can fail, so a plan that
 * only fits while some tiers are off would be a trap. The 30,000 total avoids that.
 *
 * ## Curated hosts are never lost
 *
 * The tier files already on disk are read first and their hosts are always included, in
 * their original tier. Compilation *extends* the curated baseline; it never replaces it. That
 * keeps the hand-picked, highest-confidence entries stable across runs and makes the diff of
 * a regenerated tier purely additive.
 *
 * ## Ranking the cut by what actually blocked
 *
 * The hub's list is ~117,000 domains and the budget is 30,000, so the cut is not a detail —
 * it decides what the extension blocks. Taking candidates in input order means the list's
 * own ordering decides it, and a merged blocklist's order is a merge artifact: whichever
 * upstream list was concatenated first gets the slots, which says nothing about the traffic
 * the user actually generates.
 *
 * `--hits <file>` therefore ranks each tier's candidates by the browser's own rule-hit
 * evidence before the budget is allocated — the same `<count> <rule>` ledger text
 * `build-hot-list.mjs --hits` reads, whether that is a raw browser ledger or the hot list
 * built from it. Hosts with evidence ship first, most-fired first; the rest keep their input
 * order, so the cut spends its slots on measured traffic and the unmeasured remainder is
 * still, deterministically, the tail of the list.
 *
 * Three boundaries are deliberate:
 *
 *  - **Ranking is opt-in, with no default evidence file.** A default that depended on a
 *    locally generated artifact would make the plan machine-dependent, which is exactly how
 *    `--check` came to exit 1 on every machine that had ever compiled. Naming the file is
 *    the packaging decision it should be.
 *  - **Evidence ranks within a tier; it never re-tiers.** Which tier a host belongs to is a
 *    statement about what kind of thing it is, and moving a busy `tier_privacy` host into
 *    `tier_core` would corrupt both the taxonomy and the curated baseline.
 *  - **Curated hosts keep their place.** They are first in their tier, in curated order, with
 *    or without evidence — they are hand-picked, not measured.
 *
 * With `--hits`, rule ids follow measured usefulness; without it, they follow input order.
 * Either way the output is byte-identical for identical inputs, so `--check` stays a diff.
 *
 * ## Placing a host in a tier, exactly
 *
 * The vocabulary above is a guess, and on the hub's real list it placed 12,552 of 122,801 hosts
 * — the rest matched no word in any list, and a host whose name happens to contain `track` was
 * filed as tracking whether or not it was. The desktop hub does not have to guess: every rule it
 * parses carries the category its *publisher* filed it under, and every compilation now writes
 * that down as one blocklist per category beside the other outputs.
 *
 * `--attribution <dir>` reads those and places each host from the publisher's own category, with
 * hostname vocabulary demoted to the fallback for a host the hub had no category for. The
 * vocabulary it replaces placed **12,444 of the hub's 122,801 hosts (10.1%)** and left the other
 * 110,249 unclassified; the categories exist for every host a publisher listed, so the two
 * numbers are not close. The report says which of the two produced each plan rather than leaving
 * it to be assumed.
 *
 * How much of a *given* list is covered depends on which sources were enabled for the hub
 * compilation that produced it, so it is reported per run and not claimed here: a build with
 * `--attribution` against a hub output whose sources were the project's nine local modules
 * covers only what those modules list. The honest measurement is a number from a real
 * compilation, which is why the report prints one rather than this comment asserting a figure.
 *
 * A host listed by several publishers is claimed by several categories and resolved by a stated
 * precedence; the count of such hosts is reported, because a taxonomy that coarse should be
 * visible. Three hub categories map to no tier on purpose — `security`, `unbreak` and
 * `anti-circumvention` — and `CATEGORY_TIERS` says why at length.
 *
 * ## Determinism
 *
 * The same inputs always produce byte-identical tier files: hosts keep the order they
 * arrived in (curated first, then evidence rank, then input order within each group), rule
 * ids are assigned from that order, and no clock, hash iteration, or locale rule
 * participates.
 *
 * ## What `--check` can and cannot be
 *
 * `--check` asks whether the tiers on disk are what this script would write now — but the
 * repository ships the *curated baseline* while a hub list compiles to a 30,000-rule plan, so
 * comparing the two unconditionally failed on every machine that had ever compiled, which is
 * why the check was never wired into the sweep. It is therefore provenance-aware: the
 * `tierCounts.generated.ts` written by every run is the declaration of which state the tree is
 * in. With a compilation recorded, the plan is recomputed and compared byte-for-byte. With
 * only the checked-in `null` baseline, there is nothing to be stale against, and the baseline
 * is verified on its own terms instead — every tier present, a non-empty ruleset array, and
 * holding exactly the rule count the extension's own catalogue declares for it.
 *
 * Usage:
 *   node scripts/compile-tier-rulesets.mjs
 *   node scripts/compile-tier-rulesets.mjs --input filters/output/hosts.txt --budget 20000
 *   node scripts/compile-tier-rulesets.mjs --hits ledger-hits.txt
 *   node scripts/compile-tier-rulesets.mjs --attribution path/to/categories
 *   node scripts/compile-tier-rulesets.mjs --check
 *   node scripts/compile-tier-rulesets.mjs --json
 *
 * Where the evidence comes from:
 *   npm run ledger:merge -- --in export-1.json --in export-2.json --out ledger-hits.txt
 *   node scripts/compile-tier-rulesets.mjs --hits ledger-hits.txt
 *
 * The attribution directory is written by the desktop hub on every compilation, beside the
 * compiled lists it already produces (<savePath directory>/categories).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT_DIR = resolve(__dirname, '..');
const EXT_DIR = resolve(ROOT_DIR, 'packages/browser-extension');
const RULES_DIR = resolve(EXT_DIR, 'rules');
const GENERATED_COUNTS_PATH = resolve(EXT_DIR, 'src/shared/tierCounts.generated.ts');
const CATALOGUE_PATH = resolve(EXT_DIR, 'src/shared/rulesetTiers.ts');

/** The one priority every tier rule uses — mirrors `PRIORITY_STATIC_TIER`. */
export const PRIORITY_STATIC_TIER = 1;

/** Chrome's guaranteed static-rule floor, mirrored from `MV3_STATIC_LIMITS`. */
export const GUARANTEED_STATIC_RULES = 30000;

export const TIER_IDS = [
  'tier_core',
  'tier_ads',
  'tier_privacy',
  'tier_annoyances',
  'tier_security',
];

/**
 * Tiers the repository ships no hand-curated content for.
 *
 * `tier_security` holds the embedded classifier's own malware and phishing verdicts, and those
 * exist only where a machine has run the classifier over a real blocklist. A fresh checkout
 * therefore ships it **empty**, and that is the correct state rather than a lost baseline — which
 * is why the three places that assert "a tier is non-empty" (the ruleset validator, `--check`
 * here, and the extension's tier/model agreement suite) have to be able to tell this tier apart
 * from the other four instead of being loosened for all of them.
 *
 * A tier in this list is still compiled additively like any other: it has no curated seed to
 * preserve, so everything it ships comes from the classifier input.
 */
export const COMPILED_ONLY_TIERS = ['tier_security'];

/**
 * Share of the budget each tier may claim before redistribution, out of 100.
 *
 * A share is a *cap*, never a reservation: capacity a tier does not use is redistributed in
 * proportion to what the other tiers still hold, so the shares decide the split only when every
 * tier has more candidates than its cap.
 *
 * The security share was sized by measuring what the classifier actually flags rather than by
 * guessing. On this repository's real 190,035-host browser list the Mini-AI returns **6,392**
 * malware or phishing verdicts, so a share of 12 — about 3,600 slots — still binds, and the
 * omission is reported per tier like any other rather than being hidden. That is a deliberate
 * choice and not a shrug: a large part of that pool is fresh random-subdomain DGA hosts on the
 * `.cyou` and `.cfd` high-abuse TLDs, where an individual `||host^` rule has a short useful life
 * because the operator rotates the subdomain, while a rule in the ad or privacy tiers blocks
 * something that stays put. The four curated tiers give up their capacity in proportion to their
 * previous shares (40:27:20:13 scaled by the remaining 88), which is why the numbers are not round.
 * An operator who disagrees can move the boundary without editing this file — the shares are a
 * starting point, and the per-tier omission line is what tells them whether it bound.
 */
export const DEFAULT_SHARES = {
  tier_core: 35,
  tier_ads: 24,
  tier_privacy: 18,
  tier_annoyances: 11,
  tier_security: 12,
};

/**
 * Hostname vocabulary for tier assignment.
 *
 * Deliberately derived from the hosts already in the curated tier files rather than
 * invented here, so compilation extends the project's own taxonomy instead of competing
 * with it. Matching is on whole hyphen/dot-delimited tokens to avoid the classic
 * `adapter`/`admonition` false positives.
 */
export const TIER_VOCABULARY = {
  tier_annoyances: [
    'consent', 'cookie', 'cookies', 'cookiebot', 'cookielaw', 'onetrust', 'osano', 'termly',
    'iubenda', 'quantcast', 'privacy-mgmt', 'cmp', 'gdpr', 'ccpa', 'onesignal', 'pushengage',
    'izooto', 'webpushr', 'foxpush', 'sendpulse', 'popupsmart', 'privy', 'justuno', 'optimonk',
    'wisepops', 'getsitecontrol', 'sleeknote', 'hellobar', 'pushcrew', 'pushnami', 'notify',
    'notification', 'popup', 'popunder', 'nag', 'survey', 'exit-intent', 'newsletter',
  ],
  tier_ads: [
    'ads', 'adserver', 'adserv', 'adtech', 'advert', 'advertising', 'adnetwork', 'adbanner',
    'banner', 'banners', 'sponsor', 'sponsored', 'promo', 'promos', 'affiliate', 'affil',
    'campaign', 'creativ', 'creative', 'exchange', 'bidder', 'bids', 'dsp', 'ssp', 'rtb',
    'doubleclick', 'adsystem', 'adsense', 'adform', 'adroll', 'criteo', 'taboola', 'outbrain',
    'interstitial', 'prebid', 'advertising', 'marketing', 'leadgen',
  ],
  tier_privacy: [
    'analytics', 'analytic', 'telemetry', 'metrics', 'metric', 'stats', 'statistic', 'track',
    'tracker', 'tracking', 'pixel', 'beacon', 'collect', 'collector', 'telemetry', 'log',
    'logs', 'logging', 'monitor', 'monitoring', 'segment', 'heatmap', 'session', 'replay',
    'fingerprint', 'fingerprinting', 'attribution', 'audience', 'tagmanager', 'gtm', 'insight',
    'measure', 'measurement', 'analytics', 'profiling', 'graph', 'dmp', 'identity',
  ],
};

/**
 * Indicators that put a host in the tier that is on by default. These are the categories
 * where a false block is the least costly and a missed block is the most costly.
 *
 * Deliberately still routed to `tier_core` now that `tier_security` exists. The alternative —
 * moving every threat-named host into the opt-in tier — would mean a fresh install stops blocking
 * malware it can recognise from the hostname alone, which trades away real protection to make the
 * taxonomy tidier. So the two tiers specialise instead: `tier_core` keeps the hosts whose *name*
 * gives them away, and `tier_security` carries what name-matching cannot see and no publisher list
 * happened to carry — the classifier's own verdicts about ordinary-looking hosts.
 */
export const CORE_INDICATORS = [
  'malware', 'phishing', 'phish', 'botnet', 'c2', 'command-and-control', 'ransom',
  'cryptominer', 'miner', 'exploit', 'scam', 'fraud', 'spyware', 'trojan', 'keylog',
  'telemetry-villain', 'badtld',
];

/**
 * Multi-part public suffixes. A hosts line naming one of these would produce a rule that
 * blocks an entire registry, so they are refused outright rather than treated as a zone.
 * Not a full Public Suffix List — a guard against the catastrophic case, kept small and
 * explicit rather than approximated.
 */
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'uk', 'de', 'fr', 'ru', 'cn',
  'jp', 'br', 'in', 'au', 'pl', 'it', 'nl', 'se', 'no', 'es', 'mx', 'ch', 'at', 'be', 'dk',
  'fi', 'cz', 'gr', 'tr', 'kr', 'tw', 'hk', 'sg', 'nz', 'za', 'ar', 'cl', 'co.uk', 'org.uk',
  'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'com.br',
  'com.cn', 'com.mx', 'co.in', 'co.za', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'co.il',
  'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'co.at', 'or.at', 'com.pl', 'com.ua', 'co.ke',
  'github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'workers.dev',
  'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com', 'blogspot.com', 'wordpress.com',
]);

/** Directives that describe something a browser cannot express as a zone block. */
const SKIP_MODIFIERS = ['$dnsrewrite', '$dnstype', '$client', '$ctag', '$badfilter', '$removeparam'];

const COSMETIC_MARKERS = ['##', '#@#', '#?#', '#$#', '$$', '+js(', '#%#'];

const DOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Repo-relative when the path is inside the repo, absolute when it is not.
 *
 * `relative` on its own prints a `../../../..` chain for a ledger kept beside the checkout, which
 * is neither short nor honest about where the file actually was.
 */
export function displayPath(path) {
  const rel = relative(ROOT_DIR, path);
  return rel.startsWith('..') ? path : rel;
}

/** Splits a hostname into whole tokens: dots, hyphens and underscores all separate. */
export function hostTokens(host) {
  return String(host || '')
    .toLowerCase()
    .split(/[.\-_]/)
    .filter(Boolean);
}

/**
 * Canonicalises a blocklist line into the host it blocks, or null when the line expresses
 * something a static tier rule cannot (an exception, a cosmetic filter, a request-type
 * modifier, a loopback mapping, or a bare public suffix).
 *
 * Understands every shape the hub emits — hosts, ABP, dnsmasq, and plain domains — because
 * an operator may point `--input` at any of the compiled outputs.
 */
export function extractHostFromLine(raw) {
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
  if (localZone) line = localZone[1];
  const localData = /^local-data:\s*"([^\s"]+)/i.exec(line);
  if (localData) line = localData[1];
  const dnsmasq = /^(?:address|server)=\/([^/]+)\//i.exec(line);
  if (dnsmasq) line = dnsmasq[1];

  line = line
    .replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, '') // hosts entry
    .replace(/\$.*$/, '') // ABP modifiers
    .replace(/^@@/, '')
    .replace(/^\|\|/, '') // ABP domain anchor
    .replace(/^\|/, '')
    .replace(/[\^|].*$/, '') // terminator or trailing anchor
    .replace(/\/.*$/, '') // path
    .replace(/\.+$/, '')
    .trim()
    .toLowerCase();

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
 * Reads a compiled blocklist and returns its distinct blockable hosts in input order.
 * Returns both the hosts and how many lines were seen, so the report can state the yield
 * rather than implying every line became a rule.
 */
export function parseBlocklist(text, { into, seen } = {}) {
  const hosts = into instanceof Set ? into : new Set();
  let lineCount = 0;
  for (const rawLine of String(text || '').split('\n')) {
    lineCount += 1;
    const host = extractHostFromLine(rawLine);
    if (host) hosts.add(host);
  }
  if (seen && typeof seen === 'object') {
    seen.lines = (seen.lines || 0) + lineCount;
  }
  return { hosts, lineCount };
}

/**
 * The hub's source categories, and the tier each one means.
 *
 * A mapping, not a derivation: the two vocabularies were built by different people for different
 * purposes, and a category only lands on a tier where the *publisher's* claim matches the tier's
 * purpose. `social` is filed under annoyances because that tier is where consent and nagging
 * lives and a social widget is the same class of intrusion from the user's side.
 *
 * More categories deliberately map to nothing:
 *
 *   - **`security`** is the interesting one, and `tier_security` existing does **not** change the
 *     answer. The tier carries the *embedded classifier's own* malware and phishing verdicts, read
 *     from `--security`; this map is for the hub's publisher categories, and "Threat & Malicious
 *     Domain Defense" plus "OISD Blocklist Small" are a different body of knowledge that only
 *     partly overlaps it. Measured on this repository's own security module, the classifier calls
 *     28 of its 34 hosts `Clean` and the other 6 `Advertising` — so merging the two sources into one
 *     tier would put hosts into a tier that is graded by the very model that disagrees with them,
 *     and the agreement check would have to be weakened to accommodate it. Keeping the sources
 *     separate is what lets each be checked on its own terms: the classifier's verdicts are
 *     measured (they came from the model), and the curated threat lists stay available for an
 *     operator to route explicitly with `--input tier_security=security.txt` while knowing they are
 *     asserting the publisher's claim rather than the model's.
 *   - **`unbreak` and `anti-circumvention`** are allowlists and filter-bypass reports. Blocking
 *     them is a category error regardless of which tier receives them.
 *   - **`custom` and `uncategorised`** are the user's own additions and the parser's fallback.
 *     Attributing those to a tier would be inventing a publisher's opinion that does not exist.
 *
 * A category that arrives and is not in this map is reported by name, so adding a list to the
 * catalog surfaces as a named line in the report rather than silently landing in the residual.
 */
export const CATEGORY_TIERS = {
  ads: 'tier_ads',
  privacy: 'tier_privacy',
  annoyances: 'tier_annoyances',
  social: 'tier_annoyances',
};

/**
 * Chooses between the tiers a host's categories map to.
 *
 * A host in both an ad and a privacy list is both, and one tier has to win. Annoyances wins
 * because it is the most specific claim — a consent host that is also an ad host is still
 * something the user was nagged about — and ads wins over privacy because an ad host that is
 * also a tracker is blocked for a reason the user will recognise, whereas the reverse reads as
 * a list that over-reaches. The alternatives are not lost: they are counted as *contested*, and
 * the report says how many hosts had to choose, so a taxonomy this coarse is visible rather
 * than assumed.
 */
export function chooseTier(categories) {
  // Takes an iterable rather than an array because the caller holds a `Set` per host, and the
  // distinction between one category and three is exactly what this function is deciding on.
  const tiers = [...new Set([...categories].map((c) => CATEGORY_TIERS[c]).filter(Boolean))];
  if (tiers.length === 0) return null;
  if (tiers.includes('tier_annoyances')) return 'tier_annoyances';
  if (tiers.includes('tier_ads')) return 'tier_ads';
  return 'tier_privacy';
}

/**
 * Reads the per-category outputs the desktop hub writes beside its compiled lists.
 *
 * The manifest is read first and is not decoration: it names the categories, so a category file
 * with no manifest entry is reported rather than skipped, and a manifest that is not this
 * format is refused outright rather than half-read. Each file is read with the same
 * `extractHostFromLine` the input side uses, which is what lets an attribution file be a plain
 * blocklist rather than a format of its own.
 */
export function readAttribution(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `attribution manifest not found: ${displayPath(manifestPath)}. The hub writes it beside ` +
        'the compiled lists in <output>/categories; run a hub compilation, or drop the flag.',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== 'blockingmachine-category-attribution') {
    throw new Error(
      `${displayPath(manifestPath)} is not a Blockingmachine attribution manifest ` +
        `(format: ${JSON.stringify(manifest?.format ?? null)}).`,
    );
  }

  const hostCategories = new Map();
  const byCategory = new Map();
  const unmapped = new Set();
  let claimed = 0;

  for (const category of manifest.categories ?? []) {
    const path = join(dir, `${category}.txt`);
    if (!existsSync(path)) {
      // Named rather than skipped: a manifest promising a file that is not there is the one
      // failure mode that would otherwise look like a category that simply matched nothing.
      unmapped.add(`${category} (file missing)`);
      continue;
    }
    const tier = CATEGORY_TIERS[category] ?? null;
    if (!tier) unmapped.add(category);

    const hosts = new Set();
    parseBlocklist(readFileSync(path, 'utf8'), { into: hosts });
    byCategory.set(category, hosts);

    for (const host of hosts) {
      let cats = hostCategories.get(host);
      if (!cats) {
        cats = new Set();
        hostCategories.set(host, cats);
      }
      if (!cats.has(category)) claimed += 1;
      cats.add(category);
    }
  }

  return { manifest, hostCategories, byCategory, unmapped: [...unmapped], claimed };
}

/**
 * Chooses the tier for one host.
 *
 * Precedence, highest first:
 *   1. the tier the host already occupies in the curated files (never re-tiered);
 *   2. the tier the hub's own per-category output attributes it to (`--attribution`);
 *   3. security indicators → the default-on tier;
 *   4. consent/nag vocabulary → annoyances (the URL classifier has no such category, and
 *      consent hosts are otherwise indistinguishable from ordinary third parties);
 *   5. ad network vocabulary → ads;
 *   6. tracking vocabulary → privacy.
 *
 * A host that matches nothing is *unclassified* and left for the caller to place, so the
 * residual is a reported number rather than a silent assumption.
 *
 * The vocabulary steps are now the fallback rather than the method, which is the point of the
 * whole change: on the hub's real list they placed 12,444 of 122,801 hosts and left 110,249
 * unclassified, and they are still here for a host the hub had no category for — a custom rule,
 * or a list added after the last compilation.
 */
export function assignTier(host, curatedTierByHost, hostTierByHost) {
  const curated = curatedTierByHost.get(host);
  if (curated) return curated;

  const attributed = hostTierByHost?.get(host);
  if (attributed) return attributed;

  const tokens = new Set(hostTokens(host));
  const matches = (vocabulary) => vocabulary.some((token) => tokens.has(token));

  if (matches(CORE_INDICATORS)) return 'tier_core';
  if (matches(TIER_VOCABULARY.tier_annoyances)) return 'tier_annoyances';
  if (matches(TIER_VOCABULARY.tier_ads)) return 'tier_ads';
  if (matches(TIER_VOCABULARY.tier_privacy)) return 'tier_privacy';
  return null;
}

/**
 * Reads a browser-reported rule-hit ledger into host -> hit counts.
 *
 * Accepts the `<count> <rule>` text `build-hot-list.mjs --hits` already parses — a merged
 * ledger or the hot list built from one — and canonicalises each rule with
 * `extractHostFromLine`, the same function the input side uses, so a rule and a candidate
 * that name the same host agree on the name without a second normaliser disagreeing with the
 * first.
 *
 * The refusals are core's, and for the same reasons. A line that is only a number names no
 * rule, so it cannot be counted. An `@@` exception is dropped rather than stripped to a host:
 * it is on the record because it *allowed* a request, and ranking a block by the traffic an
 * exception saved is the inversion the ledger exists to prevent. Every refusal is counted so
 * the report can say how much of the file it understood.
 *
 * A `*.host` rule is not a refusal here, though the input side refuses it: `||host^` is how the
 * tier ships that coverage, and ranking can only reorder hosts the input already produced, so
 * widening a wildcard to its base cannot introduce a host nobody listed.
 *
 * Core owns the format definition in `packages/core/src/ledgerAggregate.ts`. This reader is not
 * imported from there because the compiler runs before any build — it is a packaging script with
 * no compiled dependency today, and taking one would make `compile:tiers` refuse to run on a
 * clean checkout. The agreement between the two readers is pinned by a test in the extension
 * suite instead, which is the cheaper half of "one definition" to keep honest.
 */
export function readHitEvidence(text) {
  const counts = new Map();
  const header = {};
  let read = 0;
  let skipped = 0;

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('!')) {
      // Both comment marks carry provenance: a merged ledger writes `#`, and the hot list
      // `build-hot-list.mjs` writes over it writes `!`. Reading only one would report a ledger's
      // worth as "unknown" for the other format, which is the one thing the header is for.
      const match = /^[#!]\s*([A-Za-z][A-Za-z ]*):\s*(.+?)\s*$/.exec(line);
      if (match) header[match[1].trim().toLowerCase()] = match[2];
      continue;
    }
    if (/^\d+$/.test(line)) {
      skipped += 1;
      continue;
    }

    let rule = line;
    let count = 1;
    const leading = /^(\d+)\s+(.+)$/.exec(line);
    const trailing = /^(.+?)\s+(\d+)$/.exec(line);
    if (leading) {
      count = Number(leading[1]);
      rule = leading[2];
    } else if (trailing) {
      rule = trailing[1];
      count = Number(trailing[2]);
    }
    if (!Number.isFinite(count) || count <= 0) {
      skipped += 1;
      continue;
    }

    // A `*.example.com` rule is evidence about `example.com`: the tier rule that would be shipped
    // for it is `||example.com^`, which covers the apex and every subdomain, so the host the rule
    // is *about* is the base domain. That widening cannot add coverage the input did not already
    // have, because ranking only reorders hosts the input produced — a host with no candidate is
    // simply never looked up.
    const host = extractHostFromLine(/^\*\./.test(rule.trim()) ? rule.trim().slice(2) : rule);
    if (!host) {
      skipped += 1;
      continue;
    }
    read += 1;
    counts.set(host, (counts.get(host) ?? 0) + Math.floor(count));
  }

  return { counts, header, read, skipped };
}

/**
 * Orders candidates by how often the browser actually matched them.
 *
 * Stable in the only way that matters here: hits descending, and input order for equal counts
 * and for everything unmeasured, so two runs over the same evidence produce the same bytes and
 * an unmeasured tail stays the tail rather than shuffling between runs.
 */
export function rankHostsByHits(hosts, counts) {
  if (!counts || counts.size === 0) return [...hosts];
  return hosts
    .map((host, index) => ({ host, index, hits: counts.get(host) ?? 0 }))
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .map((entry) => entry.host);
}

/**
 * Allocates the budget across tiers.
 *
 * Each tier claims `share%` of the budget as a cap, and capacity a tier does not use is
 * handed to the tiers that still have candidates — so an under-fed category never wastes
 * slots. Tiers are served in catalogue order, which is also the order of usefulness when
 * the user enables them one at a time.
 *
 * Returns what each tier ships and what it had to leave behind.
 */
export function allocateBudget(availableByTier, { budget, shares, order = TIER_IDS }) {
  const selection = new Map(order.map((tier) => [tier, []]));
  const leftover = new Map();
  const overflow = new Map();
  const demand = new Map(order.map((tier) => [tier, availableByTier.get(tier) || []]));

  const shareTotal = order.reduce((sum, tier) => sum + (shares[tier] ?? 0), 0) || 1;
  let remaining = Math.max(0, budget);

  // Pass 1: each tier takes up to its share.
  for (const tier of order) {
    const cap = Math.floor((budget * (shares[tier] ?? 0)) / shareTotal);
    const candidates = demand.get(tier) || [];
    const take = Math.min(cap, candidates.length, remaining);
    selection.set(tier, candidates.slice(0, take));
    leftover.set(tier, candidates.slice(take));
    remaining -= take;
  }

  // Pass 2: hand the unspent capacity to the tiers that still have candidates, *in
  // proportion to what they are holding back*. Serving them in catalogue order instead
  // would pour every freed slot into the first tier: with the hub's real list that turned
  // a 12,000 core cap into 19,900 rules and starved the other three tiers, which defeats
  // the point of having tiers at all.
  while (remaining > 0) {
    const pending = order.filter((tier) => (leftover.get(tier) || []).length > 0);
    if (pending.length === 0) break;
    const pendingTotal = pending.reduce((sum, tier) => sum + leftover.get(tier).length, 0);
    let progressed = false;
    for (const tier of pending) {
      if (remaining <= 0) break;
      const waiting = leftover.get(tier);
      const slice = Math.max(1, Math.floor((remaining * waiting.length) / pendingTotal));
      const take = Math.min(waiting.length, slice, remaining);
      if (take <= 0) continue;
      selection.set(tier, [...(selection.get(tier) || []), ...waiting.slice(0, take)]);
      leftover.set(tier, waiting.slice(take));
      remaining -= take;
      progressed = true;
    }
    if (!progressed) break;
  }

  for (const tier of order) {
    const waiting = leftover.get(tier) || [];
    if (waiting.length > 0) overflow.set(tier, waiting);
  }

  return { selection, overflow, remainingBudget: remaining };
}

/** Builds a DNR static ruleset from an ordered host list. */
export function buildRuleset(hosts) {
  return hosts.map((host, index) => ({
    id: index + 1,
    priority: PRIORITY_STATIC_TIER,
    action: { type: 'block' },
    condition: { urlFilter: `||${host}^` },
  }));
}

/**
 * Renders the generated-counts module.
 *
 * The popup's capacity math reads `ruleCount` from the curated catalogue, which is correct
 * for the checked-in baseline and wrong the moment tiers are compiled from a hub list —
 * it would report 118 active rules while shipping 30,000. Writing the real counts into a
 * module the runtime imports keeps that display honest without a runtime file fetch.
 */
export function renderGeneratedCounts(counts, meta) {
  const entries = TIER_IDS.map((tier) => `  '${tier}': ${counts[tier] ?? 0},`).join('\n');
  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by \`scripts/compile-tier-rulesets.mjs\`, which compiles the desktop hub's active
 * blocklist into \`rules/tier_*.json\` at package time. \`null\` means the files on disk are
 * the curated baseline, so the catalogue's own counts should be trusted.
 *
 * Regenerate with: npm run compile:tiers
 */

/** Real rule counts per tier, or null while the curated baseline is what shipped. */
export const GENERATED_TIER_COUNTS: Record<string, number> | null = ${
    counts ? `{\n${entries}\n}` : 'null'
  };

/** Provenance for the last compilation, or null for the checked-in baseline. */
export const GENERATED_TIER_SOURCE: { source: string; generatedAt: string; budget: number; omitted: number } | null = ${
    meta
      ? JSON.stringify(
          {
            source: meta.source,
            generatedAt: meta.generatedAt,
            budget: meta.budget,
            omitted: meta.omitted,
          },
          null,
          2,
        ).replace(/\n/g, '\n')
      : 'null'
  };
`;
}

/** Reads the checked-in tiers, returning each tier's hosts in their curated order. */
export function readCuratedTiers(rulesDir = RULES_DIR) {
  const curatedByTier = new Map();
  const curatedTierByHost = new Map();
  for (const tier of TIER_IDS) {
    // A compiled-only tier is never seeded from disk, and this is the difference between a
    // verdict list and a blocklist. The other four are read back so that regeneration is purely
    // additive and a curated host can never be lost — which is only safe because those hosts were
    // chosen by a person and are still wanted. `tier_security` holds a *model's verdicts*, and
    // seeding it from its own previous output would make it accumulate: the first run that flagged
    // a host would keep it forever, so the classifier could never withdraw a false positive and the
    // tier could only grow. It is rebuilt from the classifier input on every run instead.
    if (COMPILED_ONLY_TIERS.includes(tier)) {
      curatedByTier.set(tier, []);
      continue;
    }
    const file = resolve(rulesDir, `${tier}.json`);
    let hosts = [];
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) {
          hosts = parsed
            .map((rule) => {
              const filter = isPlainObject(rule) && isPlainObject(rule.condition)
                ? rule.condition.urlFilter
                : null;
              return typeof filter === 'string' ? filter.replace(/^\|\|/, '').replace(/\^$/, '') : null;
            })
            .filter((host) => typeof host === 'string' && host.length > 0);
        }
      } catch {
        // A malformed tier file is treated as empty rather than aborting the build; the
        // MV3 guardian validates the bytes Chrome will parse.
      }
    }
    curatedByTier.set(tier, hosts);
    for (const host of hosts) {
      if (!curatedTierByHost.has(host)) curatedTierByHost.set(host, tier);
    }
  }
  return { curatedByTier, curatedTierByHost };
}

/** Accepts `tier_ads` or the short `ads`; returns null for anything that is not a tier. */
export function normalizeTierName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (TIER_IDS.includes(name)) return name;
  const short = `tier_${name}`;
  return TIER_IDS.includes(short) ? short : null;
}

export function defaultInputCandidates(rootDir = ROOT_DIR) {
  return [
    resolve(rootDir, 'packages/electron-app/filters/output/hosts.txt'),
    resolve(rootDir, 'packages/electron-app/filters/output/genericBrowserRules.txt'),
    resolve(rootDir, 'packages/electron-app/filters/output/adguardBrowser.txt'),
    resolve(rootDir, 'packages/cli/filters/output/genericBrowserRules.txt'),
  ];
}

/**
 * Where the embedded classifier's malware and phishing verdicts are looked for.
 *
 * Beside the compiled lists, because that is where the desktop hub writes them: it already runs
 * the classifier over the same deduplicated hosts it writes `browser.txt` for, so the verdicts and
 * the blocklist they are verdicts *about* are produced in one pass from one input and cannot drift
 * apart. Discovered rather than required because a checkout with no hub run legitimately has none,
 * and the tier it feeds ships empty in that state.
 */
export function defaultSecurityCandidates(rootDir = ROOT_DIR) {
  return [
    resolve(rootDir, 'packages/electron-app/filters/output/malware.txt'),
    resolve(rootDir, 'packages/electron-app/filters/output/tier-security.txt'),
    resolve(rootDir, 'packages/cli/filters/output/malware.txt'),
  ];
}

export function parseArgs(argv) {
  const options = {
    inputs: [],
    budget: GUARANTEED_STATIC_RULES,
    shares: { ...DEFAULT_SHARES },
    // Defaults to an *opt-in* tier on purpose. Most of a large merged blocklist matches no
    // vocabulary at all, and since `tier_core` is enabled on a fresh install, parking
    // unclassified hosts there would silently make every user block thousands of hosts the
    // classifier could not justify. Operators who want maximum default blocking set
    // `--residual tier_core` deliberately.
    residual: 'tier_ads',
    check: false,
    json: false,
    quiet: false,
    // No default: see the header. A default evidence file would make the plan depend on a
    // locally generated artifact, which is how `--check` came to fail on every compiled machine.
    hits: null,
    // Also no default: the attribution directory only exists once the desktop hub has run a
    // compilation, and a compiler that silently fell back to vocabulary when it was absent would
    // be making the same promise the flag exists to keep.
    attribution: null,
    // `null` means "discover it"; a string is an explicit file; `false` means ship the tier empty.
    // Unlike `--hits` and `--attribution`, discovery is the default here, because this input is not
    // enrichment on top of a plan — it is the entire contents of a tier, and a tier that silently
    // ships nothing because nobody passed a flag is the failure mode worth avoiding. The hazard
    // those two flags guard against does not apply either: `--check` does not compare against a
    // compiled plan until a compilation has been recorded, and when one has been, the discovery is
    // the same rule the main input list has always been read by.
    security: null,
    rulesDir: RULES_DIR,
    countsPath: GENERATED_COUNTS_PATH,
    cataloguePath: CATALOGUE_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--input' || arg === '-i') {
      // `--input tier_ads=list.txt` attributes an entire list to one tier and is exact;
      // a bare path is classified by vocabulary because a merged blocklist has lost its
      // source attribution.
      const spec = String(next());
      const separator = spec.indexOf('=');
      const tier = separator > 0 ? normalizeTierName(spec.slice(0, separator)) : null;
      options.inputs.push({
        path: resolve(tier ? spec.slice(separator + 1) : spec),
        tier,
      });
    } else if (arg === '--budget') options.budget = Number.parseInt(next(), 10);
    else if (arg === '--hits') options.hits = next();
    else if (arg === '--attribution') options.attribution = next();
    // The classifier's verdicts, for `tier_security`. A named file that does not exist is an
    // error rather than a silent fall back to an empty tier, for the same reason a mistyped
    // `--hits` path is: the operator named it, so shipping without it has to be loud.
    else if (arg === '--security') options.security = next();
    else if (arg === '--no-security') options.security = false;
    else if (arg === '--residual') {
      options.residual = normalizeTierName(next()) || options.residual;
    }
    else if (arg === '--shares') {
      for (const part of String(next()).split(',')) {
        const [tier, share] = part.split(':');
        if (TIER_IDS.includes(tier)) options.shares[tier] = Number.parseInt(share, 10) || 0;
      }
    } else if (arg === '--rules-dir') options.rulesDir = resolve(next());
    else if (arg === '--counts-path') options.countsPath = resolve(next());
    else if (arg === '--catalogue-path') options.cataloguePath = resolve(next());
    else if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  if (!Number.isFinite(options.budget) || options.budget <= 0) options.budget = GUARANTEED_STATIC_RULES;
  if (!TIER_IDS.includes(options.residual)) options.residual = 'tier_core';
  return options;
}

/**
 * Compiles the hub's blocklist into tier plans without touching the filesystem, so the
 * caller can either write the result or compare it against what is already on disk.
 */
export function compile(options) {
  const { curatedByTier, curatedTierByHost } = readCuratedTiers(options.rulesDir);
  const inputs =
    options.inputs.length > 0
      ? options.inputs
      : defaultInputCandidates().map((path) => ({ path, tier: null }));

  // `null` discovers, a string is explicit, `false` ships the tier empty. A discovered file that
  // is not there is simply absent — that is the fresh-checkout state — while an explicit one that
  // is not there is an error, because the operator named it.
  const securityPath =
    options.security === false
      ? null
      : options.security !== null
        ? resolve(options.security)
        : (defaultSecurityCandidates().find((candidate) => existsSync(candidate)) ?? null);

  // The evidence is read before the blocklists so a bad path fails before the work, and a
  // file that yielded nothing usable is an error rather than a silent fall back to input order:
  // an operator who named an evidence file is asking for a ranked build, and shipping an
  // unranked one under that flag would be a lie about what was measured.
  let hitEvidence = null;
  if (options.hits) {
    const path = resolve(options.hits);
    if (!existsSync(path)) {
      throw new Error(
        `--hits file not found: ${relative(ROOT_DIR, path)}. Produce one with:\n` +
          '  npm run ledger:merge -- --in export-1.json --in export-2.json --out ledger-hits.txt',
      );
    }
    const parsed = readHitEvidence(readFileSync(path, 'utf8'));
    if (parsed.counts.size === 0) {
      throw new Error(
        `--hits file held no usable rule hits: ${relative(ROOT_DIR, path)} ` +
          `(${parsed.read} read, ${parsed.skipped} skipped). A ledger with no named rules cannot rank anything.`,
      );
    }
    hitEvidence = {
      source: displayPath(path),
      // Kept on the internal object and left out of the report, which states the totals instead
      // of a map with one entry per host.
      counts: parsed.counts,
      hosts: parsed.counts.size,
      hits: [...parsed.counts.values()].reduce((sum, value) => sum + value, 0),
      read: parsed.read,
      skipped: parsed.skipped,
      header: parsed.header,
    };
  }

  // The hub's own per-category attribution, read before the blocklists for the same reason the
  // ledger is: a bad path should fail before the work rather than after it. Unlike the ledger,
  // an absent directory is an error rather than a fallback, because the flag is a statement about
  // how the plan was built — an unlabelled vocabulary guess under `--attribution` would be a lie
  // about the provenance of every rule in the output.
  let attribution = null;
  if (options.attribution) {
    const dir = resolve(options.attribution);
    if (!existsSync(dir)) {
      throw new Error(
        `--attribution directory not found: ${displayPath(dir)}. The desktop hub writes one ` +
          'beside its compiled lists (<savePath directory>/categories) on every compilation.',
      );
    }
    const read = readAttribution(dir);

    // host -> tier, collapsing the category set once per host rather than per candidate. The
    // contested count is taken here, where a host is seen, because a host that appears in three
    // ad lists is one host that chose, not three.
    const hostTierByHost = new Map();
    let contested = 0;
    for (const [host, categories] of read.hostCategories) {
      const tier = chooseTier(categories);
      if (!tier) continue;
      if (categories.size > 1) contested += 1;
      hostTierByHost.set(host, tier);
    }

    attribution = {
      source: displayPath(dir),
      categories: read.manifest.categories ?? [],
      hosts: read.hostCategories.size,
      tiered: hostTierByHost.size,
      claimed: read.claimed,
      contested,
      unmapped: read.unmapped,
      manifestHosts: read.manifest.hosts ?? null,
      hostTierByHost,
    };
  }

  const available = [];
  const seen = { lines: 0 };
  const untieredHosts = new Set();
  const allSynced = new Set();
  const attributedByTier = new Map(TIER_IDS.map((tier) => [tier, []]));

  for (const { path, tier } of inputs) {
    if (!existsSync(path)) continue;
    available.push(path);
    const { hosts } = parseBlocklist(readFileSync(path, 'utf8'), { seen });
    for (const host of hosts) allSynced.add(host);
    if (tier) {
      for (const host of hosts) attributedByTier.get(tier).push(host);
    } else {
      for (const host of hosts) untieredHosts.add(host);
    }
  }

  if (available.length === 0) {
    throw new Error(
      'Nothing to compile: no readable blocklist input was found. Pass --input <path>, e.g. ' +
        '--input packages/electron-app/filters/output/hosts.txt',
    );
  }

  // The classifier's malware and phishing verdicts, read after the blocklists rather than as one
  // of them: this file is not a subscription list, and letting it satisfy the "something to
  // compile" check above would mean a run that found nothing but verdicts could rewrite all four
  // curated tiers from the baseline alone. Its hosts are attributed to exactly one tier, which is
  // the same placement the `--input tier_x=` form performs, so nothing downstream needs to know
  // where they came from.
  let security = null;
  if (securityPath) {
    if (!existsSync(securityPath)) {
      if (options.security !== null && options.security !== false) {
        throw new Error(
          `--security file not found: ${relative(ROOT_DIR, securityPath)}. A file the operator ` +
            'named is never silently replaced by an empty tier.',
        );
      }
    } else {
      const { hosts, lineCount } = parseBlocklist(readFileSync(securityPath, 'utf8'), { seen });
      for (const host of hosts) allSynced.add(host);
      attributedByTier.get('tier_security').push(...hosts);
      // `hosts` is a Set — it deduplicates within the file, which is the count worth reporting.
      security = { source: displayPath(securityPath), hosts: hosts.size, lines: lineCount };
    }
  }

  // Curated hosts seed their own tier; then whole lists an operator attributed to a tier
  // land exactly where they were put; then anything merged is classified. A host already
  // claimed keeps its first, most specific placement, so regeneration is purely additive.
  const byTier = new Map(TIER_IDS.map((tier) => [tier, [...(curatedByTier.get(tier) || [])]]));
  const claimed = new Set(curatedTierByHost.keys());
  let unclassified = 0;

  for (const tier of TIER_IDS) {
    for (const host of attributedByTier.get(tier)) {
      if (claimed.has(host)) continue;
      claimed.add(host);
      byTier.get(tier).push(host);
    }
  }

  // How each host reached its tier, counted as it is placed. The three numbers together are the
  // answer to "is this plan measured or guessed", and printing only the total would hide the
  // difference between a fully attributed compile and one that silently fell back to vocabulary.
  let placedByAttribution = 0;
  let placedByVocabulary = 0;

  for (const host of untieredHosts) {
    if (claimed.has(host)) continue;
    claimed.add(host);
    const tier =
      assignTier(host, curatedTierByHost, attribution?.hostTierByHost) || options.residual;
    if (attribution?.hostTierByHost.has(host)) placedByAttribution += 1;
    else if (assignTier(host, curatedTierByHost)) placedByVocabulary += 1;
    else unclassified += 1;
    byTier.get(tier).push(host);
  }

  // The plan this input order would have produced, computed so the report can say what ranking
  // actually bought rather than only that it ran. `allocateBudget` is pure, and the cost is one
  // more pass over the same candidates.
  const inputOrderedPlan = allocateBudget(new Map(byTier), {
    budget: options.budget,
    shares: options.shares,
  });

  if (hitEvidence) {
    for (const tier of TIER_IDS) {
      const list = byTier.get(tier) || [];
      // Curated hosts are first in their tier by construction, and they stay there: they are
      // hand-picked rather than measured, and re-ordering them would make the regenerated
      // diff touch the one part of the file that was never in question.
      const curatedCount = (curatedByTier.get(tier) || []).length;
      const curated = list.slice(0, curatedCount);
      const synced = list.slice(curatedCount);
      byTier.set(tier, [...curated, ...rankHostsByHits(synced, hitEvidence.counts)]);
    }
  }

  const { selection, overflow, remainingBudget } = allocateBudget(byTier, {
    budget: options.budget,
    shares: options.shares,
  });

  const tiers = new Map();
  const counts = {};
  const omitted = {};
  for (const tier of TIER_IDS) {
    const hosts = selection.get(tier) || [];
    tiers.set(tier, buildRuleset(hosts));
    counts[tier] = hosts.length;
    omitted[tier] = (overflow.get(tier) || []).length;
  }

  // Curated hosts are deliberately excluded from the budget arithmetic — they are the
  // hand-picked, highest-confidence entries and must survive every compilation. The shares
  // are orders of magnitude larger than the curated baseline, so this can only trip if
  // someone shrinks the budget pathologically; failing loudly beats silently dropping them.
  const droppedCurated = [];
  for (const tier of TIER_IDS) {
    const shipped = new Set((selection.get(tier) || []));
    for (const host of curatedByTier.get(tier) || []) {
      if (!shipped.has(host)) droppedCurated.push(host);
    }
  }
  if (droppedCurated.length > 0) {
    throw new Error(
      `Budget would drop ${droppedCurated.length} curated host(s), e.g. ${droppedCurated.slice(0, 3).join(', ')}. ` +
        'Raise --budget or lower the synced volume; curated entries are never sacrificed.',
    );
  }

  // A declared ruleset that ships zero rules is a defect, not a no-op: the manifest declares five
  // rulesets and `validateTierRuleset` rejects an empty one for a tier that has a curated baseline
  // to lose. Writing `[]` for such a tier would only move the failure to the compliance guardian
  // with a much worse error message.
  //
  // The compiled-only tier is the exception and the reason is in `COMPILED_ONLY_TIERS`: it has no
  // baseline to lose, so `[]` is not a defect there — it is the honest state of a build where the
  // classifier has not run. Chrome accepts an empty ruleset array and `verify:mv3` checks only the
  // rules that are present, so nothing downstream has to tolerate something invalid.
  const emptyTiers = TIER_IDS.filter(
    (tier) => counts[tier] === 0 && !COMPILED_ONLY_TIERS.includes(tier),
  );
  if (emptyTiers.length > 0) {
    throw new Error(
      `No rules for ${emptyTiers.join(', ')}. A tier declared in the manifest must ship at least one rule — ` +
        'point --rules-dir at the extension rules/ directory so the curated baseline seeds every tier.',
    );
  }

  // What the ranking bought, in the only terms that matter: how much of what ships is backed by
  // a measured match, and how many hosts that promoted displaced from the input-ordered plan.
  // "It ranked" is not a claim worth printing; these two numbers are.
  let shippedWithEvidence = 0;
  let promoted = 0;
  const promotedExamples = [];
  for (const tier of TIER_IDS) {
    const baseline = new Set(inputOrderedPlan.selection.get(tier) || []);
    for (const host of selection.get(tier) || []) {
      if (!hitEvidence || !hitEvidence.counts.has(host)) continue;
      shippedWithEvidence += 1;
      if (!baseline.has(host)) {
        promoted += 1;
        if (promotedExamples.length < 5) promotedExamples.push(host);
      }
    }
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    tiers,
    counts,
    omitted,
    total,
    omittedTotal: Object.values(omitted).reduce((sum, value) => sum + value, 0),
    remainingBudget,
    report: {
      inputs: available,
      inputsMissing: inputs.map((input) => input.path).filter((path) => !available.includes(path)),
      linesRead: seen.lines,
      distinctSyncedHosts: allSynced.size,
      curatedHosts: curatedTierByHost.size,
      attributedHosts: TIER_IDS.reduce((sum, tier) => sum + attributedByTier.get(tier).length, 0),
      unclassified,
      residualTier: options.residual,
      // Null unless `--attribution` was given, for the same reason as `hitEvidence`: a report
      // that always claimed attribution would make a vocabulary guess indistinguishable from a
      // publisher's own filing.
      attribution: attribution
        ? {
            source: attribution.source,
            categories: attribution.categories,
            hosts: attribution.hosts,
            tiered: attribution.tiered,
            claimed: attribution.claimed,
            contested: attribution.contested,
            unmapped: attribution.unmapped,
            placedByAttribution,
            placedByVocabulary,
          }
        : null,
      budget: options.budget,
      counts,
      omitted,
      total,
      omittedTotal: Object.values(omitted).reduce((sum, value) => sum + value, 0),
      remainingBudget,
      // Null unless `--hits` was given, so a report never implies the plan was measured.
      hitEvidence: hitEvidence
        ? {
            source: hitEvidence.source,
            hosts: hitEvidence.hosts,
            hits: hitEvidence.hits,
            read: hitEvidence.read,
            skipped: hitEvidence.skipped,
            header: hitEvidence.header,
            shippedWithEvidence,
            promoted,
            promotedExamples,
          }
        : null,
      // Null when no verdict file was found at all, which is a different fact from a verdict file
      // that held nothing: the first says the classifier has not run here, the second says it ran
      // and found no malware. `tier_security` ships empty in both cases, and a reader who cannot
      // tell them apart will read an empty tier as "nothing is malicious on this list".
      security,
    },
  };
}

export function serializeRuleset(rules) {
  return `[\n${rules
    .map((rule) => `  ${JSON.stringify(rule)}`)
    .join(',\n')}\n]\n`;
}

/**
 * Whether the tier files on disk came from a hub compilation.
 *
 * `compile:tiers` writes `tierCounts.generated.ts` on every run; the checked-in file is its
 * `null` baseline. That module is therefore the declaration of *which* state the tree is in, and
 * `--check` needs it: the repo ships the curated baseline, while the hub list on any machine
 * compiles to a 30,000-rule plan, so a check that always compared the two exited 1 everywhere —
 * which is why it was never part of the sweep.
 */
export function hasRecordedCompilation(countsPath = GENERATED_COUNTS_PATH) {
  if (!existsSync(countsPath)) return false;
  return !/\bGENERATED_TIER_COUNTS\b[^=]*=\s*null\s*;/.test(readFileSync(countsPath, 'utf8'));
}

/**
 * The per-tier rule counts the extension's own catalogue declares for the curated baseline.
 *
 * `packages/browser-extension/src/shared/rulesetTiers.ts` documents `ruleCount` as “rules in the
 * curated baseline file”, and the popup reports it — so it is an independent statement of what the
 * baseline should contain, which is what makes it worth checking against. Read with a narrow
 * pattern rather than by importing TypeScript into a build script.
 */
export function readCatalogueRuleCounts(path = CATALOGUE_PATH) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const counts = {};
  const pattern = /id:\s*'(tier_[a-z]+)'[\s\S]*?ruleCount:\s*(\d+)/g;
  let match;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    counts[found[1]] = Number(found[2]);
  }
  return TIER_IDS.every((tier) => typeof counts[tier] === 'number') ? counts : null;
}

/**
 * Verifies the curated baseline on its own terms.
 *
 * There is no hub-derived plan for it to be stale against, so the check asserts what is actually
 * knowable in that state: every tier is present, is a non-empty JSON array, and holds exactly as
 * many rules as the extension's catalogue says it does. A hand-edit that adds or drops a rule
 * without the catalogue moving fails here. Rule-level validation (block-only, bottom priority, a
 * printable `urlFilter`) belongs to `verify:mv3`, which runs the same validator the runtime uses,
 * rather than being duplicated.
 */
export function checkCuratedBaseline({ rulesDir = RULES_DIR, quiet = false, cataloguePath = CATALOGUE_PATH } = {}) {
  let problem = false;
  const declared = readCatalogueRuleCounts(cataloguePath);
  for (const tier of TIER_IDS) {
    const file = resolve(rulesDir, `${tier}.json`);
    if (!existsSync(file)) {
      console.error(`❌ [Tiers] ${basename(file)} is missing`);
      problem = true;
      continue;
    }
    let rules;
    try {
      rules = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`❌ [Tiers] ${basename(file)} is not valid JSON: ${err?.message || err}`);
      problem = true;
      continue;
    }
    // A compiled-only tier is legitimately empty on a checkout where the classifier has never
    // run, and legitimately non-empty (with a count the catalogue does not know, because there is
    // no curated figure to know) once it has. Both the non-empty assertion and the count
    // comparison are therefore wrong for it, and only for it.
    const compiledOnly = COMPILED_ONLY_TIERS.includes(tier);
    if (!Array.isArray(rules) || (rules.length === 0 && !compiledOnly)) {
      console.error(`❌ [Tiers] ${basename(file)} is not a non-empty ruleset array`);
      problem = true;
      continue;
    }
    if (declared && !compiledOnly && declared[tier] !== rules.length) {
      console.error(
        `❌ [Tiers] ${basename(file)} holds ${rules.length} rule(s) but the catalogue declares ${declared[tier]}`,
      );
      problem = true;
    }
  }
  if (problem) return 1;
  if (!quiet) {
    const detail = declared
      ? TIER_IDS.map((tier) => `${tier}:${declared[tier]}`).join(', ')
      : 'counts not readable from rulesetTiers.ts, structure checked only';
    console.log(`✅ [Tiers] Curated baseline in place (no compilation recorded) — ${detail}`);
  }
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    // The header comment is the documentation, so print it with the comment syntax stripped
    // rather than maintaining a second copy that can drift.
    const header = readFileSync(__filename, 'utf8').split('*/')[0];
    console.log(
      header
        .replace(/^#![^\n]*\n/, '')
        .replace(/^\s*\/\*\*\n?/, '')
        .replace(/^\s*\* ?/gm, '')
        .trim(),
    );
    return 0;
  }

  let result;
  try {
    result = compile(options);
  } catch (err) {
    console.error(`❌ [Tiers] ${err?.message || err}`);
    return 1;
  }
  const { report } = result;

  // The guardian enforces this too; failing here keeps the error next to its cause.
  if (result.total > options.budget) {
    console.error(`❌ [Tiers] Planned ${result.total} rules, above the ${options.budget} budget.`);
    return 1;
  }

  if (options.check) {
    if (!hasRecordedCompilation(options.countsPath)) {
      return checkCuratedBaseline({
        rulesDir: options.rulesDir,
        quiet: options.quiet,
        cataloguePath: options.cataloguePath,
      });
    }
    let stale = false;
    for (const tier of TIER_IDS) {
      const file = resolve(options.rulesDir, `${tier}.json`);
      const expected = serializeRuleset(result.tiers.get(tier) || []);
      const actual = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (actual !== expected) {
        stale = true;
        console.error(`❌ [Tiers] ${tier} is stale (${basename(file)} differs from the compiled plan)`);
      }
    }
    if (stale) {
      console.error('   Run: npm run compile:tiers');
      return 1;
    }
    if (!options.quiet) console.log(`✅ [Tiers] Fresh: ${result.total} rules match the hub blocklist.`);
    return 0;
  }

  for (const tier of TIER_IDS) {
    writeFileSync(resolve(options.rulesDir, `${tier}.json`), serializeRuleset(result.tiers.get(tier) || []), 'utf8');
  }
  writeFileSync(
    options.countsPath,
    renderGeneratedCounts(result.counts, {
      source: report.inputs.map((input) => relative(ROOT_DIR, input)).join(', '),
      generatedAt: new Date().toISOString(),
      budget: report.budget,
      omitted: report.omittedTotal,
    }),
    'utf8',
  );

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (!options.quiet) {
    console.log('🗂️  [Tiers] Compiled the hub blocklist into the extension static rulesets');
    for (const input of report.inputs) console.log(`   source  ${relative(ROOT_DIR, input)}`);
    for (const missing of report.inputsMissing) {
      console.log(`   skipped ${relative(ROOT_DIR, missing)} ${'(not found)'}`);
    }
    console.log(`   read    ${report.linesRead.toLocaleString()} lines`);
    console.log(
      `   hosts   ${report.distinctSyncedHosts.toLocaleString()} distinct synced + ${report.curatedHosts} curated`,
    );
    for (const tier of TIER_IDS) {
      const shipped = report.counts[tier];
      const dropped = report.omitted[tier];
      console.log(
        `   ${tier.padEnd(16)} ${String(shipped).padStart(6)} shipped` +
          (dropped > 0 ? `  (${dropped.toLocaleString()} over budget)` : ''),
      );
    }
    console.log(
      `   total   ${report.total.toLocaleString()} / ${report.budget.toLocaleString()} budget` +
        ` · ${report.omittedTotal.toLocaleString()} omitted`,
    );
    if (report.hitEvidence) {
      const evidence = report.hitEvidence;
      // The header the ledger carries is its own provenance, and it is the difference between
      // "ranked by 34 days of real browsing" and "ranked by one afternoon", so it is printed
      // rather than left for the reader to open the file and find.
      const span = evidence.header.sessions && evidence.header.days
        ? ` — ${evidence.header.sessions} session(s) across ${evidence.header.days} day(s)`
        : evidence.header['measured on']
          ? ` — measured on ${evidence.header['measured on']}`
          : '';
      console.log(
        `   ranked  ${evidence.shippedWithEvidence.toLocaleString()} of ` +
          `${report.total.toLocaleString()} shipped rules carry measured hits` +
          ` (${evidence.hosts.toLocaleString()} hosts in ${evidence.source}${span})`,
      );
      console.log(
        `           ${evidence.promoted.toLocaleString()} evidence-backed host(s) took the slots of ` +
          `${evidence.promoted > 0 ? 'unmeasured ones' : 'no unmeasured host (nothing was crowded out)'}` +
          (evidence.promotedExamples.length > 0 ? `, e.g. ${evidence.promotedExamples.slice(0, 3).join(', ')}` : ''),
      );
      if (evidence.skipped > 0) {
        console.log(
          `           ${evidence.skipped.toLocaleString()} ledger line(s) named no block host and were not ranked`,
        );
      }
    } else {
      console.log('   ranked  no rule-hit evidence given — tiers are in input order (--hits <ledger>)');
    }
    if (report.security) {
      // Printed with the count for the same reason the evidence line carries its provenance: an
      // empty security tier and a tier holding a passing classifier run look identical in the
      // table above, and only one of them means "this list has no malware on it".
      console.log(
        `   verdicts ${report.counts.tier_security.toLocaleString()} shipped from ` +
          `${report.security.hosts.toLocaleString()} classifier verdict(s) in ${report.security.source}`,
      );
    } else {
      console.log(
        '   verdicts no classifier verdict file found — tier_security ships empty (--security <file>)',
      );
    }
    if (report.attribution) {
      const a = report.attribution;
      // The line a reader actually needs: how much of what ships came from the hub's own
      // filing rather than a hostname guess, and what the guess still had to cover.
      const placed = a.placedByAttribution + a.placedByVocabulary + report.unclassified;
      const pct = placed > 0 ? ((a.placedByAttribution / placed) * 100).toFixed(1) : '0.0';
      console.log(
        `   exact    ${a.placedByAttribution.toLocaleString()} of ${placed.toLocaleString()} hosts ` +
          `attributed by the hub's own categories (${pct}%) · ` +
          `${a.placedByVocabulary.toLocaleString()} by hostname vocabulary · ` +
          `${report.unclassified.toLocaleString()} unclassified`,
      );
      console.log(
        `            ${a.hosts.toLocaleString()} hosts across ${a.categories.length} categor` +
          `${a.categories.length === 1 ? 'y' : 'ies'} in ${a.source}` +
          (a.contested > 0
            ? ` · ${a.contested.toLocaleString()} claimed by more than one and resolved by precedence`
            : ''),
      );
      if (a.unmapped.length > 0) {
        console.log(
          `            no tier for: ${a.unmapped.join(', ')} (counted, left to the residual)`,
        );
      }
    } else {
      console.log(
        '   exact    no per-category attribution given — tiers are placed by hostname vocabulary ' +
          '(--attribution <hub output>/categories)',
      );
    }
    if (report.unclassified > 0) {
      console.log(
        `   note    ${report.unclassified.toLocaleString()} hosts matched no vocabulary and were placed in ${report.residualTier} (--residual to change)`,
      );
    }
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  process.exitCode = main();
}
