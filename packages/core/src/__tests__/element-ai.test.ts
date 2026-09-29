import {
  MiniAiElementClassifier,
  analyzeElement,
  assessElementEvidence,
  classifyElementWithMiniAi,
  elementSignature,
  hostOfUrl,
  isElementSnapshot,
  matchSourceHostKind,
  tokenizeElementIdentifier,
  type ElementSnapshot,
} from '../ai/elementClassifier.js';

const el = (partial: Partial<ElementSnapshot> & { tag: string }): ElementSnapshot => partial;

describe('Element AI — identifier boundaries', () => {
  it('splits identifiers on punctuation and camelCase', () => {
    expect(tokenizeElementIdentifier('adsContainer')).toEqual(['ads', 'container']);
    expect(tokenizeElementIdentifier('ad-slot__inner')).toEqual(['ad', 'slot', 'inner']);
    expect(tokenizeElementIdentifier('GDPRConsentBanner')).toEqual(['gdpr', 'consent', 'banner']);
  });

  it('never matches `ad` inside an ordinary word', () => {
    // The hostname model's most expensive bug was a bare token matching as a fact.
    // Identifier atoms make that class of mismatch impossible here.
    for (const identifier of [
      'admonition',
      'adapter',
      'admin',
      'address',
      'adaptive',
      'adventure',
      'download',
      'shadow',
      'gradient',
      'header',
      'loading',
      'thread',
      'spread',
    ]) {
      const analysis = analyzeElement(el({ tag: 'div', classes: [identifier] }));
      expect(analysis.features.adStrongToken).toBe(0);
      expect(analysis.features.adWeakToken).toBe(0);
      expect(analysis.families).toEqual([]);
    }
  });

  it('matches `ad` when it is a real atom', () => {
    // A bare `ad` on its own is the weakest signal on a page — sites abbreviate "admin" and
    // "address" that way — so it corroborates but never names an element by itself.
    expect(analyzeElement(el({ tag: 'div', classes: ['ad'] })).features.adWeakToken).toBe(1);
    expect(analyzeElement(el({ tag: 'div', classes: ['ad'] })).features.adStrongToken).toBe(0);
  });

  it('promotes a compound identifier that leads or ends with `ad`', () => {
    // `video-ad` and `adsContainer` exist to name an ad, and a cosmetic filter matches them
    // exactly as it matches `adunit`. Position is the guard: only the leading and trailing atom
    // promote, so an upsell that merely mentions ads stays a hint.
    for (const identifier of ['header-ad', 'video-ad', 'adsContainer', 'anchor_ad', 'in-article-ad']) {
      const analysis = analyzeElement(el({ tag: 'div', classes: [identifier] }));
      expect(`${identifier}:${analysis.features.adStrongToken}`).toBe(`${identifier}:1`);
      expect(analysis.families).toContain('ad-marker');
    }

    const middle = analyzeElement(el({ tag: 'div', classes: ['no-ads-subscription'] }));
    expect(middle.features.adStrongToken).toBe(0);
    expect(middle.features.adWeakToken).toBe(1);
    expect(middle.families).not.toContain('ad-marker');
  });
});

describe('Element AI — host and path evidence', () => {
  it('resolves sources on registrable suffixes', () => {
    expect(matchSourceHostKind('securepubads.g.doubleclick.net')).toBe('ad-network');
    expect(matchSourceHostKind('o1.ingest.sentry.io')).toBe('measurement');
    expect(matchSourceHostKind('platform.twitter.com')).toBe('social');
    expect(matchSourceHostKind('example.com')).toBe('none');
  });

  it('ignores data and blob URLs', () => {
    expect(hostOfUrl('data:image/gif;base64,R0lGOD')).toBeNull();
    expect(hostOfUrl('blob:https://example.com/abc')).toBeNull();
    expect(hostOfUrl('https://cdn.example.com/a.png')).toBe('cdn.example.com');
  });

  it('does not treat a link to an ad network as an ad', () => {
    // A publisher's "Advertise with us" footer link, or a news article about
    // DoubleClick, is content. Only resource attributes carry weight.
    const link = el({ tag: 'a', href: 'https://www.doubleclick.net/about', text: 'About DoubleClick' });
    const prediction = classifyElementWithMiniAi(link);
    expect(prediction.action).toBe('leave');
    expect(prediction.elementClass).toBe('Content');
  });
});

describe('Element AI — corroboration and confidence honesty', () => {
  it('hides on definitive evidence, with confidence capped below certainty', () => {
    const prediction = classifyElementWithMiniAi(el({ tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 }));
    expect(prediction.elementClass).toBe('Ad');
    expect(prediction.action).toBe('hide');
    expect(prediction.corroboration).toBe('corroborated');
    expect(prediction.confidence).toBeLessThanOrEqual(98);
    expect(prediction.confidence).toBeGreaterThan(90);
  });

  it('reports which evidence carried the verdict, not just the list of families', () => {
    const prediction = classifyElementWithMiniAi(
      el({
        tag: 'aside',
        classes: ['ad-slot-container'],
        attributes: [{ name: 'data-ad-slot', value: 'top' }],
        width: 300,
        height: 250,
      }),
    );

    // The split is the decision: these two could act alone, the rest only corroborate.
    expect(prediction.definitiveFamilies).toEqual(['ad-marker', 'ad-attribute']);
    expect(prediction.supportingFamilies).toEqual(['ad-size', 'ad-weak-marker']);
    expect(prediction.evidenceFamilies).toEqual([
      ...prediction.definitiveFamilies,
      ...prediction.supportingFamilies,
    ]);

    // `ad-slot-container` is more use to a reader than the atom `ad` matched inside it,
    // and the delivery attribute is named rather than only counted.
    expect(prediction.evidence.adMatchedOn).toBe('ad-slot-container');
    expect(prediction.evidence.adAttribute).toBe('data-ad-slot');
  });

  it('reports the analytics attribute a verdict did not count', () => {
    const prediction = classifyElementWithMiniAi(
      el({
        tag: 'a',
        classes: ['SocialLinks-module__iconLink'],
        attributes: [{ name: 'data-analytics-event', value: 'click' }],
      }),
    );

    expect(prediction.elementClass).toBe('Content');
    expect(prediction.evidence.trackerAttribute).toBe('data-analytics-event');
  });

  it('needs two independent hints before hiding on structural evidence', () => {
    const vocabularyOnly = classifyElementWithMiniAi(el({ tag: 'div', classes: ['ad'], width: 10, height: 10 }));
    expect(vocabularyOnly.action).toBe('suggest');
    expect(vocabularyOnly.corroboration).toBe('single-signal');
    expect(vocabularyOnly.confidence).toBeLessThanOrEqual(58);

    const vocabularyAndSize = classifyElementWithMiniAi(el({ tag: 'div', classes: ['ad'], width: 728, height: 90 }));
    expect(vocabularyAndSize.action).toBe('hide');
    expect(vocabularyAndSize.corroboration).toBe('corroborated');
  });

  it('will not call a hero banner an ad', () => {
    const prediction = classifyElementWithMiniAi(
      el({ tag: 'div', classes: ['banner'], width: 1440, height: 420, text: 'Welcome to our store' }),
    );
    expect(prediction.elementClass).toBe('Content');
    expect(prediction.action).toBe('leave');
    expect(prediction.reasons.join(' ')).toContain('Layout vocabulary');
  });

  it('leaves a shape-only element alone but still explains the shape', () => {
    const prediction = classifyElementWithMiniAi(
      el({ tag: 'img', src: 'https://cdn.example.com/team.jpg', width: 300, height: 250 }),
    );
    expect(prediction.action).toBe('leave');
    expect(prediction.elementClass).toBe('Content');
    expect(prediction.reasons[0]).toContain('300x250');
  });

  it('never claims a class it cannot name', () => {
    for (const snapshot of [
      el({ tag: 'div' }),
      el({ tag: 'div', classes: ['analytics-panel'], text: 'Revenue is up 12%' }),
      el({ tag: 'img', src: 'https://cdn.jsdelivr.net/gh/x/spacer.gif', width: 1, height: 1 }),
      el({ tag: 'iframe', src: 'https://www.youtube.com/embed/abc', width: 560, height: 315, crossOriginFrame: true }),
    ]) {
      const prediction = classifyElementWithMiniAi(snapshot);
      expect(prediction.elementClass).toBe('Content');
      expect(prediction.action).toBe('leave');
      expect(prediction.reasons.length).toBeGreaterThan(0);
    }
  });

  it('states a reason for every hide', () => {
    const cases: ElementSnapshot[] = [
      el({ tag: 'div', classes: ['adsbygoogle'] }),
      el({ tag: 'img', src: 'https://t.example.com/p.gif', width: 1, height: 1 }),
      el({ tag: 'div', classes: ['cookie-banner'], position: 'fixed', zIndex: 9999, text: 'Accept all cookies' }),
      el({ tag: 'div', classes: ['share-buttons'] }),
      el({ tag: 'script', src: 'https://www.googletagmanager.com/gtm.js?id=1' }),
    ];
    for (const snapshot of cases) {
      const prediction = classifyElementWithMiniAi(snapshot);
      expect(prediction.action).toBe('hide');
      expect(prediction.reasons.length).toBeGreaterThan(0);
      expect(prediction.reasons[0].length).toBeGreaterThan(10);
    }
  });

  it('only hides trackers for real beacons, not for CDN spacers', () => {
    const spacer = classifyElementWithMiniAi(el({ tag: 'img', src: 'https://cdn.jsdelivr.net/spacer.gif', width: 1, height: 1 }));
    expect(spacer.action).toBe('leave');

    const beacon = classifyElementWithMiniAi(el({ tag: 'img', src: 'https://metrics.example.net/p.gif', width: 1, height: 1 }));
    expect(beacon.elementClass).toBe('Tracker');
    expect(beacon.action).toBe('hide');

    const inlinePixel = classifyElementWithMiniAi(el({ tag: 'img', src: 'data:image/gif;base64,R0lGOD', width: 1, height: 1 }));
    expect(inlinePixel.action).toBe('leave');
  });

  it('composes with the URL model when a source verdict is supplied', () => {
    const frame = el({
      tag: 'iframe',
      src: 'https://widget.example.com/embed',
      width: 300,
      height: 250,
      crossOriginFrame: true,
      sourceVerdict: { category: 'Advertising', verdict: 'suspicious' },
    });
    const prediction = classifyElementWithMiniAi(frame);
    expect(prediction.evidenceFamilies).toContain('ad-network');
    expect(prediction.action).toBe('hide');
  });

  it('marks lone weak evidence as not actionable in the assessment', () => {
    const analysis = analyzeElement(el({ tag: 'div', classes: ['banner'] }));
    const assessment = assessElementEvidence(analysis);
    expect(assessment.named).toBe(false);
    expect(assessment.maxAction).toBe('leave');
    expect(assessment.supporting).toContain('layout-marker');
    expect(classifyElementWithMiniAi(el({ tag: 'div', classes: ['banner'] })).action).toBe('leave');
  });
});

describe('Element AI — annoyances', () => {
  it('hides a shaped consent wall', () => {
    const prediction = classifyElementWithMiniAi(
      el({
        tag: 'div',
        id: 'onetrust-banner-sdk',
        position: 'fixed',
        zIndex: 99999,
        width: 1440,
        height: 200,
        text: 'We use cookies. Accept all cookies',
      }),
    );
    expect(prediction.elementClass).toBe('Annoyance');
    expect(prediction.action).toBe('hide');
    expect(prediction.reasons[0]).toContain('consent');
  });

  it('suggests rather than hides an adblock wall', () => {
    const prediction = classifyElementWithMiniAi(
      el({
        tag: 'div',
        position: 'fixed',
        zIndex: 9999,
        text: 'Please disable your ad blocker to continue reading.',
      }),
    );
    expect(prediction.elementClass).toBe('Annoyance');
    expect(prediction.action).toBe('suggest');
    expect(prediction.reasons[0]).toContain('Adblock-wall');
  });

  it('classifies a newsletter modal as an annoyance even with pages of copy', () => {
    const prediction = classifyElementWithMiniAi(
      el({
        tag: 'div',
        classes: ['newsletter-modal'],
        position: 'fixed',
        zIndex: 5000,
        width: 600,
        height: 500,
        text: 'Subscribe to our newsletter for weekly updates. '.repeat(30),
      }),
    );
    expect(prediction.elementClass).toBe('Annoyance');
    expect(prediction.action).toBe('hide');
  });

  it('leaves a bare consent word alone', () => {
    const prediction = classifyElementWithMiniAi(
      el({ tag: 'div', classes: ['cookie'], text: 'Our famous chocolate chip cookie recipe.' }),
    );
    expect(prediction.action).toBe('leave');
  });

  it('is not fooled by page instrumentation attributes', () => {
    const prediction = classifyElementWithMiniAi(
      el({ tag: 'button', attributes: [{ name: 'data-track-click', value: 'cta' }], text: 'Get started free' }),
    );
    expect(prediction.action).toBe('leave');
    expect(prediction.elementClass).toBe('Content');
  });
});

describe('Element AI — user feedback', () => {
  it('generalizes a correction from the exact element to the token', () => {
    const classifier = new MiniAiElementClassifier();
    const onSiteA = el({ tag: 'div', classes: ['sponsored-block'], width: 400, height: 200 });
    const onSiteB = el({ tag: 'span', classes: ['sponsored-block'], width: 400, height: 200 });

    classifier.tuneElementFeedback(onSiteA, 'keep');
    expect(classifier.getElementFeedback(onSiteA)).toBe(-1);
    // A decision on one site informs the same widget on another.
    expect(classifier.getElementFeedback(onSiteB)).toBe(-1);
    expect(classifier.classify(onSiteB).action).toBe('leave');
    expect(classifier.getElementFeedbackCount()).toBe(2);
  });

  it('lets a user decision make an unnamed shape actionable', () => {
    const classifier = new MiniAiElementClassifier();
    const element = el({ tag: 'aside', classes: ['sidebar-unit'], width: 300, height: 600 });
    expect(classifier.classify(element).action).toBe('leave');

    // The user's own call is the only evidence that can promote a shape the model
    // cannot name — and it generalizes to the exact element across pages.
    classifier.tuneElementFeedback(element, 'hide');
    const after = classifier.classify(element);
    expect(after.action).toBe('hide');
    expect(after.evidenceFamilies).toContain('user-choice');
    expect(after.reasons[0]).toContain('You marked');
    expect(after.topContributions.some((item) => item.name === 'Your previous decisions')).toBe(true);
    // No recognisable token, so the correction stays keyed to this exact shape.
    expect(after.signature.token).toBeNull();
    expect(classifier.getElementFeedbackCount()).toBe(1);
  });

  it('lets a user decision outrank a structural prior, not merely nudge it', () => {
    // `<aside>` carries the `semanticContainer` prior for Content (-5 on Ad, +4 on
    // Content), which a +5 bias on the logits cannot overcome. The decision has to be
    // a ruling: the user said "not content", so the model only picks which kind.
    const classifier = new MiniAiElementClassifier();
    const sidebar = el({ tag: 'aside', classes: ['sidebar-unit'] });
    expect(classifier.classify(sidebar).action).toBe('leave');

    classifier.tuneElementFeedback(sidebar, 'hide');
    const after = classifier.classify(sidebar);
    expect(after.action).toBe('hide');
    expect(['Ad', 'Tracker', 'Annoyance']).toContain(after.elementClass);
    expect(after.confidence).toBeGreaterThanOrEqual(70);

    // And the veto works the same way in the opposite direction.
    classifier.tuneElementFeedback(el({ tag: 'div', classes: ['adsbygoogle'] }), 'keep');
    expect(classifier.classify(el({ tag: 'div', classes: ['adsbygoogle'] })).action).toBe('leave');
  });

  it('honours a user veto over every inference', () => {
    const classifier = new MiniAiElementClassifier();
    const element = el({ tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 });
    expect(classifier.classify(element).action).toBe('hide');

    classifier.tuneElementFeedback(element, 'keep');
    const after = classifier.classify(element);
    expect(after.action).toBe('leave');
    expect(after.reasons[0]).toContain('content');
  });

  it('resets, deletes and round-trips feedback', () => {
    const classifier = new MiniAiElementClassifier();
    const element = el({ tag: 'div', classes: ['advert'] });

    classifier.tuneElementFeedback(element, 'keep');
    expect(classifier.getElementFeedback(element)).toBe(-1);
    expect(classifier.deleteElementFeedback(element)).toBe(true);
    expect(classifier.getElementFeedback(element)).toBe(0);

    classifier.tuneElementFeedback(element, 'hide');
    const exported = classifier.exportElementFeedback();
    expect(Object.keys(exported).length).toBeGreaterThan(0);

    const restored = new MiniAiElementClassifier();
    restored.importElementFeedback(exported);
    expect(restored.getElementFeedback(element)).toBe(1);

    restored.clearElementFeedback();
    expect(restored.getElementFeedbackCount()).toBe(0);
  });

  it('refuses prototype-polluting keys', () => {
    const classifier = new MiniAiElementClassifier();
    classifier.importElementFeedback({ __proto__: 1, constructor: 1, prototype: 1, 'div|ad': 0.5 } as Record<string, number>);
    expect(classifier.exportElementFeedback()['__proto__']).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keys feedback by signature, not by page', () => {
    const signature = elementSignature(el({ tag: 'div', classes: ['adsbygoogle'] }));
    expect(signature.exact).toBe('div|adsbygoogle');
    expect(signature.token).toBe('adsbygoogle');
  });
});

describe('Element AI — cache and fail-safety', () => {
  it('caches repeat classifications without leaking mutable state', () => {
    const classifier = new MiniAiElementClassifier();
    const element = el({ tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 });

    const first = classifier.classify(element);
    first.reasons.push('mutated');
    first.evidence.adTokens.push('mutated');

    const second = classifier.classify(element);
    expect(second.reasons).not.toContain('mutated');
    expect(second.evidence.adTokens).not.toContain('mutated');
    expect(classifier.getCacheStats().hits).toBe(1);
  });

  it('invalidates the cache when feedback changes', () => {
    const classifier = new MiniAiElementClassifier();
    const element = el({ tag: 'div', classes: ['promo-box'], width: 400, height: 200 });
    classifier.classify(element);
    classifier.tuneElementFeedback(element, 'keep');
    expect(classifier.getCacheStats().size).toBe(0);
  });

  it('survives malformed snapshots without ever hiding', () => {
    const classifier = new MiniAiElementClassifier();
    const junk = [
      undefined,
      null,
      {} as ElementSnapshot,
      { tag: '' },
      { tag: 'div', classes: 'not-an-array' as unknown as string[] },
      { tag: 'div', attributes: [null as unknown as { name: string; value: string }] },
      { tag: 'div', width: Number.NaN, height: -5 },
      { tag: `div<script>alert(1)</script>` },
    ];

    for (const input of junk) {
      const prediction = classifier.classify(input as ElementSnapshot);
      expect(prediction.action).toBe('leave');
      expect(prediction.elementClass).toBe('Content');
      expect(prediction.confidence).toBeLessThanOrEqual(45);
    }
  });

  it('sanitizes tags arriving over a message port', () => {
    const prediction = classifyElementWithMiniAi(el({ tag: 'DIV" onload="x', classes: ['adsbygoogle'] }));
    expect(prediction.action).toBe('hide');
    expect(prediction.signature.exact.startsWith('div')).toBe(true);
  });

  it('validates untrusted snapshots structurally', () => {
    expect(isElementSnapshot({ tag: 'div' })).toBe(true);
    expect(isElementSnapshot(null)).toBe(false);
    expect(isElementSnapshot({ tag: 42 })).toBe(false);
    expect(isElementSnapshot({ tag: 'x'.repeat(40) })).toBe(false);
  });
});
