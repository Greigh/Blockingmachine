/**
 * On-device domain matcher — the subset of the hub's `compileRuleSet` semantics
 * that a published feed needs: `||domain^` matches the domain and every
 * subdomain; `@@||` exceptions win; `*.domain` behaves like `||domain^`.
 * Rules carrying `$options` (third-party, important, …) are treated as
 * domain-level since a bare hostname has no request context — matching what
 * `/v1/check` reports for the same input.
 */

export interface MatchResult {
  domain: string;
  verdict: 'blocked' | 'exception' | 'not_blocked';
  coveringRule: string | null;
}

interface CompiledRule {
  /** Suffix to match, e.g. 'doubleclick.net'. */
  pattern: string;
  exception: boolean;
  raw: string;
}

export interface CompiledRuleset {
  size: number;
  evaluate(domain: string): MatchResult;
}

/** Strip `$options` and trailing `^` separators off an ABP host rule. */
function ruleHostPattern(raw: string, exception: boolean): string | null {
  let body = exception ? raw.slice(2) : raw;
  if (body.startsWith('||')) body = body.slice(2);
  body = body.split('$')[0].replace(/\^+$/, '');
  if (body.startsWith('*.')) body = body.slice(2);
  const d = body.toLowerCase().trim();
  // Path rules (contain '/') and bare wildcards can't be domain rules.
  return d && !d.includes('/') && !d.includes('*') && d.includes('.') ? d : null;
}

export function compileMatcher(rules: string[]): CompiledRuleset {
  const blocked: CompiledRule[] = [];
  const exceptions: CompiledRule[] = [];
  // Index by last label so lookup walks suffixes of the query only.
  const bySuffix = new Map<string, CompiledRule[]>();
  const exSuffix = new Map<string, CompiledRule[]>();

  for (const raw of rules) {
    const exception = raw.startsWith('@@');
    const pattern = ruleHostPattern(raw, exception);
    if (!pattern) continue;
    const rule = { pattern, exception, raw };
    (exception ? exceptions : blocked).push(rule);
    const map = exception ? exSuffix : bySuffix;
    const list = map.get(pattern);
    if (list) list.push(rule);
    else map.set(pattern, [rule]);
  }

  const lookup = (map: Map<string, CompiledRule[]>, domain: string): CompiledRule | null => {
    let d = domain;
    for (;;) {
      const hit = map.get(d);
      if (hit && hit.length) return hit[0];
      const dot = d.indexOf('.');
      if (dot < 0) return null;
      d = d.slice(dot + 1);
    }
  };

  return {
    size: blocked.length + exceptions.length,
    evaluate(domain: string): MatchResult {
      const d = domain.trim().toLowerCase().replace(/\.+$/, '');
      const ex = lookup(exSuffix, d);
      if (ex) return { domain: d, verdict: 'exception', coveringRule: ex.raw };
      const hit = lookup(bySuffix, d);
      if (hit) return { domain: d, verdict: 'blocked', coveringRule: hit.raw };
      return { domain: d, verdict: 'not_blocked', coveringRule: null };
    },
  };
}
