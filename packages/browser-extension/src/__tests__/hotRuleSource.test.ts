import { jest, describe, test, expect } from '@jest/globals';
import { DnrManager, chooseRuleSource, planListRules } from '../background/dnrManager.js';

/**
 * The automatic choice of rule source, and the wiring that feeds it.
 *
 * The decision itself is a pure function precisely so it can be asserted here without a browser:
 * "does the full export fit?" is the whole question, and inferring the answer from what ended up
 * installed would let a wrong answer pass as long as something plausible was installed.
 */

/** A full export comfortably larger than any budget used below. */
function manyRules(count: number, prefix = 'full'): string[] {
  return Array.from({ length: count }, (_, i) => `||${prefix}${i}.example^`);
}

function installChrome(maxDynamic: number, installed: any[] = []) {
  const getDynamicRules = (jest.fn() as any).mockResolvedValue(installed);
  const updateDynamicRules = (jest.fn() as any).mockResolvedValue(undefined);
  (globalThis as any).chrome = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES: maxDynamic,
      RuleActionType: { BLOCK: 'block', ALLOW: 'allow' },
      ResourceType: { SCRIPT: 'script' },
      getDynamicRules,
      updateDynamicRules,
    },
  };
  return { getDynamicRules, updateDynamicRules };
}

describe('chooseRuleSource', () => {
  test('installs the full export when it fits, and says nothing about a hot set', () => {
    const hot = ['||only-me.example^'];
    const plan = chooseRuleSource(manyRules(10), hot, {}, 100);

    expect(plan.source).toBe('full');
    // No reason on the happy path: a client that logged "using the hot set" when it used the
    // full list would train everyone to ignore the message that matters.
    expect(plan.reason).toBeNull();
    expect(plan.fullOverflow).toBe(0);
    expect(plan.rules).toHaveLength(10);
    expect(plan.rules.map((rule) => rule.pattern)).toContain('||full3.example^');
    expect(plan.rules.map((rule) => rule.pattern)).not.toContain('||only-me.example^');
  });

  test('chooses the hot set when the full export exceeds the budget', () => {
    const plan = chooseRuleSource(manyRules(500), ['||measured.example^'], {}, 100);

    expect(plan.source).toBe('hot');
    expect(plan.reason).toMatch(/exceeded/);
    expect(plan.reason).toMatch(/measured hot set/);
    expect(plan.fullOverflow).toBe(400);
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0].pattern).toBe('||measured.example^');
  });

  test('the hot plan it returns is the hot set’s own plan, not the full one', () => {
    // The guard against a subtler bug: a `source: 'hot'` plan that still carried the full
    // export's truncated rules. That installs the prefix while reporting that it is protected by
    // measurement, which is worse than either list on its own.
    const hot = ['||a.example^', '||b.example^'];
    const plan = chooseRuleSource(manyRules(500), hot, {}, 100);
    const expected = planListRules(hot, {}, 100);

    expect(plan.rules).toEqual(expected.rules);
    expect(plan.offered).toBe(expected.offered);
    expect(plan.overflow).toBe(0);
  });

  test('falls back to pruning the full export when no hot set was supplied', () => {
    const plan = chooseRuleSource(manyRules(500), null, {}, 100);

    expect(plan.source).toBe('full');
    expect(plan.rules).toHaveLength(100);
    // The reason is what stops this being silent: without it a reader sees 100 rules installed
    // from a 500-rule list and has no way to know the tail is simply gone.
    expect(plan.reason).toMatch(/no measured hot set/);
    expect(plan.fullOverflow).toBe(400);
  });

  test('treats an empty hot set as no hot set', () => {
    // A deployment that serves an empty hot set has no measurement, and the planner must not
    // install zero rules and call it protection.
    const plan = chooseRuleSource(manyRules(500), [], {}, 100);

    expect(plan.source).toBe('full');
    expect(plan.rules).toHaveLength(100);
    expect(plan.reason).toMatch(/no measured hot set/);
  });

  test('keeps the full export when the hot set would overflow too', () => {
    // Both lists too big. The hot set is then not a smaller list but a differently-shaped one,
    // so choosing it would trade a truncation for a truncation with no gain.
    const plan = chooseRuleSource(manyRules(500, 'full'), manyRules(300, 'hot'), {}, 100);

    expect(plan.source).toBe('full');
    expect(plan.rules).toHaveLength(100);
    expect(plan.rules[0].pattern).toBe('||full0.example^');
    expect(plan.reason).toMatch(/also exceeded the budget/);
    expect(plan.reason).toMatch(/200/);
  });

  test('honours an explicit budget rather than the default', () => {
    const generous = chooseRuleSource(manyRules(500), ['||measured.example^'], {}, 10_000);
    const tight = chooseRuleSource(manyRules(500), ['||measured.example^'], {}, 100);

    expect(generous.source).toBe('full');
    expect(tight.source).toBe('hot');
    // The reason names the budget that actually decided it, so a reader can tell 28,500 from
    // a smaller cap the browser reported.
    expect(tight.reason).toMatch(/100-rule budget/);
  });

  test('a full export that fits is unaffected by user rules eating into the budget', () => {
    const control = { allowedDomains: ['a.example', 'b.example'] };
    const plan = chooseRuleSource(manyRules(10), ['||measured.example^'], control, 100);

    expect(plan.source).toBe('full');
    expect(plan.reason).toBeNull();
  });
});

describe('chooseRuleSource reporting the hot set’s own standing', () => {
  test('measures the hot set on the happy path too — the comparison is not a fallback artefact', () => {
    // If the standing were only computed when the hot set was needed, a deployment whose export
    // fit the budget would have no way to see its hot set going stale.
    const plan = chooseRuleSource(manyRules(10), ['||measured.example^'], {}, 100);

    expect(plan.source).toBe('full');
    expect(plan.hotSet).toEqual({ offered: 1, overflow: 0, absentFromFull: 1, shipped: 1, ownRules: 0 });
  });

  test('counts the hot rules the full list does not carry — the staleness signal', () => {
    // The builder only ships rules that appear verbatim in the source, so every absent rule means
    // the served pair is out of step: the export moved on and the hot set did not.
    const full = manyRules(10);
    const hot = ['||full0.example^', '||gone-a.example^', '||gone-b.example^'];
    const plan = chooseRuleSource(full, hot, {}, 100);

    expect(plan.hotSet?.absentFromFull).toBe(2);
    expect(plan.hotSet?.offered).toBe(3);
  });

  test('reports the hot set’s own budget position, not just its presence', () => {
    // A hot set that also overflows is refused — the standing is what makes that visible before
    // the reason string has to carry it.
    const plan = chooseRuleSource(manyRules(500), manyRules(300, 'hot'), {}, 100);

    expect(plan.source).toBe('full');
    expect(plan.hotSet?.overflow).toBe(200);
    expect(plan.hotSet?.absentFromFull).toBe(300);
  });

  test('reports no standing when no hot set was supplied', () => {
    const plan = chooseRuleSource(manyRules(500), null, {}, 100);

    expect(plan.hotSet).toBeNull();
    // An empty file is not a measurement either — "deployment serves an empty hot set" is the
    // same state as "deployment serves none".
    expect(chooseRuleSource(manyRules(500), [], {}, 100).hotSet).toBeNull();
  });
});

describe('chooseRuleSource own-ledger hot rules', () => {
  test('the deployment\'s own fired rules become the hot set when no shipped one exists', () => {
    // Flag 17's lever: the ledger this browser accumulated is a measurement of *its* traffic —
    // exactly what the shipped hot set cannot be. An overflowing export with own hits should
    // install them rather than prune blind.
    const plan = chooseRuleSource(
      manyRules(500),
      null,
      {},
      100,
      null,
      ['||mine-a.example^', '||mine-b.example^'],
    );

    expect(plan.source).toBe('hot');
    expect(plan.rules.map((rule) => rule.pattern)).toEqual([
      '||mine-a.example^',
      '||mine-b.example^',
    ]);
    expect(plan.hotSet?.ownRules).toBe(2);
    expect(plan.reason).toMatch(/this browser's own ledger/);
  });

  test('own fired rules lead the merge ahead of the shipped set', () => {
    // When both exist, the deployment's own evidence is strictly more representative than the
    // scripted sessions the shipped set was measured on — so it claims the budget first.
    const plan = chooseRuleSource(
      manyRules(500),
      ['||shipped-a.example^', '||shipped-b.example^'],
      {},
      100,
      null,
      ['||mine.example^'],
    );

    expect(plan.source).toBe('hot');
    const patterns = plan.rules.map((rule) => rule.pattern);
    expect(patterns).toContain('||mine.example^');
    expect(patterns).toContain('||shipped-a.example^');
    expect(plan.hotSet?.ownRules).toBe(1);
    expect(plan.hotSet?.offered).toBe(3);
  });

  test('a fired rule that duplicates a shipped line counts once, as own evidence', () => {
    const plan = chooseRuleSource(
      manyRules(500),
      ['||mine.example^'],
      {},
      100,
      null,
      ['||mine.example^'],
    );

    expect(plan.rules).toHaveLength(1);
    expect(plan.hotSet?.ownRules).toBe(1);
  });

  test('own hits still feed the staleness tripwire, not its victim count', () => {
    // An own rule the export dropped is the browser's own evidence — it still installs — but a
    // *shipped* rule absent from the full list is what names a stale pair.
    const plan = chooseRuleSource(
      manyRules(500),
      ['||stale-shipped.example^'],
      {},
      100,
      null,
      ['||stale-mine.example^'],
    );

    expect(plan.hotSet?.absentFromFull).toBe(1);
    expect(plan.hotSet?.ownRules).toBe(1);
    expect(plan.rules.map((rule) => rule.pattern)).toContain('||stale-mine.example^');
  });
});

describe('chooseRuleSource trimming by measured tier benefit', () => {
  /** Ranks the named hosts ahead of everything else, in the order given. */
  function rankOf(...hosts: string[]) {
    const order = new Map(hosts.map((host, index) => [host, index]));
    return (host: string) => order.get(host) ?? null;
  }

  test('keeps the tiered host a plain prefix would have dropped', () => {
    // The one case the fallback exists for: the measured host sits at the end of the file, so
    // a merge-order cut throws it away and a benefit-ordered cut keeps it.
    const full = ['||unmeasured-a.example^', '||unmeasured-b.example^', '||tiered.example^'];
    const plan = chooseRuleSource(full, null, {}, 2, rankOf('tiered.example'));

    expect(plan.source).toBe('full');
    expect(plan.tierTrimmed).toBe(true);
    expect(plan.reason).toMatch(/measured tier benefit/);
    const kept = plan.rules.map((rule) => rule.pattern);
    expect(kept).toContain('||tiered.example^');
    expect(kept).not.toContain('||unmeasured-b.example^');
  });

  test('a ranking with no answer for the list is reported as a plain prune', () => {
    // An empty ranking produces a prefix with extra steps; `tierTrimmed` stays false so the
    // report cannot claim a measurement that placed nothing.
    const plan = chooseRuleSource(manyRules(5), null, {}, 2, () => null);

    expect(plan.tierTrimmed).toBe(false);
    expect(plan.reason).toMatch(/rules were pruned/);
    expect(plan.benefitRanked).toBe(0);
  });

  test('reports the plain prefix when no ranking is supplied at all', () => {
    const plan = chooseRuleSource(manyRules(5), null, {}, 2);

    expect(plan.tierTrimmed).toBe(false);
    expect(plan.benefitRanked).toBeUndefined();
    expect(plan.reason).toMatch(/rules were pruned/);
  });

  test('the trim also applies when the hot set exists but overflows too', () => {
    // The decision between two truncations still keeps what evidence ranks — the fallback is
    // about which full-export rules survive, not about whether a hot set was offered.
    const plan = chooseRuleSource(
      ['||unmeasured-a.example^', '||unmeasured-b.example^', '||tiered.example^'],
      manyRules(300, 'hot'),
      {},
      2,
      rankOf('tiered.example'),
    );

    expect(plan.source).toBe('full');
    expect(plan.tierTrimmed).toBe(true);
    expect(plan.reason).toMatch(/also exceeded the budget/);
    expect(plan.rules.map((rule) => rule.pattern)).toContain('||tiered.example^');
  });

  test('a winning hot set is never reported as tier-trimmed', () => {
    const plan = chooseRuleSource(
      manyRules(500),
      ['||measured.example^'],
      {},
      100,
      rankOf('full0.example'),
    );

    expect(plan.source).toBe('hot');
    expect(plan.tierTrimmed).toBe(false);
  });

  test('a fitting export reports no trim even when a ranking was supplied', () => {
    const plan = chooseRuleSource(manyRules(3), null, {}, 100, rankOf('full0.example'));

    expect(plan.tierTrimmed).toBe(false);
    expect(plan.reason).toBeNull();
  });
});

describe('DnrManager installing the chosen source', () => {
  test('installs the hot set when the browser’s cap is below the full export', async () => {
    // A browser reporting 1,000 usable rules against a 5,000-rule export is the constrained
    // client this exists for. Cap 1000 -> quotaCap = max(1000, 1000-500) = 1000.
    const stub = installChrome(1000);
    const full = manyRules(5000);

    const count = await new DnrManager().updateDynamicRules(full, {}, {
      hotRuleLines: ['||measured.example^'],
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    const filters = call.addRules.map((rule) => rule.condition.urlFilter);
    expect(filters).toContain('||measured.example^');
    expect(filters).not.toContain('||full2500.example^');
    expect(count).toBe(1);
  });

  test('installs the full export when the browser has room for it', async () => {
    const stub = installChrome(30_000);
    const full = manyRules(20);

    await new DnrManager().updateDynamicRules(full, {}, { hotRuleLines: ['||measured.example^'] });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    const filters = call.addRules.map((rule) => rule.condition.urlFilter);
    expect(filters).toContain('||full3.example^');
    expect(filters).not.toContain('||measured.example^');
  });

  test('a full export past Chrome’s default cap gets the hot set', async () => {
    // The claim that makes this the default path rather than an edge case: the project’s shipped
    // export compiles to 127,820 dynamic rules against a 30,000-rule cap, so an ordinary browser
    // overflows. Pinned at the default cap with a list sized past it, so the day the export is
    // small enough to fit, this fails and says so.
    const stub = installChrome(30_000);
    const full = manyRules(40_000);

    const count = await new DnrManager().updateDynamicRules(full, {}, {
      hotRuleLines: ['||measured.example^'],
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    expect(call.addRules.map((rule) => rule.condition.urlFilter)).toEqual(['||measured.example^']);
    expect(count).toBe(1);
  });

  test('keeps today’s pruning when no hot set is offered', async () => {
    const stub = installChrome(1000);

    const count = await new DnrManager().updateDynamicRules(manyRules(5000), {}, { hotRuleLines: null });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    expect(call.addRules).toHaveLength(1000);
    expect(call.addRules[0].condition.urlFilter).toBe('||full0.example^');
    expect(count).toBe(1000);
  });

  test('the default is unchanged when the option is omitted entirely', async () => {
    // A caller that predates this option must get a prefix, not a hot set it never asked for.
    const stub = installChrome(1000);

    await new DnrManager().updateDynamicRules(manyRules(5000), {});

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    expect(call.addRules).toHaveLength(1000);
    expect(call.addRules[0].condition.urlFilter).toBe('||full0.example^');
  });

  test('retires the previously installed full-export rules when it switches to the hot set', async () => {
    // The load-bearing case, on the path that actually performs it. A client that installed a
    // prefix of the full export and then syncs a measurement must not be left holding both.
    const installed = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `||full${i}.example^`, resourceTypes: ['script'] },
    }));
    const stub = installChrome(1000, installed);

    await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      replaceInstalledList: true,
      hotRuleLines: ['||measured.example^'],
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as {
      removeRuleIds: number[];
      addRules: any[];
    };
    // Every stale full-export rule goes; only the measured one is added.
    expect(call.addRules.map((rule) => rule.condition.urlFilter)).toEqual(['||measured.example^']);
    expect([...call.removeRuleIds].sort((a, b) => a - b)).toEqual(installed.map((rule) => rule.id));
  });

  test('a preserving call with a list that fits leaves the installed family alone', async () => {
    // `replaceInstalledList: false` is the "this worker holds no full list" path, so what it is
    // given is only the user's own rules — a handful that always fits. That is precisely why it
    // can never select the hot set: the list it would be installing instead is 2 rules, and the
    // budget is 1,000. Pinned because it is the invariant that keeps a site pause from swapping
    // the whole blocklist out from under the user.
    const installed = [
      {
        id: 7,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '||listed.example^', resourceTypes: ['script'] },
      },
    ];
    const stub = installChrome(1000, installed);

    await new DnrManager().updateDynamicRules(['||custom.example^'], {}, {
      replaceInstalledList: false,
      hotRuleLines: ['||measured.example^'],
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as {
      removeRuleIds: number[];
      addRules: any[];
    };
    // The installed family survives untouched; the custom rule is added alongside it.
    expect(call.addRules.map((rule) => rule.condition.urlFilter)).toEqual(['||custom.example^']);
    expect(call.removeRuleIds).not.toContain(7);
  });

  test('the owned-filter set and the installed plan come from the same source', async () => {
    // The safety property behind the shared `sourceLines`. If the two were read from different
    // lists, every filter in the owned set would be removed from the browser on the promise that
    // the plan puts it back — and the plan is the hot set, so the promise would be a lie. Here
    // the hot set is the source of both, so the superset relationship holds exactly: everything
    // removed is also added.
    const installed = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `||measured${i}.example^`, resourceTypes: ['script'] },
    }));
    const hot = installed.map((rule) => rule.condition.urlFilter);
    const stub = installChrome(1000, installed);

    await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      replaceInstalledList: false,
      hotRuleLines: hot,
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as {
      removeRuleIds: number[];
      addRules: any[];
    };
    const added = call.addRules.map((rule) => rule.condition.urlFilter);
    const removed = [...call.removeRuleIds];

    expect(removed).toHaveLength(200);
    // Nothing removed that the plan does not also reinstall, which is the whole invariant.
    expect(new Set(added)).toEqual(new Set(hot));
    expect(removed.filter((id) => !added.includes(`||measured${id - 1}.example^`))).toEqual([]);
  });

  test('warns that protection is narrower when it falls back to the hot set', async () => {
    installChrome(1000);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
        hotRuleLines: ['||measured.example^'],
      });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      const note = messages.find((message) => message.includes('measured hot set'));
      expect(note).toBeDefined();
      expect(note).toMatch(/limited to the traffic that measurement saw/);
    } finally {
      warn.mockRestore();
    }
  });

  test('stays quiet about the hot set on the full-export path', async () => {
    installChrome(30_000);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await new DnrManager().updateDynamicRules(manyRules(20), {}, {
        hotRuleLines: ['||measured.example^'],
      });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('measured hot set'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test('a global pause still installs nothing, hot set or not', async () => {
    const stub = installChrome(1000, [
      {
        id: 3,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '||full0.example^', resourceTypes: ['script'] },
      },
    ]);

    const count = await new DnrManager().updateDynamicRules(manyRules(5000), { globalPaused: true }, {
      hotRuleLines: ['||measured.example^'],
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as {
      removeRuleIds: number[];
      addRules: any[];
    };
    expect(call.addRules).toHaveLength(0);
    expect(call.removeRuleIds).toContain(3);
    expect(count).toBe(0);
  });
});

describe('updateDynamicRules reporting the chosen source', () => {
  test('reports the hot set, with the full export’s overflow, after a successful apply', async () => {
    installChrome(1000);
    const seen: any[] = [];

    await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      hotRuleLines: ['||measured.example^'],
      onRuleSource: (source) => seen.push(source),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('hot');
    expect(seen[0].installed).toBe(1);
    expect(seen[0].offered).toBe(1);
    // The number the popup quotes when it explains why the hot set is running.
    expect(seen[0].fullOverflow).toBe(4000);
    expect(typeof seen[0].appliedAt).toBe('number');
  });

  test('reports the full export when it fits, hot set held or not', async () => {
    installChrome(30_000);
    const seen: any[] = [];

    await new DnrManager().updateDynamicRules(manyRules(20), {}, {
      hotRuleLines: ['||measured.example^'],
      onRuleSource: (source) => seen.push(source),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('full');
    expect(seen[0].installed).toBe(20);
    expect(seen[0].offered).toBe(20);
    expect(seen[0].fullOverflow).toBe(0);
  });

  test('does not report when the browser rejects the apply', async () => {
    // The report is a record of what the browser installed. Letting it fire on a rejected batch
    // would leave the popup claiming a source that never ran.
    const stub = installChrome(1000);
    stub.updateDynamicRules.mockRejectedValue(new Error('quota'));
    const seen: any[] = [];

    await expect(
      new DnrManager().updateDynamicRules(manyRules(5000), {}, {
        hotRuleLines: ['||measured.example^'],
        onRuleSource: (source) => seen.push(source),
      }),
    ).rejects.toThrow('quota');
    expect(seen).toHaveLength(0);
  });

  test('does not report on a preserving apply — the kept rules still belong to their own source', async () => {
    // A worker that has not synced holds no list, so the call only re-plans the custom rules it
    // was handed — but the browser can still be holding a hot set a previous worker installed.
    // Reporting 'full' then would claim the browser switched sources when it did not.
    installChrome(1000, [
      {
        id: 7,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '||listed.example^', resourceTypes: ['script'] },
      },
    ]);
    const seen: any[] = [];

    await new DnrManager().updateDynamicRules(['||custom.example^'], {}, {
      replaceInstalledList: false,
      hotRuleLines: ['||measured.example^'],
      onRuleSource: (source) => seen.push(source),
    });

    expect(seen).toHaveLength(0);
  });

  test('does not report on a global pause — clearing the rules installs no source', async () => {
    // The record a pause leaves behind describes the list that resumes, not the empty set the
    // pause installed. Reporting 'full' here would misstate both.
    installChrome(1000);
    const seen: any[] = [];

    await new DnrManager().updateDynamicRules(manyRules(5000), { globalPaused: true }, {
      hotRuleLines: ['||measured.example^'],
      onRuleSource: (source) => seen.push(source),
    });

    expect(seen).toHaveLength(0);
  });

  test('installs the benefit-ranked cut when no hot set exists and the export overflows', async () => {
    // The whole point of the fallback, on the path that performs it: the last line of the file
    // is the one a prefix drops, and the tier-measured host is exactly that line here.
    const stub = installChrome(1000);
    const seen: any[] = [];
    const rank = (host: string) => (host === 'full4999.example' ? 0 : null);

    const count = await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      benefitRank: rank,
      onRuleSource: (source) => seen.push(source),
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    const filters = call.addRules.map((rule) => rule.condition.urlFilter);
    expect(filters).toContain('||full4999.example^');
    expect(count).toBe(1000);
    expect(seen[0].tierTrimmed).toBe(true);
    expect(seen[0].source).toBe('full');
  });

  test('keeps the plain prefix when the supplied ranking knows none of the list', async () => {
    const stub = installChrome(1000);
    const seen: any[] = [];

    await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      benefitRank: () => null,
      onRuleSource: (source) => seen.push(source),
    });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    expect(call.addRules[0].condition.urlFilter).toBe('||full0.example^');
    expect(seen[0].tierTrimmed).toBe(false);
  });

  test('names the benefit ordering in the overflow warning', async () => {
    installChrome(1000);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
        benefitRank: (host) => (host === 'full4999.example' ? 0 : null),
      });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      const note = messages.find((message) => message.includes('exceeds safe MV3 dynamic limit'));
      expect(note).toBeDefined();
      expect(note).toMatch(/measured-benefit order/);
    } finally {
      warn.mockRestore();
    }
  });

  test('an apply without the option works exactly as before', async () => {
    installChrome(1000);

    const count = await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      hotRuleLines: ['||measured.example^'],
    });

    expect(count).toBe(1);
  });

  test('the record carries the hot set’s standing alongside the installed source', async () => {
    installChrome(1000);
    const seen: any[] = [];

    await new DnrManager().updateDynamicRules(manyRules(5000), {}, {
      hotRuleLines: ['||measured.example^'],
      onRuleSource: (source) => seen.push(source),
    });

    expect(seen[0].hotSet).toEqual({ offered: 1, overflow: 0, absentFromFull: 1, shipped: 1, ownRules: 0 });
  });

  test('warns that a served hot set is stale even when the full export won the budget', async () => {
    // The whole point of the comparison: a deployment whose export still fits would never see
    // the hot-set warning — staleness must be reported on its own, or it goes unnoticed until
    // the day the export stops fitting.
    installChrome(30_000);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await new DnrManager().updateDynamicRules(manyRules(20), {}, {
        hotRuleLines: ['||measured.example^'],
      });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      const note = messages.find((message) => message.includes('not in the full export'));
      expect(note).toBeDefined();
      expect(note).toMatch(/1 of the shipped hot set's 1 rules/);
      expect(note).toMatch(/different or older list/);
    } finally {
      warn.mockRestore();
    }
  });

  test('stays quiet about staleness when every hot rule is carried by the export', async () => {
    installChrome(30_000);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await new DnrManager().updateDynamicRules(manyRules(20), {}, {
        hotRuleLines: ['||full3.example^'],
      });
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('not in the full export'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
