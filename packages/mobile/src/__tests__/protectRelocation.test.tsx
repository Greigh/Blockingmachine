/**
 * Task 3 relocation audit — the this-phone filtering cards moved out of the
 * Settings scroll into the Protect tab. Source-level pins because the cards
 * exercise native modules that jest cannot host; the scan is the contract
 * that nothing was stranded or duplicated.
 */

import * as fs from 'fs';
import * as path from 'path';

const pkgRoot = path.resolve(__dirname, '..', '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8');

const protectSrc = readSrc('app/(tabs)/protect.tsx');
const settingsSrc = readSrc('app/settings.tsx');
const layoutSrc = readSrc('app/(tabs)/_layout.tsx');

const MOVED_CARDS = [
  'LocalFilterCard',
  'HttpsCaptureCard',
  'IosTunnelCard',
  'IosHubFilterCard',
  'LocalDnsCard',
  'PerAppBypassCard',
  'StandaloneFilterCard',
];

describe('Protect tab relocation', () => {
  it('defines every moved this-phone card', () => {
    for (const card of MOVED_CARDS) {
      expect(protectSrc).toContain(`function ${card}(`);
    }
  });

  it('mounts the cards under the platform gates they had in Settings', () => {
    expect(protectSrc).toContain('isLocalVpnSupported() ? <LocalFilterCard');
    expect(protectSrc).toContain('isLocalVpnSupported() ? <HttpsCaptureCard');
    expect(protectSrc).toContain('isLocalVpnSupported() ? <PerAppBypassCard');
    expect(protectSrc).toContain('isIosTunnelSupported() ? <IosTunnelCard');
    expect(protectSrc).toContain("Platform.OS === 'ios' ? <IosHubFilterCard");
    expect(protectSrc).toContain('<LocalDnsCard');
    expect(protectSrc).toContain('<StandaloneFilterCard');
  });

  it('settings keeps none of the moved identifiers', () => {
    for (const card of MOVED_CARDS) {
      expect(settingsSrc).not.toContain(card);
    }
  });

  it('both screens share the one StyleSheet', () => {
    expect(protectSrc).toContain('screenStyles');
    expect(settingsSrc).toContain('screenStyles');
    expect(protectSrc).not.toContain('StyleSheet.create');
    expect(settingsSrc).not.toContain('StyleSheet.create');
  });

  it('the protect tab is wired into the tab layout', () => {
    expect(layoutSrc).toContain('tab.route');
    const routes = readSrc('src/routes.ts');
    expect(routes).toContain("'protect'");
  });
});
