import { requireNativeModule } from 'expo';

export interface DnsProxyStatus {
  installed: boolean;
  enabled: boolean;
}

interface LocalDnsProxyNative {
  getStatus(): Promise<DnsProxyStatus>;
  setEnabled(enabled: boolean): Promise<void>;
  publishRuleset(sourcePath: string): Promise<number>;
}

const mod = requireNativeModule<LocalDnsProxyNative>('LocalDnsProxy');
export default mod;
