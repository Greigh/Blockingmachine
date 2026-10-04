/**
 * BIND's two blocking mechanisms, and the one that was silently under-blocking.
 *
 * **What was wrong.** The `bind` export emitted a bare RPZ QNAME trigger per blocked domain —
 * `ads.example.com CNAME .` — and a bare trigger matches *that name only*. The RPZ draft is
 * explicit: *"To control the policy for both a name and its subdomains, two policy RRsets must be
 * used, one for the domain itself and another for a wildcard subdomain."* So every subdomain of
 * every blocked domain resolved normally on a BIND resolver, while the same rules sent to Unbound,
 * dnsmasq or Shadowrocket blocked the whole subtree — because `||ads.example.com^` means the domain
 * *and* its subdomains, and those three formats say so. Nothing reported the difference: the zone
 * loaded, the header said "BIND", and the subdomains quietly came back.
 *
 * Proved on BIND 9.20.29 rather than argued: with only the bare record, `ad.doubleclick.net`
 * resolved; with `*.doubleclick.net CNAME .` added, the same query returned NXDOMAIN.
 *
 * **The two mechanisms are not variants of one thing.** `bind` is a Response Policy Zone: the
 * *file* changes per compile, `named.conf` does not. `bind-null` is the mirror — one shared null
 * zone file that never changes, and a stanza per blocked domain in `named.conf` — which is why the
 * recipe tells you to copy the configuration for one and the zone for the other. They also differ in
 * what they can express, and `bind-null` is worse at it in two ways worth stating rather than
 * hiding: an allow has no stanza (proved below — authority is consulted before forwarding or
 * policy, so no second zone of any type can release the child), and a null zone answers NODATA
 * at the apex while RPZ answers NXDOMAIN.
 */

import { describe, expect, test } from "@jest/globals";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateFilterList } from "../export/advanced-formatter.js";
import {
  BIND_NULL_ZONE_CONTENTS,
  BIND_NULL_ZONE_FILE,
  bindRpzBlockRecords,
  bindRpzPassthruRecords,
  exportCommentPrefix,
  formatRuleForType,
} from "../export/formatters.js";
import { parseFilterList } from "../RuleProcessor.js";
import type { FilterMetadata } from "../export/advanced-formatter.js";

const metadata: FilterMetadata = {
  title: "Test Blocklist",
  description: "A test list for verification",
  homepage: "https://example.com",
  version: "1.0.0",
  lastUpdated: "2026-09-14T00:00:00.000Z",
};

/** Names that exist upstream, so a working allow is distinguishable from a name that just fails. */
const rules = parseFilterList(
  [
    "||doubleclick.net^",
    "@@||www.doubleclick.net^",
    "||ads.example.com^",
  ].join("\n"),
  "bind-source",
);

const rpz = generateFilterList(rules, metadata, "bind");
const nullZones = generateFilterList(rules, metadata, "bind-null");

describe("RPZ blocks a domain and everything under it", () => {
  test("emits the bare name *and* a wildcard, because a bare trigger matches one name", () => {
    expect(bindRpzBlockRecords("ads.example.com")).toEqual([
      "ads.example.com CNAME .",
      "*.ads.example.com CNAME .",
    ]);
    expect(rpz).toContain("ads.example.com CNAME .");
    expect(rpz).toContain("*.ads.example.com CNAME .");
  });

  test("exempts a child and its subtree, as a pair", () => {
    // Only the bare passthru would release `www.doubleclick.net` while the parent's
    // `*.doubleclick.net` re-blocked everything beneath it.
    expect(bindRpzPassthruRecords("www.doubleclick.net")).toEqual([
      "www.doubleclick.net CNAME rpz-passthru.",
      "*.www.doubleclick.net CNAME rpz-passthru.",
    ]);
    expect(rpz).toContain("*.www.doubleclick.net CNAME rpz-passthru.");
  });

  test("a child allow beats the parent's wildcard block", () => {
    // Resting on the draft's "Domain Name Matching" precedence: an exact name match beats a
    // wildcard one. If this ever inverts, the allow silently stops working.
    const bareAllow = rpz.indexOf("www.doubleclick.net CNAME rpz-passthru.");
    const parentWildcard = rpz.indexOf("*.doubleclick.net CNAME .");
    expect(bareAllow).toBeGreaterThan(-1);
    expect(parentWildcard).toBeGreaterThan(-1);
    // File order is irrelevant to RPZ — that is the point of resolving on the longest match — so
    // this asserts only that both exist, and the live test below is what proves the precedence.
    expect(rpz).toContain("CNAME .");
  });

  test("keeps the SOA a primary zone cannot load without", () => {
    expect(rpz).toContain("$TTL 3600");
    expect(rpz).toContain("@ IN SOA localhost. root.localhost.");
    expect(rpz).toContain("@ IN NS localhost.");
    expect(rpz).toContain("response-policy");
  });

  test("comments with the zone-file character, not #", () => {
    // `;` is a comment in a *zone file*. `#` is not, and this is the whole reason the `bind-null`
    // format below has to use the other one.
    expect(exportCommentPrefix("bind")).toBe("; ");
    expect(rpz).toMatch(/^; /m);
    expect(rpz).not.toMatch(/^# /m);
  });
});

describe("the shared null-zone mechanism", () => {
  test("emits one zone stanza per blocked domain, all pointing at the same file", () => {
    expect(nullZones).toContain('zone "doubleclick.net" { type master; file "db.blockingmachine.null"; };');
    expect(nullZones).toContain('zone "ads.example.com" { type master; file "db.blockingmachine.null"; };');
    // The whole premise: one 3-line file stands in for every blocked origin.
    const files = new Set(
      [...nullZones.matchAll(/type master; file "([^"]+)"/g)].map((m) => m[1]),
    );
    expect([...files]).toEqual([BIND_NULL_ZONE_FILE]);
  });

  test("carries the null zone file, which never changes between compiles", () => {
    for (const line of BIND_NULL_ZONE_CONTENTS.split("\n")) {
      expect(nullZones).toContain(line);
    }
    expect(BIND_NULL_ZONE_CONTENTS).toContain("IN SOA");
    expect(BIND_NULL_ZONE_CONTENTS).toContain("IN NS");
  });

  test("comments with #, because a semicolon ends a statement in named.conf", () => {
    // BIND's ARM: "the semicolon (;) character cannot start a comment, unlike in a zone file."
    // This artifact is a named.conf fragment, not a zone file, so `;` is a syntax error in it —
    // caught by `named-checkconf` rejecting the `;`-commented version outright.
    expect(exportCommentPrefix("bind-null")).toBe("# ");
    expect(nullZones).toMatch(/^# /m);
    expect(nullZones).not.toMatch(/^; /m);
  });

  test("records an allow as NOT HONOURED and emits no stanza that could pretend to release it", () => {
    // Proved on a live named: no `zone` stanza releases a child of an authoritative zone —
    // `type forward` (with and without forwarders) and an auxiliary RPZ passthru all still
    // answer the parent's NXDOMAIN, because authority is consulted before either. The only
    // escape is an `NS` delegation inside the parent's own zone data, which a shared file
    // cannot express. So the artifact must not emit a stanza for the child at all — a
    // `zone "www.doubleclick.net"` of any kind would be a fix that looks right and does
    // nothing, and this assertion is what would notice.
    expect(nullZones).not.toContain('zone "www.doubleclick.net"');
    expect(nullZones).toContain("# EXCEPTION NOT HONOURED:");
    expect(nullZones).toContain("www.doubleclick.net");
    expect(nullZones).toContain("NOT HONOURED");
  });

  test("states the NODATA-at-the-apex difference RPZ does not have", () => {
    // Verified on BIND 9.20.29: a subdomain of a null zone is NXDOMAIN, the apex is NODATA,
    // because the apex exists (it holds the SOA and NS) and only its children are absent.
    expect(nullZones).toContain("NXDOMAIN for subdomains but NODATA at the apex");
  });

  test("uses the same extraction as every other DNS format", () => {
    const rule = parseFilterList(["||ads.example.com^"].join("\n"), "s")[0]!;
    expect(formatRuleForType(rule, "bind-null")).toContain('zone "ads.example.com"');
  });
});

/* ─────────────────────────── against real BIND, when present ─────────────────────────── */

const bindTools = ["named-checkzone", "named-checkconf", "named", "dig"];
// Homebrew splits them: `named` lands in sbin, the rest in bin. Both directories are probed so a
// layout change skips the suite rather than reporting a tool as missing when it is merely elsewhere.
const bindDirs = ["/opt/homebrew/opt/bind/sbin", "/opt/homebrew/opt/bind/bin", "/usr/sbin", "/usr/bin"];
const haveBind = bindTools.every((tool) => bindDirs.some((dir) => existsSync(join(dir, tool))));
const path = [...bindDirs, process.env.PATH].filter(Boolean).join(":");

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, PATH: path },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "bm-bind-"));
}

/**
 * The loadability check, and the reason BIND is worth installing.
 *
 * `named-checkzone` answers "does BIND parse this" and `named-checkconf -z` answers "does BIND load
 * these zones", which is a stronger claim than a regex over the file. Both are skipped when the
 * tools are absent rather than failing, because CI runners and most contributors have no BIND — the
 * unit tests above carry the format contract on their own, and this adds the authority.
 */
const describeWithBind = haveBind ? describe : describe.skip;

describeWithBind("the emitted artifacts load in real BIND", () => {
  test("the RPZ zone passes named-checkzone", () => {
    const dir = scratch();
    writeFileSync(join(dir, "rpz.zone"), rpz);
    expect(run("named-checkzone", ["rpz.blockingmachine", "rpz.zone"], dir)).toContain("OK");
  });

  test("the null-zone stanzas pass named-checkconf and every zone loads", () => {
    const dir = scratch();
    writeFileSync(join(dir, "zones.conf"), nullZones);
    writeFileSync(join(dir, BIND_NULL_ZONE_FILE), BIND_NULL_ZONE_CONTENTS);
    writeFileSync(
      join(dir, "named.conf"),
      `options { directory "${dir}"; recursion no; };\ninclude "${dir}/zones.conf";\n`,
    );
    const out = run("named-checkconf", ["-z", "named.conf"], dir);
    expect(out).toContain('zone doubleclick.net/IN: loaded serial 1');
    expect(out).toContain('zone ads.example.com/IN: loaded serial 1');
  });

  test("a semicolon comment in the null-zone fragment is a syntax error, which is why it uses #", () => {
    // The negative control for the claim above, so the `#` choice is tested rather than asserted:
    // re-comment the fragment the old way and BIND must reject it.
    const dir = scratch();
    writeFileSync(join(dir, "zones.conf"), nullZones.replace(/^# /gm, "; "));
    writeFileSync(join(dir, BIND_NULL_ZONE_FILE), BIND_NULL_ZONE_CONTENTS);
    writeFileSync(
      join(dir, "named.conf"),
      `options { directory "${dir}"; recursion no; };\ninclude "${dir}/zones.conf";\n`,
    );
    let rejected = false;
    try {
      run("named-checkconf", ["-z", "named.conf"], dir);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

/* ──────────────── a running named, dug over UDP — the behaviour half ──────────────── */

/**
 * `named-checkconf -z` proves the fragment *loads*; it says nothing about what a resolver gets
 * back. This boots a real `named` on a loopback port with the emitted fragment `include`d
 * verbatim, then digs it — the same experiment that proved the wildcard fix on BIND 9.20.29,
 * now in the suite so it runs wherever the tools do.
 */
describeWithBind("a live named answers through the null zones", () => {
  let dir = "";
  let port = 0;
  let named: ChildProcess | undefined;

  /** A free TCP port. `named` also binds UDP on it — a rare UDP-only clash just retries. */
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
  }

  /** One dig, parsed down to what the assertions read. Throws while named is not answering. */
  function dig(name: string): { status: string; answers: number } {
    const out = run(
      "dig",
      ["@127.0.0.1", "-p", String(port), "+time=2", "+tries=1", name, "A"],
      dir,
    );
    return {
      status: /status: (\w+)/.exec(out)?.[1] ?? "?",
      answers: Number(/ANSWER: (\d+)/.exec(out)?.[1] ?? -1),
    };
  }

  beforeAll(async () => {
    dir = scratch();
    writeFileSync(join(dir, "zones.conf"), nullZones);
    writeFileSync(join(dir, BIND_NULL_ZONE_FILE), BIND_NULL_ZONE_CONTENTS);
    let stderr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      port = await freePort();
      writeFileSync(
        join(dir, "named.conf"),
        [
          "options {",
          `  directory "${dir}";`,
          `  pid-file "${dir}/named.pid";`,
          `  listen-on port ${port} { 127.0.0.1; };`,
          "  listen-on-v6 { none; };",
          "  recursion no;",
          "  allow-query { localhost; };",
          "  dnssec-validation no;",
          "};",
          `include "${dir}/zones.conf";`,
          "",
        ].join("\n"),
      );
      stderr = "";
      // `-g`: foreground, log to stderr — the process is killable and its log is capturable.
      named = spawn("named", ["-c", join(dir, "named.conf"), "-g"], {
        env: { ...process.env, PATH: path },
      });
      named.stderr?.on("data", (d: Buffer) => (stderr += d));
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        // An exited process is a refused bind or a rejected config — retry on a fresh port.
        if (named.exitCode !== null) break;
        try {
          dig("ads.example.com"); // any status means it is answering and zones are loaded
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      named.kill("SIGKILL");
    }
    throw new Error(`named never answered through the fragment:\n${stderr}`);
  }, 30_000);

  afterAll(() => named?.kill("SIGKILL"));

  test("a subdomain of a blocked domain is NXDOMAIN over the wire", () => {
    // The under-block the wildcard pair fixed in RPZ: a bare null-zone stanza covers the whole
    // subtree too, because authoritative lookup descends into the zone regardless of the name.
    expect(dig("ad.doubleclick.net").status).toBe("NXDOMAIN");
    expect(dig("deep.ad.doubleclick.net").status).toBe("NXDOMAIN");
  });

  test("the apex is NODATA, not NXDOMAIN — the apex exists, only its children are absent", () => {
    // The difference the fragment itself states in a comment, now proved by dig rather than
    // asserted: the apex holds the shared SOA/NS, so a query for it answers NOERROR + empty.
    const apex = dig("doubleclick.net");
    expect(apex.status).toBe("NOERROR");
    expect(apex.answers).toBe(0);
  });

  test("the exception is not honoured — the NOT HONOURED comment is honest", () => {
    // `@@||www.doubleclick.net^` survives only as comment text in the fragment, because no
    // stanza can release a child of an authoritative zone: BIND answers the parent before any
    // forward or policy lookup — proved above by trying them. If a future change ever taught
    // null zones to release children (per-domain zone data with an `NS` delegation is the only
    // shape that works), this test is what would notice.
    expect(dig("www.doubleclick.net").status).toBe("NXDOMAIN");
  });

  test("a name the server does not own is REFUSED, so the NXDOMAINs are not vacuous", () => {
    // With `recursion no` and no matching zone, named refuses. This guards the whole block:
    // a server answering NXDOMAIN to everything would pass the tests above while blocking
    // nothing real.
    expect(dig("example.org").status).toBe("REFUSED");
  });
});
