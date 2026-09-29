import {
  DEFAULT_ENABLED_TIER_IDS,
  buildTierStatus,
  diffRulesets,
  isTierId,
  resolveEnabledTierIds,
  type StaticTierId,
  type StaticTierStatus,
} from '../shared/rulesetTiers.js';
import { STORAGE_KEY_STATIC_TIERS } from '../shared/constants.js';

export interface RulesetSyncResult {
  enableRulesetIds: string[];
  disableRulesetIds: string[];
}

const NOTHING_TO_DO: RulesetSyncResult = { enableRulesetIds: [], disableRulesetIds: [] };

/**
 * Owns which static ruleset tiers are enabled.
 *
 * The browser is the source of truth for what is *currently* enabled; storage is the source
 * of truth for what the user *wants*. `sync()` reconciles the two, so state survives service
 * worker restarts and a browser that quietly re-enabled a manifest default cannot drift from
 * the user's choice.
 */
export class RulesetManager {
  private enabled: StaticTierId[] = [...DEFAULT_ENABLED_TIER_IDS];
  /**
   * Set while blocking is paused everywhere. The paused state clears the dynamic rules, so the
   * shipped tiers have to be silenced too — otherwise "pause everywhere" would leave the static
   * rules blocking, which is precisely the promise the switch makes.
   */
  private suspended = false;

  /** Reads the persisted choice into memory. Falls back to the defaults on any read error. */
  async load(): Promise<StaticTierId[]> {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_STATIC_TIERS);
      this.enabled = resolveEnabledTierIds(stored?.[STORAGE_KEY_STATIC_TIERS]);
    } catch (err) {
      console.warn('[Rulesets] Could not read static tier state:', err);
      this.enabled = [...DEFAULT_ENABLED_TIER_IDS];
    }
    return this.getEnabledTierIds();
  }

  getEnabledTierIds(): StaticTierId[] {
    return [...this.enabled];
  }

  private async persist(): Promise<void> {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_STATIC_TIERS]: this.enabled });
    } catch (err) {
      console.warn('[Rulesets] Could not persist static tier state:', err);
    }
  }

  /**
   * Reconciles the browser's enabled rulesets with the persisted tiers.
   *
   * Idempotent, and it issues no call when nothing changed — `updateEnabledRulesets` is a
   * no-op that still costs a service worker wakeup, and this runs on every worker start.
   */
  async sync(): Promise<RulesetSyncResult> {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr?.updateEnabledRulesets || !dnr?.getEnabledRulesets) return { ...NOTHING_TO_DO };

    let current: string[];
    try {
      current = await dnr.getEnabledRulesets();
    } catch (err) {
      // Without a reading there is no safe diff. Enabling every tier to "be sure" would be
      // worse than leaving the browser's own state untouched.
      console.warn('[Rulesets] Could not read enabled rulesets:', err);
      return { ...NOTHING_TO_DO };
    }

    const patch = diffRulesets(current, this.enabled);
    if (patch.enableRulesetIds.length === 0 && patch.disableRulesetIds.length === 0) {
      return patch;
    }

    await dnr.updateEnabledRulesets(patch);
    console.log(
      `[Rulesets] Static tiers updated: enabled ${patch.enableRulesetIds.length}, disabled ${patch.disableRulesetIds.length}.`,
    );
    return patch;
  }

  /** Whether the tiers are currently silenced by the global pause. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Applies the pause state to the browser's rulesets, without touching the saved selection.
   *
   * Both directions are reconciled, and both read the browser first: paused disables whatever is
   * actually on, and not-paused makes the browser match the saved selection. Deliberately separate
   * from `setEnabledTierIds`, because pausing everywhere must not look like the user turned their
   * tiers off.
   */
  async setSuspended(suspended: boolean): Promise<void> {
    this.suspended = suspended;

    const dnr = chrome.declarativeNetRequest;
    if (!dnr?.updateEnabledRulesets) return;

    if (suspended) {
      // Only the tiers actually on need silencing, and re-reading the browser's state keeps this
      // honest after a worker restart where nothing is in memory yet.
      let toDisable: string[] = [...this.enabled];
      if (dnr.getEnabledRulesets) {
        try {
          const current = await dnr.getEnabledRulesets();
          toDisable = current.filter((id) => isTierId(id));
        } catch {
          // Fall back to the selection, which is the best available answer.
        }
      }
      if (toDisable.length === 0) return;
      await dnr.updateEnabledRulesets({ disableRulesetIds: toDisable });
      return;
    }

    // Not paused, so the browser has to match the saved selection — and this runs every time, not
    // only when the flag flipped. `sync()` issues no call when the two already agree, so it is
    // cheap enough to be the single entry point for "make the browser reflect the user's state".
    // It is also the only thing that repairs a browser which reset its enabled rulesets to the
    // manifest defaults, which is what an extension update does: storage would still hold the
    // user's choice, the popup would read it back and show those tiers as on, and nothing would be
    // blocking. Gating this on the previous flag meant that repair never happened.
    await this.sync();
  }

  /** Replaces the whole selection. Unknown ids are dropped rather than sent to Chrome. */
  async setEnabledTierIds(ids: readonly string[]): Promise<StaticTierId[]> {
    this.enabled = [...new Set(ids.filter(isTierId))];
    await this.persist();
    // While paused everywhere the selection is still saved but stays silent in the browser.
    if (!this.suspended) await this.sync();
    return this.getEnabledTierIds();
  }

  async setTierEnabled(id: string, enabled: boolean): Promise<StaticTierId[]> {
    if (!isTierId(id)) return this.getEnabledTierIds();
    const next = new Set(this.enabled);
    if (enabled) {
      next.add(id);
    } else {
      next.delete(id);
    }
    return this.setEnabledTierIds([...next]);
  }

  /** Current tier state plus optional live diagnostics from the browser. */
  async status(): Promise<StaticTierStatus> {
    let availableStaticRules: number | null = null;
    try {
      const dnr = chrome.declarativeNetRequest;
      if (dnr?.getAvailableStaticRuleCount) {
        availableStaticRules = await dnr.getAvailableStaticRuleCount();
      }
    } catch {
      // Diagnostics only; a missing count must never block the toggle UI.
    }
    return buildTierStatus(this.enabled, availableStaticRules, this.suspended);
  }
}
