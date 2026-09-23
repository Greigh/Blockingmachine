export interface SafeUrlCheckResult {
  isSafe: boolean;
  reason?: string;
}

function extractIpv4Octets(host: string): [number, number, number, number] | null {
  // Direct dotted decimal IPv4
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const o0 = Number(ipv4Match[1]);
    const o1 = Number(ipv4Match[2]);
    const o2 = Number(ipv4Match[3]);
    const o3 = Number(ipv4Match[4]);
    if (o0 <= 255 && o1 <= 255 && o2 <= 255 && o3 <= 255) {
      return [o0, o1, o2, o3];
    }
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1, 0:0:0:0:0:ffff:...)
  const ffffIndex = host.toLowerCase().lastIndexOf('ffff:');
  if (ffffIndex !== -1) {
    const mapped = host.slice(ffffIndex + 5);
    const dotMatch = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotMatch) {
      const o0 = Number(dotMatch[1]);
      const o1 = Number(dotMatch[2]);
      const o2 = Number(dotMatch[3]);
      const o3 = Number(dotMatch[4]);
      if (o0 <= 255 && o1 <= 255 && o2 <= 255 && o3 <= 255) {
        return [o0, o1, o2, o3];
      }
    }
    const hexParts = mapped.split(':');
    if (
      hexParts.length === 2 &&
      /^[0-9a-f]{1,4}$/i.test(hexParts[0]) &&
      /^[0-9a-f]{1,4}$/i.test(hexParts[1])
    ) {
      const high = parseInt(hexParts[0], 16);
      const low = parseInt(hexParts[1], 16);
      return [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ];
    }
  }

  return null;
}

/**
 * Validates whether a target URL is safe for web crawling, filter downloading, and network fetching.
 * Strictly blocks private RFC 1918 subnets, loopback, link-local metadata (169.254.169.254),
 * local network hostnames (.local, .lan, localhost), and non-HTTP(S) protocols against SSRF attacks.
 * @beta
 */
export function isSafePublicWebUrl(urlStr: string): SafeUrlCheckResult {
  if (!urlStr || typeof urlStr !== 'string') {
    return { isSafe: false, reason: 'URL must be a non-empty string' };
  }

  let toParse = urlStr.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(toParse)) {
    if (!/^https?:\/\//i.test(toParse)) {
      const scheme = toParse.split(':')[0].toLowerCase();
      return { isSafe: false, reason: `Forbidden protocol "${scheme}:": only http and https are permitted` };
    }
  } else {
    toParse = `https://${toParse}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(toParse);
  } catch {
    return { isSafe: false, reason: 'Malformed or invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isSafe: false, reason: `Forbidden protocol "${parsed.protocol}": only http and https are permitted` };
  }

  let host = parsed.hostname.toLowerCase().trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return { isSafe: false, reason: 'Target resolved to localhost or internal network domain' };
  }

  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc00:') ||
    host.startsWith('fd00:') ||
    host.startsWith('2001:db8:') ||
    host.startsWith('100:')
  ) {
    return { isSafe: false, reason: 'Target resolved to IPv6 loopback, link-local, documentation, or private address' };
  }

  const octets = extractIpv4Octets(host);
  if (octets) {
    const [o0, o1, o2, o3] = octets;

    // Loopback 127.0.0.0/8
    if (o0 === 127) {
      return { isSafe: false, reason: 'Target is IPv4 loopback address (127.0.0.0/8)' };
    }
    // Unspecified 0.0.0.0/8
    if (o0 === 0) {
      return { isSafe: false, reason: 'Target is IPv4 unspecified address (0.0.0.0/8)' };
    }
    // Link-local / Cloud metadata 169.254.0.0/16
    if (o0 === 169 && o1 === 254) {
      return { isSafe: false, reason: 'Target is link-local or cloud metadata address (169.254.0.0/16)' };
    }
    // RFC 1918 Private Subnets
    if (o0 === 10) {
      return { isSafe: false, reason: 'Target is RFC 1918 private subnet (10.0.0.0/8)' };
    }
    if (o0 === 172 && o1 >= 16 && o1 <= 31) {
      return { isSafe: false, reason: 'Target is RFC 1918 private subnet (172.16.0.0/12)' };
    }
    if (o0 === 192 && o1 === 168) {
      return { isSafe: false, reason: 'Target is RFC 1918 private subnet (192.168.0.0/16)' };
    }
    // Broadcast 255.255.255.255
    if (o0 === 255 && o1 === 255 && o2 === 255 && o3 === 255) {
      return { isSafe: false, reason: 'Target is broadcast address' };
    }
    // Documentation / Test networks RFC 5737
    if (o0 === 192 && o1 === 0 && o2 === 2) {
      return { isSafe: false, reason: 'Target is documentation/test address (192.0.2.0/24)' };
    }
    if (o0 === 198 && o1 === 51 && o2 === 100) {
      return { isSafe: false, reason: 'Target is documentation/test address (198.51.100.0/24)' };
    }
    if (o0 === 203 && o1 === 0 && o2 === 113) {
      return { isSafe: false, reason: 'Target is documentation/test address (203.0.113.0/24)' };
    }
  }

  return { isSafe: true };
}
