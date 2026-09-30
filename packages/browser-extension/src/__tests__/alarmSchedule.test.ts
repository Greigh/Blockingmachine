/**
 * The periodic schedule has to be re-asserted, because the browser is what holds it.
 *
 * `chrome.alarms` is browser state in exactly the way the enabled rulesets are: Chrome's own
 * documentation warns that alarms can be cleared by a browser restart or an update, and that an
 * extension should therefore treat its schedule as something to check rather than something it set
 * once. This suite pins both halves of that — what counts as a missing alarm, and that confirming a
 * correct schedule costs no calls — because the failure mode is silence: an extension with no alarms
 * does not error, it simply stops syncing and stops reporting, with nothing to say so.
 */

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  ALARM_PERIODIC_SYNC,
  ALARM_SCHEDULE,
  ALARM_TELEMETRY_PUSH,
  missingAlarms,
  reconcileAlarms,
  type ExistingAlarm,
} from '../background/alarmSchedule.js';

interface AlarmStub {
  getAll: any;
  create: any;
  clear: any;
}

/** Installs a chrome stub whose alarm list is whatever the test says the browser holds. */
function installChrome(options: { existing?: ExistingAlarm[]; getAllThrows?: boolean; missingApi?: boolean } = {}): AlarmStub {
  const getAll = options.getAllThrows
    ? (jest.fn() as any).mockRejectedValue(new Error('boom'))
    : (jest.fn() as any).mockResolvedValue([...(options.existing ?? [])]);
  const create = jest.fn() as any;
  const clear = (jest.fn() as any).mockResolvedValue(true);

  const alarms: Record<string, unknown> = { getAll, create, clear };
  if (options.missingApi) delete (globalThis as any).chrome;

  (globalThis as any).chrome = { alarms };
  if (options.missingApi) {
    (globalThis as any).chrome = {};
  }

  return { getAll, create, clear };
}

beforeEach(() => {
  delete (globalThis as any).chrome;
});

describe('what counts as a missing alarm', () => {
  const schedule = ALARM_SCHEDULE;

  test('asks for the whole schedule when the browser holds nothing', () => {
    expect(missingAlarms([], schedule)).toEqual([...schedule]);
  });

  test('asks for nothing when every alarm is running on the period it should be', () => {
    const existing = schedule.map((entry) => ({ ...entry }));
    expect(missingAlarms(existing, schedule)).toEqual([]);
  });

  test('asks only for the alarm that is gone', () => {
    const existing = [{ name: ALARM_PERIODIC_SYNC, periodInMinutes: 60 }];
    expect(missingAlarms(existing, schedule)).toEqual([
      { name: ALARM_TELEMETRY_PUSH, periodInMinutes: 2 },
    ]);
  });

  test('counts a one-shot alarm as missing, because it can never fire again', () => {
    // An alarm with no `periodInMinutes` is not scheduled; it is a leftover that will fire at most
    // once, and reading it as "present" would leave the extension with a schedule it never runs.
    const existing = [{ name: ALARM_PERIODIC_SYNC }, { name: ALARM_TELEMETRY_PUSH, periodInMinutes: 2 }];
    expect(missingAlarms(existing, schedule)).toEqual([
      { name: ALARM_PERIODIC_SYNC, periodInMinutes: 60 },
    ]);
  });

  test('counts an alarm on the wrong period as missing, so a changed cadence takes effect', () => {
    const existing = [
      { name: ALARM_PERIODIC_SYNC, periodInMinutes: 5 },
      { name: ALARM_TELEMETRY_PUSH, periodInMinutes: 2 },
    ];
    expect(missingAlarms(existing, schedule)).toEqual([
      { name: ALARM_PERIODIC_SYNC, periodInMinutes: 60 },
    ]);
  });

  test('ignores alarms it does not own, in both directions', () => {
    // Another part of the extension may legitimately schedule its own work; this function's job is
    // to make its own schedule true, not to tidy the browser.
    const existing = [
      { name: 'someone-elses-alarm', periodInMinutes: 3 },
      { name: ALARM_PERIODIC_SYNC, periodInMinutes: 60 },
      { name: ALARM_TELEMETRY_PUSH, periodInMinutes: 2 },
    ];
    expect(missingAlarms(existing, schedule)).toEqual([]);
  });

  test('survives junk in the browser’s list rather than trusting its shape', () => {
    const existing = [null, undefined, { name: 42 }, { name: '' }] as unknown as ExistingAlarm[];
    // None of these is one of ours, so the whole schedule is still missing.
    expect(missingAlarms(existing, schedule)).toEqual([...schedule]);
  });

  test('is stated once, so both alarms and their periods come from one place', () => {
    expect(ALARM_SCHEDULE.map((entry) => entry.name)).toEqual([ALARM_PERIODIC_SYNC, ALARM_TELEMETRY_PUSH]);
    expect(ALARM_SCHEDULE.every((entry) => entry.periodInMinutes > 0)).toBe(true);
  });
});

describe('reconciling the browser’s alarms', () => {
  test('creates the alarms the browser is missing', async () => {
    const stub = installChrome({ existing: [] });

    const recreated = await reconcileAlarms();

    expect(stub.getAll).toHaveBeenCalledTimes(1);
    expect(recreated).toEqual([...ALARM_SCHEDULE]);
    for (const entry of ALARM_SCHEDULE) {
      expect(stub.clear).toHaveBeenCalledWith(entry.name);
      expect(stub.create).toHaveBeenCalledWith(entry.name, { periodInMinutes: entry.periodInMinutes });
    }
  });

  test('issues no call at all when the schedule is already what it should be', async () => {
    // This runs on every worker start, so a correct schedule has to cost nothing.
    const stub = installChrome({ existing: ALARM_SCHEDULE.map((entry) => ({ ...entry })) });

    await expect(reconcileAlarms()).resolves.toEqual([]);

    expect(stub.getAll).toHaveBeenCalledTimes(1);
    expect(stub.create).not.toHaveBeenCalled();
    expect(stub.clear).not.toHaveBeenCalled();
  });

  test('repairs one alarm without touching the other', async () => {
    const stub = installChrome({
      existing: [
        { name: ALARM_PERIODIC_SYNC, periodInMinutes: 5 },
        { name: ALARM_TELEMETRY_PUSH, periodInMinutes: 2 },
      ],
    });

    await reconcileAlarms();

    expect(stub.create).toHaveBeenCalledTimes(1);
    expect(stub.create).toHaveBeenCalledWith(ALARM_PERIODIC_SYNC, { periodInMinutes: 60 });
    expect(stub.create).not.toHaveBeenCalledWith(ALARM_TELEMETRY_PUSH, expect.anything());
    // Only the alarm being replaced is cleared: the telemetry push is running as it should be.
    expect(stub.clear).toHaveBeenCalledTimes(1);
    expect(stub.clear).toHaveBeenCalledWith(ALARM_PERIODIC_SYNC);
  });

  test('leaves the browser alone when its alarm list cannot be read', async () => {
    // No reading means no safe repair: clearing alarms that may already be correct would be worse
    // than leaving a schedule that might be wrong, and the next start asks again.
    const stub = installChrome({ getAllThrows: true });

    await expect(reconcileAlarms()).resolves.toEqual([]);

    expect(stub.create).not.toHaveBeenCalled();
    expect(stub.clear).not.toHaveBeenCalled();
  });

  test('is a safe no-op where the alarms API is unavailable', async () => {
    installChrome({ missingApi: true });
    await expect(reconcileAlarms()).resolves.toEqual([]);

    (globalThis as any).chrome = { alarms: { getAll: undefined } };
    await expect(reconcileAlarms()).resolves.toEqual([]);
  });

  test('reports the repair rather than doing it silently', async () => {
    const logged: string[] = [];
    const spy = jest
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
    installChrome({ existing: [] });

    await reconcileAlarms();

    expect(logged.join('\n')).toContain(ALARM_PERIODIC_SYNC);
    expect(logged.join('\n')).toContain('the browser was holding 0 alarm(s)');
    spy.mockRestore();
  });
});
