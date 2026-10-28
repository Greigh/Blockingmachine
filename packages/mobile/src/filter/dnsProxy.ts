/**
 * JS surface for the iOS system-DNS proxy (`modules/local-dns-proxy` +
 * `ios/BlockingmachineDNSProxy`). `NEDNSProxyProvider` gives the extension every
 * cleartext system DNS flow — device-wide filtering without a VPN tunnel.
 *
 * Every call degrades gracefully: on Android (or a dev client built without
 * the pod) the module is absent and these become honest no-ops/false answers.
 */

import { Platform } from 'react-native';
import { UserError } from '../errors';

export interface DnsProxyStatus {
  /** The manager's saved config points at our extension bundle id. */
  installed: boolean;
  /** The saved `isEnabled` flag — the OS prompt gates the first `true`. */
  enabled: boolean;
}

interface LocalDnsProxyNative {
  getStatus(): Promise<DnsProxyStatus>;
  setEnabled(enabled: boolean): Promise<void>;
  publishRuleset(sourcePath: string): Promise<number>;
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

export function isDnsProxySupported(): boolean {
  return Platform.OS === 'ios' && native() !== null;
}

export async function getDnsProxyStatus(): Promise<DnsProxyStatus> {
  return (await native()?.getStatus()) ?? { installed: false, enabled: false };
}

export async function setDnsProxyEnabled(enabled: boolean): Promise<void> {
  const m = native();
  if (!m) throw new Error('LocalDnsProxy native module is unavailable on this platform');
  try {
    await m.setEnabled(enabled);
  } catch (e) {
    // saveToPreferences failures surface as bare NEError strings ("IPC
    // failed") — the useful context is what that means for this feature.
    const detail = e instanceof Error ? ` (${e.message})` : '';
    throw new UserError(
      `The system refused the DNS proxy configuration${detail} — device-wide DNS needs Apple's Network Extension entitlement on the app's provisioning profile, and doesn't run in the Simulator.`,
    );
  }
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
