/**
 * Extract a hostname from a URL, host/port pair, hosts entry or domain filter.
 * This is normalization only; rule writers must still validate with sanitizeDomain.
 * Kept independent of reputation and entropy to avoid circular dependencies.
 */
export function normalizeHostname(input: string): string {
  if (typeof input !== 'string') return '';
  let clean = input.trim().toLowerCase();
  if (
    /[\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(clean)
  )
    return '';
  clean = clean.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/, '');
  clean = clean.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  clean = clean.replace(/^\|\|/, '').replace(/^\*\.?/, '');
  // Discard URL paths before looking for credentials: /path@other.net is not a host.
  clean = clean.split(/[/?#^$]/, 1)[0];
  clean = clean.slice(clean.lastIndexOf('@') + 1);
  if (clean.startsWith('[')) {
    const bracket = clean.indexOf(']');
    if (bracket < 0 || !/^(?::\d+)?$/.test(clean.slice(bracket + 1))) return '';
    return clean.slice(1, bracket);
  }
  if ((clean.match(/:/g) || []).length === 1) {
    const colon = clean.indexOf(':');
    if (!/^\d+$/.test(clean.slice(colon + 1))) return '';
    clean = clean.slice(0, colon);
  }
  return clean.replace(/^\.+|\.+$/g, '');
}

/**
 * Validates whether a string is a standard IPv4 address.
 */
function isValidIpv4(clean: string): boolean {
  const ipMatch = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipMatch) return false;
  const octets = [
    Number(ipMatch[1]),
    Number(ipMatch[2]),
    Number(ipMatch[3]),
    Number(ipMatch[4]),
  ];
  return octets.every((o) => o >= 0 && o <= 255);
}

/**
 * Validates whether a string is a standard or compressed IPv6 address per RFC 4291 / RFC 5952.
 */
function isValidIpv6(clean: string): boolean {
  let target = clean.toLowerCase().trim();
  if (target.startsWith('[') && target.endsWith(']')) {
    target = target.slice(1, -1);
  }
  const ipv6Regex =
    /^(?:[a-f0-9]{1,4}:){7}[a-f0-9]{1,4}$|^(?:[a-f0-9]{1,4}:){1,7}:$|^:(?::[a-f0-9]{1,4}){1,7}$|^(?:[a-f0-9]{1,4}:){1,6}:[a-f0-9]{1,4}$|^(?:[a-f0-9]{1,4}:){1,5}(?::[a-f0-9]{1,4}){1,2}$|^(?:[a-f0-9]{1,4}:){1,4}(?::[a-f0-9]{1,4}){1,3}$|^(?:[a-f0-9]{1,4}:){1,3}(?::[a-f0-9]{1,4}){1,4}$|^(?:[a-f0-9]{1,4}:){1,2}(?::[a-f0-9]{1,4}){1,5}$|^[a-f0-9]{1,4}:(?::[a-f0-9]{1,4}){1,6}$|^:(?::[a-f0-9]{1,4}){1,6}$|^::$|^(?:[a-f0-9]{1,4}:){1,4}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/i;
  return ipv6Regex.test(target);
}

/**
 * Sanitizes and validates a domain or IP address per RFC 1035 / RFC 1123 / RFC 4291 standards.
 * Prevents rule injection attacks by stripping schemes, paths, ports, newlines,
 * carriage returns, bidirectional control characters, and ABP modifier characters.
 *
 * @returns Sanitized lowercase domain/IP string, or null if the input is malformed or invalid.
 * @beta
 */
export function sanitizeDomain(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  // 1. Prototype pollution protection
  if (
    input === '__proto__' ||
    input === 'constructor' ||
    input === 'prototype'
  ) {
    return null;
  }

  // 2. Immediate rejection of control characters, bidirectional overrides, zero-width spaces, and filter list syntax injection characters
  if (
    /[\r\n\t\0\x00-\x1f\x7f\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069$^|@#!,;<>"`']/.test(
      input,
    )
  ) {
    return null;
  }

  // 3. Strip URL scheme, path, query parameters, fragment
  let clean = input.trim().toLowerCase();

  // Handle bracketed IPv6 with optional port (e.g. [2001:db8::1]:8080 or [::1])
  if (clean.startsWith('[') && clean.includes(']')) {
    const endBracket = clean.indexOf(']');
    const ipCandidate = clean.slice(1, endBracket);
    if (isValidIpv6(ipCandidate)) {
      return ipCandidate;
    }
  }

  clean = clean.replace(/^[a-z0-9+.-]+:\/\//i, '');
  clean = clean.split('/')[0]?.split('?')[0]?.split('#')[0] ?? clean;

  // Handle unbracketed IPv6 addresses
  if (
    clean.includes(':') &&
    (clean.match(/:/g) || []).length >= 2 &&
    isValidIpv6(clean)
  ) {
    return clean;
  }

  // Strip port numbers from hostnames or IPv4 addresses (only when not IPv6)
  if (!clean.includes('::') && (clean.match(/:/g) || []).length === 1) {
    clean = clean.split(':')[0] ?? clean;
  }

  // 4. Remove leading and trailing dots
  while (clean.startsWith('.')) clean = clean.slice(1);
  while (clean.endsWith('.')) clean = clean.slice(0, -1);

  if (clean.length === 0 || clean.length > 253) {
    return null;
  }

  // Reject consecutive dots
  if (clean.includes('..')) {
    return null;
  }

  // 5. Validate standard IPv4 address
  if (isValidIpv4(clean)) {
    return clean;
  }

  // 6. Validate standard RFC 1123 domain labels
  // Domains must contain at least one alphabetic character (purely numeric domains are invalid per ICANN/RFC 1123)
  if (!/[a-z]/i.test(clean)) {
    return null;
  }

  const labels = clean.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return null;
    }
    // Must contain only alphanumeric characters and hyphens
    if (!/^[a-z0-9-]+$/i.test(label)) {
      return null;
    }
    // Cannot begin or end with a hyphen
    if (label.startsWith('-') || label.endsWith('-')) {
      return null;
    }
  }

  // The Top-Level Domain (TLD) must not be purely numeric per ICANN / RFC 1123 section 2.1
  const tld = labels[labels.length - 1];
  if (labels.length >= 2 && /^\d+$/.test(tld)) {
    return null;
  }

  return clean;
}
