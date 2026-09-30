/**
 * Per-tier block attribution: how much each static tier has actually blocked, and whether the
 * ledger has earned the right to weight the plan by it.
 *
 * The implementation moved to `@blockingmachine/core` alongside the planner it feeds, because the
 * hub and the CLI need the same verdict vocabulary and the same refusal to treat a disabled tier's
 * zero as a measurement. This file remains as the extension's import path.
 */

export * from '@blockingmachine/core/tiers';
