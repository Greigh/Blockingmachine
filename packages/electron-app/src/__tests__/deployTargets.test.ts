/**
 * The Deploy Hub target registry.
 *
 * The tab strip used to be nine hand-written buttons and the panes nine `activeTab === '…'` guards,
 * with nothing tying the two together. The registry makes the list data; these tests pin the data
 * (ids, labels, order, helpers) and pin that the pane dispatch still answers to it at runtime — the
 * compile-time half is the `never` default in `DeployHubView`, which is proved by the build rather
 * than here.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  DEFAULT_DEPLOY_TARGET_ID,
  DEPLOY_TARGETS,
  deployTargetById,
  isDeployTargetId,
} from '../deploy/deployTargets';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const hubSource = readFileSync(join(appRoot, 'src/views/DeployHubView.tsx'), 'utf8');

/**
 * The order the tabs appear in, pinned so a reorder is a deliberate edit rather than a diff nobody
 * notices — it is user-facing.
 */
const EXPECTED_ORDER = [
  'adguard-home',
  'pihole',
  'home-assistant',
  'system-daemon',
  'adguard-desktop',
  'hosts',
  'dnsmasq',
  'unbound',
  'shadowrocket',
  'privoxy',
  'bind',
];

describe('Deploy Hub target registry', () => {
  it('declares each target once, in the pinned tab order', () => {
    expect(DEPLOY_TARGETS.map((target) => target.id)).toEqual(EXPECTED_ORDER);
    expect(new Set(DEPLOY_TARGETS.map((target) => target.id)).size).toBe(DEPLOY_TARGETS.length);
  });

  it('gives every target a distinct, non-empty label and summary', () => {
    const labels = DEPLOY_TARGETS.map((target) => target.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const target of DEPLOY_TARGETS) {
      expect(target.label.trim().length).toBeGreaterThan(0);
      // The summary is the tab's tooltip, so an empty one is a dead tooltip.
      expect(target.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('renders a real icon for every target', () => {
    for (const target of DEPLOY_TARGETS) {
      expect(target.icon).toBeTruthy();
      const markup = renderToStaticMarkup(createElement('span', null, target.icon));
      // A broken or missing path would render an empty <svg> and a blank tab.
      expect(markup).toContain('<svg');
      expect(markup.length).toBeGreaterThan('<svg></svg>'.length);
    }
  });

  it('opens on a target that exists', () => {
    expect(isDeployTargetId(DEFAULT_DEPLOY_TARGET_ID)).toBe(true);
  });

  it('resolves ids exactly, and refuses anything else rather than guessing', () => {
    for (const target of DEPLOY_TARGETS) {
      expect(deployTargetById(target.id)).toBe(target);
    }
    expect(deployTargetById('not-a-target')).toBeUndefined();
    expect(deployTargetById('')).toBeUndefined();
    expect(deployTargetById(null)).toBeUndefined();
    expect(deployTargetById(undefined)).toBeUndefined();

    expect(isDeployTargetId('not-a-target')).toBe(false);
    expect(isDeployTargetId(null)).toBe(false);
    expect(isDeployTargetId(7)).toBe(false);
  });

  it('keeps side effects on the target that needs live state, and nowhere else', () => {
    const withEffects = DEPLOY_TARGETS.filter((target) => target.selectEffect);
    expect(withEffects.map((target) => target.id)).toEqual(['system-daemon']);
  });

  it('is the one place a tab is defined: no per-target id literal is left in the Hub markup', () => {
    // The strip compares `activeTab === target.id`; a literal comparison in a JSX guard would mean
    // the tab list had grown a hand-written branch again instead of reading the registry.
    expect(hubSource).not.toContain("{activeTab === '");

    // And each pane is dispatched by a case named for its registry id — the runtime echo of the
    // compile-time exhaustiveness check, so a rename that upstream forgets is caught here too.
    for (const target of DEPLOY_TARGETS) {
      expect(hubSource).toContain(`case '${target.id}':`);
    }
  });
});
