/**
 * The capacity-aware tier planner.
 *
 * The implementation moved to `@blockingmachine/core` so the extension popup, the desktop hub and
 * the CLI all plan with the same function instead of three that could disagree. This file remains
 * as the extension's import path, so nothing that already reached for `shared/tierPlanner.js` — the
 * popup, the planner suite, the basis card — has to change.
 *
 * See `packages/core/src/tiers.ts` for the planner itself and for why it is pure enough to share.
 */

export * from '@blockingmachine/core/tiers';
