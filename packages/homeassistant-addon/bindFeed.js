/**
 * BIND Response Policy Zone generation for the Home Assistant add-on.
 *
 * BIND has no remote blocklist feature, so the deployment is a copy step plus `rndc reload` — and
 * until this route existed the only host answering for that copy was the desktop hub, which stops
 * answering whenever the laptop sleeps. The add-on is already the long-lived service on the LAN,
 * so it renders the zone file from the same DNS feed the Unbound drop-in and the Shadowrocket
 * rule set are rendered from, and the resolver host fetches from the add-on.
 *
 * Three properties of the format are load-bearing — each one a defect the desktop exporter already
 * hit and fixed, and each one replicated here rather than relearned:
 *
 *   - **A zone file is not a named.conf fragment.** Its comment character is `;`, and `#` is a
 *     parse error, not a comment. Every line below that is prose starts with `; `.
 *   - **A primary zone does not load without an SOA.** A file of bare policy records is refused
 *     outright, so the preamble travels with the artifact.
 *   - **A bare QNAME trigger matches that name only.** The RPZ draft is explicit that blocking a
 *     domain and its subdomains takes two policy RRsets — the name and a wildcard — so every
 *     blocked host emits a pair, the same pair the desktop's `bindRpzBlockRecords` emits.
 *
 * Only the RPZ mechanism is served. The shared null zone has no per-domain artifact to fetch — its
 * *file* is three fixed lines and its *configuration* is what changes — and it cannot honour an
 * allow at all, so a feed that emitted it would silently drop exceptions this file can express.
 */

import { hostFromRule } from './hostRules.js';

/**
 * The record section a BIND master file needs before any policy record.
 *
 * Byte-identical to the desktop exporter's `RPZ_ZONE_PREAMBLE` — the SOA/NS pair is the one the
 * BIND ARM's own RPZ example uses, and a diff between the two artifacts should mean something,
 * not wander.
 */
const ZONE_PREAMBLE = [
  '$TTL 3600',
  '@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )',
  '@ IN NS localhost.',
];

/** The zone name the generated records and the named.conf stanza have to agree on. */
const RPZ_ZONE_NAME = 'rpz.blockingmachine';

/**
 * The two records that block one host and everything under it.
 *
 * Two records, not one — `CNAME .` is RPZ's documented NXDOMAIN policy, and the wildcard is what
 * makes the block cover the subtree the way `local-zone`, `address=/…/` and `DOMAIN-SUFFIX` all
 * do in the sibling feeds.
 */
export function bindRpzBlockRecords(host) {
  return [`${host} CNAME .`, `*.${host} CNAME .`];
}

/**
 * The two records that exempt one host and everything under it.
 *
 * `rpz-passthru.` is the documented allow, and RPZ resolves by longest match rather than file
 * order, so a child's passthru beats a blocked parent's wildcard without any ordering work. An
 * allow whose parent was never blocked is a no-op record — harmless, and worth emitting anyway so
 * the zone says what the list decided.
 */
export function bindRpzPassthruRecords(host) {
  return [`${host} CNAME rpz-passthru.`, `*.${host} CNAME rpz-passthru.`];
}

/**
 * The policy records for one feed line, or an empty array when the line is not a block or an
 * allow — cosmetic rules, comments and directives act on a document, not on a name.
 */
export function bindRpzRecordsFromRule(rule) {
  const parsed = hostFromRule(rule);
  if (!parsed) return [];
  return parsed.allowed ? bindRpzPassthruRecords(parsed.host) : bindRpzBlockRecords(parsed.host);
}

/**
 * Converts a whole feed into sorted, de-duplicated policy records, blocks before passthrus.
 *
 * De-duplication happens on the host, so `||ads.example^` and `0.0.0.0 ads.example` emit one pair
 * of records rather than two identical RRsets. A host that is both blocked and allowed resolves
 * to the allow — emitting a `CNAME .` and a `CNAME rpz-passthru.` pair for the same name would be
 * two contradictory RRsets at one trigger, which the draft does not define, so the block is
 * suppressed the way the desktop's precedence pass suppresses it.
 */
export function rulesToBindRpzRecords(rules) {
  const blocks = new Set();
  const allows = new Set();

  for (const rule of Array.isArray(rules) ? rules : []) {
    const parsed = hostFromRule(rule);
    if (!parsed) continue;
    (parsed.allowed ? allows : blocks).add(parsed.host);
  }

  const records = [];
  for (const host of [...blocks].filter((h) => !allows.has(h)).sort()) {
    records.push(...bindRpzBlockRecords(host));
  }
  for (const host of [...allows].sort()) {
    records.push(...bindRpzPassthruRecords(host));
  }
  return records;
}

/**
 * Renders the zone file the BIND feed serves.
 *
 * The named.conf lines travel in the header as `;` comments, the way the desktop artifact carries
 * them — the file is also the recipe, because the stanza and the policy line are the two things a
 * deployment forgets.
 */
export function renderBindRpzFeed(rules, { generatedAt = new Date().toISOString() } = {}) {
  const records = rulesToBindRpzRecords(rules);
  const blocked = records.filter((r) => r.endsWith('CNAME .')).length;
  const header = [
    '; Blockingmachine — BIND Response Policy Zone feed',
    `; Generated: ${generatedAt}`,
    `; Policy records: ${records.length} (${blocked} blocking, ${records.length - blocked} passthru)`,
    ';',
    '; Add it to named.conf:',
    `;   zone "${RPZ_ZONE_NAME}" { type master; file "db.blockingmachine.rpz"; };`,
    '; and inside options { }:',
    `;   response-policy { zone "${RPZ_ZONE_NAME}"; };`,
    ';',
    '; Each blocked name is TWO records — the name and a wildcard — because a bare RPZ',
    '; trigger matches that name only and would let every subdomain resolve.',
    '; Do not edit by hand, it is regenerated.',
    '',
    ...ZONE_PREAMBLE,
  ];
  return `${[...header, '', ...records].join('\n')}\n`;
}

/**
 * The record count the add-on's status payload and dashboard report — rendered records, not input
 * lines, so the number the card shows is the number named will load.
 */
export function bindRpzRecordCount(rules) {
  return rulesToBindRpzRecords(rules).length;
}
