/**
 * JS surface for the app-group bridge module (`modules/local-dns-proxy`).
 * The name survives the flag-89 removal — `NEDNSProxyProvider` was deleted
 * because Apple only runs it on supervised/MDM devices (TN3134) — but the
 * module's real job was always the shared-container channel:
 * `publishRuleset` lands `ruleset_native.txt` where the packet-tunnel
 * extension reads it, and `drainObservations` pulls the appex's
 * shadow-observation stream back out for upload to the hub.
 *
 * Every call degrades gracefully: on Android (or a dev client built without
 * the pod) the module is absent and these become honest no-ops/false answers.
 */

import { Platform } from 'react-native';

interface LocalDnsProxyNative {
  publishRuleset(sourcePath: string): Promise<number>;
  drainObservations(): Promise<string>;
}

let cached: LocalDnsProxyNative | null | undefined;

function native(): LocalDnsProxyNative | null {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('../../modules/local-dns-proxy/src').default as LocalDnsProxyNative;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Mirrors `ruleset_native.txt` into the app-group container the extension reads. */
export async function publishDnsProxyRuleset(sourcePath: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await native()?.publishRuleset(sourcePath);
  } catch {
    // No app-group entitlement (unsigned/sim builds) — filtering just won't
    // see rules; not worth failing a ruleset sync over.
  }
}

/**
 * Read-and-clear the packet tunnel's shadow-observation stream from the app
 * group — the JSONL `DnsObservationRecord`s the extension appended while
 * answering queries. "" when the module, the group, or the stream is absent.
 */
export async function drainTunnelObservations(): Promise<string> {
  if (Platform.OS !== 'ios') return '';
  try {
    return (await native()?.drainObservations()) ?? '';
  } catch {
    return '';
  }
}
