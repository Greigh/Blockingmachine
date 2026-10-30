/**
 * Flag-43 mobile intake: the packet tunnel appends one DnsObservationRecord
 * per answered DNS query into the app-group `dns-observations.jsonl`. This
 * module drains that stream, buffers the records locally (bounded — they are
 * statistical evidence, not a ledger), and POSTs them to the paired hub's
 * `/v1/shadow/observations`, where the learned-model shadow scorer compares
 * each domain's production verdict with the candidate model's. Standalone
 * phones accrue the same backlog and flush it when a hub gets paired.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BlockingmachineClient } from '../api/client';
import type { ShadowObservationRecord } from '../api/types';
import { drainTunnelObservations } from './dnsProxy';

const BUFFER_KEY = '@blockingmachine/shadow-observations';
/** Fresh traffic outranks backlog — oldest records drop first at the cap. */
const BUFFER_MAX = 2000;
/** The hub route accepts at most 500 records per POST. */
const BATCH_SIZE = 500;

function parseObservationLines(body: string): ShadowObservationRecord[] {
  const out: ShadowObservationRecord[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as ShadowObservationRecord;
      if (typeof rec?.domain === 'string' && rec.domain.length > 0) out.push(rec);
    } catch {
      // Torn line — the extension may have been mid-append at drain time.
    }
  }
  return out;
}

async function readBuffer(): Promise<ShadowObservationRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(BUFFER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeBuffer(records: ShadowObservationRecord[]): Promise<void> {
  try {
    await AsyncStorage.setItem(BUFFER_KEY, JSON.stringify(records));
  } catch {
    /* best-effort persistence */
  }
}

/**
 * Drain the extension's stream into the local buffer. Returns how many
 * records are pending upload — the count the UI reports.
 */
export async function collectObservations(): Promise<number> {
  const body = await drainTunnelObservations();
  const fresh = parseObservationLines(body);
  if (fresh.length === 0) return (await readBuffer()).length;
  const merged = (await readBuffer()).concat(fresh);
  const trimmed = merged.slice(Math.max(0, merged.length - BUFFER_MAX));
  await writeBuffer(trimmed);
  return trimmed.length;
}

/**
 * Drain, then upload pending records to the hub in ≤500-record batches.
 * On any failure the unsent remainder stays buffered for the next tick —
 * the appex keeps accruing either way.
 */
let reportInFlight = false;

export async function reportObservations(
  client: BlockingmachineClient | null,
): Promise<{ pending: number; posted: number }> {
  // 60s tick + AppState + effect re-run can overlap — a second run would
  // double-POST a batch and clobber records the first appended.
  if (reportInFlight) return { pending: -1, posted: 0 };
  reportInFlight = true;
  try {
    const pending = await collectObservations();
    if (!client) return { pending, posted: 0 };
    let buffer = await readBuffer();
    let posted = 0;
    while (buffer.length > 0) {
      const batch = buffer.slice(0, BATCH_SIZE);
      const res = await client.postShadowObservations(batch);
      if (res.success === false) break; // hub refused — retry next tick
      buffer = buffer.slice(batch.length);
      posted += batch.length;
      await writeBuffer(buffer);
    }
    return { pending: buffer.length, posted };
  } finally {
    reportInFlight = false;
  }
}
