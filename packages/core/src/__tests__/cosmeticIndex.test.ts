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

  test("*.sony.* matches subdomains of the entity, never the apex (flag 112)", () => {
    const index = createCosmeticIndex(["*.sony.*##.sub-ad"]);
    // Proper subdomains of any `sony` entity — any TLD, any depth.
    expect(index.forHost("x.sony.com")?.hide).toContain(".sub-ad");
    expect(index.forHost("y.sony.co.jp")?.hide).toContain(".sub-ad");
    expect(index.forHost("a.b.sony.com")?.hide).toContain(".sub-ad");
    // The apexes stay out — that is the whole point of the combined token.
    expect(index.forHost("sony.com")?.hide).toBeUndefined();
    expect(index.forHost("sony.co.jp")?.hide).toBeUndefined();
    // And the SLD boundary still holds — no suffix lookalikes.
    expect(index.forHost("x.sonyplc.com")?.hide).toBeUndefined();
    expect(index.forHost("a.sony.com.evil.example")?.hide).toBeUndefined();
  });

  test("~*.sony.* vetoes subdomains only — the apex keeps the rule", () => {
    const index = createCosmeticIndex([
      "sony.com,~*.sony.*##.ad",
      "sub.sony.com##.sub",
    ]);
    // The include covers sony.com; the sub-entity exclusion can't veto it.
    expect(index.forHost("sony.com")?.hide).toEqual([".ad"]);
    // A real subdomain of a sony entity IS vetoed (its own rule still fires).
    expect(index.forHost("sub.sony.com")?.hide).toEqual([".sub"]);
    expect(index.forHost("other.sony.com")?.hide).toBeUndefined();
    // A subdomain of a different entity is untouched.
    expect(index.forHost("sub.sonyplc.com")?.hide).toBeUndefined();
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

  test("a ] inside a quoted attribute value cannot end the bracket scan", () => {
    // `[a="]"]{…}` — the quoted `]` must not close the attribute matcher:
    // otherwise the trailing `"` opens a checker-quote that swallows the
    // `{`, and arbitrary CSS rides into the page.
    const index = createCosmeticIndex([
      'example.com##[a="]"]{position:fixed;inset:0}',
      "example.com##[a=']{']{position:fixed;inset:0}",
      'example.com##[a="]{still-quoted}"]',
      'example.com##[a="unterminated',
      "example.com##.safe",
    ]);
    // Both escape attempts and the unclosed quote are rejected; the
    // legitimately-quoted `]{…}` inside a string stays inert and valid.
    expect(index.forHost("example.com")?.hide).toEqual([
      '[a="]{still-quoted}"]',
      ".safe",
    ]);
    expect(index.stats.invalidSelectors).toBe(3);
  });

  test("*.foo.com covers subdomains only — never the apex", () => {
    const index = createCosmeticIndex([
      "*.sony.com##.sub-ad",
      "sony.com##.apex-ad",
      "~*.ads.example.com##.everywhere-but-subs",
    ]);
    expect(index.forHost("sony.com")?.hide).toEqual([
      ".apex-ad",
      ".everywhere-but-subs",
    ]);
    expect(index.forHost("www.sony.com")?.hide).toEqual(
      expect.arrayContaining([".sub-ad", ".apex-ad"]),
    );
    // `~*.` vetoes only the subdomains — the apex keeps the rule.
    expect(index.forHost("ads.example.com")?.hide).toContain(
      ".everywhere-but-subs",
    );
    expect(index.forHost("x.ads.example.com")?.hide).toBeUndefined();
  });

  test("~* excludes everything — the rule applies nowhere", () => {
    const index = createCosmeticIndex([
      "foo.com,~*##.never",
      "~*##.also-never",
      "foo.com##.yes",
      "##.global",
    ]);
    expect(index.forHost("foo.com")?.hide).toEqual([".yes", ".global"]);
    expect(index.forHost("bar.example")?.hide).toEqual([".global"]);
    const only = createCosmeticIndex(["~*##.sel"]);
    expect(only.forHost("anything.example")).toBeUndefined();
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

  test("#$?# extended-style rules emit when the selector is translatable", () => {
    const index = createCosmeticIndex([
      '#$?#meta[name="apple-itunes-app"] { remove: true; }',
      'example.com#$?#div:-abp-has(.banner) { display: none !important; }',
      "example.com##.ad",
    ]);
    expect(index.stats.extendedStyles).toBe(2);
    expect(index.forHost("example.com")?.hide).toContain(".ad");
    // `:-abp-has` folds to native `:has`; the declarations ride verbatim.
    // The host rule leads; the global one lands after it.
    expect(index.forHost("example.com")?.styles).toEqual([
      "div:has(.banner) { display: none !important; }",
      'meta[name="apple-itunes-app"] { remove: true; }',
    ]);
    // The global rule's plain selector needs no translation — emitted as-is.
    expect(index.forHost("other.example")?.styles).toEqual([
      'meta[name="apple-itunes-app"] { remove: true; }',
    ]);
  });

  test("#?# extended-css rules emit the CSS-expressible subset (flag 104)", () => {
    const index = createCosmeticIndex([
      "filecrypt.co#?#form > .protection.online ul > li:not(.buttons):-abp-has(> div)",
      "example.com#@?#.also-extended",
      "example.com##.ad",
    ]);
    expect(index.stats.extendedCss).toBe(2);
    // `:-abp-has(…)` translated to `:has(…)` — the selector hides for real now.
    expect(index.forHost("filecrypt.co")?.hide).toEqual([
      "form > .protection.online ul > li:not(.buttons):has(> div)",
    ]);
    // A `#@?#` exception with no pseudos stores like a `#@#` one.
    expect(index.size().exceptions).toBe(1);
    expect(index.forHost("example.com")?.hide).toEqual([".ad"]);
  });

  test("#?# pseudos that have no native reading are skipped and counted", () => {
    const index = createCosmeticIndex([
      "a.example#?#div:-abp-contains(advertisement)",
      'b.example#?#div:has-text("sponsored")',
      "c.example#?#div:contains(promo)",
      "d.example#?#div:matches-css(color: red)",
      "e.example#?#div:-abp-matches-css(display: block)",
      "f.example#?#div:upward(.container)",
      "g.example#?#div:xpath(//div)",
      "h.example#?#div:matches-attr(href=/ad/)",
      "i.example#?#div:something-unknown(1)",
      "j.example#?#div:has(.ok)",
      "k.example##.ad",
    ]);
    expect(index.stats.extendedCss).toBe(10);
    expect(index.stats.extendedUnsupported).toBe(9);
    // The one translatable rule emitted; every unsupported one stayed out.
    expect(index.forHost("j.example")?.hide).toEqual(["div:has(.ok)"]);
    expect(index.forHost("a.example")?.hide).toBeUndefined();
    expect(index.forHost("i.example")?.hide).toBeUndefined();
    expect(index.forHost("k.example")?.hide).toEqual([".ad"]);
  });

  test("a translated :has() cannot smuggle CSS through quote/bracket games", () => {
    const index = createCosmeticIndex([
      'example.com#?#div:has([a="]"]){position:fixed;inset:0}',
      "example.com#?#div:-abp-has([a=']{']){position:fixed;inset:0}",
      'example.com#?#div:has([a="]{still-quoted}"])',
      'example.com#?#div:has([a="unterminated',
      "example.com#?#div.safe",
      'example.com#?#span[title=":-abp-has(x)"]',
    ]);
    // The two quote-escape breakouts and the unterminated quote are refused
    // at the same structural gate `##` selectors pass through.
    expect(index.forHost("example.com")?.hide).toEqual([
      'div:has([a="]{still-quoted}"])',
      "div.safe",
      // `:-abp-has` inside a quoted attribute value is data — emitted as-is.
      'span[title=":-abp-has(x)"]',
    ]);
    expect(index.stats.invalidSelectors).toBe(3);
  });

  test("#@?# cancels a #?# hide by its translated selector", () => {
    const index = createCosmeticIndex([
      "example.com#?#div:-abp-has(.ad)",
      "example.com#@?#div:has(.ad)",
      "other.com#?#div:-abp-has(.ad)",
    ]);
    // Both spellings translate to `div:has(.ad)` — the exception's literal
    // match holds across marker families.
    expect(index.forHost("example.com")?.hide).toBeUndefined();
    expect(index.forHost("other.com")?.hide).toEqual(["div:has(.ad)"]);
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

  test("a name-only scriptlet exception cancels only the zero-arg call", () => {
    // uBO is literal-match on the whole call content: `#@#+js(nobab)` cancels
    // `##+js(nobab)` but leaves `##+js(nobab, _)` live — the escape hatch list
    // authors use to re-enable a scriptlet one arg-set at a time.
    const index = createCosmeticIndex([
      "uii.io#@#+js(nobab)",
      "uii.io##+js(nobab)",
      "uii.io##+js(nobab, _)",
      "uii.io##+js(noeval)",
      "uii.io##+js(set, x, 1)",
    ]);
    const payload = index.forHost("uii.io");
    expect(payload?.scriptlets).toEqual([
      { name: "prevent-bab", args: ["_"] },
      { name: "prevent-eval-if", args: [] },
      { name: "set-constant", args: ["x", "1"] },
    ]);
  });

  test("#@#+js() with no name cancels every scriptlet for its host only", () => {
    const index = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com##+js(set, x, 1)",
      "example.com#@#+js()",
      "other.com##+js(aopr, _pop)",
    ]);
    expect(index.forHost("example.com")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("other.com")?.scriptlets).toHaveLength(1);
    expect(index.size().scriptletExceptions).toBe(1);
  });

  test("a bare #@#+js() is the global scriptlet kill-all", () => {
    const index = createCosmeticIndex([
      "##+js(aopr, _pop)",
      "example.com##+js(set, x, 1)",
      "#@#+js()",
    ]);
    expect(index.forHost("example.com")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("anything.example")?.scriptlets ?? []).toHaveLength(0);
    // The non-exception `##+js()` is meaningless — malformed, not kill-all.
    const meaningless = createCosmeticIndex([
      "example.com##+js()",
      "example.com##+js(set, x, 1)",
    ]);
    expect(meaningless.stats.malformed).toBe(1);
    expect(meaningless.forHost("example.com")?.scriptlets).toHaveLength(1);
  });

  test("#@#+js():matches-path(…) kills scriptlets on matching paths only (flag 107)", () => {
    const index = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com##+js(set, x, 1)",
      "example.com#@#+js():matches-path(/ads/)",
    ]);
    // A matching path — every scriptlet cancelled.
    expect(index.forHost("example.com", "/ads/x")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("example.com", "/ads/")?.scriptlets ?? []).toHaveLength(0);
    // A non-matching path — the exception does not fire.
    expect(index.forHost("example.com", "/")?.scriptlets).toHaveLength(2);
    expect(index.forHost("example.com", "/other")?.scriptlets).toHaveLength(2);
    // No path at all — the exception applies unconditionally (the
    // under-injection direction: better to cancel a scriptlet than to keep
    // one the list meant to kill).
    expect(index.forHost("example.com")?.scriptlets ?? []).toHaveLength(0);
    expect(index.size().scriptletExceptions).toBe(1);
    expect(index.stats.malformed).toBe(0);
    expect(index.stats.scopeModifiers).toBe(0);
  });

  test("a path-scoped named exception cancels only that call on matching paths", () => {
    const index = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com##+js(set, x, 1)",
      "example.com#@#+js(aopr, _pop):matches-path(/x)",
    ]);
    // `/x` is a prefix — `/xyz` and `/x/y` match it, `/` and `/ax` do not.
    expect(index.forHost("example.com", "/x")?.scriptlets).toEqual([
      { name: "set-constant", args: ["x", "1"] },
    ]);
    expect(index.forHost("example.com", "/x/y")?.scriptlets).toEqual([
      { name: "set-constant", args: ["x", "1"] },
    ]);
    expect(index.forHost("example.com", "/")?.scriptlets).toHaveLength(2);
    expect(index.forHost("example.com", "/ax")?.scriptlets).toHaveLength(2);
    // The glob never matches a mid-path segment.
    expect(index.forHost("example.com", "/p/x")?.scriptlets).toHaveLength(2);
  });

  test("matches-path args: /regex/ form, glob wildcards and | end-anchor", () => {
    const index = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com#@#+js():matches-path(/\\/(?:weather\\/|pogoda\\/|hava\\/)/)",
    ]);
    // The real AdGuard regex arg — matches the segment anywhere in the path.
    expect(index.forHost("example.com", "/weather/today")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("example.com", "/pogoda/x")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("example.com", "/climate/x")?.scriptlets).toHaveLength(1);

    const glob = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com#@#+js():matches-path(/ads/*/x)",
    ]);
    expect(glob.forHost("example.com", "/ads/a/x")?.scriptlets ?? []).toHaveLength(0);
    expect(glob.forHost("example.com", "/ads/a/x/y")?.scriptlets ?? []).toHaveLength(0);
    expect(glob.forHost("example.com", "/ads/x")?.scriptlets).toHaveLength(1);

    const anchored = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com#@#+js():matches-path(/ads|)",
    ]);
    // `|` end-anchors: only the exact prefix `/ads` (and nothing longer).
    expect(anchored.forHost("example.com", "/ads")?.scriptlets ?? []).toHaveLength(0);
    expect(anchored.forHost("example.com", "/ads/x")?.scriptlets).toHaveLength(1);

    // A full URL is accepted — path+search is what gets matched.
    const viaUrl = createCosmeticIndex([
      "example.com##+js(aopr, _pop)",
      "example.com#@#+js():matches-path(/ads)",
    ]);
    expect(
      viaUrl.forHost("example.com", "https://example.com/ads/x?q=1")
        ?.scriptlets ?? [],
    ).toHaveLength(0);
    expect(
      viaUrl.forHost("example.com", "https://example.com/other")?.scriptlets,
    ).toHaveLength(1);
  });

  test("path-scoped kill-alls compose with ~ exclusions and domain scoping", () => {
    const index = createCosmeticIndex([
      "##+js(aopr, _pop)",
      "example.com,~sub.example.com#@#+js():matches-path(/ads/)",
    ]);
    // On a matching path the host's kill-all fires...
    expect(index.forHost("example.com", "/ads/x")?.scriptlets ?? []).toHaveLength(0);
    // ...on other paths it does not — the global scriptlet survives.
    expect(index.forHost("example.com", "/")?.scriptlets).toHaveLength(1);
    // The `~` exclusion still vetoes its own rule only — the subdomain is
    // exempt even on the matching path.
    expect(index.forHost("sub.example.com", "/ads/x")?.scriptlets).toHaveLength(1);
    // Unscoped hosts never carry the exception at all.
    expect(index.forHost("other.example", "/ads/x")?.scriptlets).toHaveLength(1);
  });

  test("a global path-scoped kill-all gates the shared global payload per path", () => {
    const index = createCosmeticIndex([
      "##+js(aopr, _pop)",
      "##.ad",
      "#@#+js():matches-path(/kill/)",
    ]);
    // The shared global payload is the no-path resolution — the exception
    // applies there.
    expect(index.forHost("anywhere.example")?.scriptlets ?? []).toHaveLength(0);
    // With a path carried, it applies only where the scope matches — the
    // same host answers differently per path (the host+path cache key).
    expect(index.forHost("anywhere.example", "/kill/x")?.scriptlets ?? []).toHaveLength(0);
    expect(index.forHost("anywhere.example", "/")?.scriptlets).toHaveLength(1);
    // Hides are unaffected either way.
    expect(index.forHost("anywhere.example", "/")?.hide).toEqual([".ad"]);
  });

  test("path-scoped invocations and non-exception +js() stay honest-skip", () => {
    const index = createCosmeticIndex([
      "example.com##+js(aopr, _pop):matches-path(/x)",
      "example.com##+js():matches-path(/x)",
      "example.com##+js(set, x, 1)",
      "example.com#@#+js():not-a-scope(/x)",
    ]);
    // The scoped invocation and the scoped non-exception kill-all skip —
    // under-injection is the honest direction for rules; the exception
    // carrying an unreadable scope is malformed like any other `+js()` tail.
    expect(index.stats.scopeModifiers).toBe(1);
    expect(index.stats.malformed).toBe(2);
    expect(index.forHost("example.com", "/x")?.scriptlets).toHaveLength(1);
  });

  test("a mid-token apostrophe is literal — quotes open only at arg start", () => {
    const index = createCosmeticIndex([
      "example.com##+js(set, prop, it's, value)",
    ]);
    expect(index.forHost("example.com")?.scriptlets).toEqual([
      { name: "set-constant", args: ["prop", "it's", "value"] },
    ]);
  });

  test("commas inside parens do not split args", () => {
    const index = createCosmeticIndex([
      "example.com##+js(set, x, f(a,b), y)",
    ]);
    expect(index.forHost("example.com")?.scriptlets).toEqual([
      { name: "set-constant", args: ["x", "f(a,b)", "y"] },
    ]);
  });

  test("backtick-quoted args group as raw literals (uBO ≥1.61)", () => {
    const index = createCosmeticIndex([
      "example.com##+js(set, x, `a,b`, y)",
      "other.com##+js(set, x, `keep \\n raw`)",
    ]);
    expect(index.forHost("example.com")?.scriptlets).toEqual([
      { name: "set-constant", args: ["x", "a,b", "y"] },
    ]);
    expect(index.forHost("other.com")?.scriptlets).toEqual([
      { name: "set-constant", args: ["x", "keep \\n raw"] },
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
    // The path-scoped exception is stored now (flag 107), not counted as an
    // unreadable scope — the invocation it would cancel still does not exist.
    expect(index.stats.scopeModifiers).toBe(0);
    expect(index.size().scriptletExceptions).toBe(1);
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
      scriptletExceptions: 0,
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

  test("two domainless hosts share one frozen payload object", () => {
    // The miss path is the hot path — domainless hosts must not each pay a
    // fresh ~40k-entry merge when the same global bucket answers them all.
    const index = createCosmeticIndex(["##.ad", "##+js(set, x, 1)", "other.com##.other"]);
    const a = index.forHost("alpha.example");
    const b = index.forHost("beta.example");
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a?.hide).toEqual([".ad"]);
    expect(a?.scriptlets).toHaveLength(1);
  });

  test("a host with domain hits gets its own merged payload — globals still apply", () => {
    const index = createCosmeticIndex(["##.global", "example.com##.local"]);
    const shared = index.forHost("other.example");
    const merged = index.forHost("example.com");
    expect(merged).not.toBe(shared);
    expect(merged?.hide).toEqual([".local", ".global"]);
    expect(shared?.hide).toEqual([".global"]);
    // Subdomain hits take the per-host path too.
    const sub = index.forHost("a.example.com");
    expect(sub).not.toBe(shared);
    expect(sub?.hide).toEqual([".local", ".global"]);
  });

  test("a vetoing ~ exclusion drops the host to the per-host path — the shared payload stays clean", () => {
    const index = createCosmeticIndex(["~vetoed.example##.ad", "##.global"]);
    const vetoed = index.forHost("vetoed.example");
    const shared = index.forHost("clean.example");
    expect(vetoed).not.toBe(shared);
    expect(vetoed?.hide).toEqual([".global"]);
    expect(shared?.hide).toEqual([".ad", ".global"]);
  });

  test("size() reports the indexed populations", () => {
    const index = createCosmeticIndex([
      "example.com,other.com##.ad",
      "##.global",
      "example.com#@#.ad",
      "example.com#$#.x { display: none; }",
      "example.com##+js(set, a, b)",
      "example.com#@#+js(set, a, b)",
    ]);
    expect(index.size()).toEqual({
      selectors: 2,
      exceptions: 1,
      scriptlets: 1,
      scriptletExceptions: 1,
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
    // AdGuard legacy camelCase spellings fold onto the canonical names.
    expect(canonicalScriptletName("abortOnPropertyRead")).toBe(
      "abort-on-property-read",
    );
    expect(canonicalScriptletName("preventWindowOpen")).toBe(
      "prevent-window-open",
    );
    expect(canonicalScriptletName("setLocalStorageItem")).toBe(
      "set-local-storage-item",
    );
    expect(canonicalScriptletName("noWindowOpenIf")).toBe(
      "prevent-window-open",
    );
    expect(canonicalScriptletName("preventSetTimeout")).toBe(
      "prevent-setTimeout",
    );
    // A `ubo`-prefixed spelling folds only onto a known name.
    expect(canonicalScriptletName("ubo-set-constant")).toBe("set-constant");
    expect(canonicalScriptletName("uboSetConstant")).toBe("set-constant");
    expect(canonicalScriptletName("ubo-something-unknown")).toBe(
      "ubo-something-unknown",
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

describe("forHost — shared global payload + merged hosts (flag 114)", () => {
  test("domainless hosts share one frozen payload object, not a re-merge", () => {
    const index = createCosmeticIndex(["##.global", "hit.example##.hit"]);
    const a = index.forHost("alpha.example");
    const b = index.forHost("beta.example");
    expect(a?.hide).toEqual([".global"]);
    expect(a).toBe(b); // the one shared global payload — object identity
    // …and the cached re-lookup is that same object again.
    expect(index.forHost("alpha.example")).toBe(a);
  });

  test("a host with its own rules merges them host-first over the globals", () => {
    const index = createCosmeticIndex([
      "##.global",
      "hit.example##.hit",
    ]);
    const merged = index.forHost("hit.example");
    // Host-sourced selectors precede globals — the order the old
    // single-bag merge produced.
    expect(merged?.hide).toEqual([".hit", ".global"]);
    // The merged result is itself cached — repeat lookups share it.
    expect(index.forHost("hit.example")).toBe(merged);
    // Other hosts keep their own merged payload, not the domainless one.
    expect(index.forHost("alpha.example")?.hide).toEqual([".global"]);
  });

  test("a `~` exclusion on a global vetoes it only on the excluded host", () => {
    const index = createCosmeticIndex([
      "~skip.example##.ad",
      "hit.example##.x",
    ]);
    // The vetoed host has no hits of its own and its only global is
    // excluded — the merge yields nothing.
    expect(index.forHost("skip.example")).toBeUndefined();
    // Unaffected lookups are untouched — `hit.example` still carries the
    // conditional global after its own rule (host-first merge order).
    expect(index.forHost("hit.example")?.hide).toEqual([".x", ".ad"]);
    expect(index.forHost("other.example")?.hide).toEqual([".ad"]);
  });

  test("conditional globals splice into the unconditional stream at their original position", () => {
    // Order fidelity: the merge must emit globals in `globalEntries` order,
    // not partition-order — a conditional sitting between two unconditional
    // rules keeps its slot (the single-bag merge's semantics).
    const index = createCosmeticIndex([
      "##.u1",
      "~ex.example##.c1",
      "##.u2",
      "hit.example##.hit",
    ]);
    expect(index.forHost("hit.example")?.hide).toEqual([
      ".hit",
      ".u1",
      ".c1",
      ".u2",
    ]);
    // The vetoed host loses only the conditional — position intact.
    expect(index.forHost("ex.example")?.hide).toEqual([".u1", ".u2"]);
  });

  test("a host-scoped #@# still cancels a global-sourced selector on its host only", () => {
    const index = createCosmeticIndex([
      "##.reklama",
      "ex.example#@#.reklama",
      "ex.example##.own",
    ]);
    // The global selector dies on the exception's host; the host's own
    // hide survives — exception membership unions across the merge.
    expect(index.forHost("ex.example")?.hide).toEqual([".own"]);
    expect(index.forHost("plain.example")?.hide).toEqual([".reklama"]);
  });

  test("style and scriptlet merge order/dedupe survive the shared-global overlay", () => {
    const index = createCosmeticIndex([
      "##.dup",
      "hit.example##.dup", // first occurrence wins — the host slot
      "#$#.g{color:red}",
      "hit.example#$#.h{color:blue}",
      "##+js(set-constant, g, 1)",
      "hit.example##+js(set-constant, h, 2)",
    ]);
    const payload = index.forHost("hit.example");
    expect(payload?.hide).toEqual([".dup"]);
    expect(payload?.styles).toEqual([
      ".h{color:blue}",
      ".g{color:red}",
    ]);
    expect(payload?.scriptlets).toEqual([
      { name: "set-constant", args: ["h", "2"] },
      { name: "set-constant", args: ["g", "1"] },
    ]);
  });
});
