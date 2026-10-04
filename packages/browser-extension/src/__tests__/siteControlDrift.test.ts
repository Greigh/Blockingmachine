/**
 * The comparison underneath the popup's site-control drift notice.
 *
 * The tier manager already reports whether the browser's enabled rulesets match the saved
 * selection; this is the same question asked of the dynamic rules, where a site pause or an
 * allowed domain lives. `deriveShieldStatus` reads storage alone, so a decision whose apply
 * failed used to render as a state the browser was never in — this is the read that closes it.
 *
 * The function is pure: the caller supplies the browser's families, so the tests state them
 * directly rather than stubbing `getDynamicRules` — the same convention `rulesetManager`'s
 * stateful fake keeps, one level down.
 */

import { describe, expect, it } from '@jest/globals';
import {
  PRIORITY_SITE_PAUSE,
  PRIORITY_USER_ALLOW,
} from '../shared/constants.js';
import {
  BLOCK_RESOURCE_TYPES,
  computeSiteControlDrift,
  type InstalledRuleFamilies,
  type PlannedRule,
} from '../background/dnrManager.js';

/** A dynamic rule as Chrome reports it, with only the fields the comparison reads. */
function installedRule(
  id: number,
  options: {
    priority?: number;
    actionType?: string;
    urlFilter?: string;
    resourceTypes?: string[];
  } = {},
): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: options.priority ?? 1,
    action: { type: (options.actionType ?? 'block') as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      urlFilter: options.urlFilter ?? `||listed-${id}.example^`,
      resourceTypes: (options.resourceTypes ?? ['script']) as chrome.declarativeNetRequest.ResourceType[],
    },
  } as chrome.declarativeNetRequest.Rule;
}

/** The browser's shape for a pause or allowance the extension would have installed. */
function installedDecision(rule: PlannedRule, id: number): chrome.declarativeNetRequest.Rule {
  return installedRule(id, {
    priority: rule.priority,
    actionType: rule.action,
    urlFilter: rule.pattern,
    resourceTypes: rule.resourceTypes,
  });
}

function families(
  user: chrome.declarativeNetRequest.Rule[] = [],
  list: chrome.declarativeNetRequest.Rule[] = [],
): InstalledRuleFamilies {
  return { user, list };
}

/** A saved site pause as the planner and the browser would both write it. */
const PAUSE_RULE: PlannedRule = {
  priority: PRIORITY_SITE_PAUSE,
  action: 'allowAllRequests',
  pattern: '||paused.example^',
  resourceTypes: ['main_frame', 'sub_frame'],
};
const ALLOW_RULE: PlannedRule = {
  priority: PRIORITY_USER_ALLOW,
  action: 'allow',
  pattern: '||allowed.example^',
  resourceTypes: [...BLOCK_RESOURCE_TYPES],
};

describe('computeSiteControlDrift', () => {
  it('reports an unreadable browser as unknown, never as in sync', () => {
    const drift = computeSiteControlDrift(null, { pausedSites: ['paused.example'] });
    // "No reading" and "no rules" lead to opposite claims — the popup must not be told the
    // decisions are enforced about a state nobody has seen.
    expect(drift).toMatchObject({ known: false, inSync: false });
  });

  it('agrees when every decision has its rule and nothing extra is held', () => {
    const drift = computeSiteControlDrift(
      families([installedDecision(PAUSE_RULE, 1), installedDecision(ALLOW_RULE, 2)]),
      { pausedSites: ['paused.example'], allowedDomains: ['allowed.example'] },
    );
    expect(drift).toMatchObject({ known: true, inSync: true });
    expect(drift.missingPauses).toEqual([]);
    expect(drift.unexpectedPauses).toEqual([]);
  });

  it('names a saved pause the browser has no rule for — a pause that is not pausing', () => {
    const drift = computeSiteControlDrift(families(), { pausedSites: ['paused.example'] });
    expect(drift.inSync).toBe(false);
    expect(drift.missingPauses).toEqual(['paused.example']);
  });

  it('names a saved allowance the browser has no rule for — an allowance that is not allowing', () => {
    const drift = computeSiteControlDrift(families(), { allowedDomains: ['allowed.example'] });
    expect(drift.inSync).toBe(false);
    expect(drift.missingAllowances).toEqual(['allowed.example']);
  });

  it('names a pause the browser still enforces that no saved pause asks for', () => {
    // A rule with no decision behind it is a page being let through the user did not pause —
    // the expensive direction, and the one storage-only reporting could never see.
    const drift = computeSiteControlDrift(families([installedDecision(PAUSE_RULE, 1)]), {});
    expect(drift.inSync).toBe(false);
    expect(drift.unexpectedPauses).toEqual(['paused.example']);
  });

  it('names an allowance the browser still enforces that no saved allowance asks for', () => {
    const drift = computeSiteControlDrift(families([installedDecision(ALLOW_RULE, 1)]), {});
    expect(drift.inSync).toBe(false);
    expect(drift.unexpectedAllowances).toEqual(['allowed.example']);
  });

  it('names a saved rule the browser has no rule for, by the filter the user asked for', () => {
    const drift = computeSiteControlDrift(families(), {}, ['||custom.example^']);
    expect(drift.inSync).toBe(false);
    expect(drift.missingRules).toEqual(['||custom.example^']);
  });

  it('does not ask for a saved rule the planner refuses outright', () => {
    // A line that can never become a rule contributes no filter — requiring it would be a
    // repair loop rather than a reconcile.
    const drift = computeSiteControlDrift(families(), {}, ['not a rule']);
    expect(drift.missingRules).toEqual([]);
  });

  it('does not hold a custom rule against the browser while blocking is paused everywhere', () => {
    // The pause installs nothing at all — a saved rule that is legitimately absent must not
    // read as a rule that failed to install.
    const drift = computeSiteControlDrift(families(), { globalPaused: true }, ['||custom.example^']);
    expect(drift.missingRules).toEqual([]);
  });

  it('counts the blocklist still installed while paused everywhere — the pause that did not clear', () => {
    const drift = computeSiteControlDrift(
      families([installedDecision(PAUSE_RULE, 1)], [installedRule(2), installedRule(3)]),
      { globalPaused: true },
    );
    expect(drift.inSync).toBe(false);
    expect(drift.unexpectedBlocking).toBe(2);
    // The leftover pause rule is still reported by name rather than folded into the count.
    expect(drift.unexpectedPauses).toEqual(['paused.example']);
  });

  it('reports a mutated rule in both directions — missing the one saved, holding one unsaved', () => {
    const widened = installedRule(1, {
      priority: PRIORITY_SITE_PAUSE,
      actionType: 'allowAllRequests',
      urlFilter: '||paused.example^',
      resourceTypes: ['main_frame', 'sub_frame', 'script'],
    });
    const drift = computeSiteControlDrift(families([widened]), { pausedSites: ['paused.example'] });
    expect(drift.inSync).toBe(false);
    expect(drift.missingPauses).toEqual(['paused.example']);
    expect(drift.unexpectedPauses).toEqual(['paused.example']);
  });

  it('reports a user-family rule that matches no decision shape as foreign state', () => {
    const foreign = installedRule(1, {
      priority: PRIORITY_USER_ALLOW,
      actionType: 'block',
      urlFilter: '||foreign.example^',
    });
    const drift = computeSiteControlDrift(families([foreign]), {});
    expect(drift.inSync).toBe(false);
    expect(drift.unexpectedRules).toEqual(['||foreign.example^']);
  });
});
