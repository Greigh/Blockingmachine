/**
 * The bearer-token check behind the feed server's optional second gate.
 *
 * `feedToken` unset keeps the origin-guard-only trust model a LAN deployment assumes — a
 * headerless Home Assistant or curl client stays authorised because asking it for a token it
 * was never given would break the deployment, not secure it. Set, every mutation needs
 * `Authorization: Bearer`, whatever origin it arrives from: the token is the boundary for the
 * LAN that is not fully trusted, which is the case it exists for.
 *
 * A module of its own for the same reason `sinkholeNet` is: `index.ts` cannot be imported in a
 * test, and a comparison that must never leak timing deserves the pin a unit test gives it.
 */

import { timingSafeEqual } from 'crypto';

/**
 * Whether an `Authorization` header satisfies the configured feed token.
 *
 * An empty or whitespace-only `configuredToken` means the gate is unset — every caller is
 * authorised, because the token is opt-in hardening, not a requirement the server can assume.
 * Otherwise the presented value must be exactly `Bearer <token>`; anything else — missing
 * header, a different scheme, an empty bearer — is refused. The compare is length-gated before
 * `timingSafeEqual`, so a wrong guess learns nothing from the timing beyond its own length.
 */
export function feedTokenAuthorised(
  configuredToken: string | undefined | null,
  authorizationHeader: string | undefined | null,
): boolean {
  const configured = (configuredToken ?? '').trim();
  if (!configured) return true;

  const presented =
    typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')
      ? authorizationHeader.slice('Bearer '.length).trim()
      : '';
  const presentedBuf = Buffer.from(presented);
  const configuredBuf = Buffer.from(configured);
  return (
    presentedBuf.length === configuredBuf.length &&
    timingSafeEqual(presentedBuf, configuredBuf)
  );
}
