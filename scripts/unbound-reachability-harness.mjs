/**
 * Run the Unbound reachability check against real resolvers, and print what it says.
 *
 * A plain Node harness rather than a Jest run, because this is meant to execute inside the
 * container network where the resolvers live, and Jest cannot resolve modules through the Colima
 * virtiofs mount — it fails to find its own `jest-circus/build/runner.js` before it ever looks at a
 * test. The code under test is the same either way: `unboundProbe.js` and `unboundReachability.js`
 * compiled straight from the app's TypeScript, importing nothing but each other and `dns`.
 *
 * Every scenario below differs only in which resolver is asked, or in what the Hub's own feed server
 * is serving. Nothing about the answers is constructed here — they come off the wire.
 *
 *   node harness.mjs <drop-in path> <deployed> [bare] [swallow] [reference]
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import {
  RESOLVER_CONTROL_DOMAIN,
  classifyUnboundReachability,
  createFeedServeLog,
  parseUnboundDropIn,
  pickCanaryDomain,
  reachabilityProbeHeaders,
} from './unboundReachability.js';
import { probeUnboundResolver } from './unboundProbe.js';
import { parseUnboundResolverAddress, pickReferenceTarget } from './unboundAddress.js';
import { parseArgvOrExit } from './argv.mjs';

// Five positionals at most, every one a value — a sixth used to be silently dropped, and a
// `--flag` used to land in slot 1 and fail later as a file that doesn't exist.
const { positional } = parseArgvOrExit(process.argv.slice(2), { positionals: 5 });
const [dropinPath, deployed, bare, swallow, explicitReference] = positional;
if (!dropinPath || !deployed) {
  console.error('usage: node harness.mjs <drop-in> <deployed> [bare] [swallow] [reference]');
  process.exit(2);
}

const body = readFileSync(dropinPath, 'utf8');
const dropIn = parseUnboundDropIn(body);
const canaryDomain = pickCanaryDomain(dropIn.domains);
if (!canaryDomain) {
  console.error('the drop-in has no domain that could serve as a canary');
  process.exit(2);
}

const serveLog = createFeedServeLog();
const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  const ok = pathname === '/blockingmachine.conf';
  serveLog.record(
    { headers: req.headers, peer: req.socket.remoteAddress ?? 'unknown' },
    pathname,
    ok ? 200 : 404,
    body.length,
  );
  res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
  res.end(ok ? body : 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const address = (raw) => {
  const parsed = parseUnboundResolverAddress(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.target;
};

/**
 * The check, as the main process runs it: fetch the served file, read the drop-in out of the body,
 * ask the resolver, classify. Only the resolver and the feed differ between scenarios.
 */
async function check({ tested, reference = null, probeSkipped = null, lastCompiledAt = null, servedBody = body }) {
  const response = await fetch(`${baseUrl}/blockingmachine.conf`, { headers: reachabilityProbeHeaders() });
  const text = servedBody === body ? await response.text() : servedBody;
  const parsed = parseUnboundDropIn(text);

  const probe = probeSkipped
    ? null
    : await probeUnboundResolver({
        target: address(tested),
        canaryDomain,
        controlDomain: RESOLVER_CONTROL_DOMAIN,
        referenceTarget: reference ? address(reference) : null,
      });

  return classifyUnboundReachability({
    checkedAt: new Date().toISOString(),
    feedUrl: `${baseUrl}/blockingmachine.conf`,
    feedFileName: 'blockingmachine.conf',
    feedServerRunning: true,
    selfFetch: {
      ok: response.ok,
      status: response.status,
      zones: parsed.zones,
      hasServerBlock: parsed.hasServerBlock,
      canaryDomain: pickCanaryDomain(parsed.domains),
    },
    serves: [...serveLog.entries()],
    lastCompiledAt,
    probe,
    probeSkipped,
  });
}

// Unbound has no remote blocklist feature, so the recipe's scheduled `curl` *is* the subscription.
// Stand in for it with a real request carrying no probe header, so the serve log holds a genuine
// fetch with a genuine timestamp — staleness is only ever claimed on a dated fetch, and without this
// the `stale` verdict is unreachable by construction.
const scheduledFetch = await fetch(`${baseUrl}/blockingmachine.conf`, {
  headers: { 'user-agent': 'curl/8.7.1 (the recipe refresh)' },
});
await scheduledFetch.text();

const results = [];
const record = async (name, why, verdict, extra = {}) => {
  results.push({ name, why, verdict, ...extra });
};

/** Print the verdict the way the pane shows it, which is the thing worth recording. */
function show({ name, why, verdict, probeNote }) {
  const rows = verdict.rows.map((r) => `      ${r.tone === 'ok' ? 'ok  ' : r.tone === 'warn' ? 'warn' : 'off '}  ${r.label}: ${r.value}`);
  console.log(`\n  ${name}`);
  console.log(`      because:  ${why}`);
  console.log(`      state:    ${verdict.state}  (tone: ${verdict.tone})`);
  if (probeNote) console.log(`      probe:    ${probeNote}`);
  console.log(`      headline: ${verdict.headline}`);
  console.log(`      detail:   ${verdict.detail}`);
  if (verdict.nextStep) console.log(`      nextStep: ${verdict.nextStep}`);
  console.log('      rows:');
  console.log(rows.join('\n'));
}

// 1. The deployment the recipe describes.
record('live', `${deployed} loaded the core drop-in; ${bare} confirms the canary exists upstream`,
  await check({ tested: deployed, reference: bare ?? null }));

// 2. The same resolver, holding a copy older than the last compile.
record('stale', `${deployed} loaded it, but the last compile is newer than the fetch`,
  await check({ tested: deployed, reference: bare ?? null, lastCompiledAt: new Date(Date.now() + 60_000).toISOString() }));

// 3. NXDOMAIN with nobody to confirm the name exists.
record('canary-unconfirmed', `${deployed} loaded it, and no second resolver was available`,
  await check({ tested: deployed, reference: null }));

// 4. A resolver that never loaded the file.
if (bare) {
  record('not-loaded', `${bare} was served and fetched, but has no include: line`,
    await check({ tested: bare, reference: deployed }));
}

// 5. The CLI's own artifact, which blocks just as well and answers differently.
if (process.env.HARNESS_CLI_RESOLVER) {
  record('cli-artifact', `${process.env.HARNESS_CLI_RESOLVER} loaded the CLI's redirect + local-data drop-in`,
    await check({ tested: process.env.HARNESS_CLI_RESOLVER, reference: bare ?? null }));
}

// 6. A resolver that refuses the control name too.
if (swallow) {
  record('inconclusive', `${swallow} refuses ${RESOLVER_CONTROL_DOMAIN}, so NXDOMAIN proves nothing`,
    await check({ tested: swallow, reference: bare ?? null }));
}

// 7. A port with nothing on it.
record('resolver-unreachable', 'a closed port, which is what a wrong address looks like',
  await check({ tested: '127.0.0.1:1', reference: bare ?? null }));

// 8. A file that is not a drop-in.
const notADropIn = '! Title: something\n! Version: 1\n\n||doubleclick.net^\n';
{
  const response = await fetch(`${baseUrl}/blockingmachine.conf`, { headers: reachabilityProbeHeaders() });
  await response.text();
  record('feed-invalid', 'the hub served an AdGuard list under the Unbound feed name',
    await check({ tested: deployed, reference: bare ?? null, servedBody: notADropIn }));
}

// 9. Served, never queried.
record('unverified', 'the file is served but no resolver has been queried',
  await check({ tested: deployed, probeSkipped: 'no probe for this case' }));

// What the reference picker does with the addresses the rig supplied.
console.log('\n  reference selection');
for (const candidate of [deployed, bare, swallow, explicitReference].filter(Boolean)) {
  const tested = address(deployed);
  const picked = pickReferenceTarget(tested, candidate, []);
  console.log(`      reference=${candidate.padEnd(16)} -> ${picked.ok ? `usable (${picked.reference.source})` : `refused: ${picked.message}`}`);
}

console.log(`\n  canary: ${canaryDomain}   drop-in: ${dropIn.zones} local-zone, ${dropIn.hasServerBlock ? 'has' : 'no'} server: block`);

for (const entry of results) show(entry);

// What a hostname does. `dns.Resolver.setServers` takes an IP address only, and the call sits outside
// the probe's try block, so this is not a verdict — it is an exception out of the IPC handler.
console.log('\n  targets the parser accepts but the probe cannot query');
for (const raw of ['unbound.lan:5335', '::1:5353', '127.0.0.1:1']) {
  let line;
  try {
    const t0 = Date.now();
    const probe = await probeUnboundResolver({ target: address(raw), canaryDomain, controlDomain: RESOLVER_CONTROL_DOMAIN });
    line = `answered: canary=${probe.canary.answer.state} control=${probe.control.answer.state} in ${Date.now() - t0}ms`;
  } catch (error) {
    line = `THREW ${error.code ?? error.name}: ${error.message}`;
  }
  const parsed = address(raw);
  console.log(`      ${raw.padEnd(20)} -> host=${parsed.host.padEnd(14)} port=${parsed.port}  ${line}`);
}

const tally = {};
for (const { verdict } of results) tally[verdict.state] = (tally[verdict.state] ?? 0) + 1;
console.log('\n  ' + Object.entries(tally).map(([s, n]) => `${s}×${n}`).join('  '));

await new Promise((resolve) => server.close(resolve));
