import {
  MiniAiClassifier,
  detectAntiAdblock,
  hostnameHasToken,
  isAdmiralAntiAdblock,
  resolveCnameChain,
  synthesizeAdmiralDefusers,
  synthesizeAntiAdblockDefusers,
  synthesizeRules,
} from '../index.js';

describe('Anti-Adblock Defuser & Circumvention Mitigation Suite', () => {
  const classifier = new MiniAiClassifier();

  describe('detectAntiAdblock Detection Engine', () => {
    it('identifies primary Admiral infrastructure and dynamic domains', () => {
      expect(isAdmiralAntiAdblock('getadmiral.com')).toBe(true);
      expect(isAdmiralAntiAdblock('admiraldrm.com')).toBe(true);
      expect(isAdmiralAntiAdblock('admiralservices.com')).toBe(true);
      expect(isAdmiralAntiAdblock('admiralcloud.com')).toBe(true);
      expect(isAdmiralAntiAdblock('sub.admiraldrm.com')).toBe(true);
      expect(isAdmiralAntiAdblock('delivery.client.getadmiral.com')).toBe(true);
      expect(isAdmiralAntiAdblock('carter-carrier.com')).toBe(true);
      expect(isAdmiralAntiAdblock('whisperingwax.com')).toBe(true);
      expect(isAdmiralAntiAdblock('molecularhouseholdadmiral.com')).toBe(true);
      expect(isAdmiralAntiAdblock('proverbadmiraluphill.com')).toBe(true);
      expect(isAdmiralAntiAdblock('admiralugly.com')).toBe(true);

      const det = detectAntiAdblock('getadmiral.com');
      expect(det.detected).toBe(true);
      expect(det.provider).toBe('admiral');
    });

    it('identifies Google Funding Choices & Privacy Messaging', () => {
      const gfc1 = detectAntiAdblock('fundingchoicesmessages.google.com');
      expect(gfc1.detected).toBe(true);
      expect(gfc1.provider).toBe('google-fc');

      const gfc2 = detectAntiAdblock('fc.yahoo.com');
      expect(gfc2.detected).toBe(true);
      expect(gfc2.provider).toBe('google-fc');
    });

    it('identifies BlockThrough / PageFair Ad Recovery', () => {
      const bt1 = detectAntiAdblock('btloader.com');
      expect(bt1.detected).toBe(true);
      expect(bt1.provider).toBe('blockthrough');

      const bt2 = detectAntiAdblock('blockthrough.com');
      expect(bt2.detected).toBe(true);
      expect(bt2.provider).toBe('blockthrough');

      const pf = detectAntiAdblock('pagefair.com');
      expect(pf.detected).toBe(true);
      expect(pf.provider).toBe('blockthrough');
    });

    it('identifies AdInPlay Game Canvas Anti-Adblockers', () => {
      const aip1 = detectAntiAdblock('adinplay.com');
      expect(aip1.detected).toBe(true);
      expect(aip1.provider).toBe('adinplay');

      const aip2 = detectAntiAdblock('sub.adinplay.bid');
      expect(aip2.detected).toBe(true);
      expect(aip2.provider).toBe('adinplay');
    });

    it('identifies Ezoic, NitroPay, Snigel and Generic Anti-Adblock systems', () => {
      expect(detectAntiAdblock('ezodn.com').provider).toBe('ezoic');
      expect(detectAntiAdblock('nitropay.com').provider).toBe('nitropay');
      expect(detectAntiAdblock('snigelweb.com').provider).toBe('snigel');
      expect(detectAntiAdblock('fuckadblock.com').provider).toBe('generic');
      expect(detectAntiAdblock('blockadblock.com').provider).toBe('generic');
      expect(detectAntiAdblock('antiblock.org').provider).toBe('generic');
      expect(detectAntiAdblock('anti-adblock.herokuapp.com').provider).toBe('generic');
    });

    it('does NOT falsely flag legitimate sites', () => {
      expect(detectAntiAdblock('admiral.com').detected).toBe(false);
      expect(detectAntiAdblock('www.admiral.com').detected).toBe(false);
      expect(detectAntiAdblock('google.com').detected).toBe(false);
      expect(detectAntiAdblock('yahoo.com').detected).toBe(false);
      expect(detectAntiAdblock('status.cursor.com').detected).toBe(false);
      expect(detectAntiAdblock('play.google.com').detected).toBe(false);
    });
  });

  describe('Mini-AI Classifier Integration', () => {
    it('classifies core Admiral domains as Advertising threat with high confidence', () => {
      const pred = classifier.classify('getadmiral.com');
      expect(pred.category).toBe('Advertising');
      expect(pred.verdict).toBe('ad_server');
      expect(pred.confidence).toBeGreaterThanOrEqual(80);
      expect(pred.reasons.join(' ')).toMatch(/anti-adblock/i);
    });

    it('classifies Google Funding Choices as Advertising threat', () => {
      const pred = classifier.classify('fundingchoicesmessages.google.com');
      expect(pred.category).toBe('Advertising');
      expect(pred.verdict).toBe('ad_server');
      expect(pred.reasons.join(' ')).toMatch(/Funding Choices/i);
    });

    it('classifies BlockThrough as Advertising threat', () => {
      const pred = classifier.classify('btloader.com');
      expect(pred.category).toBe('Advertising');
      expect(pred.verdict).toBe('ad_server');
      expect(pred.reasons.join(' ')).toMatch(/BlockThrough/i);
    });

    it('classifies AdInPlay as Advertising threat', () => {
      const pred = classifier.classify('adinplay.com');
      expect(pred.category).toBe('Advertising');
      expect(pred.verdict).toBe('ad_server');
      expect(pred.reasons.join(' ')).toMatch(/AdInPlay/i);
    });

    it('preserves legitimate insurance provider admiral.com as Clean', () => {
      const pred = classifier.classify('admiral.com');
      expect(pred.category).toBe('Clean');
      expect(pred.verdict).toBe('clean');
      expect(pred.riskLevel).toBe('none');
    });
  });

  describe('Multi-Vendor Defuser & Scriptlet Synthesis', () => {
    it('synthesizes scriptlet defusers and CSS modal suppressors for Admiral domains', () => {
      const rules = synthesizeRules({
        domain: 'getadmiral.com',
        verdict: 'ad_server',
        category: 'Advertising',
        target: 'all',
      });

      // Network rules
      expect(rules).toContain('||getadmiral.com^');
      expect(rules).toContain('0.0.0.0 getadmiral.com');

      // In-page procedural JavaScript scriptlet defusers
      expect(rules).toContain('##+js(set, admiral, noopfn)');
      expect(rules).toContain('##+js(set, Admiral, noopfn)');
      expect(rules).toContain('##+js(set, admiral.properties.suppress, true)');
      expect(rules).toContain('##+js(abort-current-script, admiral)');

      // Cosmetic modal neutralizer and scroll-lock fix
      expect(rules.some((r) => r.includes('.admiral-overlay'))).toBe(true);
      expect(rules.some((r) => r.includes('overflow: auto !important'))).toBe(true);
    });

    it('synthesizes Google Funding Choices scriptlets and modal suppressors', () => {
      const rules = synthesizeRules({
        domain: 'fundingchoicesmessages.google.com',
        verdict: 'ad_server',
        category: 'Advertising',
        target: 'all',
      });

      expect(rules).toContain('||fundingchoicesmessages.google.com^');
      expect(rules).toContain('##+js(set, googlefc, undefined)');
      expect(rules).toContain('##+js(set, google_ad_client, undefined)');
      expect(rules).toContain('##+js(abort-current-script, googlefc)');
      expect(rules.some((r) => r.includes('.fc-ab-root'))).toBe(true);
    });

    it('synthesizes BlockThrough / BT Loader scriptlets and selectors', () => {
      const rules = synthesizeRules({
        domain: 'btloader.com',
        verdict: 'ad_server',
        category: 'Advertising',
        target: 'all',
      });

      expect(rules).toContain('||btloader.com^');
      expect(rules).toContain('##+js(set, blockthrough, noopfn)');
      expect(rules).toContain('##+js(set, BT_LOADER, undefined)');
      expect(rules).toContain('##+js(abort-current-script, btloader)');
      expect(rules.some((r) => r.includes('.bt-ad-container'))).toBe(true);
    });

    it('synthesizes AdInPlay canvas unlocker scriptlets', () => {
      const rules = synthesizeRules({
        domain: 'adinplay.com',
        verdict: 'ad_server',
        category: 'Advertising',
        target: 'all',
      });

      expect(rules).toContain('||adinplay.com^');
      expect(rules).toContain('##+js(set, aiptag, { cmd: { display: noopfn, player: noopfn } })');
      expect(rules).toContain('##+js(set, aipPlayer, noopfn)');
    });

    it('synthesizes defusers when CNAME target resolves to an anti-adblock provider', () => {
      const rules = synthesizeRules({
        domain: 'delivery.publisher.com',
        verdict: 'tracker',
        category: 'CNAME Cloaking',
        cnames: ['client.btloader.com'],
        target: 'all',
      });

      expect(rules).toContain('||delivery.publisher.com^');
      expect(rules).toContain('||client.btloader.com^');
      expect(rules).toContain('##+js(set, blockthrough, noopfn)');
    });

    it('direct synthesizeAntiAdblockDefusers outputs complete defusal suite', () => {
      const defusers = synthesizeAntiAdblockDefusers('custom-proxy.com', 'generic');
      expect(defusers).toContain('||custom-proxy.com^$important');
      expect(defusers).toContain('0.0.0.0 custom-proxy.com');
      expect(defusers).toContain('##+js(set, FuckAdBlock, noopfn)');
      expect(defusers).toContain('##+js(set, BlockAdBlock, noopfn)');
      expect(defusers).toContain('##+js(set, canRunAds, true)');
      expect(defusers).toContain('##+js(set, isAdBlockActive, false)');
      expect(defusers.some((r) => r.includes('.adblock-overlay'))).toBe(true);
    });

    it('direct synthesizeAdmiralDefusers maintains backwards compatibility', () => {
      const defusers = synthesizeAdmiralDefusers('custom-admiral-proxy.com');
      expect(defusers).toContain('||custom-admiral-proxy.com^$important');
      expect(defusers).toContain('##+js(set, admiral, noopfn)');
    });
  });

  describe('CNAME Cloaking Boundary Safety & Anti-Adblock Targets', () => {
    it('does not falsely flag domains where provider is a substring of attacker domain', async () => {
      const res = await resolveCnameChain('tracker.evil.com');
      expect(res).toBeDefined();

      // If CNAME is attacker-controlled prefix like criteo.com.attacker.com, it should not trigger criteo provider
      // Simulate by inspecting known target matching logic directly:
      const spoofedCname = 'criteo.com.attacker.com';
      const btCname = 'tracker.btloader.com';

      // Test against rule synthesis CNAME resolution
      const spoofedRules = synthesizeRules({
        domain: 'tracker.evil.com',
        verdict: 'suspicious',
        category: 'Unknown',
        cnames: [spoofedCname],
      });
      expect(spoofedRules).toHaveLength(0); // Ignored, not a valid block

      const legitimateBtRules = synthesizeRules({
        domain: 'tracker.news.com',
        verdict: 'tracker',
        category: 'CNAME Cloaking',
        cnames: [btCname],
        target: 'all',
      });
      expect(legitimateBtRules).toContain('##+js(set, blockthrough, noopfn)');
    });
  });

  describe('Memory Safety & Bounded Caches', () => {
    it('tokenRegexCache caps and evicts cleanly under heavy dynamic token volume without leaking', () => {
      for (let i = 0; i < 600; i++) {
        expect(hostnameHasToken(`domain-${i}.com`, `token${i}`)).toBe(false);
      }
      // Re-verify normal matching continues to work reliably
      expect(hostnameHasToken('adserver.com', 'adserver')).toBe(true);
      expect(hostnameHasToken('clean-domain.org', 'telemetry')).toBe(false);
    });
  });
});
