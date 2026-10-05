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
import { timingSafeEqual } from 'node:crypto';
import { renderUnboundFeed, rulesToUnboundZones } from './unboundFeed.js';
import { renderShadowrocketFeed, shadowrocketHostCount } from './shadowrocketFeed.js';
import { renderPrivoxyFeed, privoxyPatternCount } from './privoxyFeed.js';
import { renderBindRpzFeed, bindRpzRecordCount } from './bindFeed.js';
import { hostFromRule, normalizeHost } from './hostRules.js';

const PORT = parseInt(process.env.FEED_PORT || '9191', 10);
const DATA_DIR = process.env.DATA_DIR || '/data/blockingmachine';
const AUTO_COMPILE = process.env.AUTO_COMPILE || '24h';
const ENABLE_AI = process.env.ENABLE_AI !== 'false';
const STARTED_AT = Date.now();

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
const FEED_TOKEN = (process.env.FEED_TOKEN || '').trim();

/** Constant-time comparison — the token is a credential, not a label. */
function tokenMatches(candidate) {
  if (!candidate || !FEED_TOKEN) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(FEED_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(req, url) {
  if (!FEED_TOKEN) return true;
  if (tokenMatches(url.searchParams.get('token'))) return true;

  const header = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer && tokenMatches(bearer[1].trim())) return true;

  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    // `user:token` is the standard shape; a bare `token` or `token:` is accepted because some
    // fetchers hand the credential over without a username.
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    if (tokenMatches(password) || tokenMatches(decoded)) return true;
  }
  return false;
}

/** Rejects with a Basic challenge so browsers, curl and feed fetchers can answer it. */
function rejectUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Blockingmachine feeds", charset="UTF-8"',
  });
  res.end(JSON.stringify({ error: 'Unauthorized — a feed token is configured on this add-on' }));
}

/**
 * The URL the dashboard should print for a feed path, token included when one is configured.
 * The page itself is behind the same check, so anyone who can read the rendered URL already knows
 * the token — and a copied URL that lacks it would simply fail to fetch.
 */
function feedUrl(path) {
  const base = `http://homeassistant.local:${PORT}${path}`;
  return FEED_TOKEN ? `${base}?token=${encodeURIComponent(FEED_TOKEN)}` : base;
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

/** @type {{ lastCompile: string|null, lastCompileMs: number|null, totalRules: number, dnsRules: number, browserRules: number, quarantinedThreats: number, compileCount: number }} */
let compileStats = {
  lastCompile: null,
  lastCompileMs: null,
  totalRules: 0,
  dnsRules: 0,
  browserRules: 0,
  quarantinedThreats: 0,
  compileCount: 0,
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
    console.error(`[Add-on Hub] Failed to persist ${path}:`, err);
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
    console.error('[Add-on Hub] Failed to load persisted state:', err);
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
    console.error(`[Add-on Hub] Failed to read ${feedPath}:`, err);
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
    // The add-on consumes feeds prepared by the desktop app / sync pipeline.
    // Compilation here = refresh stats from disk, stamp the ledger, notify.
    const { dns, browser } = await recomputeStats();
    compileStats.lastCompile = new Date().toISOString();
    compileStats.lastCompileMs = Date.now() - startedAt;
    compileStats.compileCount += 1;
    await persistJson(STATS_PATH, compileStats);
    broadcastSse('compile_completed', {
      total: compileStats.totalRules,
      dns: compileStats.dnsRules,
      browser: compileStats.browserRules,
      durationMs: compileStats.lastCompileMs,
    });
    const sourceNote = dns.source === 'baseline' && browser.source === 'baseline'
      ? ' (baseline rules — run a compile from the Blockingmachine desktop app to publish full feeds)'
      : '';
    return {
      success: true,
      message: `Compiled ${compileStats.totalRules} rules (${compileStats.dnsRules} DNS, ${compileStats.browserRules} browser) in ${compileStats.lastCompileMs}ms${sourceNote}`,
      durationMs: compileStats.lastCompileMs || 0,
    };
  } catch (err) {
    console.error('[Add-on Hub] Compile failed:', err);
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
    console.log(`[Add-on Hub] Auto-compile tick (${AUTO_COMPILE} schedule)`);
    runCompile()
      .then((res) => console.log(`[Add-on Hub] Auto-compile: ${res.message}`))
      .catch(() => {});
  }, intervalMs);
  timer.unref?.();
  console.log(`[Add-on Hub] Auto-compile scheduled every ${periodHours}h`);
}

// ─── Ingress dashboard UI ─────────────────────────────────────────────────────

function renderDashboard(dns, browser) {
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

  const inlineRules = JSON.stringify([...dns.rules, ...browser.rules].slice(0, 5000)).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  h2 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .muted { color: var(--secondary-text-color, #94a3b8); font-size: 13px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .btn {
    background: var(--accent-color, #0284c7); color: var(--card-background-color, #fff); border: none;
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
      <span>Feed source: <strong>${dns.source === 'file' || browser.source === 'file' ? 'published feeds' : 'baseline'}</strong></span>
      <span>Uptime: <strong>${escapeHtml(uptime)}</strong></span>
      <span>AI Radar: <strong>${ENABLE_AI ? 'enabled' : 'disabled'}</strong></span>
    </div>
  </div>

  <div class="card">
    <h2>📡 Local Feed Endpoints</h2>
    <p class="muted">Wire these into Home Assistant's AdGuard Home or Pi-hole add-on, into an Unbound resolver, or into a phone on this LAN:</p>
    <div class="feed"><span class="tag">DNS Feed</span><code>${feedUrl('/dns.txt')}</code><button data-copy="${feedUrl('/dns.txt')}">Copy</button></div>
    <div class="feed"><span class="tag">Browser Feed</span><code>${feedUrl('/browser.txt')}</code><button data-copy="${feedUrl('/browser.txt')}">Copy</button></div>
    <div class="feed"><span class="tag">Unbound Feed</span><code>${feedUrl('/unbound.conf')}</code><button data-copy="${feedUrl('/unbound.conf')}">Copy</button></div>
    <div class="feed"><span class="tag">Shadowrocket Feed</span><code>${feedUrl('/shadowrocket.conf')}</code><button data-copy="${feedUrl('/shadowrocket.conf')}">Copy</button></div>
    <div class="feed"><span class="tag">Privoxy Feed</span><code>${feedUrl('/privoxy.action')}</code><button data-copy="${feedUrl('/privoxy.action')}">Copy</button></div>
    <div class="feed"><span class="tag">BIND RPZ Feed</span><code>${feedUrl('/db.blockingmachine.rpz')}</code><button data-copy="${feedUrl('/db.blockingmachine.rpz')}">Copy</button></div>
    <div class="feed"><span class="tag">REST Status</span><code>${feedUrl('/v1/status')}</code><button data-copy="${feedUrl('/v1/status')}">Copy</button></div>
    <div class="feed"><span class="tag">Live Events</span><code>${feedUrl('/v1/events')}</code><button data-copy="${feedUrl('/v1/events')}">Copy</button></div>${FEED_TOKEN ? '\n    <p class="muted">A feed token is configured — the URLs above carry it, so they work as pasted. Keep them out of places you would not put a password.</p>' : ''}
  </div>

  <div class="card">
    <h2>🧾 Compiled Rules</h2>
    <p class="muted">Browse what the feeds currently serve.</p>
    <div class="row" style="gap:8px; margin-bottom:6px">
      <input id="rule-filter" placeholder="Filter rules…" />
      <span class="pill" id="filter-count">${compileStats.totalRules} rules</span>
    </div>
    <details class="rules" open>
      <summary>DNS-level rules (first ${Math.min(60, dns.rules.length)} of ${dns.rules.length})</summary>
      <pre>${dnsRulesPreview.join('\n') || '(empty)'}</pre>
    </details>
    <details class="rules">
      <summary>Browser rules (first ${Math.min(60, browser.rules.length)} of ${browser.rules.length})</summary>
      <pre>${browserRulesPreview.join('\n') || '(empty)'}</pre>
    </details>
  </div>

  <div class="card">
    <h2>🩺 Diagnostics</h2>
    <div class="kv">
      <span class="k">Service</span><span>Blockingmachine Home Assistant Add-on</span>
      <span class="k">Version</span><span>1.1.0</span>
      <span class="k">Port</span><span>${PORT}</span>
      <span class="k">Feed auth</span><span>${FEED_TOKEN ? 'token required on every endpoint' : 'open (LAN trust)'}</span>
      <span class="k">Data directory</span><span>${escapeHtml(DATA_DIR)}</span>
      <span class="k">DNS feed</span><span>${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">Browser feed</span><span>${browser.source === 'file' ? 'published browser.txt' : 'baseline fallback'}</span>
      <span class="k">Unbound feed</span><span>${unboundZoneCount} local-zone rules rendered from the ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">Shadowrocket feed</span><span>${shadowrocketCount} DOMAIN-SUFFIX rules for a phone on this LAN, from the same ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">Privoxy feed</span><span>${privoxyCount} action-file patterns rendered from the same ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
      <span class="k">BIND RPZ feed</span><span>${rpzCount} policy records rendered from the same ${dns.source === 'file' ? 'published dns.txt' : 'baseline fallback'}</span>
    </div>
    <div class="meta-line"><a class="btn secondary" href="/v1/status" target="_blank" rel="noopener">Open raw status JSON</a></div>
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

  var compileBtn = document.getElementById('compile-btn');
  compileBtn.addEventListener('click', function () {
    compileBtn.disabled = true;
    compileBtn.textContent = 'Compiling…';
    fetch('/v1/compile', { method: 'POST' })
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

  var protectionToggle = document.getElementById('protection-toggle');
  protectionToggle.addEventListener('change', function () {
    var enable = protectionToggle.checked;
    fetch('/v1/protection', {
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

  var allRules = ${inlineRules};
  var filterInput = document.getElementById('rule-filter');
  var filterCount = document.getElementById('filter-count');
  filterInput.addEventListener('input', function () {
    var q = filterInput.value.trim().toLowerCase();
    if (!q) { filterCount.textContent = allRules.length + ' rules'; return; }
    var matches = allRules.filter(function (r) { return r.toLowerCase().indexOf(q) !== -1; });
    filterCount.textContent = matches.length + ' match' + (matches.length === 1 ? '' : 'es');
  });

  // Live updates: refresh when a compile or protection change lands anywhere
  if (window.EventSource) {
    try {
      var es = new EventSource('/v1/events');
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
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // Everything is gated when a feed token is configured — feeds, API and the dashboard alike,
  // because the dashboard embeds rule previews and the feed URLs. The token is deliberately the
  // only credential: an `X-Ingress-Path` header marks a request that came through Home
  // Assistant's ingress proxy, but the same header is trivially set by anything that can reach
  // this port directly, so it cannot be the trust boundary on a network that is not trusted.
  if (!isAuthorized(req, reqUrl)) {
    rejectUnauthorized(res);
    return;
  }

  // 1. Ingress UI / Dashboard (when accessed from the Home Assistant sidebar)
  if (pathname === '/' || pathname === '/index.html') {
    const { dns, browser } = await recomputeStats();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderDashboard(dns, browser));
    return;
  }

  // 2. REST API: /v1/status
  if (pathname === '/v1/status' || pathname === '/api/status') {
    const paused = protection.pausedUntil !== null && protection.pausedUntil > Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'online',
      service: 'Blockingmachine Home Assistant Add-on',
      version: '1.1.0',
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
      feedServer: {
        port: PORT,
        requiresAuth: Boolean(FEED_TOKEN),
        dnsFeedUrl: feedUrl('/dns.txt'),
        browserFeedUrl: feedUrl('/browser.txt'),
        unboundFeedUrl: feedUrl('/unbound.conf'),
        shadowrocketFeedUrl: feedUrl('/shadowrocket.conf'),
        privoxyFeedUrl: feedUrl('/privoxy.action'),
        bindRpzFeedUrl: feedUrl('/db.blockingmachine.rpz'),
        eventsUrl: feedUrl('/v1/events'),
      },
      protection: {
        enabled: protection.enabled && !paused,
        pausedUntil: paused ? protection.pausedUntil : null,
      },
      // The add-on has no browser clients reporting to it — the counters are honestly
      // zero here rather than absent, so the integration's telemetry sensors stay
      // meaningful instead of silently reading an undefined object.
      browserTelemetry: { trackersBlocked: 0, elementsHidden: 0, threatsDetected: 0 },
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
      try {
        const parsed = JSON.parse(body || '{}');
        if (typeof parsed.pauseMinutes === 'number' && parsed.pauseMinutes > 0 && parsed.pauseMinutes <= 1440) {
          protection = { enabled: true, pausedUntil: Date.now() + parsed.pauseMinutes * 60 * 1000 };
        } else if (typeof parsed.enabled === 'boolean') {
          protection = { enabled: parsed.enabled, pausedUntil: null };
        } else {
          throw new Error('Provide {"enabled": true|false} or {"pauseMinutes": N}');
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      await persistJson(PROTECTION_PATH, protection);
      broadcastSse('protection_changed', protection);
      console.log(`[Add-on Hub] Protection ${protection.enabled && protection.pausedUntil === null ? 'resumed' : 'paused'}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, protection }));
    });
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
    while (!matched && host.includes('.')) {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Blockingmachine Add-on] Hub listening on http://0.0.0.0:${PORT}`);
  console.log(`[Blockingmachine Add-on] Serving ${compileStats.totalRules} rules (${compileStats.dnsRules} DNS / ${compileStats.browserRules} browser)`);
  startAutoCompileScheduler();
});
