import { parseFilterList, RuleProcessor } from "../RuleProcessor.js";
import { cleanDomainPattern } from "../createMetadata.js";

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
    expect(cleanDomainPattern("||adserver.com^$third-party,important")).toBe("adserver.com");
    expect(cleanDomainPattern("0.0.0.0 telemetry.app.com")).toBe("telemetry.app.com");
    expect(cleanDomainPattern("127.0.0.1 ads.com # inline comment")).toBe("ads.com");
    expect(cleanDomainPattern("@@||allowed.com^")).toBe("allowed.com");

    // Path rules should not be extracted as pure domain names
    expect(cleanDomainPattern("||example.com/ad-banner.js")).toBeNull();
    expect(cleanDomainPattern("##.ad-class")).toBeNull();
    expect(cleanDomainPattern("! comment")).toBeNull();
  });

  test("classifyRule handles multi-modifier rules with comma separation", () => {
    const processor = new RuleProcessor();

    // Secondary modifier 'script' should be detected as a browser modifier and classified as blocking
    const type = processor.classifyRule("||example.com^$domain=example.org,script");
    expect(type).toBe("blocking");

    // $csp as secondary modifier should be recognized
    const cspType = processor.classifyRule("||example.com^$third-party,csp=script-src 'none'");
    expect(cspType).toBe("csp");
  });

  test("getErrors and clearErrors manage processor errors correctly", () => {
    const processor = new RuleProcessor();

    expect(processor.getErrors().unrecognizedRules).toHaveLength(0);
    processor.clearErrors();
    expect(processor.getErrors().processingErrors).toHaveLength(0);
  });
});
