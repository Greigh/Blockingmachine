/**
 * systemProxy.ts — the P7 (flag 123) OS system-proxy writers, driven through
 * the recording PlatformRunner seam so no test ever touches a real OS store.
 * The pins are argv-level: each platform's read/set/revert tool calls are
 * asserted literally, plus the snapshot-first / revert-only-own-writes
 * contract ('skipped-foreign' on drift) and honest 'unsupported'/'needs-admin'.
 */

import { describe, expect, it } from "@jest/globals";
import type { PlatformRunner, PlatformRunResult } from "../caTrustStore.js";
import {
  applySystemProxy,
  normalizeSystemProxyState,
  planSystemProxyApply,
  planSystemProxyRevert,
  readSystemProxyState,
  revertSystemProxy,
  stateMatchesConfig,
  stateMatchesSnapshot,
  summarizeSystemProxyState,
  systemProxySupported,
  type SystemProxyConfig,
  type SystemProxyState,
} from "../systemProxy.js";

const DARWIN = { platform: "darwin" as NodeJS.Platform };
const WIN32 = { platform: "win32" as NodeJS.Platform };
const LINUX = { platform: "linux" as NodeJS.Platform };

const MANUAL: SystemProxyConfig = { mode: "manual", host: "127.0.0.1", port: 9294 };
const PAC: SystemProxyConfig = { mode: "pac", pacUrl: "http://127.0.0.1:9294/proxy.pac" };

const ok = (stdout = ""): PlatformRunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1): PlatformRunResult => ({ code, stdout: "", stderr });

/** A recording PlatformRunner — argv per call, handler keyed on (file, argv, call#). */
function recordingRunner(handler: (file: string, args: string[], call: number) => PlatformRunResult) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: PlatformRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    return handler(file, args, calls.length - 1);
  };
  return { runner, calls };
}

// ============================================================================
// Fixtures — each platform's tool output rendered as the real thing prints it
// ============================================================================

const DARWIN_LIST = "An asterisk (*) denotes that a network service is disabled.\nWi-Fi\nEthernet\n*Disabled VPN\n";

function darwinGet(enabled: boolean, server = "", port = 0): string {
  return `Enabled: ${enabled ? "Yes" : "No"}\nServer: ${server}\nPort: ${port}\nAuthenticated Proxy Enabled: 0\n`;
}

function darwinAuto(enabled: boolean, url = ""): string {
  return `URL: ${url === "" ? "(null)" : url}\nEnabled: ${enabled ? "Yes" : "No"}\n`;
}

const DARWIN_BYPASS_GET = "*.local\n169.254/16\n";

/**
 * A darwin fixture runner: services Wi-Fi + Ethernet, everything off, the
 * macOS default bypass list. `overrides` bends single legs for drift tests.
 */
function darwinRunner(overrides?: {
  web?: Partial<Record<"enabled" | "server" | "port", string | number | boolean>>;
  auto?: Partial<Record<"enabled" | "url", string | boolean>>;
  bypass?: string;
}) {
  return recordingRunner((_file, args) => {
    const verb = args[0];
    if (verb === "-listallnetworkservices") return ok(DARWIN_LIST);
    if (verb === "-getwebproxy" || verb === "-getsecurewebproxy") {
      return ok(
        darwinGet(
          (overrides?.web?.enabled as boolean) ?? false,
          (overrides?.web?.server as string) ?? "",
          (overrides?.web?.port as number) ?? 0,
        ),
      );
    }
    if (verb === "-getautoproxyurl") {
      return ok(
        darwinAuto(
          (overrides?.auto?.enabled as boolean) ?? false,
          (overrides?.auto?.url as string) ?? "",
        ),
      );
    }
    if (verb === "-getproxybypassdomains") {
      return ok(overrides?.bypass ?? DARWIN_BYPASS_GET);
    }
    // Set verbs — succeed by default.
    if (verb.startsWith("-set")) return ok("");
    return fail(`unexpected verb ${verb}`);
  });
}

const WIN32_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function win32Query(values: Record<string, { type: string; data: string }>): string {
  let out = `\n${WIN32_KEY}\n`;
  for (const [name, v] of Object.entries(values)) {
    out += `    ${name}    ${v.type}    ${v.data}\n`;
  }
  return out;
}

/** The whole live manual-write state — what OUR apply leaves behind. */
function win32AppliedQuery(): string {
  return win32Query({
    ProxyEnable: { type: "REG_DWORD", data: "0x1" },
    ProxyServer: { type: "REG_SZ", data: "127.0.0.1:9294" },
    ProxyOverride: {
      type: "REG_SZ",
      data: "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;169.254.*;<local>",
    },
  });
}

function gsettingsList(): Map<string, Map<string, string>> {
  return new Map([
    ["org.gnome.system.proxy", new Map([["mode", "'none'"], ["ignore-hosts", "['localhost', '127.0.0.0/8', '::1']"], ["autoconfig-url", "''"]])],
    ["org.gnome.system.proxy.http", new Map([["host", "''"], ["port", "0"], ["enabled", "false"]])],
    ["org.gnome.system.proxy.https", new Map([["host", "''"], ["port", "0"], ["enabled", "false"]])],
  ]);
}

function renderGSettings(tables: Map<string, Map<string, string>>): Map<string, string> {
  // schema → rendered list-recursively stdout
  const out = new Map<string, string>();
  for (const [schema, rows] of tables) {
    out.set(
      schema,
      [...rows.entries()].map(([k, v]) => `${schema} ${k} ${v}`).join("\n"),
    );
  }
  return out;
}

function linuxRunner(tables: Map<string, Map<string, string>>) {
  const rendered = renderGSettings(tables);
  return recordingRunner((_file, args) => {
    if (args[0] === "list-recursively") {
      const body = rendered.get(args[1]);
      return body === undefined ? fail("No such schema") : ok(body + "\n");
    }
    if (args[0] === "set") return ok("");
    return fail(`unexpected ${args[0]}`);
  });
}

// ============================================================================
// support + read
// ============================================================================

describe("readSystemProxyState — platform dispatch + unsupported", () => {
  it("answers 'unsupported' on an unimplemented platform without spawning", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(readSystemProxyState({ platformRunner: runner, platform: "freebsd" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
    expect(systemProxySupported("freebsd")).toBe(false);
    expect(systemProxySupported("darwin")).toBe(true);
  });

  it("darwin reads every enabled service's web/secure/auto/bypass legs and skips disabled ones", async () => {
    const { runner, calls } = darwinRunner();
    const state = await readSystemProxyState({ platformRunner: runner, ...DARWIN });
    expect(state).not.toBe("unsupported");
    if (state === "unsupported") return;
    expect(state.platform).toBe("darwin");
    if (state.platform !== "darwin") return;
    // '*Disabled VPN' never gets a -get* call — disabled services aren't read or written.
    expect(state.services.map((s) => s.name)).toEqual(["Wi-Fi", "Ethernet"]);
    const setCalls = calls.filter((c) => c.args[0].startsWith("-set"));
    expect(setCalls).toHaveLength(0); // a read never writes
    const gets = calls.filter((c) => c.args[0] === "-getwebproxy").map((c) => c.args[1]);
    expect(gets).toEqual(["Wi-Fi", "Ethernet"]);
  });

  it("win32 parses whole-key reg output; absent values stay null", async () => {
    const { runner } = recordingRunner((_f, args) =>
      args[0] === "query"
        ? ok(
            win32Query({
              ProxyEnable: { type: "REG_DWORD", data: "0x1" },
              ProxyServer: { type: "REG_SZ", data: "10.0.0.5:8080" },
            }),
          )
        : ok(),
    );
    const state = await readSystemProxyState({ platformRunner: runner, ...WIN32 });
    if (state === "unsupported" || state.platform !== "win32") throw new Error("expected win32 state");
    expect(state.values.ProxyEnable).toEqual({ type: "REG_DWORD", data: "0x1" });
    expect(state.values.ProxyServer).toEqual({ type: "REG_SZ", data: "10.0.0.5:8080" });
    expect(state.values.ProxyOverride).toBeNull();
    expect(state.values.AutoConfigURL).toBeNull();
  });

  it("linux merges the three schema listings and strips string quotes", async () => {
    const tables = gsettingsList();
    tables.get("org.gnome.system.proxy")!.set("mode", "'manual'");
    tables.get("org.gnome.system.proxy.http")!.set("host", "'127.0.0.1'").set("port", "9294");
    const { runner } = linuxRunner(tables);
    const state = await readSystemProxyState({ platformRunner: runner, ...LINUX });
    if (state === "unsupported" || state.platform !== "linux") throw new Error("expected linux state");
    expect(state.mode).toBe("manual");
    expect(state.httpHost).toBe("127.0.0.1");
    expect(state.httpPort).toBe("9294");
    const n = normalizeSystemProxyState(state);
    expect(n.enabled).toBe(true);
    expect(n.mode).toBe("manual");
    expect(n.manual).toEqual({ host: "127.0.0.1", port: 9294 });
  });

  it("linux answers 'unsupported' when the schema is absent (and a missing gsettings rejects)", async () => {
    const { runner: noSchema } = recordingRunner(() => fail("No such schema"));
    await expect(readSystemProxyState({ platformRunner: noSchema, ...LINUX })).resolves.toBe("unsupported");
    const { runner: noTool } = {
      runner: (() => Promise.reject(new Error("spawn gsettings ENOENT"))) as PlatformRunner,
    };
    await expect(readSystemProxyState({ platformRunner: noTool, ...LINUX })).resolves.toBe("unsupported");
  });
});

// ============================================================================
// write plans — argv pins
// ============================================================================

describe("planSystemProxyApply — the per-platform argv pins", () => {
  it("darwin manual writes web+secure+bypass+auto-off per service", async () => {
    const { runner } = darwinRunner();
    const state = await readSystemProxyState({ platformRunner: runner, ...DARWIN });
    if (state === "unsupported") throw new Error("expected state");
    const plan = planSystemProxyApply(MANUAL, "darwin", state);
    expect(plan.map((w) => w.args)).toEqual([
      ["-setwebproxy", "Wi-Fi", "127.0.0.1", "9294"],
      ["-setsecurewebproxy", "Wi-Fi", "127.0.0.1", "9294"],
      ["-setproxybypassdomains", "Wi-Fi", "localhost", "127.0.0.0/8", "::1", "*.local", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
      ["-setautoproxystate", "Wi-Fi", "off"],
      ["-setwebproxy", "Ethernet", "127.0.0.1", "9294"],
      ["-setsecurewebproxy", "Ethernet", "127.0.0.1", "9294"],
      ["-setproxybypassdomains", "Ethernet", "localhost", "127.0.0.0/8", "::1", "*.local", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
      ["-setautoproxystate", "Ethernet", "off"],
    ]);
    for (const w of plan) expect(w.file).toBe("networksetup");
  });

  it("darwin pac writes autoproxyurl + disables the manual legs", async () => {
    const { runner } = darwinRunner();
    const state = await readSystemProxyState({ platformRunner: runner, ...DARWIN });
    if (state === "unsupported") throw new Error("expected state");
    const plan = planSystemProxyApply(PAC, "darwin", state);
    expect(plan.map((w) => w.args)).toEqual([
      ["-setautoproxyurl", "Wi-Fi", "http://127.0.0.1:9294/proxy.pac"],
      ["-setwebproxystate", "Wi-Fi", "off"],
      ["-setsecurewebproxystate", "Wi-Fi", "off"],
      ["-setautoproxyurl", "Ethernet", "http://127.0.0.1:9294/proxy.pac"],
      ["-setwebproxystate", "Ethernet", "off"],
      ["-setsecurewebproxystate", "Ethernet", "off"],
    ]);
  });

  it("win32 manual writes ProxyServer/ProxyOverride/ProxyEnable and deletes AutoConfigURL", async () => {
    const { runner } = recordingRunner(() => ok(win32Query({})));
    const state = await readSystemProxyState({ platformRunner: runner, ...WIN32 });
    if (state === "unsupported") throw new Error("expected state");
    const plan = planSystemProxyApply(MANUAL, "win32", state);
    expect(plan.map((w) => [w.file, ...w.args])).toEqual([
      ["reg", "add", WIN32_KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", "127.0.0.1:9294", "/f"],
      ["reg", "add", WIN32_KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", expect.any(String), "/f"],
      ["reg", "add", WIN32_KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"],
      ["reg", "delete", WIN32_KEY, "/v", "AutoConfigURL", "/f"],
    ]);
  });

  it("linux manual sets mode manual + per-protocol host/port + ignore-hosts", async () => {
    const { runner } = linuxRunner(gsettingsList());
    const state = await readSystemProxyState({ platformRunner: runner, ...LINUX });
    if (state === "unsupported") throw new Error("expected state");
    const plan = planSystemProxyApply(MANUAL, "linux", state);
    expect(plan.map((w) => w.args)).toEqual([
      ["set", "org.gnome.system.proxy.http", "host", "'127.0.0.1'"],
      ["set", "org.gnome.system.proxy.http", "port", "9294"],
      ["set", "org.gnome.system.proxy.https", "host", "'127.0.0.1'"],
      ["set", "org.gnome.system.proxy.https", "port", "9294"],
      ["set", "org.gnome.system.proxy", "ignore-hosts", expect.stringContaining("10.0.0.0/8")],
      ["set", "org.gnome.system.proxy", "mode", "'manual'"],
    ]);
    const pacPlan = planSystemProxyApply(PAC, "linux", state);
    expect(pacPlan.map((w) => w.args)).toEqual([
      ["set", "org.gnome.system.proxy", "autoconfig-url", "'http://127.0.0.1:9294/proxy.pac'"],
      ["set", "org.gnome.system.proxy", "mode", "'auto'"],
    ]);
  });
});

// ============================================================================
// apply — snapshot-first + verify
// ============================================================================

describe("applySystemProxy", () => {
  it("darwin manual: reads before writing, emits the write plan, verifies post-state, returns the prior snapshot", async () => {
    // Stateful fake: the -set* verbs flip the fixture legs so the post-read matches.
    let applied = false;
    const { runner, calls } = recordingRunner((_f, args) => {
      const verb = args[0];
      if (verb === "-listallnetworkservices") return ok(DARWIN_LIST);
      if (verb === "-getwebproxy" || verb === "-getsecurewebproxy") {
        return ok(applied ? darwinGet(true, "127.0.0.1", 9294) : darwinGet(false));
      }
      if (verb === "-getautoproxyurl") return ok(darwinAuto(false));
      if (verb === "-getproxybypassdomains") {
        return ok(applied ? "localhost\n127.0.0.0/8\n::1\n*.local\n10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16\n169.254.0.0/16\n" : DARWIN_BYPASS_GET);
      }
      if (verb.startsWith("-set")) {
        applied = true;
        return ok("");
      }
      return fail(`unexpected ${verb}`);
    });
    const res = await applySystemProxy(MANUAL, { platformRunner: runner, ...DARWIN });
    expect(res.outcome).toBe("applied");
    expect(res.prior?.platform).toBe("darwin");
    // The snapshot records the PRE-write state: services, legs off, default bypass.
    if (res.prior?.platform === "darwin") {
      expect(res.prior.services).toHaveLength(2);
      expect(res.prior.services[0].web.enabled).toBe(false);
      expect(res.prior.services[0].bypass).toEqual(["*.local", "169.254/16"]);
    }
    // Reads precede writes: the first set verb comes after all -get* calls of the read pass.
    const firstWrite = calls.findIndex((c) => c.args[0].startsWith("-set"));
    const readsBeforeWrite = calls.slice(0, firstWrite).filter((c) => c.args[0].startsWith("-get"));
    expect(readsBeforeWrite.length).toBeGreaterThanOrEqual(6); // 2 services × 3 proxy gets (+bypass gets)
    expect(calls[0].args[0]).toBe("-listallnetworkservices");
  });

  it("maps authorization-worded write failures to needs-admin and still returns the snapshot", async () => {
    const { runner } = recordingRunner((_f, args) => {
      const verb = args[0];
      if (verb === "-listallnetworkservices") return ok(DARWIN_LIST);
      if (verb === "-getwebproxy" || verb === "-getsecurewebproxy") return ok(darwinGet(false));
      if (verb === "-getautoproxyurl") return ok(darwinAuto(false));
      if (verb === "-getproxybypassdomains") return ok(DARWIN_BYPASS_GET);
      if (verb.startsWith("-set")) return fail("** Error: The authorization was denied.");
      return fail("unexpected");
    });
    const res = await applySystemProxy(MANUAL, { platformRunner: runner, ...DARWIN });
    expect(res.outcome).toBe("needs-admin");
    expect(res.prior?.platform).toBe("darwin");
  });

  it("returns 'unsupported' on a platform with no writer, spawning nothing", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    const res = await applySystemProxy(MANUAL, { platformRunner: runner, platform: "freebsd" });
    expect(res.outcome).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("win32 apply writes then verifies — a state that stays foreign throws rather than overclaiming", async () => {
    let applied = false;
    const { runner } = recordingRunner((_f, args) => {
      if (args[0] === "query") return ok(applied ? win32AppliedQuery() : win32Query({}));
      if (args[0] === "add") {
        applied = true;
        return ok("The operation completed successfully.");
      }
      if (args[0] === "delete") return ok("The operation completed successfully.");
      return fail("unexpected");
    });
    const res = await applySystemProxy(MANUAL, { platformRunner: runner, ...WIN32 });
    expect(res.outcome).toBe("applied");

    // The never-takes variant: writes "succeed" but the read still disagrees → throw.
    const { runner: lying } = recordingRunner((_f, args) =>
      args[0] === "query" ? ok(win32Query({})) : ok("The operation completed successfully."),
    );
    await expect(applySystemProxy(MANUAL, { platformRunner: lying, ...WIN32 })).rejects.toThrow(/did not take|unchanged/);
  });
});

// ============================================================================
// revert — only what we wrote, only while the user hasn't touched it
// ============================================================================

describe("revertSystemProxy — snapshot-first reversion", () => {
  const darwinPrior: SystemProxyState = {
    platform: "darwin",
    services: [
      { name: "Wi-Fi", web: { enabled: false, server: "", port: 0 }, secure: { enabled: false, server: "", port: 0 }, auto: { enabled: false, url: "" }, bypass: ["*.local", "169.254/16"] },
    ],
  };

  it("darwin: foreign drift → skipped-foreign, spawning nothing", async () => {
    // Current state shows a DIFFERENT manual proxy than ours → user-owned now.
    const { runner, calls } = darwinRunner({
      web: { enabled: true, server: "10.0.0.9", port: 3128 },
      bypass: "*.local\n169.254/16\n",
    });
    // Only Wi-Fi in the fixture list — trim the services list via overrides is
    // not needed: every service shows the same foreign 10.0.0.9 → not ours.
    const res = await revertSystemProxy(
      { applied: MANUAL, prior: darwinPrior },
      { platformRunner: runner, ...DARWIN },
    );
    expect(res.outcome).toBe("skipped-foreign");
    expect(calls.filter((c) => c.args[0].startsWith("-set"))).toHaveLength(0);
  });

  it("darwin: restores disabled legs to off and the recorded bypass list verbatim", async () => {
    // Current = our applied manual write on one service.
    const list = "An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n";
    const { runner, calls } = recordingRunner((_f, args) => {
      const verb = args[0];
      if (verb === "-listallnetworkservices") return ok(list);
      if (verb === "-getwebproxy" || verb === "-getsecurewebproxy") return ok(darwinGet(true, "127.0.0.1", 9294));
      if (verb === "-getautoproxyurl") return ok(darwinAuto(false));
      if (verb === "-getproxybypassdomains") {
        return ok("localhost\n127.0.0.0/8\n::1\n*.local\n10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16\n169.254.0.0/16\n");
      }
      if (verb.startsWith("-set")) return ok("");
      return fail("unexpected");
    });
    const res = await revertSystemProxy(
      { applied: MANUAL, prior: darwinPrior },
      { platformRunner: runner, ...DARWIN },
    );
    expect(res.outcome).toBe("reverted");
    const writes = calls.filter((c) => c.args[0].startsWith("-set")).map((c) => c.args);
    // The prior service was disabled everywhere → *state off verbs, bypass restored.
    expect(writes).toContainEqual(["-setwebproxystate", "Wi-Fi", "off"]);
    expect(writes).toContainEqual(["-setsecurewebproxystate", "Wi-Fi", "off"]);
    expect(writes).toContainEqual(["-setautoproxystate", "Wi-Fi", "off"]);
    expect(writes).toContainEqual(["-setproxybypassdomains", "Wi-Fi", "*.local", "169.254/16"]);
  });

  it("win32: restores recorded values and deletes what was absent before", async () => {
    const prior: SystemProxyState = {
      platform: "win32",
      values: {
        ProxyEnable: { type: "REG_DWORD", data: "0x0" },
        ProxyServer: { type: "REG_SZ", data: "10.0.0.5:8080" },
        ProxyOverride: null,
        AutoConfigURL: { type: "REG_SZ", data: "http://old.example/wpad.dat" },
      },
    };
    const { runner, calls } = recordingRunner((_f, args) =>
      args[0] === "query" ? ok(win32AppliedQuery()) : ok("The operation completed successfully."),
    );
    const res = await revertSystemProxy({ applied: MANUAL, prior }, { platformRunner: runner, ...WIN32 });
    expect(res.outcome).toBe("reverted");
    const writes = calls.filter((c) => c.args[0] !== "query").map((c) => c.args);
    expect(writes).toContainEqual(["add", WIN32_KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0x0", "/f"]);
    expect(writes).toContainEqual(["add", WIN32_KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", "10.0.0.5:8080", "/f"]);
    expect(writes).toContainEqual(["add", WIN32_KEY, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", "http://old.example/wpad.dat", "/f"]);
    // ProxyOverride did not exist before → delete, not a phantom restore.
    expect(writes).toContainEqual(["delete", WIN32_KEY, "/v", "ProxyOverride", "/f"]);
  });

  it("win32: `reg delete` on an already-absent value is tolerated (unable-to-find)", async () => {
    const prior: SystemProxyState = {
      platform: "win32",
      values: {
        ProxyEnable: null,
        ProxyServer: null,
        ProxyOverride: null,
        AutoConfigURL: null,
      },
    };
    const { runner } = recordingRunner((_f, args) => {
      if (args[0] === "query") return ok(win32AppliedQuery());
      if (args[0] === "delete") return fail("ERROR: The system was unable to find the specified registry key or value.");
      return ok("The operation completed successfully.");
    });
    const res = await revertSystemProxy({ applied: MANUAL, prior }, { platformRunner: runner, ...WIN32 });
    expect(res.outcome).toBe("reverted");
  });

  it("linux: reverts the six keys verbatim — the recorded GVariant spellings ride back", async () => {
    const tables = gsettingsList();
    tables.get("org.gnome.system.proxy")!.set("mode", "'manual'");
    tables.get("org.gnome.system.proxy.http")!.set("host", "'127.0.0.1'").set("port", "9294");
    tables.get("org.gnome.system.proxy.https")!.set("host", "'127.0.0.1'").set("port", "9294");
    tables.get("org.gnome.system.proxy")!.set("ignore-hosts", "['localhost', '127.0.0.0/8', '::1', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']");
    const { runner, calls } = linuxRunner(tables);
    const prior: SystemProxyState = {
      platform: "linux",
      mechanism: "gsettings",
      mode: "none",
      ignoreHosts: "['localhost', '127.0.0.0/8', '::1']",
      autoconfigUrl: "",
      httpHost: "",
      httpPort: "0",
      httpsHost: "",
      httpsPort: "0",
    };
    const res = await revertSystemProxy({ applied: MANUAL, prior }, { platformRunner: runner, ...LINUX });
    expect(res.outcome).toBe("reverted");
    const writes = calls.filter((c) => c.args[0] === "set").map((c) => c.args);
    expect(writes).toContainEqual(["set", "org.gnome.system.proxy", "mode", "'none'"]);
    expect(writes).toContainEqual(["set", "org.gnome.system.proxy", "ignore-hosts", "['localhost', '127.0.0.0/8', '::1']"]);
    expect(writes).toContainEqual(["set", "org.gnome.system.proxy.http", "host", "''"]);
  });

  it("linux: a recorded non-empty host re-emits QUOTED — bare words are not GVariant strings", async () => {
    // Prior state had a foreign manual proxy at proxy.corp:3128 — the read
    // stores host quote-stripped; revert must re-wrap it or gsettings fails.
    const tables = gsettingsList();
    tables.get("org.gnome.system.proxy")!.set("mode", "'manual'");
    tables.get("org.gnome.system.proxy.http")!.set("host", "'127.0.0.1'").set("port", "9294");
    tables.get("org.gnome.system.proxy.https")!.set("host", "'127.0.0.1'").set("port", "9294");
    tables.get("org.gnome.system.proxy")!.set("ignore-hosts", "['localhost', '127.0.0.0/8', '::1', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']");
    const { runner, calls } = linuxRunner(tables);
    const prior: SystemProxyState = {
      platform: "linux",
      mechanism: "gsettings",
      mode: "manual",
      ignoreHosts: "['localhost']",
      autoconfigUrl: "",
      httpHost: "proxy.corp",
      httpPort: "3128",
      httpsHost: "proxy.corp",
      httpsPort: "3128",
    };
    const res = await revertSystemProxy({ applied: MANUAL, prior }, { platformRunner: runner, ...LINUX });
    expect(res.outcome).toBe("reverted");
    const writes = calls.filter((c) => c.args[0] === "set").map((c) => c.args);
    expect(writes).toContainEqual(["set", "org.gnome.system.proxy.http", "host", "'proxy.corp'"]);
    expect(writes).toContainEqual(["set", "org.gnome.system.proxy.http", "port", "3128"]);
  });
});

// ============================================================================
// state matching + normalize + summary
// ============================================================================

describe("stateMatchesConfig / stateMatchesSnapshot / normalize / summarize", () => {
  it("win32 normalize reads manual/pac/both/off honestly", () => {
    const off: SystemProxyState = {
      platform: "win32",
      values: { ProxyEnable: null, ProxyServer: null, ProxyOverride: null, AutoConfigURL: null },
    };
    expect(normalizeSystemProxyState(off).mode).toBe("off");
    const both: SystemProxyState = {
      platform: "win32",
      values: {
        ProxyEnable: { type: "REG_DWORD", data: "0x1" },
        ProxyServer: { type: "REG_SZ", data: "127.0.0.1:8080" },
        ProxyOverride: null,
        AutoConfigURL: { type: "REG_SZ", data: "http://x/wpad.dat" },
      },
    };
    expect(normalizeSystemProxyState(both).mode).toBe("both");
    expect(summarizeSystemProxyState(off)).toBe("off");
  });

  it("stateMatchesConfig pins the exact post-apply shape per platform", () => {
    const win32Applied: SystemProxyState = {
      platform: "win32",
      values: {
        ProxyEnable: { type: "REG_DWORD", data: "0x1" },
        ProxyServer: { type: "REG_SZ", data: "127.0.0.1:9294" },
        ProxyOverride: {
          type: "REG_SZ",
          data: "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;169.254.*;<local>",
        },
        AutoConfigURL: null,
      },
    };
    expect(stateMatchesConfig(win32Applied, MANUAL)).toBe(true);
    expect(stateMatchesConfig(win32Applied, PAC)).toBe(false);
  });

  it("stateMatchesSnapshot ignores a service that appeared after the snapshot", () => {
    const prior: SystemProxyState = {
      platform: "darwin",
      services: [
        { name: "Wi-Fi", web: { enabled: false, server: "", port: 0 }, secure: { enabled: false, server: "", port: 0 }, auto: { enabled: false, url: "" }, bypass: ["*.local"] },
      ],
    };
    const after: SystemProxyState = {
      platform: "darwin",
      services: [
        { name: "Wi-Fi", web: { enabled: false, server: "127.0.0.1", port: 9294 }, secure: { enabled: false, server: "", port: 0 }, auto: { enabled: false, url: "" }, bypass: ["*.local"] },
        // 'Ethernet 2' appeared later — not in the snapshot, holds nothing of ours.
        { name: "Ethernet 2", web: { enabled: true, server: "127.0.0.1", port: 9294 }, secure: { enabled: true, server: "127.0.0.1", port: 9294 }, auto: { enabled: false, url: "" }, bypass: [] },
      ],
    };
    expect(stateMatchesSnapshot(after, prior)).toBe(true);
  });

  it("darwin summary names the services honestly", () => {
    const state: SystemProxyState = {
      platform: "darwin",
      services: [
        { name: "Wi-Fi", web: { enabled: true, server: "127.0.0.1", port: 9294 }, secure: { enabled: true, server: "127.0.0.1", port: 9294 }, auto: { enabled: false, url: "" }, bypass: [] },
        { name: "Ethernet", web: { enabled: false, server: "", port: 0 }, secure: { enabled: false, server: "", port: 0 }, auto: { enabled: false, url: "" }, bypass: ["*.local"] },
      ],
    };
    expect(summarizeSystemProxyState(state)).toBe("manual 127.0.0.1:9294 on Wi-Fi, Ethernet");
    expect(normalizeSystemProxyState(state).mode).toBe("manual");
  });

  it("planSystemProxyRevert only plans services the snapshot recorded", () => {
    const prior: SystemProxyState = {
      platform: "darwin",
      services: [
        { name: "Wi-Fi", web: { enabled: false, server: "", port: 0 }, secure: { enabled: false, server: "", port: 0 }, auto: { enabled: false, url: "" }, bypass: [] },
      ],
    };
    const plan = planSystemProxyRevert(prior, "darwin");
    // Bypass was empty → the Empty clear literal; no service it never wrote.
    expect(plan.map((w) => w.args)).toEqual([
      ["-setwebproxystate", "Wi-Fi", "off"],
      ["-setsecurewebproxystate", "Wi-Fi", "off"],
      ["-setautoproxystate", "Wi-Fi", "off"],
      ["-setproxybypassdomains", "Wi-Fi", "Empty"],
    ]);
  });
});
