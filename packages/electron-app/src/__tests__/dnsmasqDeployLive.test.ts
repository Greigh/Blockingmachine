/**
 * Live rehearsal for the dnsmasq deploy recipe, against a real dnsmasq.
 *
 * `dnsmasqDeploy.ts` makes one claim that a doc audit cannot settle: that fetching a *hosts file*
 * and running `reload` lands new blocks, while a conf-dir drop-in followed by the same `reload`
 * is inert — because SIGHUP re-reads `addn-hosts`/`hostsdir` inputs and never the configuration.
 * Flag 42 exists because "the manual says so" was the only evidence ten recipes had; this suite
 * is the daemon half for the one that is cheap to run.
 *
 * A real dnsmasq is started on a loopback port with both inputs pointed at a scratch directory,
 * then the suite adds a name to each *after* startup and sends SIGHUP — the exact operation the
 * recipe's cron performs. What answers and what does not is the whole finding:
 *
 *   addn-hosts name   → 0.0.0.0   (the reload re-read it — the recipe's mechanism works)
 *   conf-dir name     → nothing   (the reload never saw it — the retired recipe was inert)
 *
 * Skips when `dnsmasq` is not installed, like the BIND suite does: most contributors and the CI
 * runners do not have it, and the format contract is carried by the unit suites either way.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dnsmasqAddnHostsDirective } from '../dnsmasqDeploy';

const dnsmasqDirs = ['/opt/homebrew/opt/dnsmasq/sbin', '/opt/homebrew/sbin', '/usr/sbin', '/usr/local/sbin'];
const dnsmasqBin = dnsmasqDirs.map((dir) => join(dir, 'dnsmasq')).find(existsSync);
const digBin = ['/opt/homebrew/opt/bind/bin/dig', '/opt/homebrew/bin/dig', '/usr/bin/dig'].find(existsSync);
const haveDaemons = Boolean(dnsmasqBin && digBin);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

(haveDaemons ? describe : describe.skip)('the dnsmasq recipe, rehearsed on a live dnsmasq', () => {
  let daemon: ChildProcess | null = null;
  let port = 0;
  let dir = '';

  function answer(name: string): string {
    return execFileSync(
      digBin!,
      ['@127.0.0.1', '-p', String(port), '+time=2', '+tries=1', '+short', name, 'A'],
      { encoding: 'utf8' },
    ).trim();
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bm-dnsmasq-'));
    mkdirSync(join(dir, 'conf.d'));
    // The two inputs the recipe distinguishes: a hosts-format file behind `addn-hosts` (what the
    // recipe fetches and reloads), and a conf-dir drop-in (what the retired recipe fetched into).
    writeFileSync(join(dir, 'block.hosts'), '0.0.0.0 ads.example.com\n');
    writeFileSync(join(dir, 'conf.d', 'drop.conf'), 'address=/confblocked.example.net/0.0.0.0\n');
    // `dnsmasqAddnHostsDirective` is the recipe's own directive builder — the rehearsal loads
    // the file through the same line the pane tells the user to install.
    writeFileSync(
      join(dir, 'dnsmasq.conf'),
      [
        'no-resolv',
        'no-daemon',
        `port=${port = await freePort()}`,
        'listen-address=127.0.0.1',
        dnsmasqAddnHostsDirective(join(dir, 'block.hosts')),
        `conf-dir=${join(dir, 'conf.d')}`,
        '',
      ].join('\n'),
    );
    let stderr = '';
    daemon = spawn(dnsmasqBin!, ['-C', join(dir, 'dnsmasq.conf'), '-d']);
    daemon.stderr?.on('data', (d: Buffer) => (stderr += d));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) break;
      try {
        answer('ads.example.com');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    daemon?.kill('SIGKILL');
    throw new Error(`dnsmasq never answered:\n${stderr}`);
  }, 20_000);

  afterAll(() => {
    daemon?.kill('SIGKILL');
  });

  test('the recipe inputs answer before anything reloads', () => {
    // Baseline: the addn-hosts name and the startup conf-dir name both sink — the rig is sane.
    expect(answer('ads.example.com')).toBe('0.0.0.0');
    expect(answer('confblocked.example.net')).toBe('0.0.0.0');
  });

  test('SIGHUP applies a new hosts-file name and ignores a new conf-dir name', async () => {
    // The recipe's cron, verbatim: fetch a fresh hosts file, then `reload`. The conf-dir file is
    // what the retired recipe fetched instead — both are added after startup, one SIGHUP.
    appendFileSync(join(dir, 'block.hosts'), '0.0.0.0 newblocked.example.com\n');
    writeFileSync(join(dir, 'conf.d', 'late.conf'), 'address=/newconf.example.net/0.0.0.0\n');
    daemon!.kill('SIGHUP');
    await new Promise((r) => setTimeout(r, 700));

    // The claim the manual could only assert: the addn-hosts re-read happened.
    expect(answer('newblocked.example.com')).toBe('0.0.0.0');
    // And the counter-claim that made the conf-dir recipe inert: the late drop-in is unseen.
    expect(answer('newconf.example.net')).toBe('');
  });
});
