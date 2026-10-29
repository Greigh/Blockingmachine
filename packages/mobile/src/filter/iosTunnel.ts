/**
 * JS surface for the iOS on-device filtering VPN (`modules/local-tunnel` +
 * `targets/BlockingmachineTunnel`). `NEPacketTunnelProvider` is the standard
 * Network Extensions route — `packet-tunnel-provider` runs on consumer
 * devices, unlike flag 89's `NEDNSProxyProvider` (supervised/MDM-only per
 * TN3134) — so this is the standalone path today. iOS 26 adds an
 * unrestricted `url-filter-provider` to the same table — the eventual route
 * past DNS-only filtering.
 *
 *
 * standalone filter path that ships on TestFlight today.
 *
 * Every call degrades gracefully: off iOS (or a build without the module)
 * these become honest no-ops/false answers.
 */

import { Platform } from 'react-native';
import { UserError } from '../errors';

export interface IosTunnelStatus {
  /** A saved VPN configuration points at our extension bundle id. */
  installed: boolean;
  /** The saved `isEnabled` flag — the OS consent prompt gates the first true. */
  enabled: boolean;
  /** NEVPNStatus mapped to a string (connected/connecting/disconnected/…). */
  connection: string;
}

interface LocalTunnelNative {
  getStatus(): Promise<{
    installed: boolean;
    enabled: boolean;
    connection: string;
  }>;
  setEnabled(enabled: boolean): Promise<void>;
}

let cached: LocalTunnelNative | null | undefined;

function native(): LocalTunnelNative | null {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('../../modules/local-tunnel/src').default as LocalTunnelNative;
    } catch {
      cached = null;
    }
  }
  return cached;
}

export function isIosTunnelSupported(): boolean {
  return Platform.OS === 'ios' && native() !== null;
}

export async function getIosTunnelStatus(): Promise<IosTunnelStatus> {
  return (
    (await native()?.getStatus()) ?? {
      installed: false,
      enabled: false,
      connection: 'absent',
    }
  );
}

export async function setIosTunnelEnabled(enabled: boolean): Promise<void> {
  const m = native();
  if (!m) throw new Error('LocalTunnel native module is unavailable on this platform');
  try {
    await m.setEnabled(enabled);
  } catch (e) {
    // NEError strings arrive bare — the common honest causes are consent
    // declined at the "Add VPN Configuration" prompt, the profile deleted in
    // Settings, or a Simulator run (Network Extension needs a device).
    const detail = e instanceof Error ? ` (${e.message})` : '';
    throw new UserError(
      `The system refused the VPN configuration${detail} — grant the "Add VPN Configuration" consent if prompted; the filter needs a device, not the Simulator.`,
    );
  }
}
