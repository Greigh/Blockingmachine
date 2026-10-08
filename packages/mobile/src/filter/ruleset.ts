/**
 * On-device ruleset: the hub's compiled `/dns.txt` synced into a file, parsed and
 * evaluated by `matcher.ts` — the same ABP-domain semantics `/v1/check` uses.
 * This is the standalone-filter foundation — the Check tab falls back to it when
 * the hub is unreachable, and the Android VPN/proxy services consume the native
 * rules file written alongside.
 *
 * Storage layout:
 *   `${FileSystem.documentDirectory}ruleset.txt` — raw feed body
 *   `${FileSystem.documentDirectory}ruleset.meta.json` — { syncedAt, ruleCount, sourceUrl }
 */

import * as FileSystem from 'expo-file-system/legacy';
import { UserError } from '../errors';
import { compileMatcher, type CompiledRuleset } from './matcher';

const RULES_FILE = `${FileSystem.documentDirectory}ruleset.txt`;
const META_FILE = `${FileSystem.documentDirectory}ruleset.meta.json`;
/** Bare-domain file the VPN/proxy services load — no ABP syntax in native code. */
const NATIVE_RULES_FILE = `${FileSystem.documentDirectory}ruleset_native.txt`;

export function nativeRulesPath(): string {
  return NATIVE_RULES_FILE;
}

export interface RulesetMeta {
  syncedAt: number;
  ruleCount: number;
  sourceUrl: string;
}

/**
 * Extract the matchable rule lines from a feed body. The hub publishes ABP-syntax
 * (`||host^`, `@@||` exceptions); a hosts-style file (`0.0.0.0 host`) is
 * normalized into ABP form so either feed type produces a usable ruleset.
 */
export function parseFeedRules(body: string): string[] {
  const rules: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('||') || line.startsWith('@@')) {
      rules.push(line);
      continue;
    }
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)$/i.exec(line);
    if (m && m[1] !== 'localhost' && !m[1].endsWith('.local')) {
      rules.push(`||${m[1].toLowerCase()}^`);
    }
  }
  return rules;
}

/**
 * Reduce ABP rules to the native format: bare domain suffixes (`doubleclick.net`)
 * and `!`-prefixed exceptions. Rules with $options or path components can't map
 * to DNS/proxy semantics and are dropped.
 */
export function toNativeRules(rules: string[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const exception = r.startsWith('@@');
    const body = (exception ? r.slice(2) : r).replace(/^\|\|/, '');
    if (body.includes('$') || body.includes('/') || body.includes('*')) continue;
    const domain = body.replace(/\^+$/, '').toLowerCase();
    if (!domain || !domain.includes('.')) continue;
    out.push(exception ? `!${domain}` : domain);
  }
  return out;
}

let compiled: CompiledRuleset | null | undefined; // undefined = not attempted

/** Compile the stored ruleset (lazy, memoized). Returns null when nothing is stored. */
export async function loadRuleset(): Promise<CompiledRuleset | null> {
  if (compiled !== undefined) return compiled;
  try {
    const info = await FileSystem.getInfoAsync(RULES_FILE);
    if (!info.exists) {
      compiled = null;
      return null;
    }
    const body = await FileSystem.readAsStringAsync(RULES_FILE);
    const rules = parseFeedRules(body);
    compiled = rules.length > 0 ? compileMatcher(rules) : null;
    return compiled;
  } catch {
    compiled = null;
    return null;
  }
}

export interface LocalVerdict {
  domain: string;
  blocked: boolean;
  verdict: string;
  coveringRule: string | null;
}

/** Evaluate a domain against the on-device ruleset; null when no ruleset is stored. */
export async function evaluateLocal(domain: string): Promise<LocalVerdict | null> {
  const set = await loadRuleset();
  if (!set) return null;
  const clean = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (!clean) return null;
  const res = set.evaluate(clean);
  return {
    domain: clean,
    blocked: res.verdict === 'blocked',
    verdict: res.verdict,
    coveringRule: res.coveringRule,
  };
}

/** Fetch `dns.txt` from the hub and persist it + metadata. Throws on failure. */
export async function syncRuleset(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  token?: string,
): Promise<RulesetMeta> {
  const url = `${baseUrl.replace(/\/+$/, '')}/dns.txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    res = await fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UserError('This server is locked — add its feed token in Settings.');
  }
  if (!res.ok) {
    throw new UserError(`The server couldn\u2019t send the rules (error ${res.status}) — try again.`);
  }
  const body = await res.text();
  const rules = parseFeedRules(body);
  if (rules.length === 0) {
    throw new UserError('The rules feed came back empty — the hub may still be compiling. Try again in a moment.');
  }
  await FileSystem.writeAsStringAsync(RULES_FILE, body);
  await FileSystem.writeAsStringAsync(NATIVE_RULES_FILE, toNativeRules(rules).join('\n') + '\n');
  const meta: RulesetMeta = {
    syncedAt: Date.now(),
    ruleCount: rules.length,
    sourceUrl: url,
  };
  await FileSystem.writeAsStringAsync(META_FILE, JSON.stringify(meta));
  compiled = compileMatcher(rules); // keep the memoized set in step
  return meta;
}

export async function readRulesetMeta(): Promise<RulesetMeta | null> {
  try {
    const info = await FileSystem.getInfoAsync(META_FILE);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(META_FILE)) as RulesetMeta;
  } catch {
    return null;
  }
}

/** Remove the stored ruleset and reset the compiled cache. */
export async function clearRuleset(): Promise<void> {
  compiled = undefined;
  for (const f of [RULES_FILE, META_FILE, NATIVE_RULES_FILE]) {
    try {
      const info = await FileSystem.getInfoAsync(f);
      if (info.exists) await FileSystem.deleteAsync(f);
    } catch {
      /* best-effort cleanup */
    }
  }
}
