/**
 * Shape validators for renderer-supplied values that land in the persistent store or drive
 * main-process timers. Every handler that writes `store.set(key, <renderer arg>)` routes
 * through one of these first, because the renderer is a less-trusted principal than main:
 * a compromised or simply buggy view can send anything, and what persists here is re-read
 * by the compile pipeline, the feed server, and the background timers without another look.
 *
 * The convention matches `set-feed-token`: refuse malformed input with an error rather than
 * coercing it — a silent `Boolean(x)`/`String(x)` can persist something the consumer then
 * interprets differently than the caller expected, and a number-shaped hole has already
 * proven real here (`setInterval(fn, NaN)` fires at ~1ms, so a non-numeric poll interval
 * was a busy-loop, not a clamp).
 */

import { randomUUID } from 'crypto';
import { EXPORT_FORMATS } from '@blockingmachine/core';
import { sanitizeDomain } from '@blockingmachine/core';
import type { FilterFormat } from '@blockingmachine/core';
import type {
  AiProviderConfig,
  AiProviderType,
  AiWatchdogConfig,
  FilterSource,
  SourceScope,
  ThreatQuarantineItem,
} from './types';

type Ok<T> = { ok: true; value: T };
type Fail = { ok: false; error: string };

const SOURCE_SCOPES: readonly SourceScope[] = ['dns', 'browser', 'hybrid'];
const FORMAT_SET = new Set<string>(EXPORT_FORMATS);
const AUTO_SCHEDULES = ['disabled', '12h', '24h', 'weekly'] as const;
export type AutoSchedule = (typeof AUTO_SCHEDULES)[number];

const MAX_SOURCES = 200;
const MAX_SOURCE_NAME = 200;
const MAX_SOURCE_URL = 2048;
const MAX_SOURCE_TEXT = 500;
const MAX_CUSTOM_RULES_CHARS = 1_000_000;
const MAX_WEBHOOK_URL = 2048;
const MAX_WATCHDOG_MINUTES = 7 * 24 * 60; // one week
const MAX_RADAR_MINUTES = 30 * 24 * 60; // a month of continuous polling is already generous

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

export function sanitizeFilterSources(input: unknown): Ok<FilterSource[]> | Fail {
  if (!Array.isArray(input)) return { ok: false, error: 'filterSources must be an array' };
  if (input.length > MAX_SOURCES) {
    return { ok: false, error: `filterSources exceeds the ${MAX_SOURCES}-source limit` };
  }
  const sources: FilterSource[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!isRecord(raw)) {
      return { ok: false, error: `filterSources[${i}] is not an object` };
    }
    const name = optionalString(raw.name, MAX_SOURCE_NAME)?.trim();
    const url = optionalString(raw.url, MAX_SOURCE_URL)?.trim();
    if (!name || !url) {
      return { ok: false, error: `filterSources[${i}] needs a non-empty string name and url` };
    }
    if (typeof raw.enabled !== 'boolean') {
      return { ok: false, error: `filterSources[${i}].enabled must be a boolean` };
    }
    const source: FilterSource = { name, url, enabled: raw.enabled };
    if (raw.scope !== undefined) {
      if (!SOURCE_SCOPES.includes(raw.scope as SourceScope)) {
        return { ok: false, error: `filterSources[${i}].scope must be dns|browser|hybrid` };
      }
      source.scope = raw.scope as SourceScope;
    }
    if (raw.category !== undefined) {
      const category = optionalString(raw.category, MAX_SOURCE_TEXT);
      if (category === undefined) {
        return { ok: false, error: `filterSources[${i}].category must be a string` };
      }
      source.category = category;
    }
    if (raw.description !== undefined) {
      const description = optionalString(raw.description, MAX_SOURCE_TEXT);
      if (description === undefined) {
        return { ok: false, error: `filterSources[${i}].description must be a string` };
      }
      source.description = description;
    }
    if (raw.recommendedFor !== undefined) {
      const recommendedFor = optionalString(raw.recommendedFor, MAX_SOURCE_TEXT);
      if (recommendedFor === undefined) {
        return { ok: false, error: `filterSources[${i}].recommendedFor must be a string` };
      }
      source.recommendedFor = recommendedFor;
    }
    sources.push(source);
  }
  return { ok: true, value: sources };
}

/** Custom rules persist as one newline-joined blob — a non-string would corrupt every read. */
export function sanitizeCustomRulesText(input: unknown): Ok<string> | Fail {
  if (typeof input !== 'string') {
    return { ok: false, error: 'customRules must be a string' };
  }
  if (input.length > MAX_CUSTOM_RULES_CHARS) {
    return { ok: false, error: `customRules exceeds the ${MAX_CUSTOM_RULES_CHARS}-character limit` };
  }
  return { ok: true, value: input };
}

export function sanitizeAdditionalFormats(input: unknown): Ok<FilterFormat[]> | Fail {
  if (!Array.isArray(input)) return { ok: false, error: 'additionalFormats must be an array' };
  const formats: FilterFormat[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || !FORMAT_SET.has(raw)) {
      return { ok: false, error: `unknown export format ${JSON.stringify(raw)}` };
    }
    formats.push(raw as FilterFormat);
  }
  return { ok: true, value: formats };
}

export function sanitizeAutoSchedule(input: unknown): Ok<AutoSchedule> | Fail {
  if (typeof input !== 'string' || !(AUTO_SCHEDULES as readonly string[]).includes(input)) {
    return { ok: false, error: `autoSchedule must be one of ${AUTO_SCHEDULES.join('|')}` };
  }
  return { ok: true, value: input as AutoSchedule };
}

/**
 * The post-compile webhook is a POST target the user configures — the only requirement is
 * a fetchable http(s) URL or an empty "unset" string. Anything else is refused here so the
 * store never holds a value that reads as configured but can never fire.
 */
export function sanitizeWebhookUrl(input: unknown): Ok<string> | Fail {
  if (typeof input !== 'string') return { ok: false, error: 'webhookUrl must be a string' };
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: '' };
  if (trimmed.length > MAX_WEBHOOK_URL) {
    return { ok: false, error: `webhookUrl exceeds the ${MAX_WEBHOOK_URL}-character limit` };
  }
  let scheme: string;
  try {
    scheme = new URL(trimmed).protocol;
  } catch {
    return { ok: false, error: 'webhookUrl is not a parseable URL' };
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, error: 'webhookUrl must be http or https' };
  }
  return { ok: true, value: trimmed };
}

export interface LiveRadarOptions {
  service: 'adguard' | 'pihole';
  durationMinutes: number;
  pollIntervalSeconds: number;
}

/**
 * `durationMinutes`/`pollIntervalSeconds` feed `setInterval`/`Date.now()` arithmetic —
 * non-finite numbers must be rejected outright rather than clamped, because NaN reaches
 * `setInterval` as a ~1ms delay and turns the background poll into a busy-loop against
 * the configured sinkhole.
 */
export function sanitizeLiveRadarOptions(input: unknown): Ok<LiveRadarOptions> | Fail {
  if (!isRecord(input)) return { ok: false, error: 'live radar options must be an object' };
  if (input.service !== 'adguard' && input.service !== 'pihole') {
    return { ok: false, error: `live radar service must be adguard|pihole` };
  }
  if (
    typeof input.durationMinutes !== 'number' ||
    !Number.isFinite(input.durationMinutes) ||
    input.durationMinutes < 0 ||
    input.durationMinutes > MAX_RADAR_MINUTES
  ) {
    return { ok: false, error: `durationMinutes must be a number between 0 and ${MAX_RADAR_MINUTES}` };
  }
  let pollIntervalSeconds = 10;
  if (input.pollIntervalSeconds !== undefined) {
    if (
      typeof input.pollIntervalSeconds !== 'number' ||
      !Number.isFinite(input.pollIntervalSeconds)
    ) {
      return { ok: false, error: 'pollIntervalSeconds must be a finite number' };
    }
    pollIntervalSeconds = Math.max(3, Math.min(60, input.pollIntervalSeconds));
  }
  return {
    ok: true,
    value: {
      service: input.service,
      durationMinutes: input.durationMinutes,
      pollIntervalSeconds,
    },
  };
}

/**
 * Screens a renderer-supplied quarantine batch before it touches the store, the daemon's
 * DNS trie, or the LAN feeds.
 *
 * `domain` is load-bearing in three places that all trust it as a single hostname: it is
 * spliced into `||domain^` for the daemon injection, sorted into the store, and written
 * verbatim as a line of `threats.txt`/`ai-threats.txt`. An unsanitized one carrying a
 * newline or rule syntax (`^$important`) smuggles extra feed lines to every subscriber;
 * a non-string one throws inside every feed render until the ledger is cleared. Item
 * fields are kept as sent — the renderer built them — except the two the ledger itself
 * depends on: a missing `id` would leave an entry that remove-by-id can never match, and a
 * non-parseable `timestamp` NaNs the newest-first sort. Both are repaired, not rejected.
 *
 * Lives here rather than in `quarantineGate.ts` because that module is imported by the
 * renderer (`AIRadarView`), and the bare `@blockingmachine/core` barrel cannot bundle
 * for the browser target (it drags in `node-fetch`).
 */
export function sanitizeQuarantineItems(items: unknown): {
  accepted: ThreatQuarantineItem[];
  rejected: string[];
} {
  const accepted: ThreatQuarantineItem[] = [];
  const rejected: string[] = [];
  if (!Array.isArray(items)) return { accepted, rejected };
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<ThreatQuarantineItem>;
    const domain = typeof item.domain === 'string' ? sanitizeDomain(item.domain) : null;
    if (!domain) {
      rejected.push(typeof item.domain === 'string' ? item.domain : '(missing domain)');
      continue;
    }
    const id = typeof item.id === 'string' && item.id ? item.id : randomUUID();
    const timestamp =
      typeof item.timestamp === 'string' && !Number.isNaN(Date.parse(item.timestamp))
        ? item.timestamp
        : new Date().toISOString();
    accepted.push({ ...(item as ThreatQuarantineItem), id, domain, timestamp });
  }
  return { accepted, rejected };
}

/**
 * The watchdog patch is whitelisted to the fields the UI is allowed to set — the adaptive
 * fields (`adaptiveIntervalMinutes`, `cadenceReason`, `cadenceUpdatedAt`) and run markers
 * (`lastRun`, `lastThreatsFound`) are written by the sweep itself, and a renderer-supplied
 * `adaptiveIntervalMinutes` would pin the cadence where the heat map cannot move it.
 * `intervalMinutes` drives `setInterval`, so it must be a real number (see the NaN note on
 * `sanitizeLiveRadarOptions`).
 */
export function sanitizeWatchdogConfigPatch(
  input: unknown,
): Ok<Partial<AiWatchdogConfig>> | Fail {
  if (!isRecord(input)) return { ok: false, error: 'watchdog config must be an object' };
  const patch: Partial<AiWatchdogConfig> = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      return { ok: false, error: 'watchdog enabled must be a boolean' };
    }
    patch.enabled = input.enabled;
  }
  if (input.intervalMinutes !== undefined) {
    if (
      typeof input.intervalMinutes !== 'number' ||
      !Number.isFinite(input.intervalMinutes) ||
      input.intervalMinutes < 1 ||
      input.intervalMinutes > MAX_WATCHDOG_MINUTES
    ) {
      return { ok: false, error: `watchdog intervalMinutes must be a number between 1 and ${MAX_WATCHDOG_MINUTES}` };
    }
    patch.intervalMinutes = input.intervalMinutes;
  }
  if (input.service !== undefined) {
    if (input.service !== 'adguard' && input.service !== 'pihole') {
      return { ok: false, error: 'watchdog service must be adguard|pihole' };
    }
    patch.service = input.service;
  }
  if (input.autoQuarantineEntropyDga !== undefined) {
    if (typeof input.autoQuarantineEntropyDga !== 'boolean') {
      return { ok: false, error: 'watchdog autoQuarantineEntropyDga must be a boolean' };
    }
    patch.autoQuarantineEntropyDga = input.autoQuarantineEntropyDga;
  }
  return { ok: true, value: patch };
}

const AI_PROVIDERS: readonly AiProviderType[] = ['mini-ai', 'local-heuristics', 'ollama', 'gemini', 'openai'];
const AI_STRING_FIELDS = ['ollamaUrl', 'ollamaModel', 'apiKey', 'apiEndpoint', 'modelName'] as const;
const MAX_AI_FIELD = 2048;

/**
 * `set-ai-config` used to spread the renderer's object over the persisted config, so any
 * key at all survived — including `apiKeyEncrypted` (a caller-stuffed blob could replace a
 * seal this keychain cannot read) and `encryptionAvailable` (an output-only flag the
 * Settings card renders as "secrets are sealed"; a renderer write could spoof it). The
 * whitelist below is exactly the fields the AI settings UI edits.
 */
export function sanitizeAiConfigPatch(input: unknown): Ok<Partial<AiProviderConfig>> | Fail {
  if (!isRecord(input)) return { ok: false, error: 'aiConfig must be an object' };
  const patch: Partial<AiProviderConfig> = {};
  if (input.provider !== undefined) {
    if (!AI_PROVIDERS.includes(input.provider as AiProviderType)) {
      return { ok: false, error: `aiConfig.provider must be one of ${AI_PROVIDERS.join('|')}` };
    }
    patch.provider = input.provider as AiProviderType;
  }
  for (const key of AI_STRING_FIELDS) {
    if (input[key] !== undefined) {
      const value = optionalString(input[key], MAX_AI_FIELD);
      if (value === undefined) {
        return { ok: false, error: `aiConfig.${key} must be a string` };
      }
      patch[key] = value;
    }
  }
  if (input.allowlist !== undefined) {
    if (!Array.isArray(input.allowlist) || !input.allowlist.every((d) => typeof d === 'string')) {
      return { ok: false, error: 'aiConfig.allowlist must be a string array' };
    }
    patch.allowlist = input.allowlist;
  }
  for (const key of ['bypassCache', 'skipDns'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') {
        return { ok: false, error: `aiConfig.${key} must be a boolean` };
      }
      patch[key] = input[key];
    }
  }
  if (input.dnsTimeoutMs !== undefined) {
    if (
      typeof input.dnsTimeoutMs !== 'number' ||
      !Number.isFinite(input.dnsTimeoutMs) ||
      input.dnsTimeoutMs < 1 ||
      input.dnsTimeoutMs > 60_000
    ) {
      return { ok: false, error: 'aiConfig.dnsTimeoutMs must be a number between 1 and 60000' };
    }
    patch.dnsTimeoutMs = input.dnsTimeoutMs;
  }
  if (input.cascade !== undefined) {
    const cascade = input.cascade;
    if (!isRecord(cascade) || typeof cascade.enabled !== 'boolean') {
      return { ok: false, error: 'aiConfig.cascade must be an object with a boolean enabled' };
    }
    const cleanCascade: NonNullable<AiProviderConfig['cascade']> = { enabled: cascade.enabled };
    if (cascade.maxEscalations !== undefined) {
      if (
        typeof cascade.maxEscalations !== 'number' ||
        !Number.isInteger(cascade.maxEscalations) ||
        cascade.maxEscalations < 1 ||
        cascade.maxEscalations > 10
      ) {
        return { ok: false, error: 'aiConfig.cascade.maxEscalations must be an integer 1–10' };
      }
      cleanCascade.maxEscalations = cascade.maxEscalations;
    }
    if (cascade.escalateClean !== undefined) {
      if (typeof cascade.escalateClean !== 'boolean') {
        return { ok: false, error: 'aiConfig.cascade.escalateClean must be a boolean' };
      }
      cleanCascade.escalateClean = cascade.escalateClean;
    }
    patch.cascade = cleanCascade;
  }
  return { ok: true, value: patch };
}

const ADGUARD_MODES = ['direct', 'ha-api', 'webhook'] as const;
const SINKHOLE_STRING_FIELDS = [
  'piholeUrl',
  'adguardHomeUrl',
  'adguardHomeUser',
  'haWebhookUrl',
  'customWebhookUrl',
  'adguardDirectUrl',
] as const;
const SINKHOLE_SECRET_FIELDS = ['piholeApiKey', 'adguardHomePassword', 'haToken'] as const;

/** The whitelisted shape `set-sinkhole-config` is allowed to write. */
export interface SinkholeConfigPatch {
  piholeUrl?: string;
  adguardHomeUrl?: string;
  adguardHomeUser?: string;
  haWebhookUrl?: string;
  customWebhookUrl?: string;
  adguardDirectUrl?: string;
  adguardMode?: 'direct' | 'ha-api' | 'webhook';
  adguardDirectPort?: number;
  syncOnCompile?: boolean;
  allowInsecureLocalTls?: boolean;
  piholeApiKey?: string;
  adguardHomePassword?: string;
  haToken?: string;
  clearSecrets?: string[];
}

/**
 * Whitelist for `set-sinkhole-config`: the handler writes each present field to its own
 * store key, so an unknown or wrongly-typed field would persist junk that the sync path
 * later treats as configured. Unknown keys are dropped rather than passed through, and
 * secret fields are checked for string-ness here so the write-only path never stores a
 * non-string "credential". `adguardDirectPort` accepts the numeric string a form field can
 * send and normalizes it to the number `SinkholeUrlFields` expects — a non-numeric value
 * is refused rather than silently falling back to the default port.
 */
export function sanitizeSinkholeConfigPatch(input: unknown): Ok<SinkholeConfigPatch> | Fail {
  if (!isRecord(input)) return { ok: false, error: 'sinkhole config must be an object' };
  const patch: SinkholeConfigPatch = {};
  for (const key of SINKHOLE_STRING_FIELDS) {
    if (input[key] !== undefined) {
      const value = optionalString(input[key], MAX_WEBHOOK_URL);
      if (value === undefined) {
        return { ok: false, error: `sinkhole ${key} must be a string of at most ${MAX_WEBHOOK_URL} characters` };
      }
      patch[key] = value;
    }
  }
  for (const key of SINKHOLE_SECRET_FIELDS) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') {
        return { ok: false, error: `sinkhole secret ${key} must be a string` };
      }
      patch[key] = input[key];
    }
  }
  if (input.adguardMode !== undefined) {
    if (!(ADGUARD_MODES as readonly string[]).includes(input.adguardMode as string)) {
      return { ok: false, error: `adguardMode must be one of ${ADGUARD_MODES.join('|')}` };
    }
    patch.adguardMode = input.adguardMode as SinkholeConfigPatch['adguardMode'];
  }
  if (input.adguardDirectPort !== undefined) {
    const raw = input.adguardDirectPort;
    const port = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isInteger(port)) {
      return { ok: false, error: 'adguardDirectPort must be a number or numeric string' };
    }
    patch.adguardDirectPort = port;
  }
  for (const key of ['syncOnCompile', 'allowInsecureLocalTls'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') {
        return { ok: false, error: `sinkhole ${key} must be a boolean` };
      }
      patch[key] = input[key];
    }
  }
  if (input.clearSecrets !== undefined) {
    if (!Array.isArray(input.clearSecrets) || !input.clearSecrets.every((s) => typeof s === 'string')) {
      return { ok: false, error: 'clearSecrets must be a string array' };
    }
    patch.clearSecrets = input.clearSecrets;
  }
  return { ok: true, value: patch };
}
