import { requireNativeModule } from 'expo';

interface LocalDnsProxyNative {
  publishRuleset(sourcePath: string): Promise<number>;
  drainObservations(): Promise<string>;
}

const mod = requireNativeModule<LocalDnsProxyNative>('LocalDnsProxy');
export default mod;
