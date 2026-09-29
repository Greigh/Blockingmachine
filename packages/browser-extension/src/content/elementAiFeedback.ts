/**
 * Persistence for the element Mini-AI's user feedback.
 *
 * The model's corrections live in the shared classifier, which is per-page: without
 * this they would be forgotten on every navigation. Content scripts can reach
 * `chrome.storage` directly, so a decision is written as the classifier's own export
 * map — the same shape `importElementFeedback()` reads back — which keeps one
 * representation of the learning rather than two.
 */

import type { MiniAiElementClassifier, ElementSnapshot } from '@blockingmachine/core/element-ai';
import { STORAGE_KEY_ELEMENT_AI_FEEDBACK } from '../shared/constants.js';

const MAX_PERSISTED_ENTRIES = 2000;

/** Loads persisted decisions into the classifier. Returns how many were applied. */
export async function loadElementFeedback(classifier: MiniAiElementClassifier): Promise<number> {
  try {
    if (!chrome?.storage?.local) return 0;
    const stored = await chrome.storage.local.get(STORAGE_KEY_ELEMENT_AI_FEEDBACK);
    const raw: unknown = stored?.[STORAGE_KEY_ELEMENT_AI_FEEDBACK];
    if (!raw || typeof raw !== 'object') return 0;

    const sanitized: Record<string, number> = Object.create(null);
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_PERSISTED_ENTRIES)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      sanitized[key] = Math.max(-1, Math.min(1, value));
    }
    classifier.importElementFeedback(sanitized);
    return Object.keys(sanitized).length;
  } catch {
    return 0;
  }
}

/** Writes the classifier's current decisions back to storage. */
export async function saveElementFeedback(classifier: MiniAiElementClassifier): Promise<boolean> {
  try {
    if (!chrome?.storage?.local) return false;
    const exported = classifier.exportElementFeedback();
    const entries = Object.entries(exported).slice(-MAX_PERSISTED_ENTRIES);
    const bounded: Record<string, number> = Object.create(null);
    for (const [key, value] of entries) bounded[key] = value;
    await chrome.storage.local.set({ [STORAGE_KEY_ELEMENT_AI_FEEDBACK]: bounded });
    return true;
  } catch {
    return false;
  }
}

/**
 * Records one user decision for an element and persists the result.
 * `hide` teaches the model that this kind of element should be removed; `keep`
 * teaches it that the shape is content and must be left visible.
 */
export async function recordElementDecision(
  classifier: MiniAiElementClassifier,
  snapshot: ElementSnapshot,
  action: 'hide' | 'keep',
): Promise<{ signature: string; stored: boolean }> {
  classifier.tuneElementFeedback(snapshot, action);
  const stored = await saveElementFeedback(classifier);
  const exported = classifier.exportElementFeedback();
  return { signature: Object.keys(exported).slice(-1)[0] ?? '', stored };
}
