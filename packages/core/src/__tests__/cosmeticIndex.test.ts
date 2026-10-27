import { describe, expect, test } from "@jest/globals";
import {
  CANONICAL_SCRIPTLET_NAMES,
  canonicalScriptletName,
  createCosmeticIndex,
} from "../cosmetic/cosmeticIndex.js";

describe("createCosmeticIndex — element hiding", () => {
  test("indexes a global ## rule for every host, including bare-tag selectors", () => {
    // `##body` would be a bad *picker* rule, but list authors legitimately ship
    // broad selectors and uBO/AdGuard apply them raw — only the structural
    // check applies to list-sourced rules.
    const index = createCosmeticIndex(["##body", "##.ad-slot", "###ad"]);
    expect(index.forHost("anything.example")?.hide).toEqual(
      expect.arrayContaining(["body", ".ad-slot", "#ad"]),
    );
  });

  test("applies a domain rule to the host and its subdomains, never a sibling", () => {
    const index = createCosmeticIndex(["example.com##.ad", "other.com##.ad"]);
    expect(index.forHost("example.com")?.hide).toContain(".ad");
    expect(index.forHost("sub.example.com")?.hide).toContain(".ad");
    expect(index.forHost("notexample.com")?.hide ?? []).not.toContain(".ad");
    expect(index.forHost("example.com.evil.com")?.hide ?? []).not.toContain(
      ".ad",
    );
  });

  test("multi-domain comma lists index under every token", () => {
    const index = createCosmeticIndex([
      "20minutos.es,goplay.be,ouest-france.fr,strefabiznesu.pl#@#.didomi-screen-xlarge",
      "abczdrowie.pl,dobreprogramy.pl,wp.pl##.share-box",
    ]);
    expect(index.forHost("wp.pl")?.hide).toContain(".share-box");
    expect(index.forHost("dobreprogramy.pl")?.hide).toContain(".share-box");
    expect(index.forHost("ouest-france.fr")?.hide).toBeUndefined();
    expect(index.forHost("unrelated.io")?.hide).toBeUndefined();
  });

  test("~ exclusion vetoes its own rule only", () => {
    const index = createCosmeticIndex([
      "pingit.*,~pingit.com##+js(aopr, _pop)",
      "pingit.com##.ad",
      "example.com,~ads.example.com##.banner",
    ]);
    // The exclusion kills the scriptlet on pingit.com but not the other rule's hide.
    const vetoed = index.forHost("pingit.com");
    expect(vetoed?.scriptlets ?? []).toHaveLength(0);
    expect(vetoed?.hide).toContain(".ad");
    // The entity still applies everywhere else it reaches.
    expect(index.forHost("pingit.co.uk")?.scriptlets).toHaveLength(1);
    // And the exclusion on a different rule only bites the excluded host.
    expect(index.forHost("ads.example.com")?.hide).toBeUndefined();
    expect(index.forHost("www.example.com")?.hide).toContain(".banner");
    expect(index.forHost("example.com")?.hide).toContain(".banner");
  });

  test("a domain list of only ~ tokens is a global rule minus those hosts", () => {
    const index = createCosmeticIndex([
      '~addtoany.com##a[href="http://www.addtoany.com/share_save"]',
    ]);
    expect(index.forHost("some-random.example")?.hide).toContain(
      'a[href="http://www.addtoany.com/share_save"]',
    );
    expect(index.forHost("addtoany.com")?.hide).toBeUndefined();
    expect(index.forHost("sub.addtoany.com")?.hide).toBeUndefined();
  });

  test("entity.* matches the registered domain's SLD, not a suffix lookalike", () => {
    const index = createCosmeticIndex(["sony.*##.ad", "yandex.*##.ya-ad"]);
    expect(index.forHost("sony.pl")?.hide).toContain(".ad");
    expect(index.forHost("www.sony.co.jp")?.hide).toContain(".ad");
    expect(index.forHost("sonyplc.com")?.hide).toBeUndefined();
    expect(index.forHost("sony.com.evil.example")?.hide).toBeUndefined();
    expect(index.forHost("yandex.ru")?.hide).toContain(".ya-ad");
    expect(index.forHost("mail.yandex.ru")?.hide).toContain(".ya-ad");
  });

  test("#@# removes a global-sourced selector on the matching host only", () => {
    const index = createCosmeticIndex([
      "##.reklama",
      "101.ru#@#.reklama",
      "example.com##.ad",
      "example.com#@#.ad",
    ]);
    expect(index.forHost("101.ru")?.hide).toBeUndefined();
    expect(index.forHost("other.example")?.hide).toContain(".reklama");
    // The domain exception removed only `.ad`; the global `.reklama` stays.
    expect(index.forHost("example.com")?.hide).toEqual([".reklama"]);
    expect(index.forHost("sub.other.example")?.hide).toContain(".reklama");
  });

  test("an exception for a never-injected selector is a no-op", () => {
    const index = createCosmeticIndex([
      "example.com#@#.ghost",
      "example.com##.ad",
    ]);
    expect(index.forHost("example.com")?.hide).toContain(".ad");
  });

  test("structurally dangerous selectors are rejected and counted", () => {
    const index = createCosmeticIndex([
      "example.com##.ad { }",
      "example.com##.ad} body { display: none",
      "example.com##a; b",
      "example.com##@import url(x)",
      "example.com##</style><script>",
      "example.com##.ad /* comment */",
      "example.com##.safe",
    ]);
    expect(index.forHost("example.com")?.hide).toEqual([".safe"]);
    expect(index.stats.invalidSelectors).toBe(6);
  });

  test("host input is normalized: case, whitespace and a trailing dot", () => {
    const index = createCosmeticIndex(["example.com##.ad"]);
    expect(index.forHost("  Example.COM.  ")?.hide).toContain(".ad");
  });
});

describe("createCosmeticIndex — style rules", () => {
  test("#$# bodies are collected verbatim, selector { declarations } and all", () => {
    const index = createCosmeticIndex([
      "0calc.com#$##abmodal { display: none !important; }",
      "telekom.de#$#body { overflow: auto !important; }",
    ]);
    expect(index.forHost("0calc.com")?.styles).toEqual([
      "#abmodal { display: none !important; }",
    ]);
    expect(index.forHost("telekom.de")?.styles).toEqual([
      "body { overflow: auto !important; }",
    ]);
  });

  test("#@$# cancels the style rule for its literal selector on matching hosts", () => {
    const index = createCosmeticIndex([
      "example.com#$##overlay-content { display: none!important; }",
      "other.com#$##overlay-content { display: none!important; }",
      "example.com#@$##overlay-content { display: none!important; }",
    ]);
    expect(index.forHost("example.com")?.styles).toBeUndefined();
    expect(index.forHost("other.com")?.styles).toEqual([
      "#overlay-content { display: none!important; }",
    ]);
  });

  test("#$?# extended-style rules are parsed and skipped with a stat", () => {
    const index = createCosmeticIndex([
      '#$?#meta[name="apple-itunes-app"] { remove: true; }',
      "example.com##.ad",
    ]);
    expect(index.stats.extendedStyles).toBe(1);
    expect(index.forHost("example.com")?.hide).toContain(".ad");
  });

  test("#?# extended-css rules are parsed and skipped with a stat", () => {
    const index = createCosmeticIndex([
      "filecrypt.co#?#form > .protection.online ul > li:not(.buttons):-abp-has(> div)",
      "example.com#@?#.also-extended",
      "example.com##.ad",
    ]);
    expect(index.stats.extendedCss).toBe(2);
    expect(index.forHost("filecrypt.co")?.hide).toBeUndefined();
  });
});

describe("createCosmeticIndex — scriptlets", () => {
  test("##+js parses name + raw args and canonicalizes uBO terse names", () => {
    const index = createCosmeticIndex([
      "example.com##+js(abort-current-script, admiral)",
      "example.com##+js(set, adblock, false)",
      "example.com##+js(nowebrtc)",
    ]);
    const payload = index.forHost("example.com");
    expect(payload?.scriptlets).toEqual([
      { name: "abort-current-inline-script", args: ["admiral"] },
      { name: "set-constant", args: ["adblock", "false"] },
      { name: "nowebrtc", args: [] },
    ]);
    expect(payload?.skippedScriptlets).toBe(0);
  });

  test("the bare +js(…) global form and single-# #+js AdGuard form both parse", () => {
    const index = createCosmeticIndex([
      "##+js(noeval)",
      "example.com#+js(set-constant, ads, false)",
    ]);
    expect(index.forHost("example.com")?.scriptlets).toEqual([
      { name: "set-constant", args: ["ads", "false"] },
      { name: "prevent-eval-if", args: [] },
    ]);
    expect(index.forHost("other.example")?.scriptlets).toEqual([
      { name: "prevent-eval-if", args: [] },
    ]);
  });

  test("#%#//scriptlet parses JS-string-literal args incl. double quotes", () => {
    const index = createCosmeticIndex([
      'rp5.ru,rp5.ua#%#//scriptlet("set-constant", "Object.prototype.cABNoCheck", "undefined")',
      "123684.com#%#//scriptlet('prevent-window-open')",
    ]);
    expect(index.forHost("rp5.ru")?.scriptlets).toEqual([
      {
        name: "set-constant",
        args: ["Object.prototype.cABNoCheck", "undefined"],
      },
    ]);
    expect(index.forHost("rp5.ua")?.scriptlets).toHaveLength(1);
    expect(index.forHost("123684.com")?.scriptlets).toEqual([
      { name: "prevent-window-open", args: [] },
    ]);
  });

  test("escaped commas and quoted escapes survive arg parsing", () => {
    const index = createCosmeticIndex([
      'giga.de##+js(rpnt, script, /\\"homad\\"\\,/)',
      "lnk2.cc##+js(aeld, , '\\')",
      "example.com#%#//scriptlet('set-constant', 'it\\'s', 'a\\nb')",
    ]);
    const giga = index.forHost("giga.de");
    expect(giga?.scriptlets[0]).toEqual({
      name: "remove-node-text",
      args: ["script", '/\\"homad\\",/'],
    });
    const lnk2 = index.forHost("lnk2.cc");
    expect(lnk2?.scriptlets[0]).toEqual({
      name: "prevent-addEventListener",
      args: ["", "\\"],
    });
    const example = index.forHost("example.com");
    expect(example?.scriptlets[0]).toEqual({
      name: "set-constant",
      args: ["it's", "a\nb"],
    });
  });

  test("object-literal args with inner commas do not split", () => {
    const index = createCosmeticIndex([
      "10play.com.au##+js(set, moatPrebidApi, { cmd: { display: noopfn, player: noopfn } })",
    ]);
    expect(index.forHost("10play.com.au")?.scriptlets).toEqual([
      {
        name: "set-constant",
        args: ["moatPrebidApi", "{ cmd: { display: noopfn, player: noopfn } }"],
      },
    ]);
  });

  test("#@#+js cancels the same-named scriptlet for that host only", () => {
    const index = createCosmeticIndex([
      "##+js(aopr, _pop)",
      "abczdrowie.pl#@#+js(aopr, _pop)",
      "multi.example,dziennik.example#@#+js(set-constant, pp_adblock_is_off, trueFunc)",
      "dziennik.example##+js(set-constant, pp_adblock_is_off, trueFunc)",
    ]);
    expect(index.forHost("abczdrowie.pl")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("other.example")?.scriptlets).toHaveLength(1);
    // Name+args form cancels only the matching invocation — on dziennik.example
    // the global aopr survives while the domain set-constant is cancelled; on
    // multi.example the exception simply has nothing to cancel.
    expect(index.forHost("dziennik.example")?.scriptlets).toHaveLength(1);
    expect(index.forHost("multi.example")?.scriptlets).toHaveLength(1);
  });

  test("a name-only scriptlet exception cancels every invocation of the name", () => {
    const index = createCosmeticIndex([
      "uii.io#@#+js(noeval)",
      "uii.io##+js(noeval)",
      "uii.io##+js(no-eval-if)",
      "uii.io##+js(set, x, 1)",
    ]);
    const payload = index.forHost("uii.io");
    expect(payload?.scriptlets).toEqual([
      { name: "set-constant", args: ["x", "1"] },
    ]);
  });

  test("unknown names are emitted raw and counted in skippedScriptlets", () => {
    const index = createCosmeticIndex([
      "example.com##+js(popads-dummy)",
      "example.com##+js(set, x, 1)",
    ]);
    const payload = index.forHost("example.com");
    expect(payload?.scriptlets.map((s) => s.name)).toEqual([
      "popads-dummy",
      "set-constant",
    ]);
    expect(payload?.skippedScriptlets).toBe(1);
  });

  test(".js-suffixed names and a trailing :matches-path tail", () => {
    const index = createCosmeticIndex([
      "example.com##+js(cookie-remover.js)",
      "yandex.*#@#+js(aopr, Object.prototype.renderDirect):matches-path(/\\/(?:weather\\/|pogoda\\/|hava\\/)/)",
    ]);
    // `.js` is stripped before alias resolution; remove-cookie is not canonical.
    const payload = index.forHost("example.com");
    expect(payload?.scriptlets[0].name).toBe("remove-cookie");
    expect(payload?.skippedScriptlets).toBe(1);
    // The path-scoped exception cannot be honored — skipped with a stat, and
    // the invocation it would cancel does not exist here anyway.
    expect(index.stats.scopeModifiers).toBe(1);
  });

  test("raw-JS #%# bodies are parsed-and-skipped, never emitted", () => {
    const index = createCosmeticIndex([
      'akinator.mobi#%#document.cookie="x=1; path=/;";',
      'agoda.com#%#div[data-element-test="prominent-app-download-popover"]',
      "giga.de#@%#(function(o){return o})(Object.defineProperties);",
      "example.com##.ad",
    ]);
    expect(index.stats.rawJsRules).toBe(3);
    expect(index.forHost("akinator.mobi")?.scriptlets).toBeUndefined();
    expect(index.forHost("example.com")?.hide).toContain(".ad");
  });

  test("[$path=…]-prefixed rules are skipped with a stat, not applied globally", () => {
    const index = createCosmeticIndex([
      "[$path=/images]ya.ru,yandex.*#$?#.RelatedImages { remove: true; }",
      "[$path=/\\/sites/]forbes.com#%#//scriptlet('prevent-element-src-loading', 'script', 'x')",
      "example.com##.ad",
    ]);
    expect(index.stats.scopeModifiers).toBe(2);
    expect(index.forHost("ya.ru")?.scriptlets).toBeUndefined();
  });
});

describe("createCosmeticIndex — contract edges", () => {
  test("empty input builds an empty index", () => {
    const index = createCosmeticIndex([]);
    expect(index.size()).toEqual({
      selectors: 0,
      exceptions: 0,
      scriptlets: 0,
      styles: 0,
    });
    expect(index.forHost("example.com")).toBeUndefined();
  });

  test("forHost returns undefined when nothing matches — the hot-path skip", () => {
    const index = createCosmeticIndex(["example.com##.ad"]);
    expect(index.forHost("unrelated.io")).toBeUndefined();
    expect(index.forHost("")).toBeUndefined();
    // And when exceptions consumed everything the host had.
    const excepted = createCosmeticIndex(["##.ad", "example.com#@#.ad"]);
    expect(excepted.forHost("example.com")).toBeUndefined();
  });

  test("malformed lines are skipped, not fatal", () => {
    const index = createCosmeticIndex([
      "",
      "! a comment",
      "[Adblock Plus 2.0]",
      "||network-rule.example^",
      "example.com##",
      "example.com##+js(",
      "example.com#%#//scriptlet(",
      "example.com##.ad",
    ]);
    const payload = index.forHost("example.com");
    expect(payload?.hide).toEqual([".ad"]);
    expect(index.stats.malformed).toBe(3);
    expect(index.stats.notCosmetic).toBeGreaterThanOrEqual(4);
  });

  test("size() reports the indexed populations", () => {
    const index = createCosmeticIndex([
      "example.com,other.com##.ad",
      "##.global",
      "example.com#@#.ad",
      "example.com#$#.x { display: none; }",
      "example.com##+js(set, a, b)",
    ]);
    expect(index.size()).toEqual({
      selectors: 2,
      exceptions: 1,
      scriptlets: 1,
      styles: 1,
    });
  });

  test("canonicalScriptletName resolves aliases and leaves unknowns raw", () => {
    expect(canonicalScriptletName("aopr")).toBe("abort-on-property-read");
    expect(canonicalScriptletName("set")).toBe("set-constant");
    expect(canonicalScriptletName("setConstant")).toBe("set-constant");
    expect(canonicalScriptletName("nostif")).toBe("prevent-setTimeout");
    expect(canonicalScriptletName("nano-sib")).toBe("adjust-setInterval");
    expect(canonicalScriptletName("aeld")).toBe("prevent-addEventListener");
    expect(canonicalScriptletName("nowoif")).toBe("prevent-window-open");
    expect(canonicalScriptletName("noeval")).toBe("prevent-eval-if");
    expect(canonicalScriptletName("no-xhr-if")).toBe("prevent-xhr");
    expect(canonicalScriptletName("ra")).toBe("remove-attr");
    expect(canonicalScriptletName("rc")).toBe("remove-class");
    expect(canonicalScriptletName("abort-on-property-read")).toBe(
      "abort-on-property-read",
    );
    expect(canonicalScriptletName("something-unknown")).toBe(
      "something-unknown",
    );
    // Every alias target in the canonical table is a member of the canonical set.
    for (const name of [
      "aopr",
      "aopw",
      "acs",
      "acis",
      "abort-current-script",
      "aost",
      "aeld",
      "nostif",
      "nosiif",
      "nano-stb",
      "nano-sib",
      "no-fetch-if",
      "no-xhr-if",
      "nowoif",
      "noeval",
      "set",
      "setConstant",
      "ra",
      "rc",
    ]) {
      expect(CANONICAL_SCRIPTLET_NAMES.has(canonicalScriptletName(name))).toBe(
        true,
      );
    }
  });
});
