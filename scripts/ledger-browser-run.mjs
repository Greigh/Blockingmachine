/**
 * Browse real sites in real Chrome with the unpacked extension, and export what its static rules
 * actually blocked.
 *
 * The weekly cut is ranked by the browser's own rule hits, and until now nothing had ever produced
 * them: `ledger/ledger-hits.txt` shipped empty, so the ranking the packaging step asks for was never
 * used and the 30,000-rule cut was decided by concatenation order. This is the producer.
 *
 * **How it drives the browser.** No Playwright, no Puppeteer, no new dependency. Chrome is launched
 * with `--remote-debugging-port` and talked to over the DevTools Protocol using Node's built-in
 * `WebSocket`, which is enough to open tabs, wait, and attach to the extension's service worker.
 *
 * **Three things had to be true before any number here means anything**, and each was found by
 * running it rather than by reading the code:
 *
 *  1. **The extension is installed over CDP, not with `--load-extension`.** Chrome started that way
 *     exposes only its own component extension and no service worker for ours, so a run would have
 *     browsed every site with nothing installed and reported an empty ledger as a finding about the
 *     network. `Extensions.loadUnpacked` on the browser socket returns the real extension id, and
 *     every later step is keyed on that id rather than on a URL shape.
 *  2. **Every shipped tier is enabled before the first page loads.** A fresh install enables
 *     `tier_core` alone, so the other five tiers' rules are not installed — and a rule that is not
 *     installed cannot match. Measured: 48 real pages with the default selection produced 16
 *     distinct rules, every one of them `tier_core`, which is a ledger that says nothing about the
 *     five tiers the tier plan is trying to weigh. Enabling the whole set is also the state the plan
 *     is about: the overflow case where the static budget is the constraint.
 *  3. **Hits come from the extension's own rule matches**, resolved against its dynamic-rule index —
 *     not from observed network errors. That matters for what a run on this machine can claim: an
 *     upstream DNS blocker (AdGuard on the host, AdGuard Home on the LAN) can never add a match,
 *     because a request the extension blocks is decided before any lookup happens. It *can* reduce
 *     the third-party traffic a page loads, so absolute volumes here are depressed relative to a
 *     clean network. The ranking between rules is unaffected; the totals are not, and the per-tier
 *     export says so.
 *
 * Usage:
 *   node scripts/ledger-browser-run.mjs --sites 46 --out ledger/session-a.txt
 *   node scripts/ledger-browser-run.mjs --from 46 --sites 46 --keep-profile --out ledger/session-b.txt
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgvOrExit } from './argv.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION_DIR = join(ROOT, 'packages/browser-extension/dist');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;

/**
 * Real pages that load third-party subresources, which is the only thing that makes a static rule
 * fire. Grouped so the log reads as a session rather than a list.
 */
const SITES = [
  'https://www.bbc.co.uk/news', 'https://www.theguardian.com/uk', 'https://www.cnn.com',
  'https://www.nytimes.com', 'https://www.washingtonpost.com', 'https://www.reuters.com',
  'https://apnews.com', 'https://www.forbes.com', 'https://www.wired.com',
  'https://www.arstechnica.com', 'https://techcrunch.com', 'https://www.theverge.com',
  'https://www.engadget.com', 'https://www.polygon.com', 'https://www.eurogamer.net',
  'https://www.gamespot.com', 'https://www.ign.com', 'https://www.espn.com', 'https://www.si.com',
  'https://www.nba.com', 'https://www.weather.com', 'https://www.accuweather.com',
  'https://www.windy.com', 'https://www.timeanddate.com/weather', 'https://www.imdb.com',
  'https://www.rottentomatoes.com', 'https://www.goodreads.com', 'https://www.quora.com',
  'https://stackoverflow.com', 'https://github.com/trending', 'https://www.reddit.com/r/all',
  'https://www.reddit.com/r/technology', 'https://news.ycombinator.com',
  'https://www.twitch.tv/directory', 'https://www.tiktok.com/explore',
  'https://www.pinterest.com', 'https://www.linkedin.com/feed/', 'https://www.tumblr.com/explore/trending',
  'https://www.medium.com', 'https://www.bbc.co.uk/sport', 'https://www.skysports.com',
  'https://www.nature.com', 'https://www.scientificamerican.com', 'https://www.newscientist.com',
  'https://www.nationalgeographic.com', 'https://www.smithsonianmag.com', 'https://www.history.com',
  'https://www.bbc.co.uk/food', 'https://www.seriouseats.com', 'https://www.allrecipes.com',
  'https://www.delish.com', 'https://www.bonappetit.com', 'https://www.epicurious.com',
  'https://www.tripadvisor.com', 'https://www.airbnb.com/s/United-States', 'https://www.booking.com',
  'https://www.expedia.com', 'https://www.kayak.com', 'https://www.zillow.com',
  'https://www.realtor.com', 'https://www.autotrader.com', 'https://www.cars.com',
  'https://www.edmunds.com', 'https://www.autozone.com', 'https://www.homedepot.com',
  'https://www.lowes.com', 'https://www.ikea.com/us/en/', 'https://www.wayfair.com',
  'https://www.target.com', 'https://www.walmart.com', 'https://www.bestbuy.com',
  'https://www.newegg.com', 'https://www.bhphotovideo.com', 'https://www.macys.com',
  'https://www.nordstrom.com', 'https://www.zappos.com', 'https://www.etsy.com',
  'https://www.ebay.com', 'https://www.aliexpress.com', 'https://www.temu.com',
  'https://www.walgreens.com', 'https://www.cvs.com', 'https://www.groupon.com',
  'https://www.yelp.com', 'https://www.opentable.com', 'https://www.indeed.com',
  'https://www.glassdoor.com', 'https://www.healthgrades.com', 'https://www.webmd.com',
  'https://www.mayoclinic.org', 'https://www.redcross.org', 'https://www.unicef.org',
  'https://www.charitywater.org', 'https://www.gopro.com', 'https://www.patreon.com',
  'https://www.buymeacoffee.com', 'https://www.kickstarter.com', 'https://www.indiegogo.com',
  'https://store.steampowered.com', 'https://www.chess.com', 'https://www.duolingo.com',
  'https://www.coursera.org', 'https://www.edx.org', 'https://www.khanacademy.org',
  'https://www.scribd.com', 'https://www.slideshare.net', 'https://issuu.com',
  'https://www.canva.com', 'https://www.figma.com/community', 'https://unsplash.com',
  'https://www.pexels.com', 'https://pixabay.com', 'https://www.deviantart.com',
  'https://www.behance.net', 'https://dribbble.com', 'https://css-tricks.com',
  'https://www.smashingmagazine.com', 'https://nodejs.org/en/docs',
  'https://developer.mozilla.org/en-US/', 'https://react.dev/learn', 'https://vuejs.org/guide/introduction.html',
  'https://docs.python.org/3/', 'https://www.rust-lang.org/learn', 'https://go.dev/doc/',
  'https://www.tesla.com', 'https://www.bmw.com/en/index.html', 'https://www.nike.com',
  'https://www.adidas.com/us', 'https://www.samsung.com/us/', 'https://www.apple.com',
  'https://www.dell.com/en-us', 'https://www.lenovo.com/us/en/', 'https://www.staples.com',
  'https://www.costco.com', 'https://www.samsclub.com', 'https://www.barnesandnoble.com',
  'https://www.thriftbooks.com', 'https://www.abebooks.com', 'https://www.audible.com',
  'https://www.scribd.com/catalog', 'https://www.udemy.com', 'https://www.pluralsight.com',
  'https://www.unity.com', 'https://www.unrealengine.com', 'https://www.godotengine.org',
  'https://www.fiverr.com', 'https://www.upwork.com', 'https://www.freelancer.com',
  'https://www.bbc.com/learningenglish', 'https://www.duolingo.com/courses',
  'https://www.ted.com', 'https://www.coursera.org/learn', 'https://ocw.mit.edu',
  'https://www.gutenberg.org', 'https://archive.org', 'https://openlibrary.org',
  'https://www.flickr.com', 'https://500px.com', 'https://unsplash.com/t/wallpapers',
  'https://www.bandsintown.com', 'https://www.last.fm', 'https://www.allmusic.com',
  'https://www.metacritic.com', 'https://www.pcgamer.com', 'https://www.pcmag.com',
  'https://www.tomsguide.com', 'https://www.anandtech.com', 'https://www.tomshardware.com',
];

// Parsed through the shared refusing parser (scripts/argv.mjs). The map this replaced stored a
// bare flag as `true`, which made `--sites --keep-profile` answer `Number(true)` — *one site* —
// and `--profile` with no directory handed `true` to `rmSync` as a path. A named value is a
// value or a refusal, never a `true` wearing the flag's name.
const args = parseArgvOrExit(process.argv.slice(2), {
  values: ['--settle', '--sites', '--from', '--profile', '--out', '--list'],
  flags: ['--keep-profile', '--default-tiers'],
});
const argsValues = args.values;
const argValue = (name) => argsValues.get(name)?.at(-1);
const booleanArg = (name) => args.flags.has(name);

for (const numeric of ['--settle', '--sites', '--from']) {
  if (argsValues.has(numeric) && !Number.isFinite(Number(argValue(numeric)))) {
    console.error(`\n${numeric} is not a number: ${JSON.stringify(argValue(numeric))}\n`);
    process.exit(2);
  }
}

const settleMs = Number(argValue('--settle') ?? 7000);
const siteLimit = Number(argValue('--sites') ?? 46);
const siteOffset = Number(argValue('--from') ?? 0);
const profileDir = argValue('--profile') ?? join(tmpdir(), 'bm-ledger-profile');
const outPath = resolve(ROOT, argValue('--out') ?? 'ledger/session.json');

if (!existsSync(EXTENSION_DIR)) {
  console.error(`❌ ${EXTENSION_DIR} does not exist. Run: npm run package:extension`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`❌ Chrome not found at ${CHROME}. The ledger needs a real browser, not a fixture.`);
  process.exit(1);
}

const siteList = argValue('--list')
  ? readFileSync(resolve(ROOT, argValue('--list')), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : SITES;
const sites = siteList.slice(siteOffset, siteOffset + siteLimit);

// The profile holds the ledger, so it is only wiped on request: a long run is several invocations
// over one profile, and a browser session that is killed and restarted against a fresh profile
// would report an empty ledger every time.
if (!booleanArg('--keep-profile')) rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

console.log(`🧭 ${sites.length} sites (from ${siteOffset}), ${settleMs}ms settle each`);
console.log(`   extension ${EXTENSION_DIR}`);
console.log(`   profile   ${profileDir}`);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,OptimizationHints',
  '--window-size=1280,900',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stderr.on('data', (buf) => { chromeLog += buf.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Sites that would not navigate, reported at teardown. */
const failed = [];

/** Wait for the DevTools endpoint, which is not up the instant the process starts. */
async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    await sleep(300);
  }
  throw new Error(`Chrome DevTools endpoint never came up on ${DEBUG_PORT}\n${chromeLog.slice(-800)}`);
}

/** One CDP session over a WebSocket, with the request ids the protocol needs. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: done, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else done(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done, { once: true });
      ws.addEventListener('error', () => fail(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 30000);
    });
  }
}

/**
 * Poll for a service worker belonging to `extensionId`.
 *
 * Matched on the id `Extensions.loadUnpacked` returned and never on a URL shape: Chrome's own
 * component extensions are also service workers, and matching on the shape picks one of those
 * instead — which is what the first version of this script did. MV3 workers are lazy as well, so
 * this polls: a run that browses for minutes can find the worker asleep between two pages.
 */
async function findWorker(cdp, extensionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const found = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    if (found) return found;
    await sleep(500);
  }
  return null;
}

try {
  const version = await waitForDevTools();
  console.log(`✅ ${version.Browser}`);

  // The browser socket, which is the only place the `Extensions` domain exists.
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  if (!loaded?.id) throw new Error(`Extensions.loadUnpacked returned no id: ${JSON.stringify(loaded)}`);
  console.log(`🧩 extension ${loaded.id}`);

  const worker = await findWorker(browser, loaded.id, 30000);
  if (!worker) {
    const { targetInfos } = await browser.send('Target.getTargets');
    throw new Error(
      `the extension's service worker never appeared. Targets:\n${targetInfos.map((t) => `${t.type} ${t.url}`).join('\n')}`,
    );
  }
  console.log(`🧩 service worker ${worker.url}`);
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });

  /** Evaluate in the worker, not in the tab: only the worker has `chrome.storage`. */
  const evaluate = async (expression) => {
    const res = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return res.result?.value;
  };

  // **Every shipped tier has to be enabled before anything is browsed.** A fresh install enables
  // `tier_core` alone, so the other five tiers' rules are not installed at all — and a rule that is
  // not installed cannot match, so the ledger would come back full of `tier_core` and silent about
  // the five tiers the tier plan is trying to weigh. Measured: 48 real pages with the default
  // selection produced 16 distinct rules, every one of them `tier_core`. Enabling the whole set is
  // also the state the plan is about — the overflow case where the static budget is the constraint.
  let enabledTiers = null;
  if (!booleanArg('--default-tiers')) {
    const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
    const resources = manifest.declarative_net_request?.rule_resources ?? [];
    const ids = (Array.isArray(resources) ? resources : Object.values(resources))
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' || typeof id === 'number');
    if (ids.length === 0) throw new Error('the manifest declares no declarativeNetRequest rulesets');
    const result = await evaluate(`(async () => {
      const all = ${JSON.stringify(ids)};
      const before = await chrome.declarativeNetRequest.getEnabledRulesets();
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: all, disableRulesetIds: [] });
      return { before, on: await chrome.declarativeNetRequest.getEnabledRulesets() };
    })()`);
    // Verified rather than assumed: a run that silently left five tiers off would produce a ledger
    // that looks fine and weighs nothing.
    const missing = ids.filter((id) => !result.on.includes(id));
    if (missing.length > 0) throw new Error(`could not enable every tier; still off: ${missing.join(', ')}`);
    enabledTiers = result.on;
    console.log(`🔓 ${ids.length} rulesets enabled (was ${result.before.join(', ') || 'none'})`);
  }

  // A tab to drive. Created over HTTP so no browser-side session is needed for the page itself.
  const created = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await Cdp.connect(created.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  let visited = 0;
  for (const site of sites) {
    try {
      await page.send('Page.navigate', { url: site });
    } catch (err) {
      failed.push(`${site} (${err.message})`);
      continue;
    }
    // Settle rather than wait for a load event: the whole point is to let third-party subresources
    // arrive, and a page that never fires `load` would otherwise abort the run early.
    await sleep(settleMs);
    visited += 1;
    if (visited % 10 === 0) console.log(`   ${visited}/${sites.length} visited`);
  }

  // `hitLedgerSessions` (closed days) plus `hitLedgerActiveTally` (today, still open) are what the
  // popup's **Export hit ledger** button turns into a file. That file — `toLedgerExportJson`'s
  // `{format, version, exportedAt, sessions}` — is the format `merge-browser-ledger.mjs` reads, so
  // the artifact this script writes is the extension's own export rather than a text file dressed
  // up to look like one. `bm_rule_hits` / `bm_tier_hits` are read beside it as a cross-check: they
  // are the install-wide counters the popup's tier table shows, while the session tally is dated
  // and per-day, so agreeing totals are the evidence that the split below is the real one.
  const raw = await evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    return {
      keys: Object.keys(all),
      sessions: all.hitLedgerSessions ?? [],
      tally: all.hitLedgerActiveTally ?? null,
      rules: all.bm_rule_hits ?? [],
      tiers: all.bm_tier_hits ?? [],
    };
  })()`);
  console.log(`   storage keys: ${JSON.stringify(raw.keys)}`);

  const rules = (raw.rules ?? []).filter(
    (e) => e && typeof e.rule === 'string' && Number.isFinite(e.count) && e.count > 0,
  );
  const tiers = (raw.tiers ?? []).filter(
    (e) => e && typeof e.tier === 'string' && Number.isFinite(e.count) && e.count > 0,
  );
  const totalHits = rules.reduce((sum, e) => sum + e.count, 0);
  // The tally is today's still-open session, and the export includes it so the file is not short
  // one day's evidence just because nobody closed the browser. Its `hits` and `tierHits` are both
  // `Record<key, count>` while a closed session carries lists, so both are normalised here rather
  // than assumed — the same translation `toLedgerExportJson` would do, which is what keeps this
  // artifact byte-comparable with one the popup wrote.
  //
  // It is also only *persisted* every `LEDGER_FLUSH_EVERY` (25) hits, so a run under that threshold
  // has a tally living in the worker's memory and nothing in storage. Measured: a 2-page run left
  // the key null. The floor is therefore stated rather than left to be discovered.
  const sessions = [...(raw.sessions ?? [])];
  /** `Record<key, count>` → `[{ <field>: key, count }]`, the list form a closed session carries. */
  const asList = (record, field) =>
    Array.isArray(record)
      ? record
      : record && typeof record === 'object'
        ? Object.entries(record).map(([key, count]) => ({ [field]: key, count }))
        : [];
  const tallyHits = raw.tally ? asList(raw.tally.hits, 'rule') : [];
  const tallyTiers = raw.tally ? asList(raw.tally.tierHits, 'tier') : [];
  if (tallyHits.length > 0 || tallyTiers.length > 0) {
    sessions.push({ ...raw.tally, hits: tallyHits, tiers: tallyTiers, open: true });
  }
  if (tallyHits.length === 0) {
    console.warn(
      `⚠️  the open tally held nothing. It is persisted only every 25 hits, so a run under that\n` +
        `   threshold leaves it in the worker's memory. Browse more pages.`,
    );
  }

  if (rules.length === 0) {
    console.error('❌ no rule hits recorded. Pages loaded but nothing was blocked.');
    process.exitCode = 2;
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          format: 'blockingmachine-hit-ledger',
          // 2 is the version that added the per-tier axis to each session. Matched by hand against
          // `LEDGER_EXPORT_VERSION` because this script runs against a built extension and cannot
          // import its TypeScript; the suites assert both writers agree on the shape.
          version: 2,
          exportedAt: new Date().toISOString(),
          sessions,
        },
        null,
        2,
      )}\n`,
    );
    // The per-tier split and the provenance beside it, because a list of rule lines cannot show
    // which tier fired — and that is the number this whole run exists to produce.
    writeFileSync(
      outPath.replace(/\.json$/, '.meta.json'),
      `${JSON.stringify({
        provenance: [
          'Automated Chrome session driven by scripts/ledger-browser-run.mjs over a scripted site list.',
          'This is NOT a person’s browsing history: no URLs, titles, timestamps or initiators are',
          'recorded, only <count> <rule> pairs, and the site list is the script’s rather than anyone’s.',
          'Every shipped tier was enabled for the run; a rule that is not installed cannot match.',
          'The machine runs AdGuard locally and AdGuard Home on the LAN. Neither can add a match —',
          'a request the extension blocks is decided before any DNS lookup — but both reduce the',
          'third-party traffic pages load, so these totals are depressed relative to a clean network.',
          'The ranking between rules is unaffected; the absolute volumes are.',
        ],
        extension: loaded.id,
        enabledTiers,
        pages: { visited, attempted: sites.length, settleMs },
        sites: sites.slice(0, visited),
        totalHits,
        distinctRules: rules.length,
        // The install-wide counter, kept beside the session's own split rather than instead of it:
        // the two are recorded by different code on different schedules, so where they agree the
        // session tally is corroborated, and where they do not the disagreement is worth seeing.
        tiers: tiers.slice().sort((a, b) => b.count - a.count),
        sessionTiers: tallyTiers.slice().sort((a, b) => b.count - a.count),
        rawTally: raw.tally ?? null,
        rawSessions: raw.sessions ?? null,
      }, null, 2)}\n`,
    );
    console.log(`📊 ${totalHits.toLocaleString()} hits across ${rules.length.toLocaleString()} distinct rules`);
    for (const tier of tiers.slice().sort((a, b) => b.count - a.count)) {
      console.log(`   ${tier.tier.padEnd(20)} ${tier.count.toLocaleString()}`);
    }
    // The same split now travels inside the session file itself, which is what makes it mergeable:
    // `merge-browser-ledger.mjs` reads the export, not this sidecar.
    const sessionTierTotal = tallyTiers.reduce((sum, t) => sum + t.count, 0);
    const installedTierTotal = tiers.reduce((sum, t) => sum + t.count, 0);
    if (sessionTierTotal > 0) {
      console.log(
        `   → ${tallyTiers.length} tier(s) in the session tally` +
          (sessionTierTotal === installedTierTotal
            ? `, matching the install-wide total (${installedTierTotal.toLocaleString()})`
            : ` (${sessionTierTotal.toLocaleString()} against ${installedTierTotal.toLocaleString()} installed-wide — the difference is traffic outside the open tally)`),
      );
    }
    console.log(`💾 wrote ${outPath} (${sessions.length} session(s))`);
  }
} finally {
  try {
    chrome.kill();
  } catch {
    // Already gone.
  }
  if (failed.length) console.log(`⚠️  ${failed.length} sites did not navigate; first: ${failed[0]}`);
}