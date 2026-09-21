import type { AiVerdict, ThreatCategory } from './types.js';

export interface RuleSynthesisInput {
  domain: string;
  verdict: AiVerdict;
  category: ThreatCategory;
  cnames?: string[];
  isSubdomain?: boolean;
}

/**
 * Synthesizes ABP/AdGuard-compatible blocking rules for detected ad/tracker infrastructure.
 */
export function synthesizeRules(input: RuleSynthesisInput): string[] {
  const { domain, verdict, category, cnames } = input;
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0];
  const rules: string[] = [];

  if (verdict === 'clean') {
    return [];
  }

  // 1. Primary Network Blocking Rule (Standard ABP / AdGuard DNS syntax)
  if (category === 'Advertising' || verdict === 'ad_server') {
    rules.push(`||${cleanDomain}^`);
  } else if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
    rules.push(`||${cleanDomain}^`);
    rules.push(`||${cleanDomain}^$third-party`);
  } else if (category === 'CNAME Cloaking') {
    rules.push(`||${cleanDomain}^`);
    if (cnames && cnames.length > 0) {
      const lastCname = cnames[cnames.length - 1];
      rules.push(`||${lastCname}^`);
    }
  } else {
    // General block
    rules.push(`||${cleanDomain}^`);
  }

  // 2. Add Hosts-file compatible format
  rules.push(`0.0.0.0 ${cleanDomain}`);

  return Array.from(new Set(rules));
}
