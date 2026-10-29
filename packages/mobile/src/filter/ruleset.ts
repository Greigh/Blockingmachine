/**
 * On-device ruleset: the hub's compiled `/dns.txt` synced into a file, parsed and
 * evaluated by `matcher.ts` — the same ABP-domain semantics `/v1/check` uses.
 * This is the standalone-filter foundation — the Check tab falls back to it when
 * the hub is unreachable, and the Android VPN/proxy services consume the native
 * rules file written alongside.
 *
 * Storage layout:
 *   `${FileSystem.documentDirectory}ruleset.txt` — raw hub feed body
 *   `${FileSystem.documentDirectory}ruleset.meta.json` — { syncedAt, ruleCount, sourceUrl }
 *   `${FileSystem.documentDirectory}ruleset_local.txt` — standalone-feed body (filter/feeds.ts)
 *   `${FileSystem.documentDirectory}ruleset_local.meta.json` — standalone sync meta
 *   `${FileSystem.documentDirectory}ruleset_native.txt` — bare-domain union of both
 *   `group.com.greighstudios.blockingmachine` container — `ruleset_native.txt` copy for
 *   the iOS DNS proxy + packet-tunnel extensions (they cannot read the app's
 *   document directory)
 */

import * as FileSystem from 'expo-file-system/legacy';
import { UserError } from '../errors';
import { credentialAllowed } from '../api/credentialScope';
import { compileMatcher, type CompiledRuleset } from './matcher';
import { publishDnsProxyRuleset } from './dnsProxy';

const RULES_FILE = `${FileSystem.documentDirectory}ruleset.txt`;
const META_FILE = `${FileSystem.documentDirectory}ruleset.meta.json`;
/** Bare-domain file the VPN/proxy services load — no ABP syntax in native code. */
const NATIVE_RULES_FILE = `${FileSystem.documentDirectory}ruleset_native.txt`;
/**
 * Standalone-feed ruleset (`filter/feeds.ts`): ABP rules fetched on-device
 * rather than synced from a hub. Hub rules and local-feed rules union into
 * `ruleset_native.txt` — the VPN/proxy services see one coherent ruleset
 * whichever side produced it, and the JS matcher reads the same union.
 */
export const LOCAL_RULES_FILE = `${FileSystem.documentDirectory}ruleset_local.txt`;
export const LOCAL_META_FILE = `${FileSystem.documentDirectory}ruleset_local.meta.json`;

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

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? await FileSystem.readAsStringAsync(path) : null;
  } catch {
    return null;
  }
}

/** Union of hub-synced rules and standalone-feed rules — deduped. */
async function readUnionRules(): Promise<string[]> {
  const seen = new Set<string>();
  for (const file of [RULES_FILE, LOCAL_RULES_FILE]) {
    const body = await readFileIfExists(file);
    if (body) for (const r of parseFeedRules(body)) seen.add(r);
  }
  return [...seen];
}

/** Compile the stored ruleset (lazy, memoized). Returns null when nothing is stored. */
export async function loadRuleset(): Promise<CompiledRuleset | null> {
  if (compiled !== undefined) return compiled;
  const rules = await readUnionRules();
  compiled = rules.length > 0 ? compileMatcher(rules) : null;
  return compiled;
}

/**
 * Recompute `ruleset_native.txt` from the union of both sources and hand it to
 * the shared app-group container. Called by every writer (hub sync, standalone
 * refresh, clears) so the native services always see the current union. Also
 * refreshes the memoized matcher.
 */
export async function rewriteNativeRules(): Promise<void> {
  const rules = await readUnionRules();
  await FileSystem.writeAsStringAsync(NATIVE_RULES_FILE, toNativeRules(rules).join('\n') + '\n');
  // Hand the iOS DNS proxy extension the same file via the shared container —
  // best-effort: a missing app-group entitlement must not fail the write.
  await publishDnsProxyRuleset(NATIVE_RULES_FILE);
  compiled = rules.length > 0 ? compileMatcher(rules) : null;
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
    // Same credential scope as the REST client — TLS or provably-local only.
    if (token && credentialAllowed(url)) {
      headers.Authorization = `Bearer ${token}`;
    }
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
  await rewriteNativeRules();
  const meta: RulesetMeta = {
    syncedAt: Date.now(),
    ruleCount: rules.length,
    sourceUrl: url,
  };
  await FileSystem.writeAsStringAsync(META_FILE, JSON.stringify(meta));
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

/** Remove the stored rulesets (hub + standalone) and reset the compiled cache. */
export async function clearRuleset(): Promise<void> {
  for (const f of [RULES_FILE, META_FILE, LOCAL_RULES_FILE, LOCAL_META_FILE]) {
    try {
      const info = await FileSystem.getInfoAsync(f);
      if (info.exists) await FileSystem.deleteAsync(f);
    } catch {
      /* best-effort cleanup */
    }
  }
  // Rewrite (not just delete) the native file: the app-group copy the tunnel
  // extension reads must see the empty union too, not the last ruleset.
  await rewriteNativeRules();
}
