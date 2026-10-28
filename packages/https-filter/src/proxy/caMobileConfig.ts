/**
 * Apple configuration profile wrapping the hub CA — iOS's CA-install
 * surface. Safari opens `application/x-apple-aspen-config` payloads as
 * "Profile Downloaded" → install under Settings → Profile Downloaded,
 * then full trust under Settings → General → About → Certificate Trust
 * Settings. A raw PEM does not reliably trigger that flow, so the data
 * listener serves this profile alongside `/ca.pem` (same read-only,
 * unauthenticated posture — it carries no material the PEM route doesn't).
 *
 * PayloadUUID is derived from the CA itself: the same CA answers the same
 * UUID every fetch (iOS treats a matching UUID as an update, not a new
 * profile), and a CA rotation produces a genuinely new profile.
 */

import { createHash } from 'node:crypto';

/** DER bytes of the single PEM cert block, or null when it won't parse. */
function pemToDer(certPem: string): Buffer | null {
  const m = /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END CERTIFICATE-----/.exec(
    certPem,
  );
  if (!m) return null;
  try {
    return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
}

/**
 * v5-shaped UUID stamped from the DER hash — deterministic per CA, so a
 * re-downloaded profile reads as the same one to iOS. Version/variant
 * bits are set the RFC 4122 way even though the input is sha256, so tools
 * that introspect the UUID don't flag it malformed. `tag` namespaces the
 * derivation: each payload inside one profile wants its own UUID.
 */
function uuidFromDer(der: Buffer, tag: string): string {
  const h = createHash('sha256').update(tag).update(der).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The `.mobileconfig` document for the hub CA, or null when the PEM won't
 * parse (the authority holds a valid CA by construction — null is the
 * fail-closed answer, never a half-written profile).
 */
export function buildCaMobileConfig(certPem: string): string | null {
  const der = pemToDer(certPem);
  if (!der || der.length === 0) return null;
  const uuid = uuidFromDer(der, 'profile');
  const certUuid = uuidFromDer(der, 'cert');
  const derB64 = der.toString('base64');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
\t<key>PayloadIdentifier</key>
\t<string>com.greighstudios.blockingmachine.hubca</string>
\t<key>PayloadUUID</key>
\t<string>${uuid}</string>
\t<key>PayloadDisplayName</key>
\t<string>Blockingmachine Hub CA</string>
\t<key>PayloadDescription</key>
\t<string>Trusts the Blockingmachine hub's HTTPS-filtering CA on this device. After installing, enable full trust under Settings ▸ General ▸ About ▸ Certificate Trust Settings.</string>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.security.root</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.greighstudios.blockingmachine.hubca.cert</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>${certUuid}</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>Blockingmachine Hub CA</string>
\t\t\t<key>PayloadContent</key>
\t\t\t<data>
${derB64}
\t\t\t</data>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
}
