/** Hostname labels used in hosts files and domain-level filter rules. */
export function isValidDomainName(value: string): boolean {
  return value.length <= 253 && value.includes('.') && value.split('.').every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
  );
}

/** Exception markers are distinct from the #$?# extended-CSS blocking marker. */
export function isRuleException(raw: string): boolean {
  return raw.startsWith('@@') || /#@(?:\$?\?|[$%])?#/.test(raw);
}

/** Expand a hosts line before classification; never treat aliases as one hostname. */
export function expandHostsLine(raw: string): string[] {
  const match = raw.match(/^(0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+([^#]*)/);
  if (!match) return [raw];
  return match[2].trim().split(/\s+/).filter(isValidDomainName)
    .map((hostname) => `${match[1]} ${hostname.toLowerCase().replace(/\.$/, '')}`);
}
