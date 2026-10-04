/**
 * The Deploy Hub target registry.
 *
 * The tab strip used to be nine hand-written buttons and the panes nine `activeTab === '…'` guards,
 * with nothing tying the two together. The registry makes the list data; these tests pin the data
 * (ids, labels, order, pane, helpers) and pin that the Hub still answers to it — the panes moved
 * into `deploy/panes/`, and what replaced the `never` default is a required `pane` field, so a
 * target cannot be declared without something that renders it. The build proves that half; the
 * runtime half is what the last two tests check.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
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
const registrySource = readFileSync(join(appRoot, 'src/deploy/deployTargets.tsx'), 'utf8');
const paneModules = readdirSync(join(appRoot, 'src/deploy/panes')).filter((name) =>
  name.endsWith('.tsx'),
);

/**
 * The order the tabs appear in, pinned so a reorder is a deliberate edit rather than a diff nobody
 * notices — it is user-facing.
 */
const EXPECTED_ORDER = [
  'browser-extension',
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

  it('gives every target a pane, and each pane exactly one tab', () => {
    for (const target of DEPLOY_TARGETS) {
      // A pane that is not a function is a target whose tab opens onto nothing. This is the
      // runtime echo of the required `pane` field the compiler enforces on the entry type.
      expect(typeof target.pane).toBe('function');
      expect(target.pane.name.length).toBeGreaterThan(0);
    }
    // Two targets sharing one renderer would be one screen reachable from two tabs, which is the
    // one thing a per-target pane is supposed to rule out.
    const names = DEPLOY_TARGETS.map((target) => target.pane.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is the one place a tab is defined: the Hub names no platform at all', () => {
    // The strip compares `activeTab === target.id`, and the pane comes from the entry. Every
    // comparison of the active tab has to be against the registry's own id — a second one, against a
    // literal, is a platform reintroduced by hand beside the list that is supposed to own it.
    const comparisons = hubSource.match(/activeTab ===/g) ?? [];
    expect(comparisons.length).toBeGreaterThan(0);
    expect(hubSource.match(/activeTab === target\.id/g) ?? []).toHaveLength(comparisons.length);

    // And there is no dispatch left to keep in step: no per-platform arm, and the pane comes from
    // the entry rather than from a branch on the id.
    expect(hubSource).not.toContain("case '");
    expect(hubSource).toContain('activeTarget.pane(pickPaneProps(paneProps, activeTarget.paneKeys))');

    for (const target of DEPLOY_TARGETS) {
      // The pairing is declared once, as data: one id, one pane, both on the same entry.
      expect(registrySource.match(new RegExp(`id: '${target.id}',`, 'g'))).toHaveLength(1);
      expect(hubSource).not.toContain(`activeTab === '${target.id}'`);
    }
  });

  it('has one pane module per target, and no pane module without a tab', () => {
    for (const target of DEPLOY_TARGETS) {
      expect(registrySource).toContain(`pane: ${target.pane.name},`);
    }

    // A pane file nothing points at is either a target that was never registered — the gap this
    // registry exists to prevent — or a leftover from a rename. Read each module's own declaration
    // rather than trusting the file list, so a renamed export fails here too.
    const declared = paneModules.flatMap((name) =>
      [...readFileSync(join(appRoot, 'src/deploy/panes', name), 'utf8').matchAll(
        /export const (render\w+)\b/g,
      )].map((match) => match[1]!),
    );
    expect(declared.sort()).toEqual(DEPLOY_TARGETS.map((target) => target.pane.name).sort());
  });
});
