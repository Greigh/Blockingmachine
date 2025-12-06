import type { StoredRule } from "../RuleStore.js";
import type { SupportedFormat } from "../types.js";

export function formatRuleForType(
  rule: StoredRule,
  format: SupportedFormat,
): string {
  switch (format) {
    case "hosts":
      return formatHostsRule(rule);
    case "dnsmasq":
      return formatDnsmasqRule(rule);
    case "unbound":
      return formatUnboundRule(rule);
    case "bind":
      return formatBindRule(rule);
    case "privoxy":
      return formatPrivoxyRule(rule);
    case "shadowrocket":
      return formatShadowrocketRule(rule);
    case "adguard":
    case "abp":
      return rule.raw; // AdGuard and ABP use the original format
    case "all":
      return rule.raw; // Return original format for 'all'
    default:
      return rule.raw;
  }
}

function formatHostsRule(rule: StoredRule): string {
  if (!rule.domain) return "";
  return `0.0.0.0 ${rule.domain}`;
}

function formatDnsmasqRule(rule: StoredRule): string {
  if (!rule.domain) return "";
  return `address=/${rule.domain}/0.0.0.0`;
}

function formatUnboundRule(rule: StoredRule): string {
  if (!rule.domain) return "";
  return `local-zone: "${rule.domain}" static`;
}

function formatBindRule(rule: StoredRule): string {
  if (!rule.domain) return "";
  return `zone "${rule.domain}" { type master; file "null.zone.file"; };`;
}

function formatPrivoxyRule(rule: StoredRule): string {
  if (!rule.domain) return "";
  return `{ +block { ${rule.domain} } }`;
}

function formatShadowrocketRule(rule: StoredRule): string {
  if (!rule.domain) return "";
  return `DOMAIN,${rule.domain},REJECT`;
}
