import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { RulesetManager } from '../background/rulesetManager.js';
import { STORAGE_KEY_STATIC_TIERS } from '../shared/constants.js';
import { tierById, tierRuleCount } from '../shared/rulesetTiers.js';

interface ChromeStub {
  updateEnabledRulesets: any;
  getEnabledRulesets: any;
  getAvailableStaticRuleCount: any;
  storageGet: any;
  storageSet: any;
}

/** Installs a chrome stub and returns its fakes so a test can assert on the calls. */
function installChrome(options: {
  enabledRulesets?: string[];
  stored?: unknown;
  available?: number;
  getEnabledThrows?: boolean;
  missingApi?: boolean;
} = {}): ChromeStub {
  const updateEnabledRulesets = (jest.fn() as any).mockResolvedValue(undefined);
  const getEnabledRulesets = options.getEnabledThrows
    ? (jest.fn() as any).mockRejectedValue(new Error('boom'))
    : (jest.fn() as any).mockResolvedValue([...(options.enabledRulesets ?? [])]);
  const getAvailableStaticRuleCount = (jest.fn() as any).mockResolvedValue(options.available ?? 29976);
  const storageGet = (jest.fn() as any).mockResolvedValue(
    options.stored === undefined ? {} : { [STORAGE_KEY_STATIC_TIERS]: options.stored },
  );
  const storageSet = (jest.fn() as any).mockResolvedValue(undefined);

  const dnr: Record<string, unknown> = {
    updateEnabledRulesets,
    getEnabledRulesets,
    getAvailableStaticRuleCount,
  };
  if (options.missingApi) {
    delete dnr.updateEnabledRulesets;
    delete dnr.getEnabledRulesets;
  }

  (globalThis as any).chrome = {
    declarativeNetRequest: dnr,
    storage: { local: { get: storageGet, set: storageSet } },
  };

  return { updateEnabledRulesets, getEnabledRulesets, getAvailableStaticRuleCount, storageGet, storageSet };
}

beforeEach(() => {
  delete (globalThis as any).chrome;
});

describe('RulesetManager loading', () => {
  test('defaults to the core tier when nothing has been saved', async () => {
    installChrome();
    const manager = new RulesetManager();
    await expect(manager.load()).resolves.toEqual(['tier_core']);
    expect(manager.getEnabledTierIds()).toEqual(['tier_core']);
  });

  test('restores a saved selection and drops ids it does not recognise', async () => {
    installChrome({ stored: ['tier_ads', 'tier_nope', 'tier_core'] });
    const manager = new RulesetManager();
    await expect(manager.load()).resolves.toEqual(['tier_ads', 'tier_core']);
  });

  test('honours an all-tiers-off selection instead of reverting to defaults', async () => {
    const stub = installChrome({ stored: [], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();
    expect(manager.getEnabledTierIds()).toEqual([]);

    await manager.sync();
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: [],
      disableRulesetIds: ['tier_core'],
    });
  });

  test('falls back to the defaults when storage errors', async () => {
    installChrome();
    (globalThis as any).chrome.storage.local.get = (jest.fn() as any).mockRejectedValue(new Error('nope'));
    const manager = new RulesetManager();
    await expect(manager.load()).resolves.toEqual(['tier_core']);
  });
});

describe('RulesetManager syncing', () => {
  test('does nothing when the browser already matches the saved selection', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();
    await expect(manager.sync()).resolves.toEqual({ enableRulesetIds: [], disableRulesetIds: [] });
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();
  });

  test('applies exactly the difference, in both directions', async () => {
    const stub = installChrome({ stored: ['tier_privacy', 'tier_ads'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();
    const patch = await manager.sync();

    // Copy before sorting: `sync` hands the same object to Chrome, so an in-place sort
    // would rewrite the recorded call and make the assertion below lie.
    expect([...patch.enableRulesetIds].sort()).toEqual(['tier_ads', 'tier_privacy']);
    expect(patch.disableRulesetIds).toEqual(['tier_core']);
    expect(stub.updateEnabledRulesets).toHaveBeenCalledTimes(1);
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['tier_privacy', 'tier_ads'],
      disableRulesetIds: ['tier_core'],
    });
  });

  test('leaves the browser alone when the enabled rulesets cannot be read', async () => {
    // Enabling every tier "to be safe" would be worse than doing nothing: without a reading
    // there is no way to know what is already on.
    const stub = installChrome({ getEnabledThrows: true, stored: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();
    await expect(manager.sync()).resolves.toEqual({ enableRulesetIds: [], disableRulesetIds: [] });
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();
  });

  test('is a safe no-op where the static ruleset API is unavailable', async () => {
    installChrome({ missingApi: true, stored: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();
    await expect(manager.sync()).resolves.toEqual({ enableRulesetIds: [], disableRulesetIds: [] });
  });
});

describe('RulesetManager toggling', () => {
  test('turning a tier on persists it and enables exactly that ruleset', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();

    await expect(manager.setTierEnabled('tier_ads', true)).resolves.toEqual(['tier_core', 'tier_ads']);
    expect(stub.storageSet).toHaveBeenCalledWith({
      [STORAGE_KEY_STATIC_TIERS]: ['tier_core', 'tier_ads'],
    });
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['tier_ads'],
      disableRulesetIds: [],
    });
  });

  test('turning a tier off removes it from storage and disables the ruleset', async () => {
    const stub = installChrome({ stored: ['tier_core', 'tier_ads'], enabledRulesets: ['tier_core', 'tier_ads'] });
    const manager = new RulesetManager();
    await manager.load();

    await expect(manager.setTierEnabled('tier_ads', false)).resolves.toEqual(['tier_core']);
    expect(stub.storageSet).toHaveBeenCalledWith({ [STORAGE_KEY_STATIC_TIERS]: ['tier_core'] });
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: [],
      disableRulesetIds: ['tier_ads'],
    });
  });

  test('an unknown tier id changes nothing and never reaches Chrome', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();

    await expect(manager.setTierEnabled('tier_evil', true)).resolves.toEqual(['tier_core']);
    expect(stub.storageSet).not.toHaveBeenCalled();
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();
  });

  test('replacing the whole selection filters unknown ids and de-duplicates', async () => {
    const stub = installChrome({ enabledRulesets: [] });
    const manager = new RulesetManager();
    await manager.load();

    const result = await manager.setEnabledTierIds(['tier_ads', 'tier_ads', 'tier_bogus']);
    expect(result).toEqual(['tier_ads']);
    expect(stub.storageSet).toHaveBeenCalledWith({ [STORAGE_KEY_STATIC_TIERS]: ['tier_ads'] });
  });
});

describe('RulesetManager suspension (global pause)', () => {
  test('silences the tiers that are actually on, without forgetting the selection', async () => {
    const stub = installChrome({ stored: ['tier_core', 'tier_ads'], enabledRulesets: ['tier_core', 'tier_ads'] });
    const manager = new RulesetManager();
    await manager.load();

    await manager.setSuspended(true);

    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      disableRulesetIds: ['tier_core', 'tier_ads'],
    });
    expect(manager.isSuspended()).toBe(true);
    // Pausing everywhere must not look like the user turned their tiers off.
    expect(manager.getEnabledTierIds()).toEqual(['tier_core', 'tier_ads']);
    expect(stub.storageSet).not.toHaveBeenCalled();
  });

  test('does not disable rulesets it does not own', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core', 'someone_elses'] });
    const manager = new RulesetManager();
    await manager.load();

    await manager.setSuspended(true);
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({ disableRulesetIds: ['tier_core'] });
  });

  test('makes no call when no tier is enabled', async () => {
    const stub = installChrome({ stored: [], enabledRulesets: [] });
    const manager = new RulesetManager();
    await manager.load();

    await manager.setSuspended(true);
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();
  });

  test('resuming restores exactly the saved selection', async () => {
    const stub = installChrome({ stored: ['tier_privacy'], enabledRulesets: [] });
    const manager = new RulesetManager();
    await manager.load();
    await manager.setSuspended(true);
    stub.updateEnabledRulesets.mockClear();

    await manager.setSuspended(false);
    expect(manager.isSuspended()).toBe(false);
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['tier_privacy'],
      disableRulesetIds: [],
    });
  });

  test('repairs a browser that reset to the manifest defaults, with no pause involved', async () => {
    // The update case: storage still holds the user's choice, but the browser is back on the
    // manifest defaults (only `tier_core` is declared enabled). This used to be a silent failure —
    // the popup read storage back and showed those tiers as on while nothing was blocking.
    const stub = installChrome({ stored: ['tier_ads', 'tier_privacy'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();

    await manager.setSuspended(false);

    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['tier_ads', 'tier_privacy'],
      disableRulesetIds: ['tier_core'],
    });
    // Reconciling the browser is not a change of mind: the saved selection is untouched.
    expect(stub.storageSet).not.toHaveBeenCalled();
    expect(manager.getEnabledTierIds()).toEqual(['tier_ads', 'tier_privacy']);
  });

  test('issues no browser call when the browser already matches, so it can run on every apply', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();

    await manager.setSuspended(false);
    expect(stub.getEnabledRulesets).toHaveBeenCalled();
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();
  });

  test('survives a browser that will not report its rulesets', async () => {
    // No reading means no safe diff, so the selection is left unasserted rather than guessed at.
    installChrome({ stored: ['tier_core'], getEnabledThrows: true });
    const manager = new RulesetManager();
    await manager.load();
    await expect(manager.setSuspended(false)).resolves.toBeUndefined();
  });

  test('changing the selection while paused persists it but stays silent', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();
    await manager.setSuspended(true);
    stub.updateEnabledRulesets.mockClear();

    await manager.setEnabledTierIds(['tier_ads']);

    expect(stub.storageSet).toHaveBeenCalledWith({ [STORAGE_KEY_STATIC_TIERS]: ['tier_ads'] });
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();

    // Resuming then applies the selection the user made *while* paused, not the one they had
    // before pausing.
    await manager.setSuspended(false);
    expect(stub.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['tier_ads'],
      disableRulesetIds: ['tier_core'],
    });
  });
});

describe('RulesetManager status', () => {
  test('reports each tier, the active rule count, and the browser\'s available slots', async () => {
    installChrome({ stored: ['tier_core'], available: 29976 });
    const manager = new RulesetManager();
    await manager.load();
    const status = await manager.status();

    // `tierRuleCount` resolves the count the packaging compiler wrote, so this stays correct
    // whether the bundle carries the curated baseline or a hub-compiled ruleset.
    expect(status.enabledTiers).toBe(1);
    expect(status.enabledRules).toBe(tierRuleCount(tierById('tier_core')!));
    expect(status.availableStaticRules).toBe(29976);
    expect(status.tiers.find((t) => t.id === 'tier_core')?.enabled).toBe(true);
    expect(status.tiers.find((t) => t.id === 'tier_privacy')?.enabled).toBe(false);
  });

  test('reports the suspended flag while blocking is paused everywhere', async () => {
    installChrome({ stored: ['tier_core'], enabledRulesets: [] });
    const manager = new RulesetManager();
    await manager.load();
    await manager.setSuspended(true);

    const status = await manager.status();
    expect(status.suspended).toBe(true);
    expect(status.enabledRules).toBe(tierRuleCount(tierById('tier_core')!));
  });

  test('still reports tiers when the availability probe fails', async () => {
    installChrome({ stored: ['tier_core'] });
    (globalThis as any).chrome.declarativeNetRequest.getAvailableStaticRuleCount = (jest.fn() as any).mockRejectedValue(
      new Error('unsupported'),
    );
    const manager = new RulesetManager();
    await manager.load();
    const status = await manager.status();

    expect(status.availableStaticRules).toBeNull();
    expect(status.tiers).toHaveLength(5);
    expect(status.tiers.map((tier) => tier.id)).toEqual([
      'tier_core',
      'tier_ads',
      'tier_privacy',
      'tier_annoyances',
      'tier_security',
    ]);
  });
});

describe('RulesetManager drift (browser vs saved selection)', () => {
  test('reports agreement when the browser holds exactly the saved selection', async () => {
    installChrome({ stored: ['tier_core', 'tier_ads'], enabledRulesets: ['tier_ads', 'tier_core'] });
    const manager = new RulesetManager();
    await manager.load();

    const status = await manager.status();
    expect(status.drift).toEqual({ known: true, unexpected: [], missing: [], inSync: true });
  });

  test('names a tier the browser has on that the user turned off', async () => {
    // The over-blocking direction, and the one storage alone can never reveal: the switch says off
    // while the browser is shipping that tier's rules.
    installChrome({ stored: ['tier_core'], enabledRulesets: ['tier_core', 'tier_security'] });
    const manager = new RulesetManager();
    await manager.load();

    const status = await manager.status();
    expect(status.drift.unexpected).toEqual(['tier_security']);
    expect(status.drift.missing).toEqual([]);
    expect(status.drift.inSync).toBe(false);
  });

  test('names a selected tier the browser has off', async () => {
    // The under-blocking direction: the popup used to report these as on because storage said so.
    installChrome({ stored: ['tier_ads'], enabledRulesets: [] });
    const manager = new RulesetManager();
    await manager.load();

    const status = await manager.status();
    expect(status.drift.missing).toEqual(['tier_ads']);
    expect(status.drift.inSync).toBe(false);
  });

  test('reports unknown rather than agreement when the browser will not answer', async () => {
    installChrome({ stored: ['tier_core'], getEnabledThrows: true });
    const manager = new RulesetManager();
    await manager.load();

    const status = await manager.status();
    expect(status.drift.known).toBe(false);
    expect(status.drift.inSync).toBe(false);
  });

  test('reports unknown rather than agreement where the ruleset API does not exist', async () => {
    installChrome({ stored: ['tier_core'], missingApi: true });
    const manager = new RulesetManager();
    await manager.load();

    const status = await manager.status();
    expect(status.drift.known).toBe(false);
  });

  test('reading the status never repairs, so the disagreement stays visible', async () => {
    const stub = installChrome({ stored: ['tier_ads'], enabledRulesets: ['tier_core'] });
    const manager = new RulesetManager();
    await manager.load();

    await manager.status();
    expect(stub.updateEnabledRulesets).not.toHaveBeenCalled();
  });

  test('while paused, silence is agreement and a tier still on is drift', async () => {
    const stub = installChrome({ stored: ['tier_core'], enabledRulesets: [] });
    const manager = new RulesetManager();
    await manager.load();
    await manager.setSuspended(true);

    const silenced = await manager.status();
    // The selection is deliberately not reported as missing while paused: the pause is supposed to
    // silence it, so the expected state is no tiers at all.
    expect(silenced.drift).toEqual({ known: true, unexpected: [], missing: [], inSync: true });

    // A tier the pause did not silence is the failure the pause promises not to have.
    stub.getEnabledRulesets.mockResolvedValue(['tier_core']);
    const stillOn = await manager.status();
    expect(stillOn.drift.unexpected).toEqual(['tier_core']);
    expect(stillOn.drift.inSync).toBe(false);
  });
});
