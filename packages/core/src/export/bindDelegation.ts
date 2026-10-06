/**
 * The one mechanism that releases a child of a BIND null zone.
 *
 * A null zone answers authoritatively for its whole subtree, so nothing in `named.conf`
 * can let one child out — the parent answers before any forwarding or policy lookup is
 * consulted (proved on a live 9.20.x `named`). What escapes is zone *data*: an `NS`
 * delegation at the child's owner name hands it back to the parent's real authority,
 * and a recursive resolver follows the referral to the real record.
 *
 * That costs the shared null file its defining property — the file can no longer serve
 * every origin — so a blocked parent with an allowed child gets its own zone file,
 * `db.bm.null.<parent>`, written beside the exported fragment by `exportFormat` (the
 * async path; the sync `generateFilterList` has no DNS and keeps `NOT HONOURED`).
 */

import { BIND_NULL_ZONE_CONTENTS, BIND_NULL_ZONE_FILE } from "./formatters.js";
import { stripTrailingChars } from "../utils/textScan.js";

/** The zone filename a delegated parent uses instead of the shared null file. */
export function bindNullDelegatedZoneFile(parentDomain: string): string {
  return `db.bm.null.${parentDomain}`;
}

/** One `named.conf` stanza for a blocked domain, pointed at a chosen zone file. */
export function bindNullZoneStanza(domain: string, zoneFile = BIND_NULL_ZONE_FILE): string {
  return `zone "${domain}" { type master; file "${zoneFile}"; };`;
}

/**
 * The per-parent zone data a delegation lives in: the same SOA/NS spine as the shared
 * null file, plus one `IN NS` set per honoured child pointing at the parent's real
 * authoritative nameservers. Children are emitted relative to the zone origin; an
 * unexpected absolute name is emitted qualified rather than silently re-rooted.
 */
export function renderBindNullDelegatedZone(
  parentDomain: string,
  children: readonly string[],
  nsNames: readonly string[],
): string {
  const lines = [BIND_NULL_ZONE_CONTENTS];
  for (const sub of [...children].sort()) {
    const rel =
      sub === parentDomain
        ? "@"
        : sub.endsWith(`.${parentDomain}`)
          ? sub.slice(0, -(parentDomain.length + 1))
          : `${sub}.`;
    for (const ns of [...nsNames].sort()) {
      lines.push(`${rel} IN NS ${stripTrailingChars(ns, ".")}.`);
    }
  }
  return `${lines.join("\n")}\n`;
}
