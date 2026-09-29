import { describe, test, expect } from '@jest/globals';
import {
  describeLedger,
  formatLedgerQuota,
  formatQuotaReset,
  ledgerFeedDetail,
  ledgerFeedForSession,
  ledgerFeedFromAvailability,
  ledgerFeedLabel,
  ledgerFeedTone,
  type LedgerQuotaView,
  type LedgerStatus,
} from '../shared/ledgerStatus.js';

function quota(overrides: Partial<LedgerQuotaView> = {}): LedgerQuotaView {
  return {
    callsInWindow: 0,
    maxCalls: 20,
    remaining: 20,
    resetsInMs: 0,
    windowMs: 10 * 60 * 1000,
    ...overrides,
  };
}

function status(feed: LedgerStatus['feed'], overrides: Partial<LedgerStatus> = {}): LedgerStatus {
  return {
    feed,
    liveAvailable: feed === 'live',
    pollAvailable: feed !== 'unavailable',
    quota: quota(),
    ...overrides,
  };
}

describe('ledgerFeedFromAvailability', () => {
  test('prefers the live debug event when both paths exist', () => {
    // Same matches, plus the request URL — there is no reason to poll as well.
    expect(ledgerFeedFromAvailability({ liveAvailable: true, pollAvailable: true })).toBe('live');
  });

  test('falls back to polling, the only path a packed build has', () => {
    expect(ledgerFeedFromAvailability({ liveAvailable: false, pollAvailable: true })).toBe('polled');
  });

  test('says so plainly when neither path exists', () => {
    expect(ledgerFeedFromAvailability({ liveAvailable: false, pollAvailable: false })).toBe(
      'unavailable',
    );
  });
});

describe('ledgerFeedForSession', () => {
  test('names the two real paths and refuses to guess at the third', () => {
    expect(ledgerFeedForSession('live')).toBe('live');
    expect(ledgerFeedForSession('polled')).toBe('polled');
    // A session written when nothing could feed the ledger says so, rather than claiming the
    // better of the two sources.
    expect(ledgerFeedForSession('unavailable')).toBe('unknown');
  });
});

describe('ledger feed presentation', () => {
  test('labels each path in the badge', () => {
    expect(ledgerFeedLabel('live')).toBe('Live');
    expect(ledgerFeedLabel('polled')).toBe('Polled');
    expect(ledgerFeedLabel('unavailable')).toBe('Off');
  });

  test('tones the badge by how much the path costs', () => {
    expect(ledgerFeedTone('live')).toBe('ok');
    expect(ledgerFeedTone('polled')).toBe('warn');
    expect(ledgerFeedTone('unavailable')).toBe('off');
  });

  test('names the API behind each path in the detail line', () => {
    expect(ledgerFeedDetail('live')).toContain('onRuleMatchedDebug');
    expect(ledgerFeedDetail('polled')).toContain('getMatchedRules');
    expect(ledgerFeedDetail('unavailable')).toContain('getMatchedRules');
    expect(ledgerFeedDetail('unavailable')).toContain('onRuleMatchedDebug');
  });
});

describe('formatQuotaReset', () => {
  test('reads in the unit that keeps it short', () => {
    expect(formatQuotaReset(45_000)).toBe('45s');
    expect(formatQuotaReset(200_000)).toBe('3m 20s');
    expect(formatQuotaReset(60_000)).toBe('1m 00s');
  });

  test('never shows a negative wait', () => {
    expect(formatQuotaReset(-1000)).toBe('0s');
    expect(formatQuotaReset(0)).toBe('0s');
  });
});

describe('formatLedgerQuota', () => {
  test('a full budget is not reported as an empty one', () => {
    expect(formatLedgerQuota(quota())).toBe('20 of 20 available');
  });

  test('a partly spent budget names what is left', () => {
    expect(formatLedgerQuota(quota({ callsInWindow: 2, remaining: 18 }))).toBe('18 of 20 left');
  });

  test('an exhausted budget names when the next call becomes legal', () => {
    expect(
      formatLedgerQuota(quota({ callsInWindow: 20, remaining: 0, resetsInMs: 180_000 })),
    ).toBe('none left · next in 3m 00s');
  });

  test('treats a nonsensical negative reading as spent rather than free', () => {
    expect(formatLedgerQuota(quota({ remaining: -3, resetsInMs: 30_000 }))).toBe(
      'none left · next in 30s',
    );
  });
});

describe('describeLedger', () => {
  test('names both the source and the quota in one line', () => {
    expect(describeLedger(status('polled', { quota: quota({ callsInWindow: 5, remaining: 15 }) }))).toBe(
      'Polled · getMatchedRules 15 of 20 left',
    );
    expect(describeLedger(status('live'))).toBe('Live · getMatchedRules 20 of 20 available');
  });
});
