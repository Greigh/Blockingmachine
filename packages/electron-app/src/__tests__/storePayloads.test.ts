/**
 * Regression pins for the store-payload validators (audit F-06).
 *
 * The write-side IPC handlers used to trust the declared TypeScript types — which vanish
 * at the IPC boundary — and persist whatever the renderer sent. Two failure shapes were
 * real, not hypothetical:
 *
 *  - Non-numeric `pollIntervalSeconds`/`intervalMinutes` reached `setInterval` as NaN,
 *    which Node runs as a ~1ms delay — a renderer-supplied string turned the background
 *    poll into a busy-loop hammering the sinkhole.
 *  - `filterSources` entries with a numeric `url` or non-boolean `enabled` persisted fine
 *    and then broke the compile pipeline's assumption that `source.url` is a string.
 *
 * Refuse-and-report is the contract: no coercion, no partial writes.
 */

import { describe, expect, test } from '@jest/globals';
import {
  sanitizeAdditionalFormats,
  sanitizeAiConfigPatch,
  sanitizeAutoSchedule,
  sanitizeCustomRulesText,
  sanitizeFilterSources,
  sanitizeLiveRadarOptions,
  sanitizeQuarantineItems,
  sanitizeSinkholeConfigPatch,
  sanitizeWatchdogConfigPatch,
  sanitizeWebhookUrl,
} from '../storePayloads';
import type { FilterSource, ThreatQuarantineItem } from '../types';

const goodSource: FilterSource = {
  name: 'EasyList',
  url: 'https://easylist.to/easylist/easylist.txt',
  enabled: true,
};

describe('sanitizeFilterSources', () => {
  test('accepts a well-formed list and preserves optional fields', () => {
    const out = sanitizeFilterSources([
      { ...goodSource, scope: 'dns', category: 'ads', description: 'd', recommendedFor: 'r' },
    ]);
    expect(out).toEqual({
      ok: true,
      value: [{ ...goodSource, scope: 'dns', category: 'ads', description: 'd', recommendedFor: 'r' }],
    });
  });

  test('accepts an empty array (clearing all sources is legitimate)', () => {
    expect(sanitizeFilterSources([])).toEqual({ ok: true, value: [] });
  });

  test.each([undefined, null, 'x', 42, {}])('rejects non-array input %p', (input) => {
    expect(sanitizeFilterSources(input).ok).toBe(false);
  });

  test.each([
    [{ ...goodSource, enabled: 'yes' }],
    [{ ...goodSource, url: 42 }],
    [{ ...goodSource, name: '' }],
    [{ ...goodSource, scope: 'upside-down' }],
    [[null]],
    ['not-an-object'],
    [{ ...goodSource, description: 7 }],
  ])('rejects malformed entry %p', (sources) => {
    expect(sanitizeFilterSources(sources).ok).toBe(false);
  });

  test('rejects a batch over the source cap', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ ...goodSource, name: `s${i}` }));
    expect(sanitizeFilterSources(many).ok).toBe(false);
  });
});

describe('sanitizeCustomRulesText', () => {
  test('accepts multi-line rule text', () => {
    const rules = '||ads.example^\n@@||good.example^';
    expect(sanitizeCustomRulesText(rules)).toEqual({ ok: true, value: rules });
  });

  test.each([undefined, null, 5, ['||ads.example^'], { rules: 'x' }])(
    'rejects non-string input %p so a bad write cannot corrupt the blob every reader splits',
    (input) => {
      expect(sanitizeCustomRulesText(input).ok).toBe(false);
    },
  );

  test('rejects an oversized rules blob', () => {
    expect(sanitizeCustomRulesText('x'.repeat(1_000_001)).ok).toBe(false);
    expect(sanitizeCustomRulesText('x'.repeat(1_000_000)).ok).toBe(true);
  });
});

describe('sanitizeAdditionalFormats', () => {
  test('accepts every supported format', () => {
    const all = ['hosts', 'dnsmasq', 'unbound', 'bind', 'bind-null', 'privoxy', 'shadowrocket', 'adguard', 'abp', 'domains', 'plain'];
    expect(sanitizeAdditionalFormats(all)).toEqual({ ok: true, value: all });
  });

  test.each([[['bogus-format']], [['hosts', 5]], ['hosts'], [null]])(
    'rejects anything outside the format enum: %p',
    (input) => {
      expect(sanitizeAdditionalFormats(input).ok).toBe(false);
    },
  );
});

describe('sanitizeAutoSchedule', () => {
  test.each(['disabled', '12h', '24h', 'weekly'])('accepts %s', (v) => {
    expect(sanitizeAutoSchedule(v)).toEqual({ ok: true, value: v });
  });

  test.each(['hourly', '', null, 12, { schedule: '24h' }, ['24h']])(
    'rejects %p — an unrecognized value would persist and leave the scheduler dead',
    (input) => {
      expect(sanitizeAutoSchedule(input).ok).toBe(false);
    },
  );
});

describe('sanitizeWebhookUrl', () => {
  test('accepts http/https URLs and trims whitespace', () => {
    expect(sanitizeWebhookUrl(' https://hooks.example.com/x ')).toEqual({
      ok: true,
      value: 'https://hooks.example.com/x',
    });
    expect(sanitizeWebhookUrl('http://192.168.1.10:8123/api/webhook/x').ok).toBe(true);
  });

  test('accepts empty string as "unset"', () => {
    expect(sanitizeWebhookUrl('')).toEqual({ ok: true, value: '' });
  });

  test.each(['ftp://x', 'javascript:alert(1)', 'file:///etc/passwd', 'notaurl', 42, null])(
    'rejects %p — the store must never hold a value that reads configured but cannot fire',
    (input) => {
      expect(sanitizeWebhookUrl(input).ok).toBe(false);
    },
  );
});

describe('sanitizeLiveRadarOptions', () => {
  test('accepts a normal session', () => {
    expect(
      sanitizeLiveRadarOptions({ service: 'pihole', durationMinutes: 15, pollIntervalSeconds: 10 }),
    ).toEqual({ ok: true, value: { service: 'pihole', durationMinutes: 15, pollIntervalSeconds: 10 } });
  });

  test('defaults the poll interval and clamps out-of-range numbers', () => {
    expect(sanitizeLiveRadarOptions({ service: 'adguard', durationMinutes: 5 })).toEqual({
      ok: true,
      value: { service: 'adguard', durationMinutes: 5, pollIntervalSeconds: 10 },
    });
    const clamped = sanitizeLiveRadarOptions({ service: 'adguard', durationMinutes: 5, pollIntervalSeconds: 999 });
    expect(clamped.ok && clamped.value.pollIntervalSeconds).toBe(60);
  });

  // The regression itself: `Math.max(3, Math.min(60, NaN))` is NaN, and `setInterval(fn, NaN)`
  // is a ~1ms loop. Non-numbers must be rejected before they reach the timer.
  test.each([{ service: 'adguard', durationMinutes: 5, pollIntervalSeconds: 'fast' },
    { service: 'adguard', durationMinutes: 5, pollIntervalSeconds: NaN },
    { service: 'adguard', durationMinutes: 'forever' },
    { service: 'adguard', durationMinutes: -1 },
    { service: 'adguard', durationMinutes: 5, pollIntervalSeconds: Infinity },
    { service: 'dnsmasq', durationMinutes: 5 },
    [null],
    ['adguard'],
  ])('rejects %p', (input) => {
    expect(sanitizeLiveRadarOptions(input).ok).toBe(false);
  });
});

describe('sanitizeWatchdogConfigPatch', () => {
  test('accepts the fields the UI sets', () => {
    expect(
      sanitizeWatchdogConfigPatch({ enabled: true, intervalMinutes: 30, service: 'pihole', autoQuarantineEntropyDga: false }),
    ).toEqual({ ok: true, value: { enabled: true, intervalMinutes: 30, service: 'pihole', autoQuarantineEntropyDga: false } });
  });

  test('drops main-process-owned adaptive fields rather than persisting them', () => {
    const out = sanitizeWatchdogConfigPatch({
      enabled: true,
      adaptiveIntervalMinutes: 99999,
      cadenceReason: 'fake',
      lastRun: 'now',
    });
    expect(out).toEqual({ ok: true, value: { enabled: true } });
  });

  test.each([
    { intervalMinutes: 'hourly' }, // the NaN-timer regression
    { intervalMinutes: NaN },
    { intervalMinutes: 0 },
    { intervalMinutes: Infinity },
    { enabled: 'yes' },
    { service: 'unbound' },
    { autoQuarantineEntropyDga: 1 },
    null,
    'enabled',
  ])('rejects %p', (input) => {
    expect(sanitizeWatchdogConfigPatch(input).ok).toBe(false);
  });
});

/**
 * `add-threat-quarantine` is the one quarantine path driven by renderer input, and it used
 * to trust `item.domain` as a hostname. A domain carrying `\n` or rule syntax would be
 * written verbatim into `threats.txt`/`ai-threats.txt` — smuggling extra feed lines to
 * every LAN subscriber — and into the daemon's DNS trie. `sanitizeQuarantineItems` is the
 * screen; these pin the rejection list it must hold.
 */
describe('sanitizeQuarantineItems', () => {
  const item = (domain: string, over: Partial<ThreatQuarantineItem> = {}): ThreatQuarantineItem => ({
    id: `id-${domain}`,
    domain,
    category: 'Telemetry/Analytics',
    verdict: 'suspicious',
    riskLevel: 'medium',
    confidence: 0.7,
    reasons: [],
    generatedRules: [],
    source: 'sinkhole',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  test('accepts a well-formed item and preserves the renderer-built fields', () => {
    const good = item('doubleclick.net');
    const out = sanitizeQuarantineItems([good]);
    expect(out.rejected).toEqual([]);
    expect(out.accepted).toEqual([good]);
  });

  test('rejects feed-line injection via newline and rule-syntax characters', () => {
    const poison = [
      item('evil.example\n||allowed-everywhere.example^'),
      item('evil.example^$important'),
      item('evil.example\t'),
    ];
    const out = sanitizeQuarantineItems(poison);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(3);
  });

  test('rejects non-string and missing domains by name', () => {
    const out = sanitizeQuarantineItems([
      { ...item('ok.example'), domain: 42 },
      { ...item('ok.example'), domain: undefined },
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toEqual(['(missing domain)', '(missing domain)']);
  });

  test('drops non-object entries without throwing', () => {
    const out = sanitizeQuarantineItems([null, 'doubleclick.net', 7, item('ok.example')]);
    expect(out.accepted.map((i) => i.domain)).toEqual(['ok.example']);
  });

  test('non-array input accepts and rejects nothing', () => {
    expect(sanitizeQuarantineItems('doubleclick.net')).toEqual({ accepted: [], rejected: [] });
    expect(sanitizeQuarantineItems(undefined)).toEqual({ accepted: [], rejected: [] });
  });

  test('repairs a missing id so remove-by-id can never strand an entry', () => {
    const out = sanitizeQuarantineItems([{ ...item('no-id.example'), id: '' }]);
    expect(out.accepted).toHaveLength(1);
    expect(typeof out.accepted[0].id).toBe('string');
    expect(out.accepted[0].id.length).toBeGreaterThan(0);
  });

  test('repairs an unparseable timestamp so the newest-first sort cannot NaN', () => {
    const out = sanitizeQuarantineItems([{ ...item('no-date.example'), timestamp: 'not-a-date' }]);
    expect(Number.isNaN(Date.parse(out.accepted[0].timestamp))).toBe(false);
  });
});

/**
 * `set-ai-config` used to spread the renderer's object over the persisted config — any key
 * survived, including `apiKeyEncrypted` (a caller-stuffed blob would replace a seal this
 * keychain cannot read) and `encryptionAvailable` (an output-only flag the settings UI
 * renders as "secrets are sealed"). The patch is whitelisted to what the AI form edits.
 */
describe('sanitizeAiConfigPatch', () => {
  test('accepts the fields the AI settings form edits', () => {
    const out = sanitizeAiConfigPatch({
      provider: 'ollama',
      ollamaUrl: 'http://192.168.1.20:11434',
      ollamaModel: 'llama3',
      apiKey: 'k',
      apiEndpoint: 'https://api.openai.com/v1',
      modelName: 'gpt-4o',
      allowlist: ['example.com'],
      bypassCache: true,
      skipDns: false,
      dnsTimeoutMs: 5000,
      cascade: { enabled: true, maxEscalations: 2, escalateClean: true },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.provider).toBe('ollama');
      expect(out.value.cascade).toEqual({ enabled: true, maxEscalations: 2, escalateClean: true });
    }
  });

  test('drops apiKeyEncrypted and encryptionAvailable — outputs of main, never inputs', () => {
    const out = sanitizeAiConfigPatch({
      provider: 'openai',
      apiKeyEncrypted: 'stuffed-blob',
      encryptionAvailable: true,
      inventedKey: 'x',
    });
    expect(out).toEqual({ ok: true, value: { provider: 'openai' } });
  });

  test.each([
    { provider: 'anthropic' },
    { ollamaUrl: 11434 },
    { allowlist: 'example.com' },
    { allowlist: ['ok.example', 5] },
    { bypassCache: 'yes' },
    { dnsTimeoutMs: '5000' },
    { dnsTimeoutMs: NaN },
    { cascade: { enabled: 'on' } },
    { cascade: { enabled: true, maxEscalations: 0 } },
    null,
    ['openai'],
  ])('rejects %p', (input) => {
    expect(sanitizeAiConfigPatch(input).ok).toBe(false);
  });
});

/**
 * `set-sinkhole-config` wrote each present field to its own store key with only an
 * `!== undefined` check — a non-string `piholeUrl` persisted and `sinkholeFetch` met a
 * non-string at sync time. The patch is whitelisted and per-field typed.
 */
describe('sanitizeSinkholeConfigPatch', () => {
  test('accepts a normal save with secrets and clears', () => {
    const out = sanitizeSinkholeConfigPatch({
      piholeUrl: 'http://192.168.1.5',
      piholeApiKey: 'token',
      adguardMode: 'webhook',
      syncOnCompile: true,
      allowInsecureLocalTls: false,
      adguardDirectPort: '5053',
      clearSecrets: ['haToken'],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.adguardDirectPort).toBe(5053);
      expect(out.value.adguardMode).toBe('webhook');
    }
  });

  test('drops unknown keys instead of persisting them', () => {
    const out = sanitizeSinkholeConfigPatch({ piholeUrl: 'http://p', mystery: true });
    expect(out).toEqual({ ok: true, value: { piholeUrl: 'http://p' } });
  });

  test.each([
    { piholeUrl: 8080 },
    { adguardMode: 'bogus' },
    { adguardDirectPort: 'not-a-port' },
    { syncOnCompile: 'true' },
    { piholeApiKey: { key: 'x' } },
    { clearSecrets: ['haToken', 9] },
    null,
    'http://pihole.local',
  ])('rejects %p', (input) => {
    expect(sanitizeSinkholeConfigPatch(input).ok).toBe(false);
  });
});
