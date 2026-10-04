/**
 * The direct-mode warning, shared between Settings and the Deploy Hub's AdGuard Home pane.
 *
 * The warning exists because direct mode fails quietly in two ways — an address that is really
 * Home Assistant's web frontend (port 8123, or an HA UI path), or a Nabu Casa cloud URL, which
 * only proxies HA itself. The banner used to live only in Settings, so the pane offered the same
 * URL field without it; the markup is now one component both render, and the component computes
 * the warning itself so the two surfaces cannot disagree about when it shows.
 *
 * The sharing is pinned at the source level: `Settings.tsx` and `AdGuardHomePane.tsx` must each
 * render `<AdGuardDirectWarning`, and neither may re-inline the amber banner — a copied div would
 * render the same and drift silently.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdGuardDirectWarning } from '../components/AdGuardDirectWarning';

const render = (url: string, port = 3000): string =>
  renderToStaticMarkup(createElement(AdGuardDirectWarning, { url, port }));

describe('the shared direct-mode warning banner', () => {
  it('warns when the URL is the Home Assistant web frontend, naming the port to map', () => {
    const markup = render('http://homeassistant.local:8123');
    expect(markup).toContain('Port 8123 is the Home Assistant web interface, not AdGuard Direct');
    expect(markup).toContain('http://homeassistant.local:3000');
  });

  it('warns when the URL is a Nabu Casa cloud address', () => {
    const markup = render('https://some-instance.ui.nabu.casa');
    expect(markup).toContain('Nabu Casa');
    expect(markup).toContain('3000');
  });

  it('renders nothing for a plausible direct address, or none', () => {
    expect(render('http://192.168.8.1:3000')).toBe('');
    expect(render('')).toBe('');
  });

  it('is the only place the amber banner lives', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const settings = readFileSync(join(root, 'src/Settings.tsx'), 'utf8');
    const pane = readFileSync(join(root, 'src/deploy/panes/AdGuardHomePane.tsx'), 'utf8');
    for (const [name, source] of [
      ['Settings.tsx', settings],
      ['AdGuardHomePane.tsx', pane],
    ]) {
      if (!source.includes('<AdGuardDirectWarning')) {
        throw new Error(`${name} does not render the shared component`);
      }
    }
    // The banner's signature inline style — if it appears outside the component, the markup has
    // been duplicated and can drift.
    const signature = 'rgba(245, 158, 11, 0.15)';
    expect(settings).not.toContain(signature);
    expect(pane).not.toContain(signature);
    const component = readFileSync(join(root, 'src/components/AdGuardDirectWarning.tsx'), 'utf8');
    expect(component).toContain(signature);
  });
});
