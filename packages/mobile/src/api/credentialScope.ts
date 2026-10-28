/**
 * Credential scoping for feed tokens.
 *
 * The saved server token is a LAN-scoped bearer secret — whoever holds it can
 * drive the hub's mutation surface. It may only travel where the wire is
 * protected (TLS) or where cleartext cannot leave the local network. A
 * cleartext request to a public address would broadcast the token to every
 * on-path listener; in that case the request still goes out — an open feed has
 * no token to withhold — just without the credential, and the hub's own 401
 * surfaces the real problem to the user.
 *
 * The canonical implementation lives in `packages/core/src/utils/urlSafety.ts`
 * — the `./urlSafety` subpath is pure and Metro-safe (no `node:fs`, unlike the
 * package barrel). `isLocalFeedHost` is kept as the local name for
 * `isLocalNetworkHost`.
 */
export { credentialAllowed, isLocalNetworkHost as isLocalFeedHost } from '@blockingmachine/core/urlSafety';
