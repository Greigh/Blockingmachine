/**
 * The origin-form paths the data listener answers as self-routes for the
 * hub CA (flag 129, consolidated-review M2): `/ca.pem` shipped first; the
 * documented `/v1/proxy/ca.pem` is what the mobile `fetchHubCa` builds —
 * one handler serves both spellings.
 *
 * Kept as a dependency-free leaf module on purpose: the engine and the
 * cross-package contract test in `packages/mobile` must be able to share
 * the served set without dragging the proxy's node:net/node-forge graph
 * into the mobile jest environment. The client-side twin is
 * `hubDataUrl(host, '/v1/proxy/ca.pem', port)` in
 * `packages/mobile/src/filter/httpsCapture.ts`. `GET /proxy.pac` is
 * deliberately NOT in this set — it is the PAC surface, not a CA route.
 */
export const SELF_GET_CA_PATHS: readonly string[] = ['/ca.pem', '/v1/proxy/ca.pem'];

/**
 * iOS CA-install spellings (`buildCaMobileConfig`) — same read-only,
 * unauthenticated posture as the PEM routes: the profile wraps exactly
 * the CA the PEM route already serves. `/ca.mobileconfig` is the short
 * alias, `/v1/proxy/ca.mobileconfig` the documented contract the iOS
 * install button opens in Safari.
 */
export const SELF_GET_CA_MOBILECONFIG_PATHS: readonly string[] = [
  '/ca.mobileconfig',
  '/v1/proxy/ca.mobileconfig',
];
