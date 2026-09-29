/**
 * BIND deployment helpers.
 *
 * BIND has no remote blocklist feature and no per-domain zone list: the way to block a name in it
 * is a **Response Policy Zone** (RPZ), a single zone of policy records that `named` consults for
 * every query. The `bind` export advertised in the README was unusable — it emitted one
 * `zone "host" { type master; file … };` stanza per blocked domain, and BIND refuses to load a
 * primary zone whose file has no SOA. No single master file can serve 100k different origins
 * either, so the per-domain shape could not be repaired; the artifact is now an RPZ zone.
 *
 * BIND cannot fetch a zone file over HTTP, so unlike Privoxy and Shadowrocket there is no feed URL
 * here: the recipe is a file drop plus the two lines `named.conf` needs and a reload.
 */

/** The zone name the generated records and the `named.conf` snippet have to agree on. */
export const BIND_ZONE_ID = 'rpz.blockingmachine';

/** The zone file the compiled artifact is meant to be saved as. */
export function bindZoneFileName(savePath: string): string {
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

/** Why the recipe below cannot work yet, or null when it can. */
export function bindFormatWarning(exportFormat: string): string | null {
  if (exportFormat === 'bind') return null;
  return `The compiled export is currently "${exportFormat}". Set Format to BIND so the hub writes the RPZ records instead of ${exportFormat} syntax \u2014 a zone file with the wrong records in it loads cleanly and blocks nothing.`;
}

export interface BindRecipeStep {
  id: string;
  title: string;
  detail: string;
}

/**
 * The setup steps, in order.
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
    id: 'save',
    title: 'Save it where named can read it',
    detail:
      'Copy the compiled file to the resolver host \u2014 /etc/bind/db.blockingmachine.rpz on Debian and Ubuntu, /var/named/ on RHEL-family systems \u2014 and make sure the named user can read it.',
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
      'Run the reload command below. This is a local file rather than a feed, so it has to be re-copied and reloaded after every compile \u2014 unlike the Privoxy and Shadowrocket targets, where the client re-fetches on its own.',
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
