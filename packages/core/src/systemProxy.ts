/**
 * OS system-proxy read/plan/apply/revert (P7, flag 123) — the capture-free
 * coverage layer: point the OS HTTP(S) proxy or PAC auto-config URL at the
 * loopback engine (`127.0.0.1:9294`) and every proxy-aware app gets the
 * engine's CONNECT/plain-HTTP filtering with zero kernel surface, no service
 * account, and no driver. Apps that do not honor the system proxy bypass by
 * design — that is the honest coverage bound, not a bug.
 *
 * The writers live in `core` for the same reason the trust-store ops do: the
 * engine may run under a dedicated service user (capture installs), so OS
 * proxy writes are a user-session operation owned by the app/CLI.
 *
 * Semantics verified/recorded per platform:
 *
 * darwin (`networksetup`, verified live on this machine 2026-10-27 against a
 * non-primary service): `-listallnetworkservices` prints an asterisk legend
 * then one service per line, `*` prefix = disabled; `-getwebproxy`/
 * `-getsecurewebproxy` answer `Enabled: Yes|No` + `Server:` + `Port:` +
 * `Authenticated Proxy Enabled: n`; `-getautoproxyurl` answers `URL:` +
 * `Enabled:`; `-getproxybypassdomains` answers one domain per line. The set
 * verbs need no admin for an admin user (configd authorizes the write);
 * `-setwebproxy`/`-setsecurewebproxy`/`-setautoproxyurl` enable implicitly,
 * `-*proxystate <svc> off` disables while leaving server/URL residue (a
 * disabled proxy keeps its stale values — exact revert re-writes the stale
 * values first, then disables), `-setproxybypassdomains … Empty` clears.
 * Authorization-worded failures still map to `needs-admin` — non-admin
 * accounts and policy-locked contexts exist.
 *
 * win32 (`reg`, HKCU — per-user hive, no admin): the Internet Settings key
 * holds `ProxyEnable` (REG_DWORD), `ProxyServer` (REG_SZ `host:port`),
 * `ProxyOverride` (REG_SZ `;`-list), `AutoConfigURL` (REG_SZ). Whole-key
 * `reg query` prints every value; absent values are simply missing lines.
 * Registry writes do not notify already-running WinINet clients — the apply
 * message names the app-restart caveat honestly. Verified by runner-mock
 * only (this host is darwin) — the ledger records it.
 *
 * linux (`gsettings`, GNOME `org.gnome.system.proxy`): `mode` is
 * `none|manual|auto`; `manual` reads `org.gnome.system.proxy.http|https`
 * host/port, `auto` reads `autoconfig-url`, `ignore-hosts` is the bypass
 * GVariant list. `list-recursively` renders `schema key value` lines.
 * Tool-missing and `No such schema` both answer `unsupported`. nmcli has no
 * proxy surface (verified — `nmcli connection` carries no proxy keys), so
 * gsettings is the only linux writer; KDE's kioslaverc is a named gap.
 *
 * Reversion posture: apply snapshots full prior state BEFORE the first
 * write; revert re-reads current state and restores exactly what was
 * recorded — and only when current still equals what we wrote
 * (`stateMatchesConfig`). A drifted state means the user owns it now →
 * `skipped-foreign`, never a revert under someone else's settings.
 */

import { defaultPlatformRunner } from "./caTrustStore.js";
import type { PlatformRunner, PlatformRunResult } from "./caTrustStore.js";

/** The coverage modes the OS write can take — fixed proxy or PAC auto-config URL. */
export type SystemProxyMode = "manual" | "pac";

export interface SystemProxyConfig {
  mode: SystemProxyMode;
  /** manual mode — the proxy authority host (the engine's loopback). */
  host?: string;
  /** manual mode — the proxy authority port (the data listener, 9294). */
  port?: number;
  /** pac mode — the auto-config URL the OS fetches. */
  pacUrl?: string;
}

/** One registry value as `reg query` rendered it — `{type, data}` or null when absent. */
export interface Win32ProxyValue {
  type: string;
  data: string;
}

export interface Win32ProxyValues {
  ProxyEnable: Win32ProxyValue | null;
  ProxyServer: Win32ProxyValue | null;
  ProxyOverride: Win32ProxyValue | null;
  AutoConfigURL: Win32ProxyValue | null;
}

/** The per-service proxy triple networksetup reports, plus the bypass list. */
export interface DarwinServiceProxy {
  name: string;
  web: { enabled: boolean; server: string; port: number };
  secure: { enabled: boolean; server: string; port: number };
  auto: { enabled: boolean; url: string };
  bypass: string[];
}

/**
 * The full prior-state snapshot, per platform. JSON-serializable by design —
 * index.ts persists it verbatim in the store so a later disable/uninstall
 * restores exactly this, and nothing else.
 */
export type SystemProxyState =
  | { platform: "win32"; values: Win32ProxyValues }
  | { platform: "darwin"; services: DarwinServiceProxy[] }
  | {
      platform: "linux";
      mechanism: "gsettings";
      /** Raw rendered values — re-emitted verbatim on revert. */
      mode: string;
      ignoreHosts: string;
      autoconfigUrl: string;
      httpHost: string;
      httpPort: string;
      httpsHost: string;
      httpsPort: string;
    };

/** One tool invocation — the darwin elevate path joins these into one shell line. */
export interface SystemProxySpawn {
  file: string;
  args: string[];
}

export interface SystemProxyOptions {
  platformRunner?: PlatformRunner;
  /** Test seam — force a platform answer (CI darwin driving the win32/linux branches). */
  platform?: NodeJS.Platform;
}

export interface SystemProxyApplyResult {
  /**
   * 'apply-incomplete' (consolidated-review L5): the write plan ran but the
   * post-write state did not verify — partial writes may have landed. The
   * prior snapshot was already rolled back over them best-effort and still
   * rides the result so the caller can record or re-run the revert; a
   * thrown error used to orphan both.
   */
  outcome: "applied" | "needs-admin" | "apply-incomplete" | "unsupported";
  /** The snapshot to persist — present on 'applied', 'needs-admin' and 'apply-incomplete' (partial writes may exist). */
  prior?: SystemProxyState;
  message: string;
}

export interface SystemProxyRevertResult {
  outcome: "reverted" | "skipped-foreign" | "needs-admin" | "unsupported";
  message: string;
}

/** The persisted record index.ts keeps in the store — what we wrote + what was there before. */
export interface SystemProxyRecord {
  applied: SystemProxyConfig;
  prior: SystemProxyState;
  at: number;
}

/**
 * The normalized read of a platform state — the status surface's shape.
 * `mode` is 'both' when a foreign/manual+pac combination is live, 'other'
 * for states none of the writers produce (e.g. ProxyEnable=1 with no
 * ProxyServer).
 */
export interface NormalizedSystemProxy {
  enabled: boolean;
  mode: "off" | "manual" | "pac" | "both" | "other";
  manual?: { host: string; port: number };
  pacUrl?: string;
  /** darwin: service names where a proxy leg is on — the summary names them. */
  services?: string[];
}

const WIN32_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * The private/LAN destinations the layer deliberately bypasses — LAN and
 * intranet traffic belongs direct, not through the filter (same posture the
 * PAC body and the flag-127 denylist keep).
 */
const DARWIN_BYPASS = [
  "localhost",
  "127.0.0.0/8",
  "::1",
  "*.local",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
];

/** Windows bypass syntax: `;`-separated `*` patterns; `172.16/12` needs the sixteen explicit octets. */
const WIN32_OVERRIDE = [
  "localhost",
  "127.*",
  "10.*",
  "172.16.*",
  "172.17.*",
  "172.18.*",
  "172.19.*",
  "172.20.*",
  "172.21.*",
  "172.22.*",
  "172.23.*",
  "172.24.*",
  "172.25.*",
  "172.26.*",
  "172.27.*",
  "172.28.*",
  "172.29.*",
  "172.30.*",
  "172.31.*",
  "192.168.*",
  "169.254.*",
  "<local>",
].join(";");

/** GNOME's `ignore-hosts` GVariant list — the same private set, gsettings' own quoting. */
const LINUX_IGNORE_HOSTS =
  "['localhost', '127.0.0.0/8', '::1', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']";

/**
 * The union of caTrustStore's darwin + win32/linux authorization surfaces —
 * a write that cannot get authorization in this context → `needs-admin`
 * (the caller escalates: one `runShellAsAdmin` on darwin, a printed
 * remediation line off it).
 */
const NEEDS_ADMIN_PATTERN =
  /authorization was denied|errSecAuthFailed|interaction is not allowed|not authorized|permission denied|operation not permitted|user canceled|requires? (?:an? )?admin|access is denied|0x80070005|E_ACCESSDENIED|requires? elevation|elevation required|requested operation requires/i;

function isAuthorizationFailure(result: PlatformRunResult): boolean {
  return (
    NEEDS_ADMIN_PATTERN.test(result.stderr) || NEEDS_ADMIN_PATTERN.test(result.stdout)
  );
}

function sanitizeToolError(result: PlatformRunResult): string {
  const raw = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

function resolveRunner(options?: SystemProxyOptions): PlatformRunner {
  return options?.platformRunner ?? defaultPlatformRunner;
}

function resolvePlatform(options?: SystemProxyOptions): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

export function systemProxySupported(platform?: NodeJS.Platform): boolean {
  const p = platform ?? process.platform;
  return p === "win32" || p === "darwin" || p === "linux";
}

// ============================================================================
// win32 — reg on the per-user Internet Settings key
// ============================================================================

const WIN32_VALUE_NAMES = ["ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL"] as const;

/**
 * `reg query "<key>"` prints the key path then `    Name    REG_TYPE    data`
 * per value. Names we care about carry no spaces; a missing key or absent
 * values leave nulls — `reg delete` on revert restores absence exactly.
 */
function parseRegQuery(stdout: string): Win32ProxyValues {
  const values: Win32ProxyValues = {
    ProxyEnable: null,
    ProxyServer: null,
    ProxyOverride: null,
    AutoConfigURL: null,
  };
  for (const line of stdout.split("\n")) {
    const match = /^\s+(\w+)\s+(REG_\w+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const name = match[1] as keyof Win32ProxyValues;
    if (WIN32_VALUE_NAMES.includes(name as (typeof WIN32_VALUE_NAMES)[number])) {
      values[name] = { type: match[2], data: match[3].trim() };
    }
  }
  return values;
}

async function win32Read(run: PlatformRunner): Promise<SystemProxyState> {
  const res = await run("reg", ["query", WIN32_KEY]);
  if (res.code !== 0) {
    // The key exists on every real WinINet install; a miss reads as a fresh
    // all-absent state only when reg itself says "unable to find" — any other
    // failure is a real error.
    if (/unable to find|cannot find|the system cannot find/i.test(res.stderr + res.stdout)) {
      return {
        platform: "win32",
        values: { ProxyEnable: null, ProxyServer: null, ProxyOverride: null, AutoConfigURL: null },
      };
    }
    throw new Error(`reg query failed: ${sanitizeToolError(res)}`);
  }
  return { platform: "win32", values: parseRegQuery(res.stdout) };
}

function win32PlanApply(config: SystemProxyConfig): SystemProxySpawn[] {
  const plan: SystemProxySpawn[] = [];
  if (config.mode === "manual") {
    const authority = `${config.host ?? "127.0.0.1"}:${config.port ?? 9294}`;
    plan.push(
      { file: "reg", args: ["add", WIN32_KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", authority, "/f"] },
      { file: "reg", args: ["add", WIN32_KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", WIN32_OVERRIDE, "/f"] },
      { file: "reg", args: ["add", WIN32_KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"] },
      // Deterministic single-mode coverage: a foreign PAC URL left set would
      // race the manual proxy on WinINet clients — clear it (snapshot covers it).
      { file: "reg", args: ["delete", WIN32_KEY, "/v", "AutoConfigURL", "/f"] },
    );
  } else {
    plan.push(
      { file: "reg", args: ["add", WIN32_KEY, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", config.pacUrl ?? "", "/f"] },
      { file: "reg", args: ["add", WIN32_KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"] },
    );
  }
  return plan;
}

function win32PlanRevert(prior: Win32ProxyValues): SystemProxySpawn[] {
  const plan: SystemProxySpawn[] = [];
  for (const name of WIN32_VALUE_NAMES) {
    const recorded = prior[name];
    if (recorded === null) {
      plan.push({ file: "reg", args: ["delete", WIN32_KEY, "/v", name, "/f"] });
    } else {
      plan.push({
        file: "reg",
        args: ["add", WIN32_KEY, "/v", name, "/t", recorded.type, "/d", recorded.data, "/f"],
      });
    }
  }
  return plan;
}

// ============================================================================
// darwin — networksetup per enabled network service
// ============================================================================

interface DarwinProxyRead {
  enabled: boolean;
  server: string;
  port: number;
}

function parseGetWebProxy(stdout: string): DarwinProxyRead {
  const read = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(stdout);
    return m ? m[1].trim() : "";
  };
  return {
    enabled: /^Enabled:\s*Yes/m.test(stdout),
    server: read("Server"),
    port: Number.parseInt(read("Port"), 10) || 0,
  };
}

function parseGetAutoProxyUrl(stdout: string): { enabled: boolean; url: string } {
  const urlMatch = /^URL:\s*(.*)$/m.exec(stdout);
  const url = urlMatch ? urlMatch[1].trim() : "";
  return {
    enabled: /^Enabled:\s*Yes/m.test(stdout),
    url: url === "(null)" ? "" : url,
  };
}

function parseGetBypassDomains(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/aren'?t any|there are no/i.test(l));
}

async function darwinListServices(run: PlatformRunner): Promise<string[]> {
  const res = await run("networksetup", ["-listallnetworkservices"]);
  if (res.code !== 0) {
    throw new Error(`networksetup -listallnetworkservices failed: ${sanitizeToolError(res)}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("*") && !/^an asterisk/i.test(l));
}

async function darwinRead(run: PlatformRunner): Promise<SystemProxyState> {
  const names = await darwinListServices(run);
  const services: DarwinServiceProxy[] = [];
  for (const name of names) {
    const web = await run("networksetup", ["-getwebproxy", name]);
    const secure = await run("networksetup", ["-getsecurewebproxy", name]);
    const auto = await run("networksetup", ["-getautoproxyurl", name]);
    const bypass = await run("networksetup", ["-getproxybypassdomains", name]);
    for (const [verb, res] of [
      ["-getwebproxy", web],
      ["-getsecurewebproxy", secure],
      ["-getautoproxyurl", auto],
      ["-getproxybypassdomains", bypass],
    ] as const) {
      if (res.code !== 0) {
        throw new Error(`networksetup ${verb} "${name}" failed: ${sanitizeToolError(res)}`);
      }
    }
    services.push({
      name,
      web: parseGetWebProxy(web.stdout),
      secure: parseGetWebProxy(secure.stdout),
      auto: parseGetAutoProxyUrl(auto.stdout),
      bypass: parseGetBypassDomains(bypass.stdout),
    });
  }
  return { platform: "darwin", services };
}

function darwinPlanApply(config: SystemProxyConfig, services: string[]): SystemProxySpawn[] {
  const plan: SystemProxySpawn[] = [];
  for (const svc of services) {
    if (config.mode === "manual") {
      const host = config.host ?? "127.0.0.1";
      const port = String(config.port ?? 9294);
      plan.push(
        { file: "networksetup", args: ["-setwebproxy", svc, host, port] },
        { file: "networksetup", args: ["-setsecurewebproxy", svc, host, port] },
        { file: "networksetup", args: ["-setproxybypassdomains", svc, ...DARWIN_BYPASS] },
        // Deterministic single-mode coverage — a foreign PAC left enabled
        // races the manual proxy (snapshot covers it).
        { file: "networksetup", args: ["-setautoproxystate", svc, "off"] },
      );
    } else {
      plan.push(
        { file: "networksetup", args: ["-setautoproxyurl", svc, config.pacUrl ?? ""] },
        // Same single-mode posture in the other direction.
        { file: "networksetup", args: ["-setwebproxystate", svc, "off"] },
        { file: "networksetup", args: ["-setsecurewebproxystate", svc, "off"] },
      );
    }
  }
  return plan;
}

function darwinPlanRevert(prior: DarwinServiceProxy[]): SystemProxySpawn[] {
  const plan: SystemProxySpawn[] = [];
  for (const svc of prior) {
    // A disabled leg's server/port residue persists in networksetup — restore
    // stale values first, then disable, so the state lands exactly as found.
    if (svc.web.enabled) {
      plan.push({ file: "networksetup", args: ["-setwebproxy", svc.name, svc.web.server, String(svc.web.port)] });
    } else {
      if (svc.web.server !== "") {
        plan.push({ file: "networksetup", args: ["-setwebproxy", svc.name, svc.web.server, String(svc.web.port)] });
      }
      plan.push({ file: "networksetup", args: ["-setwebproxystate", svc.name, "off"] });
    }
    if (svc.secure.enabled) {
      plan.push({ file: "networksetup", args: ["-setsecurewebproxy", svc.name, svc.secure.server, String(svc.secure.port)] });
    } else {
      if (svc.secure.server !== "") {
        plan.push({ file: "networksetup", args: ["-setsecurewebproxy", svc.name, svc.secure.server, String(svc.secure.port)] });
      }
      plan.push({ file: "networksetup", args: ["-setsecurewebproxystate", svc.name, "off"] });
    }
    if (svc.auto.enabled) {
      plan.push({ file: "networksetup", args: ["-setautoproxyurl", svc.name, svc.auto.url] });
    } else {
      plan.push({ file: "networksetup", args: ["-setautoproxystate", svc.name, "off"] });
    }
    plan.push({
      file: "networksetup",
      args: ["-setproxybypassdomains", svc.name, ...(svc.bypass.length > 0 ? svc.bypass : ["Empty"])],
    });
  }
  return plan;
}

// ============================================================================
// linux — gsettings org.gnome.system.proxy (the only linux proxy surface)
// ============================================================================

/** `list-recursively` renders `org.gnome.system.proxy[.child] key value` — value is raw GVariant text. */
function parseGSettingsList(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    // Fully-qualified leaf key — `org.gnome.system.proxy.http host`.
    map.set(`${match[1]} ${match[2]}`, match[3]);
  }
  return map;
}

async function linuxRead(run: PlatformRunner): Promise<SystemProxyState | "unsupported"> {
  let merged = new Map<string, string>();
  for (const schema of [
    "org.gnome.system.proxy",
    "org.gnome.system.proxy.http",
    "org.gnome.system.proxy.https",
  ]) {
    const res = await run("gsettings", ["list-recursively", schema]);
    if (res.code !== 0) {
      // Missing tool rejected the spawn upstream; a missing schema or a
      // headless dbus is the honest 'unsupported' — this GNOME surface
      // simply is not there to write.
      return "unsupported";
    }
    merged = new Map([...merged, ...parseGSettingsList(res.stdout)]);
  }
  const get = (k: string) => merged.get(k) ?? "";
  return {
    platform: "linux",
    mechanism: "gsettings",
    mode: get("org.gnome.system.proxy mode").replace(/^'|'$/g, ""),
    ignoreHosts: get("org.gnome.system.proxy ignore-hosts"),
    autoconfigUrl: get("org.gnome.system.proxy autoconfig-url").replace(/^'|'$/g, ""),
    httpHost: get("org.gnome.system.proxy.http host").replace(/^'|'$/g, ""),
    httpPort: get("org.gnome.system.proxy.http port"),
    httpsHost: get("org.gnome.system.proxy.https host").replace(/^'|'$/g, ""),
    httpsPort: get("org.gnome.system.proxy.https port"),
  };
}

function linuxPlanApply(config: SystemProxyConfig): SystemProxySpawn[] {
  const g = (args: string[]): SystemProxySpawn => ({ file: "gsettings", args });
  if (config.mode === "manual") {
    const host = `'${config.host ?? "127.0.0.1"}'`;
    const port = String(config.port ?? 9294);
    return [
      g(["set", "org.gnome.system.proxy.http", "host", host]),
      g(["set", "org.gnome.system.proxy.http", "port", port]),
      g(["set", "org.gnome.system.proxy.https", "host", host]),
      g(["set", "org.gnome.system.proxy.https", "port", port]),
      g(["set", "org.gnome.system.proxy", "ignore-hosts", LINUX_IGNORE_HOSTS]),
      g(["set", "org.gnome.system.proxy", "mode", "'manual'"]),
    ];
  }
  return [
    g(["set", "org.gnome.system.proxy", "autoconfig-url", `'${config.pacUrl ?? ""}'`]),
    g(["set", "org.gnome.system.proxy", "mode", "'auto'"]),
  ];
}

function linuxPlanRevert(
  prior: Extract<SystemProxyState, { platform: "linux" }>,
): SystemProxySpawn[] {
  const g = (args: string[]): SystemProxySpawn => ({ file: "gsettings", args });
  // Recorded values ride back in gsettings' own spelling — host/url/mode
  // were stored quote-stripped so they are re-wrapped as GVariant strings;
  // port/ignore-hosts stayed raw and re-emit verbatim.
  return [
    g(["set", "org.gnome.system.proxy.http", "host", `'${prior.httpHost}'`]),
    g(["set", "org.gnome.system.proxy.http", "port", prior.httpPort || "0"]),
    g(["set", "org.gnome.system.proxy.https", "host", `'${prior.httpsHost}'`]),
    g(["set", "org.gnome.system.proxy.https", "port", prior.httpsPort || "0"]),
    g(["set", "org.gnome.system.proxy", "ignore-hosts", prior.ignoreHosts || "@as []"]),
    g(["set", "org.gnome.system.proxy", "autoconfig-url", `'${prior.autoconfigUrl}'`]),
    g(["set", "org.gnome.system.proxy", "mode", `'${prior.mode || "none"}'`]),
  ];
}

// ============================================================================
// Shared API — read / plan / apply / revert
// ============================================================================

/**
 * Read the OS proxy state. Answers 'unsupported' on a platform (or linux
 * desktop) with no writer — never throws for a missing tool; a real read
 * failure (corrupt reg key, networksetup down) throws honestly.
 */
export async function readSystemProxyState(
  options?: SystemProxyOptions,
): Promise<SystemProxyState | "unsupported"> {
  const platform = resolvePlatform(options);
  const run = resolveRunner(options);
  if (platform === "win32") return win32Read(run);
  if (platform === "darwin") return darwinRead(run);
  if (platform === "linux") {
    try {
      return await linuxRead(run);
    } catch {
      return "unsupported"; // spawn-level failure — no gsettings on this box
    }
  }
  return "unsupported";
}

/**
 * The ordered write plan an apply needs, derived from the CURRENT state —
 * darwin enumerates services at snapshot time so the writes (and the revert
 * that follows) only ever touch services we actually saw. Pure — the darwin
 * elevate path renders this into one `runShellAsAdmin` line.
 */
export function planSystemProxyApply(
  config: SystemProxyConfig,
  platform: NodeJS.Platform,
  current: SystemProxyState,
): SystemProxySpawn[] {
  if (platform === "win32" && current.platform === "win32") {
    return win32PlanApply(config);
  }
  if (platform === "darwin" && current.platform === "darwin") {
    return darwinPlanApply(
      config,
      current.services.map((s) => s.name),
    );
  }
  if (platform === "linux" && current.platform === "linux") {
    return linuxPlanApply(config);
  }
  return [];
}

/** The restore plan for a recorded prior state — revert writes exactly what the snapshot holds. */
export function planSystemProxyRevert(
  prior: SystemProxyState,
  platform: NodeJS.Platform,
): SystemProxySpawn[] {
  if (platform === "win32" && prior.platform === "win32") return win32PlanRevert(prior.values);
  if (platform === "darwin" && prior.platform === "darwin") return darwinPlanRevert(prior.services);
  if (platform === "linux" && prior.platform === "linux") return linuxPlanRevert(prior);
  return [];
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Does `state` still equal what `config` wrote? The revert foreign-check:
 * a drifted state is the user's own edit and must not be reverted under.
 * Only the legs the mode writes are compared — a pre-existing foreign
 * PAC beside our manual write (or vice versa) stays out of scope.
 */
export function stateMatchesConfig(state: SystemProxyState, config: SystemProxyConfig): boolean {
  if (state.platform === "win32") {
    const v = state.values;
    if (config.mode === "manual") {
      const authority = `${config.host ?? "127.0.0.1"}:${config.port ?? 9294}`;
      return (
        v.ProxyEnable?.data === "0x1" &&
        v.ProxyServer?.data === authority &&
        v.ProxyOverride?.data === WIN32_OVERRIDE &&
        v.AutoConfigURL === null
      );
    }
    return v.AutoConfigURL?.data === config.pacUrl && v.ProxyEnable?.data === "0x0";
  }
  if (state.platform === "darwin") {
    return state.services.every((svc) => {
      if (config.mode === "manual") {
        const host = config.host ?? "127.0.0.1";
        const port = config.port ?? 9294;
        return (
          svc.web.enabled &&
          svc.web.server === host &&
          svc.web.port === port &&
          svc.secure.enabled &&
          svc.secure.server === host &&
          svc.secure.port === port &&
          sameStringSet(svc.bypass, DARWIN_BYPASS) &&
          !svc.auto.enabled
        );
      }
      return (
        svc.auto.enabled &&
        svc.auto.url === config.pacUrl &&
        !svc.web.enabled &&
        !svc.secure.enabled
      );
    });
  }
  if (state.platform === "linux") {
    if (config.mode === "manual") {
      const host = config.host ?? "127.0.0.1";
      const port = String(config.port ?? 9294);
      return (
        state.mode === "manual" &&
        state.httpHost === host &&
        state.httpPort === port &&
        state.httpsHost === host &&
        state.httpsPort === port &&
        state.ignoreHosts === LINUX_IGNORE_HOSTS
      );
    }
    return state.mode === "auto" && state.autoconfigUrl === config.pacUrl;
  }
  return false;
}

/**
 * Does `state` now equal the recorded `prior` snapshot? The post-revert
 * verify — only the legs a revert writes are compared: darwin per-service
 * enabled flags + values-when-enabled + bypass lists (a disabled leg's stale
 * server residue is restore-best-effort, and a service that vanished since
 * the snapshot holds nothing to restore — it is skipped), win32 the four
 * values verbatim (absence included), linux the six raw keys.
 */
export function stateMatchesSnapshot(state: SystemProxyState, prior: SystemProxyState): boolean {
  if (state.platform !== prior.platform) return false;
  if (prior.platform === "win32" && state.platform === "win32") {
    return WIN32_VALUE_NAMES.every((name) => {
      const recorded = prior.values[name];
      const current = state.values[name];
      if (recorded === null) return current === null;
      return current !== null && current.type === recorded.type && current.data === recorded.data;
    });
  }
  if (prior.platform === "darwin" && state.platform === "darwin") {
    const legOk = (
      recorded: { enabled: boolean; server: string; port: number },
      current: { enabled: boolean; server: string; port: number },
    ): boolean =>
      current.enabled === recorded.enabled &&
      (!recorded.enabled || (current.server === recorded.server && current.port === recorded.port));
    return prior.services.every((recorded) => {
      const current = state.services.find((s) => s.name === recorded.name);
      if (current === undefined) return true; // service vanished — nothing of ours survives there
      return (
        legOk(recorded.web, current.web) &&
        legOk(recorded.secure, current.secure) &&
        current.auto.enabled === recorded.auto.enabled &&
        (!recorded.auto.enabled || current.auto.url === recorded.auto.url) &&
        sameStringSet(current.bypass, recorded.bypass)
      );
    });
  }
  if (prior.platform === "linux" && state.platform === "linux") {
    return (
      state.mode === prior.mode &&
      state.ignoreHosts === prior.ignoreHosts &&
      state.autoconfigUrl === prior.autoconfigUrl &&
      state.httpHost === prior.httpHost &&
      state.httpPort === prior.httpPort &&
      state.httpsHost === prior.httpsHost &&
      state.httpsPort === prior.httpsPort
    );
  }
  return false;
}

/** Run a write plan through the runner; the first failure maps to needs-admin or throws. */
async function runPlan(
  plan: SystemProxySpawn[],
  run: PlatformRunner,
): Promise<"ok" | "needs-admin"> {
  for (const w of plan) {
    const res = await run(w.file, w.args);
    if (res.code === 0) continue;
    // `reg delete` on an already-absent value is the revert happy path —
    // "unable to find" there is success-shaped, not a failure.
    if (
      w.file === "reg" &&
      w.args[0] === "delete" &&
      /unable to find|cannot find/i.test(res.stderr + res.stdout)
    ) {
      continue;
    }
    if (isAuthorizationFailure(res)) return "needs-admin";
    throw new Error(`${w.file} ${w.args[0]} failed: ${sanitizeToolError(res)}`);
  }
  return "ok";
}

/**
 * Apply the OS system-proxy write: snapshot prior state FIRST, run the plan,
 * verify the post-state equals the config. `prior` rides the result even on
 * needs-admin — partial writes may exist and the caller decides whether the
 * snapshot is worth keeping (the elevate path re-runs the whole plan anyway).
 */
export async function applySystemProxy(
  config: SystemProxyConfig,
  options?: SystemProxyOptions,
): Promise<SystemProxyApplyResult> {
  const platform = resolvePlatform(options);
  const run = resolveRunner(options);
  const prior = await readSystemProxyState({ platformRunner: run, platform });
  if (prior === "unsupported") {
    return {
      outcome: "unsupported",
      message:
        platform === "linux"
          ? "No GNOME proxy settings found on this system (gsettings absent or schema missing) — KDE and other desktops are not implemented."
          : `System-proxy writes are not implemented on ${platform}.`,
    };
  }
  const plan = planSystemProxyApply(config, platform, prior);
  const wrote = await runPlan(plan, run);
  if (wrote === "needs-admin") {
    return {
      outcome: "needs-admin",
      prior,
      message:
        "The system-proxy write needs administrator approval — confirm to retry with elevated rights.",
    };
  }
  const post = await readSystemProxyState({ platformRunner: run, platform });
  if (post !== "unsupported" && !stateMatchesConfig(post, config)) {
    // Consolidated-review L5: a verify miss is not "the apply never
    // happened" — an earlier plan step may have written, and the thrown
    // error this replaced orphaned those writes AND the snapshot that could
    // restore them. Roll `prior` back over whatever landed best-effort and
    // return an honest outcome that still carries the snapshot, so the
    // caller can record it or drive the revert again instead of inheriting
    // an untracked partial write.
    const rollback = await runPlan(planSystemProxyRevert(prior, platform), run).then(
      (outcome) => outcome,
      () => "failed" as const,
    );
    return {
      outcome: "apply-incomplete",
      prior,
      message:
        rollback === "ok"
          ? "The system-proxy writes ran but the OS state did not match afterwards — the previous settings were restored; try the toggle again."
          : "The system-proxy writes ran but the OS state did not match afterwards, and restoring the previous settings also failed — check the system proxy settings by hand.",
    };
  }
  return {
    outcome: "applied",
    prior,
    message:
      config.mode === "manual"
        ? `System proxy set to ${config.host ?? "127.0.0.1"}:${config.port ?? 9294} — proxy-aware apps now route through the filter.`
        : `System auto-config URL set to ${config.pacUrl} — proxy-aware apps now route through the filter.`,
  };
}

/**
 * Restore exactly what `record.prior` holds — and only when the current
 * state still equals `record.applied`. Drift means the user touched the OS
 * settings since our write: they own them now → 'skipped-foreign'.
 */
export async function revertSystemProxy(
  record: { applied: SystemProxyConfig; prior: SystemProxyState },
  options?: SystemProxyOptions,
): Promise<SystemProxyRevertResult> {
  const platform = resolvePlatform(options);
  const run = resolveRunner(options);
  const current = await readSystemProxyState({ platformRunner: run, platform });
  if (current === "unsupported") {
    return {
      outcome: "unsupported",
      message: `System-proxy reads are not implemented on ${platform}.`,
    };
  }
  if (!stateMatchesConfig(current, record.applied)) {
    return {
      outcome: "skipped-foreign",
      message:
        "The OS proxy settings were changed since this app wrote them — left untouched (only settings this app wrote are ever reverted).",
    };
  }
  const plan = planSystemProxyRevert(record.prior, platform);
  const wrote = await runPlan(plan, run);
  if (wrote === "needs-admin") {
    return {
      outcome: "needs-admin",
      message: "Reverting the system proxy needs administrator approval.",
    };
  }
  return { outcome: "reverted", message: "System proxy settings restored to their previous state." };
}

/**
 * The normalized view of a state — the status surface's shape. darwin rolls
 * per-service legs up: ANY enabled leg enables the read, and the mode names
 * which kind of coverage is live.
 */
export function normalizeSystemProxyState(state: SystemProxyState): NormalizedSystemProxy {
  if (state.platform === "win32") {
    const manualOn = state.values.ProxyEnable?.data === "0x1";
    const pacOn = state.values.AutoConfigURL !== null && state.values.AutoConfigURL.data !== "";
    const server = state.values.ProxyServer?.data ?? "";
    const [host, portS] = server.split(":");
    const port = Number.parseInt(portS, 10);
    return {
      enabled: manualOn || pacOn,
      mode:
        manualOn && pacOn ? "both" : manualOn ? "manual" : pacOn ? "pac" : "off",
      ...(manualOn ? { manual: { host: host || "?", port: Number.isNaN(port) ? 0 : port } } : {}),
      ...(pacOn ? { pacUrl: state.values.AutoConfigURL!.data } : {}),
    };
  }
  if (state.platform === "darwin") {
    const manualSvcs = state.services.filter((s) => s.web.enabled || s.secure.enabled);
    const pacSvcs = state.services.filter((s) => s.auto.enabled);
    const enabled = manualSvcs.length > 0 || pacSvcs.length > 0;
    const first = manualSvcs[0];
    return {
      enabled,
      mode:
        manualSvcs.length > 0 && pacSvcs.length > 0
          ? "both"
          : manualSvcs.length > 0
            ? "manual"
            : pacSvcs.length > 0
              ? "pac"
              : "off",
      ...(first
        ? { manual: { host: first.web.server || first.secure.server, port: first.web.port || first.secure.port } }
        : {}),
      ...(pacSvcs.length > 0 ? { pacUrl: pacSvcs[0].auto.url } : {}),
      services: state.services.map((s) => s.name),
    };
  }
  if (state.platform === "linux") {
    if (state.mode === "manual") {
      return {
        enabled: true,
        mode: "manual",
        manual: { host: state.httpHost, port: Number.parseInt(state.httpPort, 10) || 0 },
      };
    }
    if (state.mode === "auto") {
      return { enabled: true, mode: "pac", pacUrl: state.autoconfigUrl };
    }
    if (state.mode === "none" || state.mode === "") {
      return { enabled: false, mode: "off" };
    }
    return { enabled: true, mode: "other" };
  }
  return { enabled: false, mode: "off" };
}

/** One human line for the status surface — names the actual live posture. */
export function summarizeSystemProxyState(state: SystemProxyState): string {
  const n = normalizeSystemProxyState(state);
  if (state.platform === "darwin") {
    const names = state.services.map((s) => s.name).join(", ");
    if (n.mode === "off") return `off on all services (${names})`;
    const modeStr =
      n.mode === "manual"
        ? `manual ${n.manual?.host}:${n.manual?.port}`
        : n.mode === "pac"
          ? `PAC ${n.pacUrl}`
          : n.mode;
    return `${modeStr} on ${names}`;
  }
  if (n.mode === "off") return "off";
  if (n.mode === "manual") return `manual ${n.manual?.host}:${n.manual?.port}`;
  if (n.mode === "pac") return `PAC ${n.pacUrl}`;
  return n.mode;
}
