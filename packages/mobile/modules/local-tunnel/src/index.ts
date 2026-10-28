import { requireNativeModule } from 'expo';

export interface TunnelStatus {
  installed: boolean;
  enabled: boolean;
  /** NEVPNStatus: absent | connected | connecting | reasserting | disconnecting | disconnected | invalid */
  connection: string;
}

interface LocalTunnelNative {
  getStatus(): Promise<TunnelStatus>;
  setEnabled(enabled: boolean): Promise<void>;
}

const mod = requireNativeModule<LocalTunnelNative>('LocalTunnel');
export default mod;
