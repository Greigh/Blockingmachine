/**
 * JS surface for the iOS on-device filtering VPN (`modules/local-tunnel` +
 * `targets/BlockingmachineTunnel`). `NEPacketTunnelProvider` is the standard
 * Network Extensions route — `packet-tunnel-provider` needs no Apple grant,
 * unlike the `dns-proxy` entitlement flag 89 waits on — so this is the
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
    // saveToPreferences failures surface as bare NEError strings — name the
    // consent + profile context the failure actually means.
    const detail = e instanceof Error ? ` (${e.message})` : '';
    throw new UserError(
      `The system refused the VPN configuration${detail} — the first enable asks for "Add VPN Configuration" consent, and the filter needs a device (not the Simulator).`,
    );
  }
}
