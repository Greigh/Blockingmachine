/**
 * Unit tests for the deployment-side refresh ledger in `deployRefresh.ts`.
 *
 * The ledger is what makes a cron that broke overnight a fact rather than an absence: these
 * cover the report parsing (what the endpoint accepts off the query string), the record merge
 * (success and failure are tracked independently so a failure is not overwritten by the next
 * success before it has been seen), and the fail-question semantics (a failure that predates
 * the newest success is history, not a headline).
 */

import { describe, test, expect } from '@jest/globals';
import {
  DEPLOY_REFRESH_TARGETS,
  deployRefreshFailing,
  deployRefreshLastReportAt,
  parseDeployRefreshQuery,
  recordDeployRefresh,
} from '../deployRefresh';

const query = (raw: string) => parseDeployRefreshQuery(new URLSearchParams(raw));

describe('parseDeployRefreshQuery', () => {
  test('accepts an ok report with a target', () => {
    expect(query('ok=1&target=unbound')).toEqual({
      target: 'unbound',
      ok: true,
      detail: undefined,
    });
  });

  test('keeps a failure detail, truncated to a sentence', () => {
    expect(query('ok=0&target=unbound&detail=conf%20rejected')).toEqual({
      target: 'unbound',
      ok: false,
      detail: 'conf rejected',
    });
    const long = 'x'.repeat(500);
    expect(query(`ok=0&target=unbound&detail=${long}`)?.detail).toHaveLength(200);
  });

  test('refuses a missing or unknown target and a non-binary ok', () => {
    expect(query('ok=1')).toBeNull();
    expect(query('target=unbound')).toBeNull();
    expect(query('ok=1&target=pihole')).toBeNull();
    expect(query('ok=maybe&target=unbound')).toBeNull();
    expect(query('ok=1&target=unbound&ok=0')?.ok).toBe(true); // first wins, no silent flip
  });

  test('round-trips every registered target', () => {
    for (const target of DEPLOY_REFRESH_TARGETS) {
      expect(query(`ok=1&target=${target}`)?.target).toBe(target);
    }
  });
});

describe('recordDeployRefresh', () => {
  test('stamps success and failure into independent slots with the reporting peer', () => {
    const failed = recordDeployRefresh(null, {
      ok: false,
      at: '2026-04-20T02:00:00.000Z',
      peer: '192.168.1.20',
      detail: 'conf rejected',
    });
    expect(failed).toEqual({
      lastFailAt: '2026-04-20T02:00:00.000Z',
      lastFailPeer: '192.168.1.20',
      lastFailDetail: 'conf rejected',
    });

    // The next morning's success must not unname the failure — both stamps stay so the card
    // can compare them rather than remember only the last thing that happened.
    const recovered = recordDeployRefresh(failed, {
      ok: true,
      at: '2026-04-20T05:00:00.000Z',
      peer: '192.168.1.20',
    });
    expect(recovered.lastOkAt).toBe('2026-04-20T05:00:00.000Z');
    expect(recovered.lastFailAt).toBe('2026-04-20T02:00:00.000Z');
  });

  test('keeps the earlier success when a failure lands after it', () => {
    const ok = recordDeployRefresh(null, { ok: true, at: '2026-04-19T05:00:00.000Z' });
    const next = recordDeployRefresh(ok, { ok: false, at: '2026-04-20T02:00:00.000Z' });
    expect(next.lastOkAt).toBe('2026-04-19T05:00:00.000Z');
    expect(next.lastFailAt).toBe('2026-04-20T02:00:00.000Z');
  });

  test('a corrupt persisted record degrades to a fresh one instead of spreading junk keys', () => {
    const next = recordDeployRefresh('not-a-report' as never, {
      ok: true,
      at: '2026-04-20T05:00:00.000Z',
    });
    expect(next).toEqual({ lastOkAt: '2026-04-20T05:00:00.000Z' });
  });
});

describe('deployRefreshLastReportAt', () => {
  test('is undefined with no record and the newest stamp otherwise', () => {
    expect(deployRefreshLastReportAt(null)).toBeUndefined();
    expect(deployRefreshLastReportAt({})).toBeUndefined();
    expect(
      deployRefreshLastReportAt({
        lastOkAt: '2026-04-20T05:00:00.000Z',
        lastFailAt: '2026-04-20T02:00:00.000Z',
      }),
    ).toBe('2026-04-20T05:00:00.000Z');
  });

  test('ignores stamps that do not parse', () => {
    expect(deployRefreshLastReportAt({ lastFailAt: 'not-iso' })).toBeUndefined();
  });
});

describe('deployRefreshFailing', () => {
  test('is false when nothing has reported — no news is not bad news', () => {
    expect(deployRefreshFailing(null, '2026-04-20T09:00:00.000Z')).toBe(false);
    expect(deployRefreshFailing({ lastOkAt: '2026-04-20T09:00:00.000Z' })).toBe(false);
  });

  test('is true while a failure is newer than every success the hub knows', () => {
    const report = {
      lastOkAt: '2026-04-19T05:00:00.000Z',
      lastFailAt: '2026-04-20T02:00:00.000Z',
    };
    expect(deployRefreshFailing(report, '2026-04-19T05:30:00.000Z')).toBe(true);
  });

  test('is false once a newer success exists — a healed wound is history, not a headline', () => {
    const report = {
      lastOkAt: '2026-04-20T05:00:00.000Z',
      lastFailAt: '2026-04-20T02:00:00.000Z',
    };
    expect(deployRefreshFailing(report)).toBe(false);
    // A fetch the serve-log overheard after the failure counts as success even without a report.
    expect(deployRefreshFailing({ lastFailAt: '2026-04-20T02:00:00.000Z' }, '2026-04-20T06:00:00.000Z')).toBe(false);
  });
});
