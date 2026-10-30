/**
 * Deploy target groups — the registry's vertical axis for Distribute's inner
 * list. Twelve targets can't share one tab strip, so the registry declares
 * which of three groups each belongs to and `deployTargetsByGroup()` hands the
 * view the grouped order. Also pinned here: the registry and routes.ts's
 * distribute tabs are ONE vocabulary — same ids, same labels — so the two
 * sources can never drift into two name sets for the same target.
 */

import { describe, expect, it } from '@jest/globals';
import {
  DEPLOY_GROUP_ORDER,
  DEPLOY_TARGETS,
  deployTargetsByGroup,
} from '../deploy/deployTargets';
import { sectionById } from '../routes';

describe('deployTargetsByGroup', () => {
  it('returns the three groups in fixed order', () => {
    expect(DEPLOY_GROUP_ORDER.map((g) => g.id)).toEqual(['dns', 'apps', 'local']);
    expect(deployTargetsByGroup().map((g) => g.id)).toEqual(['dns', 'apps', 'local']);
  });

  it('uses the design-doc group headings', () => {
    expect(DEPLOY_GROUP_ORDER.map((g) => g.label)).toEqual([
      'DNS & routers',
      'Apps & devices',
      'This Mac',
    ]);
  });

  it('assigns each group exactly its targets, in registry order', () => {
    const byId = Object.fromEntries(deployTargetsByGroup().map((g) => [g.id, g.targets]));
    expect(byId.dns.map((t) => t.id)).toEqual([
      'adguard-home',
      'pihole',
      'home-assistant',
      'dnsmasq',
      'unbound',
      'bind',
    ]);
    expect(byId.apps.map((t) => t.id)).toEqual([
      'browser-extension',
      'adguard-desktop',
      'shadowrocket',
      'privoxy',
    ]);
    expect(byId.local.map((t) => t.id)).toEqual(['system-daemon', 'hosts']);
  });

  it('places every target exactly once', () => {
    const placed = deployTargetsByGroup().flatMap((g) => g.targets.map((t) => t.id));
    expect(placed.sort()).toEqual(DEPLOY_TARGETS.map((t) => t.id).sort());
  });

  it('keeps targets as the same spec objects (pane wiring survives grouping)', () => {
    const pihole = deployTargetsByGroup()
      .flatMap((g) => g.targets)
      .find((t) => t.id === 'pihole');
    expect(pihole).toBe(DEPLOY_TARGETS.find((t) => t.id === 'pihole'));
  });
});

describe('registry ↔ routes vocabulary', () => {
  it("routes' distribute tabs are the registry ids plus 'network'", () => {
    expect(sectionById('distribute').tabs.map((t) => t.id)).toEqual([
      ...DEPLOY_TARGETS.map((t) => t.id),
      'network',
    ]);
  });

  it('registry labels match the routes tab labels — one name per target', () => {
    const routeLabels = new Map(sectionById('distribute').tabs.map((t) => [t.id, t.label]));
    for (const target of DEPLOY_TARGETS) {
      expect(routeLabels.get(target.id)).toBe(target.label);
    }
  });
});
