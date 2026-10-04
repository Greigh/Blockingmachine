/**
 * Live rehearsal for the Privoxy deploy recipe, against a real privoxy.
 *
 * `privoxyDeploy.ts` makes three claims a doc audit cannot settle: that an `actionsfile` line
 * naming a file in the confdir loads the compiled action file (and that the same directive
 * pointed at a *URL* loads nothing — Privoxy resolves it as a path and dies at startup), that
 * the last matching action wins so a `{-block}` section after the blocks releases the child it
 * names, and that the loaded file shows up in `show-status`. Flag 42 exists because "the manual
 * says so" was the only evidence ten recipes had; this suite is the daemon half for this one.
 *
 * A real privoxy is started on a loopback port with a scratch confdir holding an action file
 * emitted by the project's own formatter, plus brew's `templates/` so the CGI pages render.
 * What the proxy answers through `curl -x` is the whole finding:
 *
 *   blocked host           → the "Request blocked" page         (the {+block} section fired)
 *   allowed child          → the "no such domain" page          ({-block} last-match released it —
 *                                                             it went to DNS, not to the blocker)
 *   actionsfile <a URL>    → privoxy refuses to start           ("complete file names" fatal error)
 *   show-status            → lists the file name                (flag 19's check, on the CGI)
 *
 * Skips when `privoxy` is not installed, like the BIND and dnsmasq suites do: most contributors
 * and the CI runners do not have it, and the format contract is carried by the unit suites.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { generateFilterList, parseFilterList } from '@blockingmachine/core';
import { privoxyActionsFileDirective } from '../privoxyDeploy';

const privoxyBin = [
  '/opt/homebrew/sbin/privoxy',
  '/opt/homebrew/bin/privoxy',
  '/usr/local/sbin/privoxy',
].find(existsSync);
// The templates ship with the install, not the confdir copy we make — find them beside
// the real config so the CGI pages (blocked, no-such-domain, show-status) can render.
const templateDir = [
  '/opt/homebrew/etc/privoxy/templates',
  '/usr/local/etc/privoxy/templates',
].find(existsSync);
const curlBin = ['/usr/bin/curl', '/opt/homebrew/bin/curl'].find(existsSync);
const haveDaemons = Boolean(privoxyBin && templateDir && curlBin);

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

(haveDaemons ? describe : describe.skip)('the privoxy recipe, rehearsed on a live privoxy', () => {
  let daemon: ChildProcess | null = null;
  let port = 0;
  let dir = '';

  function page(host: string): string {
    return execFileSync(
      curlBin!,
      ['-s', '-x', `127.0.0.1:${port}`, `http://${host}/`],
      { encoding: 'utf8' },
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bm-privoxy-'));
    port = await freePort();
    // The action file is emitted by the same formatter the recipe ships — a blocked parent,
    // a blocked sibling, and an allowed child whose bypass must come *after* the block section.
    const rules = parseFilterList(
      '||ads.test^\n||parent.test^\n@@||child.parent.test^',
      'live',
    );
    const action = generateFilterList(rules, { name: 'live' } as never, 'privoxy');
    writeFileSync(join(dir, 'bm.action'), action);
    cpSync(templateDir!, join(dir, 'templates'), { recursive: true });
    writeFileSync(
      join(dir, 'config'),
      [
        `confdir ${dir}`,
        `logdir ${dir}`,
        // The recipe's own directive builder — a bare file name resolved inside the confdir.
        privoxyActionsFileDirective('bm.action'),
        'logfile log.txt',
        `listen-address 127.0.0.1:${port}`,
        '',
      ].join('\n'),
    );
    let stderr = '';
    daemon = spawn(privoxyBin!, ['--no-daemon', join(dir, 'config')]);
    daemon.stderr?.on('data', (d: Buffer) => (stderr += d));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) break;
      try {
        execFileSync(curlBin!, ['-s', '-x', `127.0.0.1:${port}`, 'http://config.privoxy.org/'], {
          encoding: 'utf8',
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    daemon?.kill('SIGKILL');
    throw new Error(`privoxy never answered:\n${stderr}`);
  }, 20_000);

  afterAll(() => {
    daemon?.kill('SIGKILL');
  });

  test('a blocked host gets the block page, not a connection attempt', () => {
    // `.ads.test` is under the {+block} section — Privoxy answers it itself.
    expect(page('ads.test')).toContain('Request blocked');
  });

  test('an allowed child escapes the parent block — the last matching action wins', () => {
    // `.child.parent.test` sits under {-block}, emitted *after* the block section — the request
    // reaches DNS, and `.test` resolves nowhere, so the answer is the resolver-failure page.
    // If ordering were wrong this would be the "Request blocked" page instead.
    const body = page('child.parent.test');
    expect(body).toContain('No such Domain');
    expect(body).not.toContain('Request blocked');
    // The blocked sibling still blocks — the bypass did not un-block the whole tree.
    expect(page('other.parent.test')).toContain('Request blocked');
  });

  test('the loaded action file is listed in show-status', () => {
    // Flag 19's verify: the CGI reports which action files it parsed — ours is on the list.
    expect(
      execFileSync(
        curlBin!,
        ['-s', '-x', `127.0.0.1:${port}`, 'http://config.privoxy.org/show-status'],
        { encoding: 'utf8' },
      ),
    ).toContain('bm.action');
  });
});

(haveDaemons ? describe : describe.skip)('a URL in actionsfile loads nothing — privoxy refuses to start', () => {
  test('the feed-address deployment is fatal, on the daemon', () => {
    // The recipe's counter-example: `actionsfile http://host/feed` reads as plausible but is
    // resolved as a *file name* inside the confdir — the startup fatal names it verbatim.
    const deadDir = mkdtempSync(join(tmpdir(), 'bm-privoxy-url-'));
    writeFileSync(
      join(deadDir, 'config'),
      [
        `confdir ${deadDir}`,
        `logdir ${deadDir}`,
        privoxyActionsFileDirective('http://127.0.0.1:1/never.fetches'),
        'logfile log.txt',
        'listen-address 127.0.0.1:1',
        '',
      ].join('\n'),
    );
    let out = '';
    try {
      execFileSync(privoxyBin!, ['--no-daemon', join(deadDir, 'config')], {
        encoding: 'utf8',
        timeout: 8_000,
      });
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? '') +
        String((err as { stderr?: string }).stderr ?? '') +
        String(err);
    }
    const log = existsSync(join(deadDir, 'log.txt'))
      ? readFileSync(join(deadDir, 'log.txt'), 'utf8')
      : '';
    expect(out + log).toMatch(/can't load actions file.*http/);
  });
});
