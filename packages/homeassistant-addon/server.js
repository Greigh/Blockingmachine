/**
 * Blockingmachine Home Assistant Add-on — Hub & Feed Server
 *
 * Serves:
 *   - The ingress dashboard UI (Home Assistant sidebar)
 *   - Segregated DNS / Browser rule feeds for AdGuard Home & Pi-hole
 *   - An Unbound local-zone feed for resolvers that cannot read an ABP list
 *   - A Privoxy action file and a BIND RPZ zone rendered from the same DNS feed,
 *     for the deploy targets whose artifact is a file copied onto the host
 *   - A local REST API: status, compile, rule browser, protection toggle,
 *     diagnostics, and Server-Sent Events for live Home Assistant automations
 *
 * Everything is local: rule feeds are read from the shared data directory,
 * statistics are computed from the real feed contents, and compilation results
 * are persisted so numbers survive restarts. No cloud calls, no telemetry.
 *
 * Plain Node.js (no transpilation) — runs directly as `node /app/server.js`.
 */

import { createServer } from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { renderUnboundFeed, rulesToUnboundZones } from './unboundFeed.js';
import { renderShadowrocketFeed, shadowrocketHostCount } from './shadowrocketFeed.js';
import { renderPrivoxyFeed, privoxyPatternCount } from './privoxyFeed.js';
import { renderBindRpzFeed, bindRpzRecordCount } from './bindFeed.js';
import { hostFromRule, normalizeHost } from './hostRules.js';
import { pullFeeds } from './feedSource.js';

const PORT = parseInt(process.env.FEED_PORT || '9191', 10);
const DATA_DIR = process.env.DATA_DIR || '/data/blockingmachine';
const AUTO_COMPILE = process.env.AUTO_COMPILE || '24h';
const ENABLE_AI = process.env.ENABLE_AI !== 'false';
// The desktop hub's feed server — when set, a compile (manual or scheduled)
// pulls fresh dns.txt/browser.txt from it before recounting. Empty = serve
// whatever already sits in DATA_DIR (or the bundled baseline).
const FEED_SOURCE_URL = (process.env.FEED_SOURCE_URL || '').trim().replace(/\/+$/, '');
const FEED_SOURCE_TOKEN = (process.env.FEED_SOURCE_TOKEN || '').trim();
// The HTTPS-filter engine — the same one the desktop hub runs, bundled into
// engine.mjs so the add-on image stays dependency-free. Explicit-proxy surface
// on :9294 (CONNECT/PROXY-v2/plain-HTTP) plus the read-only enrollment routes
// (/ca.pem, /ca.mobileconfig, /proxy.pac). Its control listener stays on
// 127.0.0.1:9293 inside the container — config.yaml maps the data port only.
const HTTPS_FILTER_ENABLED = (process.env.HTTPS_FILTER || '').toLowerCase() === 'true';
const HTTPS_DATA_PORT = parseInt(process.env.HTTPS_DATA_PORT || '9294', 10);
const HTTPS_DATA_TOKEN = (process.env.HTTPS_DATA_TOKEN || '').trim();
const HTTPS_CONTROL_PORT = parseInt(process.env.HTTPS_CONTROL_PORT || '9293', 10);
const HTTPS_CONTROL_URL = `http://127.0.0.1:${HTTPS_CONTROL_PORT}`;
// The filtering DNS resolver — the same daemon the desktop's "Start DNS
// Protection" runs, bundled as dns-daemon.mjs. A router's DHCP can hand the
// add-on's address out as the LAN resolver: blocked names sinkhole, allowed
// ones forward over DoH. UDP+TCP on :53; its control API stays on 127.0.0.1
// inside the container — its query log is a browsing history, not LAN data.
const DNS_FILTER_ENABLED = (process.env.DNS_FILTER || '').toLowerCase() === 'true';
const DNS_PORT = parseInt(process.env.DNS_PORT || '53', 10);
const DNS_UPSTREAM = (process.env.DNS_UPSTREAM || 'https://dns.quad9.net/dns-query').trim();
const DNS_CONTROL_PORT = parseInt(process.env.DNS_CONTROL_PORT || '9295', 10);
const STARTED_AT = Date.now();

// The `log_level` option (info|debug|warning|error) gates chatter, never failures:
// error lines print under every level. `debug` has no dedicated call sites yet — it
// currently selects the same verbosity as `info` and leaves room for finer traces.
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_RANK = { debug: 0, info: 1, warning: 2, error: 3 };
const logLevelRank = LOG_RANK[LOG_LEVEL] ?? LOG_RANK.info;
// Log-injection guard at the sink: a request-shaped string reaching the log —
// including through a call site that forgot to clean it — gets its line-breaks
// and control characters flattened so one event can never print as two lines.
const logSafe = (v) => (typeof v === 'string' ? v.replace(/[\n\r\x00-\x08\x0b-\x1f\x7f]+/g, ' ') : v);
const log = (level, ...args) => {
  if ((LOG_RANK[level] ?? LOG_RANK.info) < logLevelRank) return;
  (level === 'error' || level === 'warning' ? console.error : console.log)(...args.map(logSafe));
};

// ─── Feed authentication ──────────────────────────────────────────────────────

/**
 * The optional token that locks every endpoint when set.
 *
 * The feeds are served on a published port, which on a not-fully-trusted network is readable by
 * anyone who can reach it — and `/v1/protection` would let one of them pause blocking outright.
 * When `feed_token` is configured the whole surface requires it; when empty, nothing changes and
 * the LAN-open behaviour is preserved.
 *
 * Three credential shapes are accepted because consumers differ in what they can send:
 * `?token=` for subscription URLs where no header is possible (Shadowrocket, some adlist
 * fetchers), `Authorization: Bearer` for scripts, and `Authorization: Basic` — which is also what
 * a client sends for a `http://user:token@host/` userinfo URL, so AdGuard Home, Pi-hole and curl
 * all work without special-casing.
 */
// ─── LAN authentication state ──────────────────────────────────────────────────
//
// Two credential sources, one posture decision:
//
//  - `FEED_TOKEN` env (the add-on's `feed_token` option) — user-managed. When set
//    it is the enforced credential, always.
//  - A minted token persisted in DATA_DIR (`.feed_token`, 0600) — the secured
//    default every *new* install gets. A first boot that finds a data dir with
//    prior artifacts (feeds, stats — proof an older version ran here) records
//    mode 'open' and stays compatible instead; token absence alone is never
//    proof of newness.
//
// The persisted `.lan-auth.json` is the explicit mode record: 'required' means
// every endpoint demands the credential; 'open' is the deliberate compatibility
// posture — a token is still honoured when sent, never required.

const ENV_FEED_TOKEN = (process.env.FEED_TOKEN || '').trim();
const AUTH_STATE_PATH = join(DATA_DIR, '.lan-auth.json');
const MINTED_TOKEN_PATH = join(DATA_DIR, '.feed_token');
const ADMIN_TOKEN_PATH = join(DATA_DIR, '.admin_token');
const AUTH_COOKIE = 'bm_token';
// Any of these in DATA_DIR means an earlier version ran here — the upgrade path.
const LEGACY_STATE_FILES = [
  'dns.txt', 'browser.txt', 'filter-list.txt', 'unbound.conf',
  'hub-stats.json', 'protection.json', 'browser-telemetry.json',
];

let mintedFeedToken = '';
let adminToken = '';
let lanAuthMode = 'open'; // refined by initLanAuth() before the server listens
let authPersistenceOk = true; // false when DATA_DIR writes fail — status surfaces it
// Serializes every state/credential mutation so concurrent admin calls (or a
// flip racing a heal) can never interleave writes into a torn state.
let authOpChain = Promise.resolve();
function serializeAuthOp(work) {
  const run = authOpChain.then(work, work);
  authOpChain = run.then(() => {}, () => {});
  return run;
}

function currentToken() {
  return ENV_FEED_TOKEN || mintedFeedToken;
}

// ─── Durable writes ───────────────────────────────────────────────────────────
// Auth state and credentials write tmp-then-rename: a crash mid-write can never
// leave a truncated JSON or a half-written credential — the reader sees either
// the complete old file or the complete new one. The tmp name is unique per
// write, and `rm` first clears a planted symlink at that name.

let authWriteSeq = 0;
async function atomicWriteFile(filePath, content, mode = 0o600) {
  const tmp = `${filePath}.tmp-${process.pid}-${authWriteSeq++}`;
  await fs.rm(tmp, { force: true });
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, filePath);
}

async function writeAuthState(mode) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await atomicWriteFile(AUTH_STATE_PATH, JSON.stringify({ version: 2, mode }, null, 2));
    authPersistenceOk = true;
  } catch (err) {
    authPersistenceOk = false;
    log('error', '[Add-on Hub] Failed to persist auth mode:', err);
  }
}

/**
 * Writes a credential create-if-absent (`wx`): on a concurrent-boot race the
 * first writer's value wins and the loser re-reads it — both end up using the
 * same durable credential. A present-but-empty file is an interrupted earlier
 * write and is atomically replaced. On an unwritable dir the in-memory value is
 * still used (persistence flagged broken) — the next boot re-mints and re-logs.
 */
async function mintCredential(filePath) {
  const candidate = randomBytes(24).toString('base64url');
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.writeFile(filePath, candidate, { mode: 0o600, flag: 'wx' });
      return candidate;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const existing = (await fs.readFile(filePath, 'utf8')).trim();
        if (existing) return existing;
        await atomicWriteFile(filePath, candidate);
        return candidate;
      }
      throw err;
    }
  } catch (err) {
    authPersistenceOk = false;
    log('error', `[Add-on Hub] Failed to persist credential ${filePath}:`, err);
    return candidate;
  }
}

async function mintToken() {
  mintedFeedToken = await mintCredential(MINTED_TOKEN_PATH);
}

/**
 * First-boot posture resolution. Runs before the server starts listening so the
 * very first request sees the decided mode.
 *
 *  - Env token configured          → required, user-managed credential.
 *  - Persisted mode 'required'     → required; mints if the token file is gone
 *                                    (fail-closed heal, same as the desktop).
 *  - Persisted mode 'open'         → explicit compatibility.
 *  - Corrupt/unreadable state file → treated as required (a read failure must
 *                                    never silently downgrade a secured install).
 *  - No state file, prior artifacts→ upgrade: record 'open', stay compatible.
 *  - No state file, empty data dir → new install: 'required' + minted token.
 *    (Ambiguous: a wiped legacy install looks identical — it gets the secured
 *    default plus the same admin recovery paths, never a silent open.)
 *
 * The admin credential is minted on EVERY install, new and existing — it gates
 * only `/v1/auth-mode`, so creating it changes no client's data-plane access.
 */
async function initLanAuth() {
  if (existsSync(ADMIN_TOKEN_PATH)) {
    try {
      adminToken = (await fs.readFile(ADMIN_TOKEN_PATH, 'utf8')).trim();
    } catch (err) {
      // Unreadable or unexpected file type — treat as absent and re-mint.
      log('error', '[Add-on Hub] Could not read .admin_token — re-minting:', err);
    }
  }
  if (!adminToken) {
    adminToken = await mintCredential(ADMIN_TOKEN_PATH);
    // The add-on's Log tab is the HA-admin-only credential-recovery path —
    // the same deliberate-disclosure boundary as the desktop's pairing QR.
    log('info', `[Blockingmachine Add-on] Generated LAN admin token: ${adminToken}`);
    log('info', '[Blockingmachine Add-on] Needed once for authentication-mode changes — also stored at .admin_token in the add-on data dir.');
  }

  if (ENV_FEED_TOKEN) {
    lanAuthMode = 'required';
    log('info', '[Blockingmachine Add-on] Feed token configured via options — every endpoint requires it.');
    return;
  }
  if (existsSync(AUTH_STATE_PATH)) {
    try {
      const raw = JSON.parse(await fs.readFile(AUTH_STATE_PATH, 'utf8'));
      lanAuthMode = raw && raw.mode === 'required' ? 'required' : 'open';
    } catch {
      lanAuthMode = 'required'; // fail-closed on a corrupt or unreadable record
    }
  } else {
    const hasPriorArtifacts = LEGACY_STATE_FILES.some((f) => existsSync(join(DATA_DIR, f)));
    lanAuthMode = hasPriorArtifacts ? 'open' : 'required';
    await writeAuthState(lanAuthMode);
    if (!hasPriorArtifacts) {
      log('info', '[Blockingmachine Add-on] New install — LAN authentication is required by default.');
    } else {
      log('info', '[Blockingmachine Add-on] Existing data detected — keeping open compatibility mode (the dashboard can migrate it).');
    }
  }
  // A persisted minted token is honoured in EITHER mode when a client sends it
  // — required mode demands it; open mode accepts it without demanding.
  if (existsSync(MINTED_TOKEN_PATH)) {
    try {
      mintedFeedToken = (await fs.readFile(MINTED_TOKEN_PATH, 'utf8')).trim();
    } catch (err) {
      // Unreadable or unexpected file type — treated as absent; a required
      // mode then re-mints (heal), an open mode runs tokenless as recorded.
      log('error', '[Add-on Hub] Could not read .feed_token — treating as absent:', err);
    }
  }
  if (lanAuthMode === 'required' && !mintedFeedToken) {
    await mintToken();
    log('info', `[Blockingmachine Add-on] Generated LAN feed token: ${mintedFeedToken}`);
    log('info', '[Blockingmachine Add-on] Keep it out of places you would not put a password; it is also stored at .feed_token in the add-on data dir.');
  }
}

/** Constant-time comparison — the token is a credential, not a label. */
function tokenMatches(candidate) {
  const token = currentToken();
  if (!candidate || !token) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === AUTH_COOKIE) return rest.join('=').trim();
  }
  return '';
}

/**
 * Authz for one request.
 * @returns {{ok: boolean, credentialed: boolean, viaQuery: boolean}}
 *   `credentialed` = the request proved it knows the token (query, header or
 *   cookie) — vs merely being allowed through open mode. Status payloads gate
 *   token echo on it so an open-mode unauthenticated probe can't exfiltrate the
 *   stored credential.
 */
function authorizeRequest(req, url) {
  const required = ENV_FEED_TOKEN ? true : lanAuthMode === 'required';
  const viaQuery = tokenMatches(url.searchParams.get('token'));
  if (viaQuery) return { ok: true, credentialed: true, viaQuery: true };

  const header = req.headers.authorization || '';
  // `/^Bearer\s/` then index-slice: the `+`-anchored form rescans a space run quadratically.
  const bearerPrefix = /^Bearer\s/i.exec(header);
  if (bearerPrefix && tokenMatches(header.slice(bearerPrefix[0].length).trim())) {
    return { ok: true, credentialed: true, viaQuery: false };
  }

  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    // `user:token` is the standard shape; a bare `token` or `token:` is accepted because some
    // fetchers hand the credential over without a username.
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    if (tokenMatches(password) || tokenMatches(decoded)) {
      return { ok: true, credentialed: true, viaQuery: false };
    }
  }

  if (tokenMatches(cookieToken(req))) return { ok: true, credentialed: true, viaQuery: false };

  return { ok: !required, credentialed: false, viaQuery: false };
}

// ─── Administrative authorization ────────────────────────────────────────────
// Mode changes are privileged: the feed token is a *data-plane* credential — a
// mobile client holding it is not entitled to reconfigure the install's trust
// posture. A separate credential, minted on every install and recoverable only
// through the add-on's own Log / `.admin_token` (the HA-admin boundary), is the
// sole proof of administrative authority. It travels header-only — never in a
// URL — so it can never leak into a subscriber link, referrer, or proxy log.

/** Constant-time comparison — the admin credential is a secret, not a label. */
function adminTokenMatches(candidate) {
  if (!candidate || !adminToken) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Administrative authority = possession of the management credential, sent as
 * `X-Admin-Token:` or `Authorization: Bearer <admin>`. Deliberately NOT:
 * the feed token (data-plane), the bm_token cookie (feed-scoped session),
 * Origin/Referer/Host/X-Ingress-Path (spoofable), or Origin absence.
 */
function isAdminRequest(req) {
  const header = req.headers['x-admin-token'];
  if (adminTokenMatches(Array.isArray(header) ? header[0] : header)) return true;
  const auth = req.headers.authorization || '';
  const bearerPrefix = /^Bearer\s/i.exec(auth);
  return Boolean(bearerPrefix && adminTokenMatches(auth.slice(bearerPrefix[0].length).trim()));
}

function rejectAdminRequired(res) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Admin credential required',
    hint: 'Pass the management token as X-Admin-Token — find it in the add-on Log or .admin_token in the add-on data dir',
  }));
}

/**
 * The unlock page for browser/ingress visits to the dashboard. A form GET drops
 * the token on `/?token=…`, which authorizes and sets the session cookie — no
 * endpoint of its own, and the token never leaves the request the user typed.
 */
function unlockPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Blockingmachine — Unlock</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;background:#10151f;color:#dfe7f3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a2332;border-radius:12px;padding:28px 32px;max-width:420px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
h1{font-size:1.15rem;margin:0 0 10px}
p{font-size:.85rem;opacity:.75;line-height:1.45}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #33415c;background:#10151f;color:inherit;font:inherit;margin:14px 0 10px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><form class="card" method="get" action="">
<h1>🔒 Blockingmachine is locked</h1>
<p>This install requires its feed token before the dashboard, feeds or API answer.
Find it in the add-on's <b>Log</b> tab (printed once at first boot), in
<code>.feed_token</code> in the add-on data directory, or re-pair from the desktop app's QR.</p>
<input name="token" type="password" placeholder="Feed token" autocomplete="current-password" autofocus>
<button type="submit">Unlock</button>
<p style="font-size:.72rem">The token is stored as a session cookie on this browser only.</p>
</form></body></html>`;
}

/**
 * Rejects with a Basic challenge so curl and feed fetchers can answer it — and,
 * for a browser visiting the dashboard itself, with the unlock page so Home
 * Assistant ingress users get a real login form instead of a blank 401.
 */
function rejectUnauthorized(res, pathname, wantsHtml) {
  if (wantsHtml && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(unlockPage());
    return;
  }
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Blockingmachine feeds", charset="UTF-8"',
  });
  res.end(JSON.stringify({ error: 'Unauthorized — a feed token is required on this add-on' }));
}

/**
 * The URL the dashboard should print for a feed path, token included when one is configured.
 * The page itself is behind the same check, so anyone who can read the rendered URL already knows
 * the token — and a copied URL that lacks it would simply fail to fetch.
 */
/**
 * The URL the dashboard should print for a feed path. The token rides along
 * only for a viewer that already proved it — on an open-mode dashboard served
 * unauthenticated, embedding the stored credential would leak it to anyone
 * who can reach the page (and that viewer's URLs work unauthenticated anyway).
 */
function feedUrl(path, disclose) {
  const base = `http://homeassistant.local:${PORT}${path}`;
  const token = currentToken();
  return token && disclose ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// ─── Baseline fallback protection ─────────────────────────────────────────────

const defaultDnsRules = [
  '||doubleclick.net^',
  '||google-analytics.com^',
  '||telemetry.microsoft.com^',
  '||adnxs.com^',
  '||scorecardresearch.com^',
];

const defaultBrowserRules = [
  '||doubleclick.net^',
  '||google-analytics.com^',
  'example.com##.ad-banner',
  '##div[class*="ad-slot"]',
  '.fc-consent-root',
];

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ enabled: boolean, pausedUntil: number|null }} */
let protection = { enabled: true, pausedUntil: null };

/** @type {{ lastCompile: string|null, lastCompileMs: number|null, totalRules: number, dnsRules: number, browserRules: number, quarantinedThreats: number, compileCount: number, history: Array<{timestamp: string, processedRuleCount: number, uniqueRuleCount: number, duplicatesRemoved: number}>, browserTelemetry: {trackersBlocked: number, elementsHidden: number, threatsDetected: number, recentTrackers: Array<{domain: string, count: number}>, lastUpdated: string|null} }} */
let compileStats = {
  lastCompile: null,
  lastCompileMs: null,
  totalRules: 0,
  dnsRules: 0,
  browserRules: 0,
  quarantinedThreats: 0,
  compileCount: 0,
  history: [],
  // Extension-reported counters, aggregated from POST /v1/telemetry/browser the
  // same way the desktop hub does — reported back out via /v1/status and
  // /v1/telemetry so a browser pointed at the add-on is not a dead end.
  browserTelemetry: {
    trackersBlocked: 0,
    elementsHidden: 0,
    threatsDetected: 0,
    recentTrackers: [],
    lastUpdated: null,
  },
};

/** Bounded SSE subscriber registry for live Home Assistant automations */
const sseClients = new Set();

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const STATS_PATH = join(DATA_DIR, 'hub-stats.json');
const PROTECTION_PATH = join(DATA_DIR, 'protection.json');

async function persistJson(path, value) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  } catch (err) {
    log('error', `[Add-on Hub] Failed to persist ${path}:`, err);
  }
}

async function loadPersistedState() {
  try {
    if (existsSync(STATS_PATH)) {
      const raw = JSON.parse(await fs.readFile(STATS_PATH, 'utf8'));
      if (raw && typeof raw === 'object') {
        compileStats = {
          lastCompile: typeof raw.lastCompile === 'string' ? raw.lastCompile : null,
          lastCompileMs: typeof raw.lastCompileMs === 'number' ? raw.lastCompileMs : null,
          totalRules: Number(raw.totalRules) || 0,
          dnsRules: Number(raw.dnsRules) || 0,
          browserRules: Number(raw.browserRules) || 0,
          quarantinedThreats: Number(raw.quarantinedThreats) || 0,
          compileCount: Number(raw.compileCount) || 0,
          history: Array.isArray(raw.history) ? raw.history.slice(0, 10) : [],
          browserTelemetry: raw.browserTelemetry && typeof raw.browserTelemetry === 'object'
            ? {
                trackersBlocked: Number(raw.browserTelemetry.trackersBlocked) || 0,
                elementsHidden: Number(raw.browserTelemetry.elementsHidden) || 0,
                threatsDetected: Number(raw.browserTelemetry.threatsDetected) || 0,
                recentTrackers: Array.isArray(raw.browserTelemetry.recentTrackers)
                  ? raw.browserTelemetry.recentTrackers.slice(0, 50)
                  : [],
                lastUpdated: typeof raw.browserTelemetry.lastUpdated === 'string' ? raw.browserTelemetry.lastUpdated : null,
              }
            : compileStats.browserTelemetry,
        };
      }
    }
    if (existsSync(PROTECTION_PATH)) {
      const raw = JSON.parse(await fs.readFile(PROTECTION_PATH, 'utf8'));
      if (raw && typeof raw.enabled === 'boolean') {
        const pausedUntil = typeof raw.pausedUntil === 'number' ? raw.pausedUntil : null;
        // An expired pause must not survive a restart
        const stillPaused = pausedUntil !== null && pausedUntil > Date.now();
        protection = {
          enabled: stillPaused ? raw.enabled : true,
          pausedUntil: stillPaused ? pausedUntil : null,
        };
      }
    }
  } catch (err) {
    log('error', '[Add-on Hub] Failed to load persisted state:', err);
  }
}

// ─── Feed loading & real statistics ───────────────────────────────────────────

/**
 * Reads a feed file from the data dir, falling back to the bundled baseline.
 * @param {string} fileName
 * @param {string[]} baseline
 * @returns {Promise<{ rules: string[], source: 'file'|'baseline' }>}
 */
async function loadFeed(fileName, baseline) {
  const feedPath = join(DATA_DIR, fileName);
  try {
    if (existsSync(feedPath)) {
      const content = await fs.readFile(feedPath, 'utf8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('!') && !l.startsWith('#'));
      if (lines.length > 0) return { rules: lines, source: 'file' };
    }
  } catch (err) {
    log('error', `[Add-on Hub] Failed to read ${feedPath}:`, err);
  }
  return { rules: [...baseline], source: 'baseline' };
}

/** Recomputes statistics from the actual feed files on disk. */
async function recomputeStats() {
  const dns = await loadFeed('dns.txt', defaultDnsRules);
  const browser = await loadFeed('browser.txt', defaultBrowserRules);
  compileStats.dnsRules = dns.rules.length;
  compileStats.browserRules = browser.rules.length;
  compileStats.totalRules = dns.rules.length + browser.rules.length;
  // The HTTPS-filter engine reads one rules file at boot and on /v1/proxy/reload
  // — request rules judge CONNECT/plain-HTTP flows, `##`/`#@#` cosmetic rules
  // feed the injection index, so it gets both feeds concatenated.
  try {
    await fs.writeFile(
      join(DATA_DIR, 'engine-rules.txt'),
      `${[...dns.rules, ...browser.rules].join('\n')}\n`,
      'utf8',
    );
  } catch (err) {
    log('error', '[Add-on Hub] Failed to write engine-rules.txt:', err);
  }
  return { dns, browser };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Compilation ──────────────────────────────────────────────────────────────

let isCompiling = false;

async function runCompile() {
  if (isCompiling) {
    return { success: false, message: 'A compilation is already in progress' };
  }
  isCompiling = true;
  const startedAt = Date.now();
  try {
    // A configured feed source turns "compile" into sync-then-recount: pull the
    // desktop's published feeds into DATA_DIR first, so a click (or the schedule)
    // is what keeps the add-on's copy current while the laptop is awake.
    let pullNote = '';
    if (FEED_SOURCE_URL) {
      const pull = await pullFeeds({
        sourceUrl: FEED_SOURCE_URL,
        token: FEED_SOURCE_TOKEN || undefined,
        dataDir: DATA_DIR,
      });
      if (pull.errors.length > 0 && pull.pulled.length === 0) {
        pullNote = ` — feed sync failed (${pull.errors.join('; ')}); kept existing feeds`;
      } else if (pull.errors.length > 0) {
        pullNote = ` — synced ${pull.pulled.join(', ')}, but ${pull.errors.join('; ')}`;
      } else {
        pullNote = ` — synced from ${FEED_SOURCE_URL}`;
      }
    }
    // The add-on consumes feeds prepared by the desktop app / sync pipeline.
    // Compilation here = refresh stats from disk, stamp the ledger, notify.
    const { dns, browser } = await recomputeStats();
    compileStats.lastCompile = new Date().toISOString();
    compileStats.lastCompileMs = Date.now() - startedAt;
    compileStats.compileCount += 1;
    // History powers the /v1/telemetry "recent compiles" card on clients. The
    // add-on recounts an already-deduped published feed, so processed == unique
    // and dupes removed is honestly 0 at this layer.
    compileStats.history.unshift({
      timestamp: compileStats.lastCompile,
      processedRuleCount: compileStats.totalRules,
      uniqueRuleCount: compileStats.totalRules,
      duplicatesRemoved: 0,
    });
    compileStats.history = compileStats.history.slice(0, 10);
    await persistJson(STATS_PATH, compileStats);
    broadcastSse('compile_completed', {
      total: compileStats.totalRules,
      dns: compileStats.dnsRules,
      browser: compileStats.browserRules,
      durationMs: compileStats.lastCompileMs,
    });
    // The engine re-reads engine-rules.txt on this loopback call — keeps its
    // evaluator in step with the feeds the add-on just recounted.
    void reloadFilterRules();
    const sourceNote = dns.source === 'baseline' && browser.source === 'baseline'
      ? ' (baseline rules — set feed_source_url to the desktop hub to publish full feeds)'
      : '';
    return {
      success: true,
      message: `Compiled ${compileStats.totalRules} rules (${compileStats.dnsRules} DNS, ${compileStats.browserRules} browser) in ${compileStats.lastCompileMs}ms${pullNote}${sourceNote}`,
      durationMs: compileStats.lastCompileMs || 0,
    };
  } catch (err) {
    log('error', '[Add-on Hub] Compile failed:', err);
    return { success: false, message: `Compilation failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    isCompiling = false;
  }
}

// ─── Auto-compile scheduler (from add-on options) ─────────────────────────────

function startAutoCompileScheduler() {
  if (AUTO_COMPILE === 'disabled') return;
  const hours = { '12h': 12, '24h': 24, weekly: 168 };
  const periodHours = hours[AUTO_COMPILE];
  if (!periodHours) return;
  const intervalMs = periodHours * 60 * 60 * 1000;
  const timer = setInterval(() => {
    log('info', `[Add-on Hub] Auto-compile tick (${AUTO_COMPILE} schedule)`);
    runCompile()
      .then((res) => log('info', `[Add-on Hub] Auto-compile: ${res.message}`))
      .catch(() => {});
  }, intervalMs);
  timer.unref?.();
  log('info', `[Add-on Hub] Auto-compile scheduled every ${periodHours}h`);
}

// ─── Ingress dashboard UI ─────────────────────────────────────────────────────

function authModeLabel() {
  if (ENV_FEED_TOKEN) return 'token required on every endpoint (from add-on options)';
  return lanAuthMode === 'required'
    ? 'token required on every endpoint (generated default)'
    : 'open (LAN trust — a token is honoured when sent, never required)';
}

function renderDashboard(dns, browser, auth) {
  const upSec = Math.floor((Date.now() - STARTED_AT) / 1000);
  const uptime = upSec >= 3600
    ? `${Math.floor(upSec / 3600)}h ${Math.floor((upSec % 3600) / 60)}m`
    : `${Math.floor(upSec / 60)}m`;
  const paused = protection.pausedUntil !== null && protection.pausedUntil > Date.now();
  const protectionLabel = !protection.enabled || paused ? 'Paused' : 'Protecting';
  const lastCompile = compileStats.lastCompile
    ? new Date(compileStats.lastCompile).toLocaleString()
    : 'Never (compile now to stamp the ledger)';

  const unboundZoneCount = rulesToUnboundZones(dns.rules).length;
  const shadowrocketCount = shadowrocketHostCount(dns.rules);
  const privoxyCount = privoxyPatternCount(dns.rules);
  const rpzCount = bindRpzRecordCount(dns.rules);
  const dnsRulesPreview = dns.rules.slice(0, 60).map((r) => escapeHtml(r));
  const browserRulesPreview = browser.rules.slice(0, 60).map((r) => escapeHtml(r));

  const inlineDnsRules = JSON.stringify(dns.rules.slice(0, 5000)).replace(/</g, '\\u003c');
  const inlineBrowserRules = JSON.stringify(browser.rules.slice(0, 5000)).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9B%A1%EF%B8%8F%3C/text%3E%3C/svg%3E">
<title>Blockingmachine Hub — Home Assistant</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--primary-background-color, #0f172a);
    color: var(--primary-text-color, #f8fafc);
    margin: 0; padding: 20px; max-width: 1100px; margin-inline: auto;
  }
  .card {
    background: var(--card-background-color, #1e293b);
    border: 1px solid var(--divider-color, #334155);
    border-radius: 14px; padding: 18px; margin-bottom: 16px;
  }
  header.hub { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  header.hub .logo { font-size: 30px; }
  h1 { font-size: 22px; margin: 0; color: var(--accent-color, #38bdf8); }
  .subtitle { color: var(--secondary-text-color, #94a3b8); font-size: 13.5px; margin: 4px 0 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .stat-card { display: flex; flex-direction: column; gap: 2px; padding: 16px; margin-bottom: 0; }
  .stat-val { font-size: 30px; font-weight: 800; color: var(--accent-color, #38bdf8); font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 12.5px; color: var(--secondary-text-color, #94a3b8); }
  /* Phone widths: two compact tile columns instead of eight full-width cards,
     so the Protection control is not three viewports of scroll away. */
  @media (max-width: 520px) {
    body { padding: 12px; }
    .grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .stat-card { padding: 10px 12px; }
    .stat-val { font-size: 20px; }
    .stat-label { font-size: 11px; }
  }
  h2 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .muted { color: var(--secondary-text-color, #94a3b8); font-size: 13px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .btn {
    background: var(--accent-color, #0369a1); color: #fff; border: none;
    padding: 10px 18px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 13.5px;
    display: inline-flex; align-items: center; gap: 7px; transition: opacity .15s ease;
    text-decoration: none;
  }
  .btn.secondary { background: transparent; color: inherit; border: 1px solid var(--divider-color, #334155); font-weight: 600; }
  .btn:disabled { opacity: .55; cursor: wait; }
  .btn:hover:not(:disabled) { opacity: .9; }
  .pill { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--divider-color, #334155); }
  .pill.ok { color: #34d399; border-color: rgba(52, 211, 153, .4); }
  .pill.warn { color: #fbbf24; border-color: rgba(251, 191, 36, .45); }
  .feed { display: flex; align-items: center; gap: 8px; background: var(--primary-background-color, #0f172a); border: 1px solid var(--divider-color, #334155); border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
  .feed code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--accent-color, #38bdf8); flex: 1; overflow-wrap: anywhere; }
  .feed .tag { font-size: 11px; font-weight: 700; color: var(--secondary-text-color, #94a3b8); min-width: 86px; }
  .feed button { background: none; border: 1px solid var(--divider-color, #334155); color: var(--secondary-text-color, #94a3b8); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .feed button:hover { color: inherit; border-color: var(--accent-color, #38bdf8); }
  details.rules { margin-top: 10px; }
  details.rules summary { cursor: pointer; color: var(--secondary-text-color, #94a3b8); font-size: 13px; user-select: none; }
  details.rules pre {
    background: var(--primary-background-color, #0f172a); border: 1px solid var(--divider-color, #334155);
    border-radius: 10px; padding: 12px; font-size: 12px; line-height: 1.55; overflow: auto;
    max-height: 300px; color: var(--secondary-text-color, #94a3b8); margin: 10px 0 0;
  }
  .switch { position: relative; width: 46px; height: 26px; flex: none; display: inline-block; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; inset: 0; background: var(--divider-color, #334155); border-radius: 999px; transition: .18s; cursor: pointer; }
  .slider:before { content: ""; position: absolute; height: 20px; width: 20px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .18s; }
  .switch input:checked + .slider { background: #34d399; }
  .switch input:checked + .slider:before { transform: translateX(20px); }
  .toast {
    position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(80px);
    background: var(--card-background-color, #1e293b); color: inherit;
    border: 1px solid var(--divider-color, #334155); border-radius: 12px;
    padding: 12px 18px; font-size: 13.5px; max-width: 92vw;
    box-shadow: 0 10px 30px rgba(0,0,0,.35); opacity: 0; transition: all .25s ease; z-index: 50;
    pointer-events: none;
  }
  .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  .toast.err { border-color: rgba(248, 113, 113, .55); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13px; }
  .kv .k { color: var(--secondary-text-color, #94a3b8); }
  .meta-line { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; color: var(--secondary-text-color, #94a3b8); font-size: 12.5px; }
  #rule-filter {
    flex: 1; background: var(--primary-background-color, #0f172a);
    border: 1px solid var(--divider-color, #334155); color: inherit;
    border-radius: 10px; padding: 9px 12px; font-size: 13px;
  }
</style>
</head>
<body>
  <main>
  <header class="hub">
    <span class="logo">🛡️</span>
    <div>
      <h1>Blockingmachine Hub</h1>
      <div class="subtitle">AI-powered rule compilation, segregated DNS &amp; browser feeds, and local network defense.</div>
    </div>
  </header>

  <div class="grid">
    <div class="card stat-card"><span class="stat-val" id="stat-total">${compileStats.totalRules}</span><span class="stat-label">Total Active Rules</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-dns">${compileStats.dnsRules}</span><span class="stat-label">DNS-Level Rules</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-browser">${compileStats.browserRules}</span><span class="stat-label">Browser Rules</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-unbound">${unboundZoneCount}</span><span class="stat-label">Unbound Zones</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-shadowrocket">${shadowrocketCount}</span><span class="stat-label">Shadowrocket Rules</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-privoxy">${privoxyCount}</span><span class="stat-label">Privoxy Patterns</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-rpz">${rpzCount}</span><span class="stat-label">BIND RPZ Records</span></div>
    <div class="card stat-card"><span class="stat-val" id="stat-threats">${compileStats.quarantinedThreats}</span><span class="stat-label">AI Threats Quarantined</span></div>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <h2 style="margin-bottom:2px">Protection</h2>
        <span class="muted" id="protection-desc">Blocking feeds stay live for every device on this network.</span>
      </div>
      <div class="row" style="gap:10px">
        <span class="pill ${protection.enabled && !paused ? 'ok' : 'warn'}" id="protection-pill">${protectionLabel}</span>
        <label class="switch" title="Pause or resume network blocking">
          <input type="checkbox" id="protection-toggle" ${protection.enabled && !paused ? 'checked' : ''} aria-label="Toggle protection">
          <span class="slider"></span>
        </label>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <h2 style="margin:0">⚡ Compilation</h2>
      <button class="btn" id="compile-btn">⚡ Compile Rules Now</button>
    </div>
    <div class="meta-line">
      <span>Last compile: <strong id="last-compile">${escapeHtml(lastCompile)}</strong></span>
      <span>Compiles this install: <strong>${compileStats.compileCount}</strong></span>
      <span>Auto-compile: <strong>${escapeHtml(AUTO_COMPILE)}</strong></span>
      <span>Feed source: <strong>${dns.source === 'file' || browser.source === 'file' ? 'published feeds' : 'baseline'}</strong></span>${FEED_SOURCE_URL ? `\n      <span>Syncs from: <strong>${escapeHtml(FEED_SOURCE_URL)}</strong></span>` : ''}
      <span>Uptime: <strong>${escapeHtml(uptime)}</strong></span>
      <span>AI Radar: <strong>${ENABLE_AI ? 'enabled' : 'disabled'}</strong></span>
    </div>
  </div>

  <div class="card">
    <h2>📡 Local Feed Endpoints</h2>
    <p class="muted">Wire these into Home Assistant's AdGuard Home or Pi-hole add-on, into an Unbound resolver, or into a phone on this LAN:</p>
    <div class="feed"><span class="tag">DNS Feed</span><code>${feedUrl('/dns.txt', auth.credentialed)}</code><button data-copy="${feedUrl('/dns.txt', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">Browser Feed</span><code>${feedUrl('/browser.txt', auth.credentialed)}</code><button data-copy="${feedUrl('/browser.txt', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">Unbound Feed</span><code>${feedUrl('/unbound.conf', auth.credentialed)}</code><button data-copy="${feedUrl('/unbound.conf', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">Shadowrocket Feed</span><code>${feedUrl('/shadowrocket.conf', auth.credentialed)}</code><button data-copy="${feedUrl('/shadowrocket.conf', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">Privoxy Feed</span><code>${feedUrl('/privoxy.action', auth.credentialed)}</code><button data-copy="${feedUrl('/privoxy.action', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">BIND RPZ Feed</span><code>${feedUrl('/db.blockingmachine.rpz', auth.credentialed)}</code><button data-copy="${feedUrl('/db.blockingmachine.rpz', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">REST Status</span><code>${feedUrl('/v1/status', auth.credentialed)}</code><button data-copy="${feedUrl('/v1/status', auth.credentialed)}">Copy</button></div>
    <div class="feed"><span class="tag">Live Events</span><code>${feedUrl('/v1/events', auth.credentialed)}</code><button data-copy="${feedUrl('/v1/events', auth.credentialed)}">Copy</button></div>${auth.credentialed && currentToken() ? '\n    <p class="muted">A feed token is configured — the URLs above carry it, so they work as pasted. Keep them out of places you would not put a password.</p>' : ''}
  </div>

  <div class="card">
    <h2>🧾 Compiled Rules</h2>
    <p class="muted">Browse what the feeds currently serve.</p>
    <div class="row" style="gap:8px; margin-bottom:6px">
      <input id="rule-filter" placeholder="Filter rules…" />
      <span class="pill" id="filter-count">${compileStats.totalRules} rules</span>
    </div>
    <details class="rules" open>
      <summary id="sum-dns">DNS-level rules (first ${Math.min(60, dns.rules.length)} of ${dns.rules.length})</summary>
      <pre id="pre-dns">${dnsRulesPreview.join('\n') || '(empty)'}</pre>
    </details>
    <details class="rules">
      <summary id="sum-browser">Browser rules (first ${Math.min(60, browser.rules.length)} of ${browser.rules.length})</summary>
      <pre id="pre-browser">${browserRulesPreview.join('\n') || '(empty)'}</pre>
    </details>
  </div>

  <div class="card">
    <h2>🩺 Diagnostics</h2>
    <div class="kv">
      <span class="k">Service</span><span>Blockingmachine Home Assistant Add-on</span>
      <span class="k">Version</span><span>1.1.0</span>
      <span class="k">Port</span><span>${PORT}</span>
      <span class="k">Feed auth</span><span>${authModeLabel()}</span>
      <span class="k">Data directory</span><span>${escapeHtml(DATA_DIR)}</span>
      <span class="k">DNS feed</span><span>${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">Browser feed</span><span>${browser.source === 'file' ? 'published browser.txt' : 'baseline fallback'}</span>
      <span class="k">Unbound feed</span><span>${unboundZoneCount} local-zone rules rendered from the ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">Shadowrocket feed</span><span>${shadowrocketCount} DOMAIN-SUFFIX rules for a phone on this LAN, from the same ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">Privoxy feed</span><span>${privoxyCount} action-file patterns rendered from the same ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">BIND RPZ feed</span><span>${rpzCount} policy records rendered from the same ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
    </div>
    <div class="meta-line"><a class="btn secondary" id="status-link" href="v1/status" target="_blank" rel="noopener">Open raw status JSON</a></div>
  </div>

  <div class="card">
    <h2>🔐 LAN authentication</h2>
    <div class="kv">
      <span class="k">Mode</span><span id="auth-mode">${lanAuthMode === 'required' ? 'required' : 'open (compatibility)'}${ENV_FEED_TOKEN ? ' — overridden by the feed_token option' : ''}</span>
      <span class="k">Credential</span><span>${auth.credentialed && currentToken()
        ? `<code>${escapeHtml(currentToken())}</code> <button class="btn secondary" data-copy="${escapeHtml(currentToken())}">Copy</button>`
        : auth.credentialed ? 'none stored' : 'hidden — unlock with the token to reveal it'}</span>
    </div>
    <p class="muted">Required mode demands the token on every endpoint — feeds, API and this dashboard.
    Compatibility mode is for installs whose feed subscribers cannot carry a token.</p>
    <p class="muted">Changing mode is an admin operation: enter the management token (add-on Log or
    <code>.admin_token</code> in the data dir). It is used for this tab only, sent as a header, and never stored.</p>
    <form id="admin-form" autocomplete="off">
      <div class="meta-line">
        <input id="admin-token" name="admin-token" type="password" placeholder="Admin token" autocomplete="current-password"
          style="flex:1;min-width:200px;padding:9px 12px;border-radius:10px;border:1px solid #334;background:#0d1117;color:#e6edf3;font:inherit">
      </div>
      <div class="meta-line">
        <button class="btn secondary" id="auth-required" type="submit" value="required">Require token (recommended)</button>
        <button class="btn secondary" id="auth-open" type="submit" value="open">Compatibility mode</button>
      </div>
    </form>
  </div>

  <div class="toast" id="toast"></div>

<script>
(function () {
  'use strict';
  var toastTimer = null;
  function toast(msg, isError) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' err' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3800);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      copyText(btn.getAttribute('data-copy')).then(function () {
        toast('Copied to clipboard');
      }).catch(function () { toast('Copy failed', true); });
    });
  });

  // Under Home Assistant Ingress the page lives at /api/hassio_ingress/<token>/ —
  // a root-relative '/v1/...' would escape that prefix and hit HA core, which
  // answers '404: Not Found' (plain text, not JSON — hence a SyntaxError toast).
  // Resolve every call against the page's own base so both ingress and direct
  // hosting land on this server. baseURI carries the query string, so split it
  // off first; a ?token= the user opened the dashboard with rides along on the
  // API calls so a token-gated install stays usable.
  // (No regex for the trailing slash: this script lives inside a JS template
  // literal where '\/' collapses to '/', which would leave '//' — a comment.)
  var apiBase = document.baseURI.split(/[?#]/)[0];
  if (apiBase.slice(-1) !== '/') apiBase += '/';
  var apiQuery = '';
  try {
    var tokenParam = new URLSearchParams(window.location.search).get('token');
    if (tokenParam) apiQuery = '?token=' + encodeURIComponent(tokenParam);
  } catch (e) { /* ancient WebView: leave apiQuery empty */ }

  var statusLink = document.getElementById('status-link');
  if (statusLink) statusLink.href = apiBase + 'v1/status' + apiQuery;

  var compileBtn = document.getElementById('compile-btn');
  compileBtn.addEventListener('click', function () {
    compileBtn.disabled = true;
    compileBtn.textContent = 'Compiling…';
    fetch(apiBase + 'v1/compile' + apiQuery, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success) {
          toast(data.message || 'Compilation complete');
          window.setTimeout(function () { window.location.reload(); }, 1400);
        } else {
          toast(data.message || 'Compilation failed', true);
        }
      })
      .catch(function (err) { toast('Compilation failed: ' + err, true); })
      .finally(function () {
        compileBtn.disabled = false;
        compileBtn.textContent = '⚡ Compile Rules Now';
      });
  });

  // The admin credential lives in sessionStorage — tab-scoped, cleared on close,
  // never persisted to disk, sent header-only (never on the URL).
  function adminToken() {
    try { return sessionStorage.getItem('bm_admin') || ''; } catch (e) { return ''; }
  }
  var adminField = document.getElementById('admin-token');
  if (adminField) {
    try { adminField.value = sessionStorage.getItem('bm_admin') || ''; } catch (e) {}
    adminField.addEventListener('input', function () {
      try { sessionStorage.setItem('bm_admin', adminField.value.trim()); } catch (e) {}
    });
  }

  function setAuthMode(mode) {
    var headers = { 'Content-Type': 'application/json' };
    if (adminToken()) headers['X-Admin-Token'] = adminToken();
    fetch(apiBase + 'v1/auth-mode' + apiQuery, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ mode: mode })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error + (data.hint ? ' — ' + data.hint : '') || 'Mode change failed');
        toast(data.message || 'Auth mode updated');
        window.setTimeout(function () { window.location.reload(); }, 900);
      })
      .catch(function (err) { toast(String(err), true); });
  }
  var adminForm = document.getElementById('admin-form');
  if (adminForm) {
    adminForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      setAuthMode(ev.submitter && ev.submitter.value === 'open' ? 'open' : 'required');
    });
  }

  var protectionToggle = document.getElementById('protection-toggle');
  protectionToggle.addEventListener('change', function () {
    var enable = protectionToggle.checked;
    fetch(apiBase + 'v1/protection' + apiQuery, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enable })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (!data.success) throw new Error(data.error || 'Toggle failed');
      var pill = document.getElementById('protection-pill');
      pill.textContent = enable ? 'Protecting' : 'Paused';
      pill.className = 'pill ' + (enable ? 'ok' : 'warn');
      document.getElementById('protection-desc').textContent = enable
        ? 'Blocking feeds stay live for every device on this network.'
        : 'Blocking state paused — feeds still serve, and automations can react.';
      toast(enable ? 'Protection resumed' : 'Protection paused');
    }).catch(function (err) {
      protectionToggle.checked = !enable;
      toast(String(err), true);
    });
  });

  var dnsRules = ${inlineDnsRules};
  var browserRules = ${inlineBrowserRules};
  var PREVIEW_CAP = 60;
  var filterInput = document.getElementById('rule-filter');
  var filterCount = document.getElementById('filter-count');
  var preDns = document.getElementById('pre-dns');
  var preBrowser = document.getElementById('pre-browser');
  var sumDns = document.getElementById('sum-dns');
  var sumBrowser = document.getElementById('sum-browser');
  function renderGroup(pre, sum, name, rules, q) {
    var matches = q ? rules.filter(function (r) { return r.toLowerCase().indexOf(q) !== -1; }) : rules;
    pre.textContent = matches.slice(0, PREVIEW_CAP).join('\\n') || '(empty)';
    sum.textContent = name + ' (' + (q ? '' : 'first ') + Math.min(PREVIEW_CAP, matches.length) + ' of ' + matches.length + (q ? ' matching' : '') + ')';
    return matches.length;
  }
  filterInput.addEventListener('input', function () {
    var q = filterInput.value.trim().toLowerCase();
    var dnsMatches = renderGroup(preDns, sumDns, 'DNS-level rules', dnsRules, q);
    var browserMatches = renderGroup(preBrowser, sumBrowser, 'Browser rules', browserRules, q);
    var total = dnsMatches + browserMatches;
    filterCount.textContent = q ? total + ' match' + (total === 1 ? '' : 'es') : (dnsRules.length + browserRules.length) + ' rules';
  });

  // Live updates: refresh when a compile or protection change lands anywhere
  if (window.EventSource) {
    try {
      var es = new EventSource(apiBase + 'v1/events' + apiQuery);
      es.addEventListener('compile_completed', function () {
        window.setTimeout(function () { window.location.reload(); }, 1200);
      });
      es.addEventListener('protection_changed', function (ev) {
        try {
          var state = JSON.parse(ev.data);
          protectionToggle.checked = Boolean(state.enabled && (!state.pausedUntil || state.pausedUntil > Date.now()));
        } catch (e) { /* ignore malformed event */ }
      });
    } catch (e) { /* SSE unavailable — page still works */ }
  }
})();
</script>
</main>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // POST is deliberately absent: a cross-origin fetch carrying a JSON content
  // type must preflight, and a preflight that doesn't offer POST never becomes
  // a real request. The dashboard's calls are same-origin (through ingress or
  // direct), so they never consult this header — only a drive-by page's would.
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let pathname;
  let reqUrl;
  try {
    reqUrl = new URL(req.url || '/', 'http://localhost');
    pathname = decodeURIComponent(reqUrl.pathname).toLowerCase();
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Bad Request: Malformed URI' }));
    return;
  }

  // Everything is gated while a token is enforced ('required' mode or a
  // configured `feed_token` option) — feeds, API and the dashboard alike, because
  // the dashboard embeds rule previews and the feed URLs. The token is
  // deliberately the only credential: an `X-Ingress-Path` header marks a request
  // that came through Home Assistant's ingress proxy, but the same header is
  // trivially set by anything that can reach this port directly, so it cannot be
  // the trust boundary on a network that is not trusted.
  const auth = authorizeRequest(req, reqUrl);
  // The admin credential is a control-plane secret, not a data-plane one — but
  // it is the STRONGER credential, so it satisfies the request gate for the one
  // endpoint that needs it (otherwise a required-mode install would demand the
  // feed token just to reach its own admin switch).
  const adminAuthorized = pathname === '/v1/auth-mode' && isAdminRequest(req);
  if (!auth.ok && !adminAuthorized) {
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    rejectUnauthorized(res, pathname, wantsHtml);
    return;
  }
  // A browser that unlocked by typing the token gets a session cookie so the
  // dashboard keeps working without the ?token= query hanging around — and so
  // the URL (which lands in proxy/history logs) carries the credential once,
  // not on every click. HttpOnly + SameSite=Strict; no Secure flag so plain-HTTP
  // LAN installs still work (HA ingress re-encrypts externally when configured).
  if (auth.viaQuery) {
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${encodeURIComponent(currentToken())}; Path=/; HttpOnly; SameSite=Strict`);
  }

  // Every POST endpoint here consumes a JSON body (compile takes {} now).
  // A browser cannot send `Content-Type: application/json` cross-origin without
  // a successful preflight — and the preflight no longer offers POST — so this
  // check is the wall against "simple request" (text/plain / form) drive-bys
  // from arbitrary web pages on installs running without a feed token. The
  // dashboard, the extension's telemetry reporter, and the mobile app all
  // declare application/json already.
  if (req.method === 'POST') {
    const contentType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'Unsupported Media Type — POST endpoints require Content-Type: application/json',
      }));
      return;
    }
  }

  // 1. Ingress UI / Dashboard (when accessed from the Home Assistant sidebar)
  if (pathname === '/' || pathname === '/index.html') {
    const { dns, browser } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderDashboard(dns, browser, auth));
    return;
  }

  // 2. REST API: /v1/status
  if (pathname === '/v1/status' || pathname === '/api/status') {
    const paused = protection.pausedUntil !== null && protection.pausedUntil > Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'online',
      service: 'Blockingmachine Home Assistant Add-on',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      rules: {
        total: compileStats.totalRules,
        dns: compileStats.dnsRules,
        browser: compileStats.browserRules,
        quarantinedThreats: compileStats.quarantinedThreats,
      },
      lastCompile: compileStats.lastCompile,
      lastCompileMs: compileStats.lastCompileMs,
      compileCount: compileStats.compileCount,
      autoCompile: AUTO_COMPILE,
      aiRadar: { enabled: ENABLE_AI },
      httpsFilter: {
        enabled: httpsFilter.enabled,
        running: httpsFilter.running,
        dataPort: httpsFilter.dataPort,
        authRequired: httpsFilter.authRequired,
        // The CA's SHA-256 fingerprint — the out-of-band value the phone's
        // install prompt is compared against (same string the desktop card shows).
        caSha256: httpsFilter.caSha256,
        error: httpsFilter.error,
      },
      dnsFilter: {
        enabled: dnsFilter.enabled,
        running: dnsFilter.running,
        port: dnsFilter.port,
        upstream: dnsFilter.upstream,
        error: dnsFilter.error,
        // Live query counters when running — the same DaemonStats shape the
        // desktop control API reports, so a router-level deployment can see
        // the filter working without shell access.
        stats: dnsDaemonRunning ? dnsDaemonRunning.dnsServer.getStats() : null,
      },
      feedServer: {
        port: PORT,
        requiresAuth: ENV_FEED_TOKEN ? true : lanAuthMode === 'required',
        authMode: ENV_FEED_TOKEN ? 'required' : lanAuthMode,
        envToken: Boolean(ENV_FEED_TOKEN),
        // Management credential is write-only — presence + proof only, never
        // the value, and never via a query parameter (admin creds stay out of URLs).
        adminConfigured: Boolean(adminToken),
        adminAuthorized: isAdminRequest(req),
        authPersisted: authPersistenceOk,
        // Deliberate credential disclosure to a caller that already proved it —
        // the unlocked dashboard uses it for the copy buttons. An open-mode
        // unauthenticated probe gets '' so the stored secret can't exfiltrate.
        feedToken: auth.credentialed ? currentToken() : '',
        dnsFeedUrl: feedUrl('/dns.txt', auth.credentialed),
        browserFeedUrl: feedUrl('/browser.txt', auth.credentialed),
        unboundFeedUrl: feedUrl('/unbound.conf', auth.credentialed),
        shadowrocketFeedUrl: feedUrl('/shadowrocket.conf', auth.credentialed),
        privoxyFeedUrl: feedUrl('/privoxy.action', auth.credentialed),
        bindRpzFeedUrl: feedUrl('/db.blockingmachine.rpz', auth.credentialed),
        eventsUrl: feedUrl('/v1/events', auth.credentialed),
      },
      protection: {
        enabled: protection.enabled && !paused,
        pausedUntil: paused ? protection.pausedUntil : null,
      },
      // Aggregated from POST /v1/telemetry/browser — zeroes until an extension
      // pointed at this add-on reports in, then real counters.
      browserTelemetry: {
        trackersBlocked: compileStats.browserTelemetry.trackersBlocked,
        elementsHidden: compileStats.browserTelemetry.elementsHidden,
        threatsDetected: compileStats.browserTelemetry.threatsDetected,
        recentTrackers: compileStats.browserTelemetry.recentTrackers,
        lastUpdated: compileStats.browserTelemetry.lastUpdated,
      },
    }, null, 2));
    return;
  }

  // 3. REST API: /v1/compile
  if (pathname === '/v1/compile' || pathname === '/api/compile') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      const result = await runCompile();
      res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ...result,
        stats: {
          total: compileStats.totalRules,
          dns: compileStats.dnsRules,
          browser: compileStats.browserRules,
        },
      }));
    });
    return;
  }

  // 4. Protection toggle (pause / resume blocking state)
  if (pathname === '/v1/protection' || pathname === '/v1/toggle') {
    // GET parity with the hub — LAN clients (mobile app, integrations) can read
    // the protection state without parsing it out of /v1/status.
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ enabled: protection.enabled, pausedUntil: protection.pausedUntil }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e4) req.destroy();
    });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        // A parser error message carries position/stack detail; the client gets the contract.
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Request body must be JSON' }));
        return;
      }
      if (typeof parsed.pauseMinutes === 'number' && parsed.pauseMinutes > 0 && parsed.pauseMinutes <= 1440) {
        protection = { enabled: true, pausedUntil: Date.now() + parsed.pauseMinutes * 60 * 1000 };
      } else if (typeof parsed.enabled === 'boolean') {
        protection = { enabled: parsed.enabled, pausedUntil: null };
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Provide {"enabled": true|false} or {"pauseMinutes": N}' }));
        return;
      }
      await persistJson(PROTECTION_PATH, protection);
      syncDnsProtection();
      broadcastSse('protection_changed', protection);
      log('info', `[Add-on Hub] Protection ${protection.enabled && protection.pausedUntil === null ? 'resumed' : 'paused'}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, protection }));
    });
    return;
  }

  // 4a2. Pin/bypass ledger — the engine's loopback control plane, proxied to
  // LAN clients (mobile app) that hit pinned-site failures through the data
  // port. The ledger names TLS hosts, so it lives behind the same auth gate as
  // every other /v1 read; the remove POST forwards the host verbatim like the
  // hub's own route does.
  if (pathname === '/v1/proxy/pins' || pathname === '/api/proxy/pins') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use GET.' }));
      return;
    }
    try {
      const upstream = await fetch(`${HTTPS_CONTROL_URL}/v1/proxy/pins`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'HTTPS filter engine is not running — pins are unavailable.' }));
    }
    return;
  }

  if (pathname === '/v1/proxy/pins/remove' || pathname === '/api/proxy/pins/remove') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    let pinsBody = '';
    req.on('data', (chunk) => {
      pinsBody += chunk;
      if (pinsBody.length > 1e4) req.destroy();
    });
    req.on('end', async () => {
      let host;
      try {
        host = JSON.parse(pinsBody || '{}').host;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Request body must be JSON' }));
        return;
      }
      const normalized = typeof host === 'string' ? host.trim() : '';
      if (normalized === '' || normalized.length > 253) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'pin-remove needs a non-empty hostname of at most 253 characters.' }));
        return;
      }
      try {
        const upstream = await fetch(`${HTTPS_CONTROL_URL}/v1/proxy/pins/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: normalized }),
          signal: AbortSignal.timeout(5_000),
        });
        const body = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'HTTPS filter engine is not running — pins are unavailable.' }));
      }
    });
    return;
  }

  // 4b. LAN auth mode — the migration/opt-out switch. Privileged: this endpoint
  // changes the install's trust posture, so it demands the admin credential in
  // BOTH modes — never the feed token, never the session cookie, never a header
  // an attacker can set. Check precedes any body parse or state touch, so a
  // refused request provably changes nothing.
  if (pathname === '/v1/auth-mode') {
    if (!isAdminRequest(req)) {
      rejectAdminRequired(res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e4) req.destroy();
    });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Request body must be JSON' }));
        return;
      }
      if (parsed.mode !== 'required' && parsed.mode !== 'open') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Mode must be "required" or "open"' }));
        return;
      }
      // Serialized and ordered: the credential is persisted BEFORE the mode
      // that requires it, so a crash between the two writes can never leave
      // 'required' recorded without its credential on disk.
      const result = await serializeAuthOp(async () => {
        let tokenMinted = false;
        if (parsed.mode === 'required' && !currentToken()) {
          await mintToken();
          tokenMinted = true;
        }
        lanAuthMode = parsed.mode;
        await writeAuthState(lanAuthMode);
        return { tokenMinted };
      });
      log('info', `[Add-on Hub] LAN auth mode set to '${lanAuthMode}'${ENV_FEED_TOKEN ? ' (feed_token option still enforces its own credential)' : ''}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        mode: lanAuthMode,
        tokenMinted: result.tokenMinted,
        envToken: Boolean(ENV_FEED_TOKEN),
        // Only an admin reached this point — echoing the current feed token is
        // safe and is what the caller needs to re-pair its clients after a flip.
        token: currentToken(),
        message: lanAuthMode === 'required'
          ? 'Required mode on — every endpoint now needs the token'
          : 'Compatibility mode on — a token is honoured when sent, never required',
      }));
    });
    return;
  }

  // 4c. Browser remote control — the same routes and the same `remote_control` SSE
  // contract the desktop hub serves, so an extension pointed at this add-on (and a
  // Home Assistant entity or the mobile app doing the pointing) can toggle cosmetic
  // filtering and force a rules reload without telling which server it is talking to.
  // The action lands on every browser subscribed to /v1/events.
  if (pathname === '/v1/control/cosmetics' || pathname === '/api/control/cosmetics') {
    // The hub's status query is an origin-gated stub; here the auth gate upstream
    // already decided who may ask, so the read is the same stub, same shape.
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, message: 'Cosmetics status query' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    let controlBody = '';
    req.on('data', (chunk) => {
      controlBody += chunk;
      if (controlBody.length > 1e4) req.destroy();
    });
    req.on('end', () => {
      let enabled = true;
      try {
        const data = JSON.parse(controlBody || '{}');
        if (typeof data.enabled === 'boolean') enabled = data.enabled;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
        return;
      }
      broadcastSse('remote_control', { action: 'toggle_cosmetics', enabled });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, action: 'toggle_cosmetics', enabled }));
    });
    return;
  }

  if (pathname === '/v1/control/reload' || pathname === '/api/control/reload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    broadcastSse('remote_control', { action: 'reload_rules' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      action: 'reload_rules',
      message: 'Reload signal broadcast to connected browsers',
    }));
    return;
  }

  // 5. Domain check — the same verdict a DNS consumer would get, resolved against the
  // live feed with the resolver's own semantics: longest matching host wins, so a
  // child allow survives a blocked parent just as it does in Unbound/Shadowrocket.
  if (pathname === '/v1/check' || pathname === '/api/check') {
    const domain = normalizeHost(reqUrl.searchParams.get('domain') || '');
    if (!domain) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Missing or invalid ?domain= parameter' }));
      return;
    }
    const dns = await loadFeed('dns.txt', defaultDnsRules);
    const verdicts = new Map();
    for (const line of dns.rules) {
      const parsed = hostFromRule(line);
      if (parsed) verdicts.set(parsed.host, parsed.allowed);
    }
    let host = domain;
    let matched = null;
    while (host.includes('.')) {
      if (verdicts.has(host)) {
        matched = { host, allowed: verdicts.get(host) };
        break;
      }
      host = host.slice(host.indexOf('.') + 1);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      domain,
      blocked: matched ? !matched.allowed : false,
      matchedHost: matched ? matched.host : null,
      source: dns.source,
    }));
    return;
  }

  // 6. Rule browser API (bounded, supports search)
  if (pathname === '/v1/rules') {
    const url = new URL(req.url || '/', 'http://localhost');
    const query = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const { dns, browser } = await recomputeStats();
    const all = [
      ...dns.rules.map((rule) => ({ rule, scope: 'dns' })),
      ...browser.rules.map((rule) => ({ rule, scope: 'browser' })),
    ];
    const filtered = query ? all.filter((r) => r.rule.toLowerCase().includes(query)) : all;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      total: filtered.length,
      offset,
      limit,
      rules: filtered.slice(offset, offset + limit),
    }));
    return;
  }

  // 6b. Telemetry — same route the hub serves so the mobile app's Telemetry tab
  // renders instead of erroring on a 404. The add-on has no AI quarantine
  // pipeline of its own, so threats is honestly empty; the browser counters are
  // the live aggregate extensions POST below.
  if (pathname === '/v1/telemetry' || pathname === '/api/telemetry') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      threats: [],
      history: compileStats.history,
      browser: compileStats.browserTelemetry,
    }));
    return;
  }

  // 6c. Browser telemetry intake — the same POST contract the hub implements, so
  // an extension pointed at the add-on (feedUrl = the add-on's address) reports
  // somewhere real instead of 404ing. Aggregation mirrors the hub: running
  // counters plus a 50-entry recent-trackers ring.
  if (pathname === '/v1/telemetry/browser' || pathname === '/api/telemetry/browser') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
      return;
    }
    let telemetryBody = '';
    req.on('data', (chunk) => {
      telemetryBody += chunk;
      if (telemetryBody.length > 1e6) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(telemetryBody || '{}');
        const agg = compileStats.browserTelemetry;
        if (typeof data.trackersBlocked === 'number' && Number.isFinite(data.trackersBlocked)) {
          agg.trackersBlocked += Math.max(0, Math.floor(data.trackersBlocked));
        }
        if (typeof data.elementsHidden === 'number' && Number.isFinite(data.elementsHidden)) {
          agg.elementsHidden += Math.max(0, Math.floor(data.elementsHidden));
        }
        if (typeof data.threatsDetected === 'number' && Number.isFinite(data.threatsDetected)) {
          agg.threatsDetected += Math.max(0, Math.floor(data.threatsDetected));
        }
        if (Array.isArray(data.trackers)) {
          for (const t of data.trackers) {
            if (typeof t?.domain !== 'string' || !t.domain.trim() || t.domain.length > 253) continue;
            const domain = t.domain.trim().toLowerCase();
            const count = typeof t.count === 'number' && Number.isFinite(t.count) && t.count > 0 ? Math.floor(t.count) : 1;
            const existing = agg.recentTrackers.find((x) => x.domain === domain);
            if (existing) existing.count += count;
            else agg.recentTrackers.unshift({ domain, count });
          }
          agg.recentTrackers = agg.recentTrackers.slice(0, 50);
        }
        agg.lastUpdated = new Date().toISOString();
        await persistJson(STATS_PATH, compileStats);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, aggregated: agg }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Invalid JSON' }));
      }
    });
    return;
  }

  // 6. Server-Sent Events for live Home Assistant automations
  if (pathname === '/v1/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* dropped */ }
    }, 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  // 7. DNS-Only Feed: /dns.txt
  if (pathname === '/dns.txt' || pathname === '/adguarddns.txt') {
    const { dns } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(dns.rules.join('\n') + '\n');
    return;
  }

  // 8. Browser-Only Feed: /browser.txt
  if (pathname === '/browser.txt' || pathname === '/adguardbrowser.txt') {
    const { browser } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(browser.rules.join('\n') + '\n');
    return;
  }

  // 9. Unbound Feed: /unbound.conf
  //
  // Unbound cannot subscribe to the DNS feed's ABP syntax, so the same rules are rendered as the
  // `local-zone` statements a drop-in file needs.
  if (
    pathname === '/unbound.conf' ||
    pathname === '/unbound.txt' ||
    pathname === '/blockingmachine.conf'
  ) {
    const { dns } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(renderUnboundFeed(dns.rules));
    return;
  }

  // 10. Shadowrocket Feed: /shadowrocket.conf
  //
  // A phone cannot read a DNS or hosts feed, and the desktop hub's feed only answers while that
  // process is running. The add-on is already a long-lived service on the same LAN, so the rule set
  // is served from here and a phone subscribes to the add-on rather than to a laptop.
  if (
    pathname === '/shadowrocket.conf' ||
    pathname === '/shadowrocket.txt' ||
    pathname === '/ruleset.conf'
  ) {
    const { dns } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(renderShadowrocketFeed(dns.rules));
    return;
  }

  // 11. Privoxy Feed: /privoxy.action
  //
  // Privoxy reads a local action file, never a URL — the `actionsfile` directive takes a path — so
  // this feed is transport for the copy step, the way the desktop feed is. The difference is which
  // host answers: the add-on renders the action file from the DNS feed itself, so it serves a real
  // artifact whatever export format the desktop is set to, and it answers while the desktop is off.
  if (
    pathname === '/privoxy.action' ||
    pathname === '/privoxy.txt' ||
    pathname === '/blockingmachine.action'
  ) {
    const { dns } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(renderPrivoxyFeed(dns.rules));
    return;
  }

  // 12. BIND RPZ Feed: /db.blockingmachine.rpz
  //
  // BIND has no remote blocklist feature either — the zone file is a local artifact that has to be
  // copied and `rndc reload`ed. Same transport role as the Privoxy feed: the add-on renders the
  // policy records (with the SOA a zone cannot load without, and the wildcard pair a bare trigger
  // needs) from the DNS feed, so the resolver's cron fetches from a host that stays up.
  if (
    pathname === '/db.blockingmachine.rpz' ||
    pathname === '/bind.rpz' ||
    pathname === '/rpz.blockingmachine'
  ) {
    const { dns } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(renderBindRpzFeed(dns.rules));
    return;
  }

  // Default fallback
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

// Bounded SSE registry: drop clients beyond a sane cap
setInterval(() => {
  if (sseClients.size > 100) {
    const excess = Array.from(sseClients).slice(0, sseClients.size - 100);
    for (const client of excess) {
      try { client.end(); } catch { /* already gone */ }
      sseClients.delete(client);
    }
  }
}, 60_000).unref?.();

await loadPersistedState();
await recomputeStats();
// LAN auth posture resolves before the first accepted connection — never after.
await initLanAuth();

// ─── HTTPS-filter engine ────────────────────────────────────────────────────
// Same engine the desktop hub runs (packages/https-filter), shipped bundled as
// engine.mjs. Phones point a Wi-Fi proxy/PAC at :9294 or splice to it over
// PROXY-v2; the read-only enrollment routes (/ca.pem, /ca.mobileconfig,
// /proxy.pac) carry the CA. A failed start degrades honestly — the feed
// server keeps running without it and /v1/status reports the error.
const httpsFilter = {
  enabled: HTTPS_FILTER_ENABLED,
  running: false,
  dataPort: HTTPS_DATA_PORT,
  authRequired: HTTPS_DATA_TOKEN !== '',
  caSha256: null,
  error: null,
};
let filterProxyRunning = null;

/** SHA-256 over the CA's DER, `AA:BB:…` — the same rendering the desktop and mobile fingerprint gates show. */
function caFingerprint256(certPem) {
  const m = /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END CERTIFICATE-----/.exec(certPem || '');
  if (!m) return null;
  return createHash('sha256')
    .update(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'))
    .digest('hex')
    .toUpperCase()
    .match(/../g)
    .join(':');
}

/** POST the rules-reload routes on both loopback control listeners — fire-and-forget after each compile. */
async function reloadFilterRules() {
  if (filterProxyRunning) {
    try {
      // The engine's control plane gates every POST on Content-Type:
      // application/json (same drive-by rule as this server) — a bare fetch 415s.
      const res = await fetch(`${HTTPS_CONTROL_URL}/v1/proxy/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) log('warning', `[Add-on Hub] filter reload answered ${res.status}`);
    } catch (err) {
      log('warning', '[Add-on Hub] filter reload failed:', err instanceof Error ? err.message : err);
    }
  }
  if (dnsDaemonRunning) {
    try {
      const res = await fetch(`http://127.0.0.1:${DNS_CONTROL_PORT}/v1/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) log('warning', `[Add-on Hub] DNS reload answered ${res.status}`);
    } catch (err) {
      log('warning', '[Add-on Hub] DNS reload failed:', err instanceof Error ? err.message : err);
    }
  }
}

if (HTTPS_FILTER_ENABLED) {
  try {
    const { startFilterProxy } = await import('./engine.mjs');
    filterProxyRunning = await startFilterProxy({
      storeDir: join(DATA_DIR, 'https-filter'),
      bindHost: '0.0.0.0',
      dataPort: HTTPS_DATA_PORT,
      controlPort: HTTPS_CONTROL_PORT,
      rulesPath: join(DATA_DIR, 'engine-rules.txt'),
      dataAuthToken: HTTPS_DATA_TOKEN || undefined,
    });
    httpsFilter.running = true;
    httpsFilter.caSha256 = caFingerprint256(filterProxyRunning.authority.caCertPem);
    log(
      'info',
      `[Blockingmachine Add-on] HTTPS filter on :${HTTPS_DATA_PORT} — ` +
        `${HTTPS_DATA_TOKEN ? 'token required' : 'open-LAN (no token — set https_data_token to require one)'}`,
    );
  } catch (err) {
    httpsFilter.error = err instanceof Error ? err.message : String(err);
    log('error', '[Blockingmachine Add-on] HTTPS filter failed to start — feeds/API continue without it:', httpsFilter.error);
  }
}

// ─── Filtering DNS resolver ─────────────────────────────────────────────────
// The desktop's system daemon, embedded. LAN clients (via the router's DHCP
// DNS option) query it directly — blocked names sinkhole or NXDOMAIN, allowed
// ones forward over the configured DoH upstream. Its own control API binds
// loopback only: the query log it exposes is the LAN's browsing history.
const dnsFilter = {
  enabled: DNS_FILTER_ENABLED,
  running: false,
  port: DNS_PORT,
  upstream: DNS_UPSTREAM,
  error: null,
};
let dnsDaemonRunning = null;
let dnsPauseTimer = null;

/** The add-on's protection toggle is the daemon's too — including timed-pause expiry. */
function syncDnsProtection() {
  if (!dnsDaemonRunning) return;
  const active = protection.enabled && (protection.pausedUntil === null || protection.pausedUntil > Date.now());
  dnsDaemonRunning.dnsServer.setProtection(active);
  if (dnsPauseTimer) clearTimeout(dnsPauseTimer);
  if (protection.pausedUntil !== null && protection.pausedUntil > Date.now()) {
    dnsPauseTimer = setTimeout(syncDnsProtection, protection.pausedUntil - Date.now() + 250);
    dnsPauseTimer.unref?.();
  }
}

if (DNS_FILTER_ENABLED) {
  try {
    const { startDaemon } = await import('./dns-daemon.mjs');
    const token = currentToken();
    dnsDaemonRunning = await startDaemon({
      bindHost: '0.0.0.0',
      dnsPort: DNS_PORT,
      controlPort: DNS_CONTROL_PORT,
      controlBindHost: '127.0.0.1',
      upstreamDoHUrl: DNS_UPSTREAM,
      sinkholeIpv4: '0.0.0.0',
      sinkholeIpv6: '::',
      // Rules come from this add-on's own compiled feed — token carried when
      // auth is on, the on-disk file as the fallback snapshot.
      feedUrl: `http://127.0.0.1:${PORT}/dns.txt${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      feedFile: join(DATA_DIR, 'dns.txt'),
      observationsFile: join(DATA_DIR, 'observations.jsonl'),
      embedded: true,
    });
    dnsFilter.running = true;
    syncDnsProtection();
    log('info', `[Blockingmachine Add-on] DNS resolver on :${DNS_PORT} (UDP+TCP) — upstream ${DNS_UPSTREAM}`);
  } catch (err) {
    dnsFilter.error = err instanceof Error ? err.message : String(err);
    log('error', '[Blockingmachine Add-on] DNS resolver failed to start — feeds/API continue without it:', dnsFilter.error);
  }
}

process.on('SIGTERM', () => {
  const closing = filterProxyRunning?.close() ?? Promise.resolve();
  dnsDaemonRunning?.dnsServer.stop();
  dnsDaemonRunning?.controlServer.close();
  void closing.finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', `[Blockingmachine Add-on] Hub listening on http://0.0.0.0:${PORT}`);
  log('info', `[Blockingmachine Add-on] Serving ${compileStats.totalRules} rules (${compileStats.dnsRules} DNS / ${compileStats.browserRules} browser)`);
  startAutoCompileScheduler();
});
