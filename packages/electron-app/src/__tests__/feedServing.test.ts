/**
 * Unit tests for `feedServing.ts` — the feed-server's servable-name allowlist.
 *
 * The route used to accept any `basename(pathname)`, so `GET /config.yaml` or
 * `GET /../package.json` served whatever non-hidden file shared the output directory. These pin
 * the contract: compiled feed artifacts serve, everything else is refused, and traversal
 * components can never smuggle a name past the check because the route only ever sees a
 * basename.
 */

import { describe, test, expect } from '@jest/globals';
import { isServableFeedFile } from '../feedServing';

const SAVE_NAME = 'processed_rules.txt';

describe('isServableFeedFile', () => {
  test('serves the segregated feed artifacts', () => {
    for (const name of [
      'browser.txt',
      'adguardBrowser.txt',
      'dns.txt',
      'adguardDns.txt',
      'malware.txt',
      'hotlist.txt',
      'filter-list.txt',
      'hosts.txt',
    ]) {
      expect(isServableFeedFile(name, SAVE_NAME)).toBe(true);
    }
  });

  test('serves the configured savePath basename', () => {
    expect(isServableFeedFile('my-export.txt', 'my-export.txt')).toBe(true);
  });

  test('serves the multi-format processed_ family with a known extension', () => {
    for (const name of [
      'processed_rules.txt',
      'processed_adguard.txt',
      'processed_dnsmasq.conf',
      'processed_privoxy.action',
      'processed_bind.rpz',
    ]) {
      expect(isServableFeedFile(name, SAVE_NAME)).toBe(true);
    }
  });

  test('refuses non-feed files that share the output directory', () => {
    for (const name of [
      'config.yaml',
      'blockmachine.config.yaml',
      'package.json',
      'tsconfig.json',
      'manifest.json',
      'mini-ai-verdicts.json',
      'notes.txt',
      'processed_backup.pem',
      'processed_secrets.key',
    ]) {
      expect(isServableFeedFile(name, SAVE_NAME)).toBe(false);
    }
  });

  test('refuses hidden and empty names', () => {
    expect(isServableFeedFile('.env', SAVE_NAME)).toBe(false);
    expect(isServableFeedFile('.config', SAVE_NAME)).toBe(false);
    expect(isServableFeedFile('', SAVE_NAME)).toBe(false);
    expect(isServableFeedFile('..', SAVE_NAME)).toBe(false);
  });

  test('matches the save name case-insensitively like the routes do', () => {
    expect(isServableFeedFile('Processed_Rules.TXT', 'processed_rules.txt')).toBe(true);
  });

  test('does not serve a name merely for ending like the save name', () => {
    expect(isServableFeedFile('old_processed_rules.txt', SAVE_NAME)).toBe(false);
  });
});
