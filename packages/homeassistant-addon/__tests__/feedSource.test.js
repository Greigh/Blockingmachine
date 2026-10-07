/**
 * Feed-source pull: the add-on's path from "baseline forever" to serving the
 * desktop's compiled feeds. The contract that matters: a bad response must
 * never overwrite a published feed — a proxy login page or an empty body is
 * worse than a stale ruleset because it makes a working install look empty.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyLooksLikeFeed, pullFeeds, FEED_FILES } from '../feedSource.js';

const SAMPLE_DNS = '# dns feed\n0.0.0.0 ads.example.com\n0.0.0.0 tracker.example.com\n';
const SAMPLE_BROWSER = '||ads.example.com^\n@@||allowed.example.com^\n';

function fakeFetch(bodies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const file = url.split('/').pop();
    const body = bodies[file];
    if (body === undefined) return { ok: false, status: 404, text: async () => '404: Not Found' };
    return { ok: true, status: 200, text: async () => body };
  };
  return { impl, calls };
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'bm-feedsource-'));
}

test('pullFeeds writes both feeds into the data dir', async () => {
  const dataDir = tmpDir();
  const { impl } = fakeFetch({ 'dns.txt': SAMPLE_DNS, 'browser.txt': SAMPLE_BROWSER });
  const res = await pullFeeds({ sourceUrl: 'http://hub.local:9191', dataDir, fetchImpl: impl });
  assert.deepEqual(res.pulled, FEED_FILES);
  assert.deepEqual(res.errors, []);
  assert.equal(await fs.readFile(join(dataDir, 'dns.txt'), 'utf8'), SAMPLE_DNS);
  assert.equal(await fs.readFile(join(dataDir, 'browser.txt'), 'utf8'), SAMPLE_BROWSER);
});

test('pullFeeds sends the source token as Bearer auth', async () => {
  const dataDir = tmpDir();
  const { impl, calls } = fakeFetch({ 'dns.txt': SAMPLE_DNS, 'browser.txt': SAMPLE_BROWSER });
  await pullFeeds({ sourceUrl: 'http://hub.local:9191/', token: 'secret', dataDir, fetchImpl: impl });
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer secret');
  }
});

test('a non-OK response reports an error and writes nothing', async () => {
  const dataDir = tmpDir();
  const { impl } = fakeFetch({ 'dns.txt': SAMPLE_DNS }); // browser.txt 404s
  const res = await pullFeeds({ sourceUrl: 'http://hub.local:9191', dataDir, fetchImpl: impl });
  assert.deepEqual(res.pulled, ['dns.txt']);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /browser\.txt.*HTTP 404/);
  await assert.rejects(fs.stat(join(dataDir, 'browser.txt')));
});

test('an HTML error page is refused — the published feed is not overwritten', async () => {
  const dataDir = tmpDir();
  const existing = '0.0.0.0 keepme.example.com\n';
  await fs.writeFile(join(dataDir, 'dns.txt'), existing, 'utf8');
  const { impl } = fakeFetch({
    'dns.txt': '<html><body>Please log in</body></html>',
    'browser.txt': SAMPLE_BROWSER,
  });
  const res = await pullFeeds({ sourceUrl: 'http://hub.local:9191', dataDir, fetchImpl: impl });
  assert.deepEqual(res.pulled, ['browser.txt']);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /no usable rules/);
  assert.equal(await fs.readFile(join(dataDir, 'dns.txt'), 'utf8'), existing);
});

test('bodyLooksLikeFeed accepts comment-bearing feeds and rejects junk', () => {
  assert.equal(bodyLooksLikeFeed(SAMPLE_DNS), true);
  assert.equal(bodyLooksLikeFeed('! Title: list\n! comment only\n'), false);
  assert.equal(bodyLooksLikeFeed('<!DOCTYPE html><html></html>'), false);
  assert.equal(bodyLooksLikeFeed(''), false);
});

test('trailing slashes on the source URL do not produce //file URLs', async () => {
  const dataDir = tmpDir();
  const { impl, calls } = fakeFetch({ 'dns.txt': SAMPLE_DNS, 'browser.txt': SAMPLE_BROWSER });
  await pullFeeds({ sourceUrl: 'http://hub.local:9191///', dataDir, fetchImpl: impl });
  for (const call of calls) {
    assert.match(call.url, /^http:\/\/hub\.local:9191\/[^/]+$/);
  }
});
