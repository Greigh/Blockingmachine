import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { jest } from "@jest/globals";
import * as meta from "../config/meta.js";
import * as performance from "../config/performance.js";
import { createPaths } from "../config/paths.js";
import { detectSourceClassification, getSourceProfile } from "../sources.js";

const coreRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("configuration and source isolation", () => {
  test("input path matches the tracked filename on case-sensitive filesystems", () => {
    const paths = createPaths(join(coreRoot, "../cli"));
    expect(readdirSync(paths.input.dir)).toContain(
      paths.input.Blockingmachine.split(/[\\/]/).pop(),
    );
  });

  test("metadata factories use the current time and isolate mutable statistics", () => {
    expect("createFilterMeta" in meta).toBe(true);
    const create = (
      meta as typeof meta & { createFilterMeta: () => meta.FilterMetaConfig }
    ).createFilterMeta;
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-09-25T12:00:00Z"));
      const first = create();
      first.stats.totalRules = 99;
      jest.setSystemTime(new Date("2026-09-26T12:00:00Z"));
      const second = create();
      expect(second.lastUpdated).toBe("2026-09-26T12:00:00.000Z");
      expect(second.stats.totalRules).toBe(0);
      expect(second.version).toBe(
        JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"))
          .version,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("performance factories isolate nested caller overrides", () => {
    expect("createPerformance" in performance).toBe(true);
    const create = (
      performance as typeof performance & {
        createPerformance: () => performance.PerformanceConfig;
      }
    ).createPerformance;
    const first = create();
    first.optimization.deduplication.aggressive = true;
    first.processing.batchSize = 1;
    expect(create().optimization.deduplication.aggressive).toBe(false);
    expect(create().processing.batchSize).toBe(1000);
  });

  test.each([getSourceProfile, detectSourceClassification])(
    "profile lookup returns isolated values",
    (lookup) => {
      const first = lookup("EasyList");
      const original = {
        ...first,
        features: [...first.features],
        targets: [...first.targets],
      };
      try {
        first.name = "changed";
        first.features.push("changed");
        first.targets.length = 0;
        expect(lookup("EasyList")).toEqual(original);
      } finally {
        // Restore the old implementation's registry when demonstrating the regression.
        Object.assign(first, original);
      }
    },
  );

  test("names containing slashes remain case-insensitive", () => {
    expect(getSourceProfile("HAGEZI'S WINDOWS/OFFICE TRACKER BLOCKLIST").trusted).toBe(true);
  });

  test("URL hostname is case-insensitive but path is case-sensitive", () => {
    expect(
      getSourceProfile("https://EASYLIST.TO/easylist/easylist.txt").trusted,
    ).toBe(true);
    expect(
      getSourceProfile("https://easylist.to/EASYLIST/easylist.txt").trusted,
    ).toBe(false);
    expect(
      getSourceProfile("./filters/modules/BLOCKINGMACHINE-base.txt").trusted,
    ).toBe(false);
  });
});

describe("sample rule scope", () => {
  test.each([
    ["*$removeparam=fbclid"],
    ["||example.com/ads.js"],
    ["||example.com^$third-party"],
    ["@@||example.com^$domain=site.test"],
    ["/ad[sx]\\.js/"],
    ["example.com#%#//scriptlet('abort-on-property-read', 'ads')"],
  ])("browser restrictions cannot be represented by DNS: %s", (rule) => {
    const profile = detectSourceClassification("custom-dns-list", [rule]);
    expect(profile.scope).toBe("browser");
    expect(profile.targets).toEqual(["browser"]);
  });

  test("mixed hosts and browser rules are hybrid", () => {
    expect(
      detectSourceClassification("custom", [
        "0.0.0.0 ads.example.com",
        "*$removeparam=fbclid",
      ]).scope,
    ).toBe("hybrid");
  });

  test("bare domains and unscoped important exceptions are DNS compatible", () => {
    expect(
      detectSourceClassification("custom", [
        "ads.example.com",
        "@@||safe.example.com^$important",
      ]).scope,
    ).toBe("dns");
  });

  test("long comment headers do not hide the first actual rules", () => {
    const profile = detectSourceClassification("custom", [
      ...Array(110).fill("# hosts comment"),
      "0.0.0.0 ads.example.com",
    ]);
    expect(profile.scope).toBe("dns");
  });
});

const moduleDir = join(coreRoot, "filters/modules");
const moduleNames = readdirSync(moduleDir).filter((name) =>
  name.endsWith(".txt"),
);
describe("bundled module integrity", () => {
  test.each(moduleNames)(
    "%s has no identical-scope redundant domain children",
    (name) => {
      const rules = readFileSync(join(moduleDir, name), "utf8")
        .split(/\r?\n/)
        .map((line) => line.match(/^(@@)?\|\|([a-z0-9.-]+)\^(\$important)?$/))
        .filter((match): match is RegExpMatchArray => match !== null);
      const redundant = rules.filter((child) =>
        rules.some(
          (parent) =>
            child !== parent &&
            child[1] === parent[1] &&
            child[3] === parent[3] &&
            child[2].endsWith(`.${parent[2]}`),
        ),
      );
      expect(redundant.map((match) => match[0])).toEqual([]);
    },
  );

  test("security domains do not contain a JavaScript filename mistaken for a hostname", () => {
    const rules = readFileSync(
      join(moduleDir, "blockingmachine-security.txt"),
      "utf8",
    ).split(/\r?\n/);
    expect(rules.filter((rule) => /^\|\|[^/]+\.js\^$/.test(rule))).toEqual([]);
  });
});
