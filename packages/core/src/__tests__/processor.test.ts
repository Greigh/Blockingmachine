import { parseFilterList, parseFilterListStream, RuleProcessor } from "../RuleProcessor.js";
import { cleanDomainPattern } from "../createMetadata.js";
import { Readable } from "stream";

describe("RuleProcessor & parseFilterList", () => {
  test("parseFilterList parses standard ABP network rules and extracts domains", () => {
    const raw = `
! Title: Sample
||example.com^
||sub.tracker.org^$third-party
    `.trim();

    const rules = parseFilterList(raw, "source-1");
    expect(rules).toHaveLength(2);
    expect(rules[0].type).toBe("blocking");
    expect(rules[0].domain).toBe("example.com");
    expect(rules[0].isException).toBe(false);

    expect(rules[1].type).toBe("blocking");
    expect(rules[1].domain).toBe("sub.tracker.org");
    expect(rules[1].isException).toBe(false);
  });

  test("parseFilterList parses hosts-style rules", () => {
    const raw = `
0.0.0.0 badhost.com
127.0.0.1 tracker.net # inline comment
    `.trim();

    const rules = parseFilterList(raw, "hosts-source");
    expect(rules).toHaveLength(2);
    expect(rules[0].domain).toBe("badhost.com");
    expect(rules[1].domain).toBe("tracker.net");
  });

  test("parseFilterList identifies exception rules", () => {
    const raw = `
@@||safe-site.com^
    `.trim();

    const rules = parseFilterList(raw, "safe-source");
    expect(rules).toHaveLength(1);
    expect(rules[0].isException).toBe(true);
    expect(rules[0].domain).toBe("safe-site.com");
  });

  test("cleanDomainPattern handles various formats correctly", () => {
    expect(cleanDomainPattern("||example.com^")).toBe("example.com");
    expect(cleanDomainPattern("||adserver.com^$third-party,important")).toBe(
      "adserver.com",
    );
    expect(cleanDomainPattern("0.0.0.0 telemetry.app.com")).toBe(
      "telemetry.app.com",
    );
    expect(cleanDomainPattern("127.0.0.1 ads.com # inline comment")).toBe(
      "ads.com",
    );
    expect(cleanDomainPattern("@@||allowed.com^")).toBe("allowed.com");

    // Path rules and cosmetic rules should not be extracted as pure domain names
    expect(cleanDomainPattern("||example.com/ad-banner.js")).toBeNull();
    expect(cleanDomainPattern("##.ad-class")).toBeNull();
    expect(cleanDomainPattern("example.com##.ad-class")).toBeNull();
    expect(cleanDomainPattern("example.com#@#.ad-class")).toBeNull();
    expect(cleanDomainPattern("example.com#$#body { display: none; }")).toBeNull();
    expect(cleanDomainPattern("! comment")).toBeNull();
  });

  test("classifyRule handles multi-modifier rules with comma separation", () => {
    const processor = new RuleProcessor();

    // Secondary modifier 'script' should be detected as a browser modifier and classified as blocking
    const type = processor.classifyRule(
      "||example.com^$domain=example.org,script",
    );
    expect(type).toBe("blocking");

    // $csp as secondary modifier should be recognized
    const cspType = processor.classifyRule(
      "||example.com^$third-party,csp=script-src 'none'",
    );
    expect(cspType).toBe("csp");
  });

  test("parseFilterList strips UTF-8 BOM correctly", () => {
    const rawWithBOM = "\uFEFF! Title: BOM List\n||adservice.com^\n";
    const rules = parseFilterList(rawWithBOM, "bom-source");
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("adservice.com");
    expect(rules[0].raw).toBe("||adservice.com^");
  });

  test("classifyRule recognizes IPv6 addresses as blocking", () => {
    const processor = new RuleProcessor();
    expect(processor.classifyRule("::1")).toBe("blocking");
    expect(
      processor.classifyRule("2001:0db8:85a3:0000:0000:8a2e:0370:7334"),
    ).toBe("blocking");
  });

  test("getErrors and clearErrors manage processor errors correctly", () => {
    const processor = new RuleProcessor();

    expect(processor.getErrors().unrecognizedRules).toHaveLength(0);
    processor.clearErrors();
    expect(processor.getErrors().processingErrors).toHaveLength(0);
  });

  test("parseFilterListStream asynchronously yields rules from stream", async () => {
    const raw = `
! Title: Stream List
||stream-ad.com^
0.0.0.0 stream-telemetry.io
@@||stream-allowed.com^
    `.trim();

    const stream = Readable.from([raw]);
    const rules = [];
    for await (const rule of parseFilterListStream(stream, "stream-source")) {
      rules.push(rule);
    }

    expect(rules).toHaveLength(3);
    expect(rules[0].domain).toBe("stream-ad.com");
    expect(rules[0].isException).toBe(false);
    expect(rules[1].domain).toBe("stream-telemetry.io");
    expect(rules[2].domain).toBe("stream-allowed.com");
    expect(rules[2].isException).toBe(true);
  });

  test("parseFilterList parses multi-domain hosts lines without dropping or cutting off hostnames", () => {
    const raw = `
0.0.0.0 alpha.com beta.org gamma.net # multi-domain hosts line
127.0.0.1 delta.io epsilon.app
    `.trim();

    const rules = parseFilterList(raw, "multi-hosts-source");
    expect(rules).toHaveLength(5);
    expect(rules.map((r) => r.domain)).toEqual([
      "alpha.com",
      "beta.org",
      "gamma.net",
      "delta.io",
      "epsilon.app",
    ]);
    expect(rules[0].raw).toBe("0.0.0.0 alpha.com");
    expect(rules[1].raw).toBe("0.0.0.0 beta.org");
    expect(rules[2].raw).toBe("0.0.0.0 gamma.net");
    expect(rules[3].raw).toBe("127.0.0.1 delta.io");
    expect(rules[4].raw).toBe("127.0.0.1 epsilon.app");
  });

  test("parseFilterList preserves CSS attribute selectors with $ without truncating", () => {
    const raw = `
##div[id$="-ad"]
example.com##a[href$=".apk"]
test.com#@#div[class$="_sponsor"]
    `.trim();

    const rules = parseFilterList(raw, "cosmetic-source");
    expect(rules).toHaveLength(3);
    expect(rules[0].metadata?.selector).toBe('div[id$="-ad"]');
    expect(rules[1].metadata?.selector).toBe('a[href$=".apk"]');
    expect(rules[2].metadata?.selector).toBe('div[class$="_sponsor"]');
    expect(rules[2].isException).toBe(true);
  });
});

