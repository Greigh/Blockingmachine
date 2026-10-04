/**
 * BIND deployment helpers.
 *
 * BIND has no remote blocklist feature and no per-domain zone list, so there are two ways to block
 * a name in it, and they are not variants of one thing. The user picks.
 *
 * **`bind` — a Response Policy Zone.** One zone of policy records that `named` consults for every
 * query. The *file* changes on every compile; `named.conf` does not. It is the only one of the two
 * that can exempt a subdomain (`rpz-passthru.`) or answer NXDOMAIN at a domain's apex, so it is the
 * one to use unless you have a reason not to.
 *
 * **`bind-null` — a shared null zone.** One fixed 3-line file holding an SOA and an NS and nothing
 * else, which BIND answers authoritatively for every name beneath whatever origin it is loaded
 * under, so a *single* file can stand in for every blocked domain. The *configuration* changes on
 * every compile instead: one `zone` stanza per blocked domain, all pointing at that one file.
 *
 * The practical difference is what you re-copy after a compile, and it inverts between the two: for
 * RPZ you replace the zone file, for the null zone you replace the configuration. Both are local
 * files rather than feeds, so unlike Shadowrocket the client cannot re-fetch them and each compile
 * needs a copy and a reload — the same shape the Privoxy action file has.
 *
 * The `bind` export was also unusable once, for a different reason: it emitted one
 * `zone "host" { … };` stanza per blocked domain *and* the artifact had no SOA, which BIND refuses
 * to load. That is fixed. A second defect in the same format — a bare RPZ QNAME trigger matching one
 * name rather than a domain and its subdomains — is what the wildcard records in core address; see
 * `bindRpzBlockRecords`.
 */

/** The zone name the generated records and the `named.conf` snippet have to agree on. */
export const BIND_ZONE_ID = 'rpz.blockingmachine';

/** How a BIND deployment blocks names, and the export format that produces it. */
export type BindMechanism = 'rpz' | 'null-zone';

export interface BindMechanismOption {
  id: BindMechanism;
  label: string;
  /** The export format that emits this mechanism's artifact. */
  format: 'bind' | 'bind-null';
  /** One line on what changes after each compile, which is the whole difference between them. */
  summary: string;
}

/**
 * The two mechanisms, in the order they should be offered.
 *
 * RPZ is first because it is the better of the two on every axis except one: it is the only one that
 * can honour an allow, and the only one that answers NXDOMAIN at an apex rather than NODATA. The
 * null zone wins on exactly one thing — its file never changes — and that is worth having when
 * `named.conf` is managed by configuration management and the zone directory is not.
 */
export const BIND_MECHANISMS: readonly BindMechanismOption[] = [
  {
    id: 'rpz',
    label: 'Response Policy Zone (recommended)',
    format: 'bind',
    summary:
      'One zone, one record per name. You replace the zone file after each compile. Exempts subdomains with rpz-passthru., and answers NXDOMAIN at an apex.',
  },
  {
    id: 'null-zone',
    label: 'Shared null zone',
    format: 'bind-null',
    summary:
      'One 3-line zone file that never changes, serving every blocked origin. You replace the named.conf fragment after each compile instead. Cannot exempt a subdomain, and answers NODATA at an apex rather than NXDOMAIN.',
  },
];

/** The mechanism an export format produces, or null for a format that is not a BIND artifact. */
export function bindMechanismForFormat(exportFormat: string): BindMechanism | null {
  const match = BIND_MECHANISMS.find((option) => option.format === exportFormat);
  return match ? match.id : null;
}

/** The file the null-zone mechanism serves every blocked origin from. */
export const BIND_NULL_FILE = 'db.blockingmachine.null';

/**
 * The null zone file's contents, for the recipe to print.
 *
 * Kept here as a string rather than imported from core because the pane is the renderer and this is
 * the one value it has to show; the exporter emits the same three lines, and the export-format
 * coverage test is what keeps the two honest.
 */
export function bindNullZoneContents(): string {
  return [
    '$TTL 86400',
    '@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )',
    '@ IN NS localhost.',
  ].join('\n');
}

/** The `include` line that pulls the generated stanzas into `named.conf`. */
export function bindIncludeLine(zonePath?: string): string {
  return `include "${zonePath || '/etc/bind/blockingmachine-zones.conf'}";`;
}

/** The zone file the compiled artifact is meant to be saved as. */
export function bindZoneFileName(savePath: string, mechanism: BindMechanism = 'rpz'): string {
  if (mechanism === 'null-zone') return BIND_NULL_FILE;
  const fileName = (savePath || '').split(/[/\\]/).pop() || '';
  return fileName || 'db.blockingmachine.rpz';
}

/** The two `named.conf` lines that make the zone live. */
export function bindNamedConfZoneLine(zonePath: string): string {
  return `zone "${BIND_ZONE_ID}" { type master; file "${zonePath || '/etc/bind/db.blockingmachine.rpz'}"; };`;
}

export function bindResponsePolicyLine(): string {
  return `response-policy { zone "${BIND_ZONE_ID}"; };`;
}

/** The `rndc` call that re-reads the zone after the file is replaced. */
export function bindReloadCommand(): string {
  return `rndc reload ${BIND_ZONE_ID}`;
}

/**
 * The `rndc` call for the null-zone mechanism, whose per-compile change is a *configuration*
 * fragment, not a zone file. `reload` re-reads zone files only — added or removed `zone` stanzas
 * need `reconfig` to be applied. (A stanza that disappeared entirely lingers until the next
 * restart; `reconfig` does not unload zones.)
 */
export function bindReconfigCommand(): string {
  return 'rndc reconfig';
}

/**
 * The Home Assistant add-on's address for the same RPZ zone.
 *
 * The add-on renders the policy records from the published DNS feed itself — SOA, wildcard pairs
 * and passthru exceptions included — so this URL answers whatever export format the desktop is
 * set to, and it answers while this machine is off. Only the RPZ artifact is served: the shared
 * null zone's file is three fixed lines and its *configuration* is what changes, so there is no
 * per-compile file for a feed to carry.
 */
export function bindHomeAssistantUrl(port: number = 9191): string {
  return `http://homeassistant.local:${port}/db.blockingmachine.rpz`;
}

/** The copy step: pull the zone file once from the hub or the add-on onto the resolver host. */
export function bindFetchCommand(feedUrl: string, zonePath?: string): string {
  return `curl -fsSL "${feedUrl}" -o ${zonePath || '/etc/bind/db.blockingmachine.rpz'}`;
}

/** Why the recipe below cannot work yet, or null when it can. */
export function bindFormatWarning(exportFormat: string, mechanism: BindMechanism = 'rpz'): string | null {
  const wanted = bindMechanismForFormat(exportFormat) === mechanism;
  if (wanted) return null;
  const option = BIND_MECHANISMS.find((entry) => entry.id === mechanism)!;
  if (bindMechanismForFormat(exportFormat)) {
    // The other BIND mechanism, which is a real choice rather than a mistake — but a silent one.
    return `The compiled export is currently the ${exportFormat === 'bind' ? 'RPZ zone' : 'shared null zone'}, and this recipe is for the ${mechanism === 'rpz' ? 'RPZ zone' : 'shared null zone'}. Set Format to ${option.format} so the artifact matches the recipe below.`;
  }
  return `The compiled export is currently "${exportFormat}". Set Format to BIND (${option.format}) so the hub writes the BIND records instead of ${exportFormat} syntax \u2014 a zone file with the wrong records in it loads cleanly and blocks nothing.`;
}

export interface BindRecipeStep {
  id: string;
  title: string;
  detail: string;
}

/**
 * The RPZ setup steps, in order.
 *
 * Worded for what BIND actually does: the zone is a local file, `response-policy` lives inside
 * `options { }`, and a reload is required before the new records are answered from.
 */
export const BIND_STEPS: BindRecipeStep[] = [
  {
    id: 'compile',
    title: 'Compile with the BIND format',
    detail:
      'The artifact is a Response Policy Zone: one CNAME policy record per blocked name, plus the SOA a primary zone cannot load without. The \u201cAdd it to named.conf\u201d lines are in the file\u2019s own header as well.',
  },
  {
    id: 'wildcard',
    title: 'Each blocked domain is two records, on purpose',
    detail:
      'The file carries `ads.example.com CNAME .` *and* `*.ads.example.com CNAME .`. A bare RPZ trigger matches that one name only, so without the wildcard every subdomain of a blocked domain would resolve \u2014 while the same rules sent to Unbound, dnsmasq or Shadowrocket block the whole subtree. Verified on BIND: with only the bare record a subdomain still resolved.',
  },
  {
    id: 'save',
    title: 'Save it where named can read it',
    detail:
      'Copy the compiled file to the resolver host \u2014 /etc/bind/db.blockingmachine.rpz on Debian and Ubuntu, /var/named/ on RHEL-family systems \u2014 and make sure the named user can read it.',
  },
  {
    id: 'addon',
    title: 'Or fetch the zone from the Home Assistant add-on',
    detail:
      'If Home Assistant is on the same LAN, the add-on renders the same policy records from the published DNS feed \u2014 the SOA, the wildcard pairs, the passthru exceptions \u2014 and serves them while this desktop is off, whatever export format the desktop compiles. The command below saves it to the path the stanza above expects.',
  },
  {
    id: 'namedconf',
    title: 'Declare the zone and enable the policy',
    detail:
      'Add the zone stanza to named.conf, and the response-policy line inside options { }. The policy line is what makes named consult the zone for every query; the stanza alone only loads it.',
  },
  {
    id: 'reload',
    title: 'Reload, and re-copy after each compile',
    detail:
      'Run the reload command below. This is a local file rather than a feed, so it has to be re-copied and reloaded after every compile \u2014 the same shape as the Privoxy recipe, and unlike the Shadowrocket target, where the client re-fetches on its own.',
  },
];

/**
 * The shared null-zone setup steps, in order.
 *
 * The order is the reverse of the RPZ recipe and that is not a stylistic choice: here the *file* is
 * written once and never touched again, so it comes first and has no "after each compile" step, and
 * what changes per compile is the `named.conf` fragment, which is reloaded.
 */
export const BIND_NULL_STEPS: BindRecipeStep[] = [
  {
    id: 'compile',
    title: 'Compile with the BIND (null zone) format',
    detail:
      'The artifact is a named.conf fragment: one `zone` stanza per blocked domain, every one of them pointing at the same shared file. Its header carries the file\u2019s contents so you do not have to find them.',
  },
  {
    id: 'save',
    title: 'Write the shared null zone file once',
    detail:
      'Save the three lines above as db.blockingmachine.null next to your other zone files, and make sure the named user can read it. This file never changes \u2014 you will not touch it again after the next compile, which is the reason to pick this mechanism.',
  },
  {
    id: 'namedconf',
    title: 'Add the stanzas, or include them',
    detail:
      'Either paste the stanzas into named.conf or add the include line so the generated file is picked up automatically. Unlike the RPZ recipe there is no response-policy line to add: a null zone is enforced by being authoritative, not by being a policy zone.',
  },
  {
    id: 'limits',
    title: 'What this mechanism cannot do',
    detail:
      'A null zone is authoritative for its whole subtree, and BIND answers the parent before any forwarding or policy lookup \u2014 the only escape is an NS delegation inside the parent\u2019s own zone data. When the export can resolve the parent\u2019s real nameservers it writes a per-parent zone file (db.bm.null.<domain>) carrying child IN NS records and marks the allow EXCEPTION DELEGATED; when it cannot \u2014 the synchronous preview, or a failed lookup \u2014 the allow is recorded as EXCEPTION NOT HONOURED and the parent keeps the shared file. Two costs come with an honoured allow: one extra zone file per affected parent, and a delegation that goes stale if the domain changes nameservers \u2014 the child then answers SERVFAIL until the next compile, which a provider change makes the operator\u2019s problem. A null zone also answers NXDOMAIN for subdomains but NODATA at the apex, because the apex exists (it holds the SOA and NS). If you want exception semantics without per-parent files or compile-time lookups, use the RPZ recipe instead.',
  },
  {
    id: 'reload',
    title: 'Reload after each compile \u2014 and re-copy the configuration, not the file',
    detail:
      'Run the reload command below after replacing the fragment. This inverts against the RPZ recipe: there you replace the zone file, here you replace the configuration. Both are local files rather than feeds, so the client cannot re-fetch them.',
  },
];

/**
 * The syntax note under the steps.
 *
 * `CNAME .` is RPZ's documented NXDOMAIN reply, and `rpz-passthru.` is its documented allow. Both
 * are relative names, which is the mechanism: named rewrites them against the RPZ origin and reads
 * the name being asked about out of the result.
 */
export function bindSyntaxNote(): string {
  return 'Records are relative to the RPZ origin on purpose: `example.com CNAME .` means \u201canswer NXDOMAIN for example.com and everything under it\u201d, and `example.com CNAME rpz-passthru.` means \u201cleave it alone\u201d. A child bypass is just a longer name, so it wins without any ordering.';
}
