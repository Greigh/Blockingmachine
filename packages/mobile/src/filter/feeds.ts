/**
 * Standalone filter feeds: blocklist URLs the phone fetches and compiles
 * on-device, so filtering works with no hub at all. These are the same public
 * lists a hub subscribes to (`core/src/sources.ts`); on-device the existing
 * `parseFeedRules`/`toNativeRules` reduce them the same way the hub's compiler
 * does, and the result unions with any hub-synced ruleset in
 * `ruleset_native.txt` — the VPN/proxy services never know which side produced
 * a rule.
 *
 * The list lives in AsyncStorage (a `FilterFeed[]`), the fetched rules in
 * `ruleset_local.txt` beside the hub's `ruleset.txt`, and per-refresh status
 * in `ruleset_local.meta.json` for the UI.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { UserError } from '../errors';
import {
  LOCAL_META_FILE,
  LOCAL_RULES_FILE,
  parseFeedRules,
  rewriteNativeRules,
} from './ruleset';

export interface FilterFeed {
  name: string;
  url: string;
  enabled: boolean;
}

export interface LocalRulesMeta {
  syncedAt: number;
  ruleCount: number;
  feedCount: number;
  /** Per-feed failures from the last refresh — a feed that 404s must not hide. */
  errors: { name: string; error: string }[];
}

const FEEDS_KEY = '@blockingmachine/filter-feeds';

/**
 * First-run seeds: public DNS-oriented lists that give real coverage out of
 * the box. Kept deliberately short — every enabled feed is fetched on every
 * refresh, and the user can add the full catalog from here.
 */
export const DEFAULT_FEEDS: FilterFeed[] = [
  {
    name: 'AdGuard DNS Filter',
    url: 'https://filters.adtidy.org/extension/chromium/filters/15.txt',
    enabled: true,
  },
];

export async function readFeeds(): Promise<FilterFeed[]> {
  try {
    const raw = await AsyncStorage.getItem(FEEDS_KEY);
    if (raw === null) {
      await AsyncStorage.setItem(FEEDS_KEY, JSON.stringify(DEFAULT_FEEDS));
      return [...DEFAULT_FEEDS];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_FEEDS];
    return parsed.filter(
      (f): f is FilterFeed =>
        typeof f?.name === 'string' && typeof f?.url === 'string' && typeof f?.enabled === 'boolean',
    );
  } catch {
    return [...DEFAULT_FEEDS];
  }
}

export async function saveFeeds(feeds: FilterFeed[]): Promise<void> {
  await AsyncStorage.setItem(FEEDS_KEY, JSON.stringify(feeds));
}

export async function readLocalRulesMeta(): Promise<LocalRulesMeta | null> {
  try {
    const info = await FileSystem.getInfoAsync(LOCAL_META_FILE);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(LOCAL_META_FILE)) as LocalRulesMeta;
  } catch {
    return null;
  }
}

const SAFE_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/\S*)?$/i;

async function fetchFeedBody(url: string, fetchImpl: typeof fetch): Promise<string> {
  if (!SAFE_URL.test(url.trim())) {
    throw new UserError('Feed URLs must be https:// — plaintext feeds can be rewritten on the wire.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetchImpl(url.trim(), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch every enabled feed, merge the matchable rules into `ruleset_local.txt`
 * and rewrite the native union. A feed that fails is recorded in meta.errors —
 * it never fails the whole refresh, because one dead list must not take the
 * phone's whole filter with it. Throws UserError only when every enabled feed
 * failed or none are enabled.
 */
export async function refreshLocalRules(
  fetchImpl: typeof fetch = fetch,
): Promise<LocalRulesMeta> {
  const feeds = await readFeeds();
  const enabled = feeds.filter((f) => f.enabled);
  const errors: { name: string; error: string }[] = [];
  const rules = new Set<string>();
  for (const feed of enabled) {
    try {
      const body = await fetchFeedBody(feed.url, fetchImpl);
      for (const r of parseFeedRules(body)) rules.add(r);
    } catch (err) {
      errors.push({
        name: feed.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (enabled.length === 0) {
    throw new UserError('No feeds are enabled — turn one on or add a list.');
  }
  if (rules.size === 0) {
    throw new UserError(
      errors.length > 0
        ? `Every feed failed (${errors[0].error}) — check the list URLs and try again.`
        : 'The feeds came back with no usable rules.',
    );
  }
  await FileSystem.writeAsStringAsync(LOCAL_RULES_FILE, [...rules].join('\n') + '\n');
  await rewriteNativeRules();
  const meta: LocalRulesMeta = {
    syncedAt: Date.now(),
    ruleCount: rules.size,
    feedCount: enabled.length,
    errors,
  };
  await FileSystem.writeAsStringAsync(LOCAL_META_FILE, JSON.stringify(meta));
  return meta;
}

/** Remove the standalone ruleset and rewrite the native union (hub rules may remain). */
export async function clearLocalRules(): Promise<void> {
  for (const f of [LOCAL_RULES_FILE, LOCAL_META_FILE]) {
    try {
      const info = await FileSystem.getInfoAsync(f);
      if (info.exists) await FileSystem.deleteAsync(f);
    } catch {
      /* best-effort cleanup */
    }
  }
  await rewriteNativeRules();
}
