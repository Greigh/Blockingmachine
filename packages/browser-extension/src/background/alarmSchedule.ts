/**
 * The periodic work this extension schedules, reconciled against the browser's own alarm list.
 *
 * `chrome.alarms` is the only thing that makes a Manifest V3 service worker run when nothing else is
 * happening, and an alarm is *browser state* rather than extension state: Chrome's own documentation
 * warns that alarms are cleared on a browser restart and on some updates, and that an extension
 * should therefore treat its schedule as something to re-assert rather than something it set once.
 * This extension did exactly what the warning is about — it created both alarms inside
 * `chrome.runtime.onInstalled` and never read them back — so a profile that had ever lost them
 * stopped syncing rules and stopped pushing telemetry, silently and permanently, because nothing
 * else in the pipeline could tell the difference between "quiet" and "never scheduled".
 *
 * The repair reads the browser first, for the same reason `RulesetManager.sync` does: a schedule
 * that is already right costs nothing to confirm, and an alarm that was never created can only be
 * found by asking Chrome what it holds. `getAll()` is the reading; only the alarms that are missing
 * or scheduled on the wrong period are touched, so a working schedule is never churned.
 *
 * The pure half ({@link missingAlarms}) is separated from the `chrome.*` half for the usual reason:
 * what counts as "missing" is the decision, and it can be asserted without a browser.
 */

/** One entry of the schedule the extension wants to be running. */
export interface AlarmScheduleEntry {
  name: string;
  /** How often it should fire. Chrome stores this, so a difference is a schedule to repair. */
  periodInMinutes: number;
}

/** The alarm that re-fetches the compiled list from the hub. */
export const ALARM_PERIODIC_SYNC = 'bm-periodic-sync';
/** The alarm that reconciles the active tab and flushes the telemetry/ledger batch. */
export const ALARM_TELEMETRY_PUSH = 'bm-telemetry-push';

/**
 * Everything the extension wants scheduled. Minutes are the unit Chrome's API takes, and the sync
 * period is deliberately the same as the hub's own publish cadence rather than a "check often"
 * value: this is a localhost fetch of a multi-megabyte list.
 */
export const ALARM_SCHEDULE: readonly AlarmScheduleEntry[] = [
  { name: ALARM_PERIODIC_SYNC, periodInMinutes: 60 },
  { name: ALARM_TELEMETRY_PUSH, periodInMinutes: 2 },
];

/** The shape of an alarm as far as this module cares: a name and, if it repeats, a period. */
export interface ExistingAlarm {
  name: string;
  periodInMinutes?: number;
}

/**
 * The alarms the browser is not currently holding as the schedule asks.
 *
 * An alarm is missing when there is no alarm by that name at all, and also when there is one with
 * no `periodInMinutes` (a one-shot, which will never fire again once it has fired) or one on a
 * different period (a schedule changed in a later build, still running on the old cadence). Names
 * the extension does not own are ignored in both directions: another part of the extension, or a
 * later feature, may legitimately add one, and this function's job is to make its own schedule true.
 */
export function missingAlarms(
  existing: readonly ExistingAlarm[],
  schedule: readonly AlarmScheduleEntry[] = ALARM_SCHEDULE,
): AlarmScheduleEntry[] {
  const byName = new Map<string, ExistingAlarm>();
  for (const alarm of existing) {
    if (alarm && typeof alarm.name === 'string') byName.set(alarm.name, alarm);
  }

  return schedule.filter((entry) => {
    const found = byName.get(entry.name);
    if (!found) return true;
    // Chrome reports the period it is actually running on, so this is a reading rather than an
    // assumption; a one-shot alarm reports none at all and can never be enough.
    return typeof found.periodInMinutes !== 'number' || found.periodInMinutes !== entry.periodInMinutes;
  });
}

/**
 * Reads the browser's alarms and (re)creates the ones the schedule is missing.
 *
 * Returns the entries it recreated, both so a caller can log the repair and so a test can assert
 * that a schedule which was already correct produced no calls at all.
 *
 * Clearing before creating is what makes this a repair rather than a second alarm: `create()` with
 * an existing name replaces the alarm outright, but an explicit clear keeps the "fire from now"
 * semantics obvious and means a stale `periodInMinutes` cannot survive the re-creating call.
 */
export async function reconcileAlarms(
  schedule: readonly AlarmScheduleEntry[] = ALARM_SCHEDULE,
): Promise<AlarmScheduleEntry[]> {
  const alarms = (globalThis as { chrome?: typeof chrome }).chrome?.alarms;
  if (!alarms?.getAll || !alarms?.create) return [];

  let existing: ExistingAlarm[];
  try {
    existing = await alarms.getAll();
  } catch (err) {
    // No reading means no safe repair: clearing alarms that may already be correct would be worse
    // than leaving a schedule alone, and the next worker start will ask again.
    console.warn('[Alarms] Could not read the browser alarm list:', err);
    return [];
  }

  const recreated = missingAlarms(existing, schedule);
  for (const entry of recreated) {
    try {
      if (alarms.clear) await alarms.clear(entry.name);
      alarms.create(entry.name, { periodInMinutes: entry.periodInMinutes });
    } catch (err) {
      console.warn(`[Alarms] Could not schedule ${entry.name}:`, err);
    }
  }

  if (recreated.length > 0) {
    console.log(
      `[Alarms] Re-scheduled ${recreated.map((entry) => `${entry.name}/${entry.periodInMinutes}m`).join(', ')} — ` +
        `the browser was holding ${existing.length} alarm(s).`,
    );
  }

  return recreated;
}
