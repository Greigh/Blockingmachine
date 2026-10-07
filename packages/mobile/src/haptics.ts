/**
 * Thin haptics layer — one import keeps every screen consistent and keeps the
 * expo-haptics surface out of components. All calls are no-ops where the
 * platform has no haptic engine; failures (e.g. missing permission on odd
 * Android builds) must never break the action they accompany, hence the
 * swallowed errors.
 */

import * as Haptics from 'expo-haptics';

const safe = (fn: () => Promise<void>) => {
  void fn().catch(() => {});
};

export const haptics = {
  /** Button presses, card taps. */
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Toggles, pickers — the light selection tick. */
  select: () => safe(() => Haptics.selectionAsync()),
  /** Mutation succeeded. */
  success: () =>
    safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Mutation failed or a server error was returned. */
  error: () =>
    safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
