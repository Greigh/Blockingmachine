/**
 * The popup's copy of the redundancy question the hub and CLI already answer.
 *
 * Both of those surfaces diff the shipped tiers against the synced list's source text
 * (`browser.txt`). The in-browser answer can ask the same question of the artifact one step
 * further along: the dynamic rules the browser is actually holding, which is what decides real
 * traffic. Rules scoped, dropped or superseded between compile and install show up in this read
 * and not in the source — which is the point of asking in the browser rather than trusting the
 * hub's answer about a file.
 *
 * The read splits provenance before diffing. The user's own rules compile through the same
 * planner as the synced list and land in the same priority band on purpose — ordering cannot
 * tell them apart, so the recorded custom filters are. A tier a user hand-typed into coverage
 * is reported as *their* coverage (`userCovered`) instead of being credited to the list, which
 * is the difference between "the list already carries this" and "you already carry this".
 *
 * The diff itself is core's — `readDynamicRuleHosts` is `readSyncedHosts` for installed rules and
 * `findTierRedundancy` is the same set difference everywhere — so a "redundant" verdict here and
 * one from the CLI cannot disagree about what redundant means. What is genuinely this module's is
 * the reading: `getDynamicRules()` runs in the service worker, the shipped tier files come through
 * `chrome.runtime.getURL`, and a refusal stays a refusal. `synced: null` means the browser would
 * not list its rules, which is a different fact from "nothing was redundant", and the popup
 * renders the two differently because they are different facts.
 *
 * Read-only by design: this is a report, and a report that writes is a reconciliation pretending
 * to be a question.
 */

import { STATIC_RULE_TIERS, type StaticTierId } from '@blockingmachine/core/tiers';
import {
  findTierRedundancy,
  readDynamicRuleHosts,
  summarizeSyncedList,
  type SyncedListSummary,
  type TierRedundancy,
} from '@blockingmachine/core/tier-plan';
import { BLOCK_RESOURCE_TYPES } from './dnrManager.js';

/** One shipped tier's redundancy against the live dynamic rules. */
export interface TierRedundancyEntry {
  /**
   * Rules in the tier file — the denominator a "covered N of M" sentence needs.
   * Null when the file could not be read, which is also when `redundant` is null.
   */
  total: number | null;
  /** The diff against list-derived rules, or null when the tier file could not be read. */
  redundant: TierRedundancy | null;
  /**
   * The same diff against only the rules the user's own filters installed — null when no
   * `userPatterns` were supplied or no installed rule matched them. A tier the user hand-typed
   * into coverage shows it here instead of being credited to the synced list.
   */
  userCovered: TierRedundancy | null;
}

/** What the popup needs to report redundancy against the live dynamic rules. */
export interface TierRedundancyReport {
  /**
   * The list-derived installed rules read as the synced list, or null when the browser refused
   * to list them. Null is the honest failure: an empty summary would claim "nothing installed",
   * which is a different answer from "we do not know".
   */
  synced: SyncedListSummary | null;
  /**
   * The installed rules the user's own filters produced, read the same way — null when no
   * `userPatterns` were supplied. The provenance split the plain `synced` count used to hide:
   * a hand-typed `||host^` shares the list's priority band, so only the recorded filters can
   * tell it from a synced one.
   */
  userOwned: SyncedListSummary | null;
  /** Per-tier diff keyed by catalogue id. A tier whose file could not be read gets nulls. */
  tiers: Partial<Record<StaticTierId, TierRedundancyEntry>>;
  /** Tiers that block nothing the list-derived rules do not, in catalogue order. */
  redundantTiers: StaticTierId[];
}

export interface TierRedundancyOptions {
  /**
   * The installed dynamic rules — raw `getDynamicRules()` output — or null when the browser
   * refused to list them. Null produces a report whose `synced` is null rather than an exception:
   * "we could not look" is a reportable state, not a failure of reporting.
   */
  rules: readonly unknown[] | null;
  /**
   * The `urlFilter`s the user's own rules were planned into — `planListRules(customRules)` output.
   * Installed rules carrying one are counted as the user's coverage, not the list's. Deliberately
   * a pattern set rather than an id set: a preserving apply keeps old ids for rules the filters
   * still name, and the filter is the decision either way.
   */
  userPatterns?: ReadonlySet<string>;
  /** Reads and parses one tier's rule file; rejecting leaves that tier's entry null. */
  readTier: (path: string) => Promise<unknown>;
  /** Defaults to the shipped catalogue; injected in tests. */
  tiers?: readonly { id: StaticTierId; path: string }[];
}

/**
 * Diffs every shipped tier against the installed dynamic rules.
 *
 * `BLOCK_RESOURCE_TYPES` is handed to the read because the compiler stamps it on every plain
 * block, so a rule carrying exactly that set is the list's spelling of an unconditional host
 * block — only a rule holding fewer of those types has a narrower claim. `trackTypeClaims`
 * makes the verdict per-type honest on top: a compiled block never claims `main_frame` or
 * `websocket`, so an all-types tier `||host^` is host-covered but never *fully* covered —
 * `complete` stays false and `typeLimited` counts the rules that are only partially redundant,
 * which is what the popup's "partially" wording hangs on.
 */
export async function computeTierRedundancy(
  options: TierRedundancyOptions,
): Promise<TierRedundancyReport> {
  // Partition before reading rather than reading and subtracting after: `readDynamicRuleHosts`
  // collapses rules into host sets, and a host in both sets would have nowhere to be counted
  // twice. The partition is by the recorded filters, not the priority band — a hand-typed rule
  // compiles through the same planner as the list and lands in the same band by design, so the
  // filter set is the only provenance that survives.
  let listRead: ReturnType<typeof readDynamicRuleHosts> | null = null;
  let userRead: ReturnType<typeof readDynamicRuleHosts> | null = null;
  if (options.rules !== null) {
    const userPatterns = options.userPatterns;
    const listRules: unknown[] = [];
    const userRules: unknown[] = [];
    for (const rule of options.rules) {
      const filter = (rule as { condition?: { urlFilter?: unknown } })?.condition?.urlFilter;
      (userPatterns && typeof filter === 'string' && userPatterns.has(filter)
        ? userRules
        : listRules
      ).push(rule);
    }
    listRead = readDynamicRuleHosts(listRules, {
      blockResourceTypes: BLOCK_RESOURCE_TYPES,
      trackTypeClaims: true,
    });
    if (userPatterns) {
      userRead = readDynamicRuleHosts(userRules, {
        blockResourceTypes: BLOCK_RESOURCE_TYPES,
        trackTypeClaims: true,
      });
    }
  }

  const tiers: Partial<Record<StaticTierId, TierRedundancyEntry>> = {};
  const redundantTiers: StaticTierId[] = [];
  for (const tier of options.tiers ?? STATIC_RULE_TIERS) {
    let file: unknown;
    try {
      file = await options.readTier(tier.path);
    } catch {
      tiers[tier.id] = { total: null, redundant: null, userCovered: null };
      continue;
    }
    const redundant = listRead ? findTierRedundancy(file, listRead) : null;
    const userCovered =
      userRead && userRead.lines > 0 ? findTierRedundancy(file, userRead) : null;
    tiers[tier.id] = {
      total: Array.isArray(file) ? file.length : null,
      redundant,
      userCovered,
    };
    if (redundant?.complete) redundantTiers.push(tier.id);
  }

  return {
    synced: listRead ? summarizeSyncedList(listRead) : null,
    userOwned: userRead ? summarizeSyncedList(userRead) : null,
    tiers,
    redundantTiers,
  };
}
