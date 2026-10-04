/**
 * The quarantine ledger is enforcement-adjacent — its entries feed the daemon's block path and
 * the published `ai-threats.txt` feed — so the bar to enter it is higher than the bar to appear
 * on the radar as a lead for review. Both sweep paths (the watchdog's periodic run and the live
 * radar's per-poll pass) share the gate here, because the last time each path spelled the rule
 * out for itself they diverged: one quarantined every flagged domain when the entropy toggle was
 * off, the other when it was on. `autoQuarantineEntropyDga` widens the gate to exactly what its
 * label says — DGA/high-entropy heuristic detections — and nothing else.
 */

import type { AiScanResult, ThreatQuarantineItem } from './types';

/** Confidence arrives 0–1 or 0–100 depending on the provider; quarantine thresholds are %. */
function confidencePercent(confidence: unknown): number {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 0;
  return confidence > 1 ? confidence : confidence * 100;
}

export function shouldAutoQuarantine(
  result: Pick<AiScanResult, 'verdict' | 'confidence' | 'riskLevel' | 'isLikelyDga' | 'entropy'>,
  autoQuarantineDga: boolean,
): boolean {
  if (result.verdict === 'clean') return false;
  if (confidencePercent(result.confidence) >= 85 || result.riskLevel === 'critical') return true;
  // Heuristic-only detections quarantine only when the operator asked for it — a keyword hint on
  // its own is a review lead, not a verdict to publish.
  return (
    autoQuarantineDga === true &&
    (result.isLikelyDga === true ||
      (typeof result.entropy === 'number' && result.entropy > 4.2))
  );
}

export interface QuarantineStoreLike {
  get(key: 'aiThreatQuarantine'): ThreatQuarantineItem[] | undefined;
  set(key: 'aiThreatQuarantine', value: ThreatQuarantineItem[]): void;
}

/**
 * Re-screens the persisted quarantine with the current classifier and releases entries it now
 * reports clean. The store accumulates verdicts across classifier versions — a domain quarantined
 * before the infrastructure guard existed stays quarantined after it ships unless something looks
 * again — and across gate bugs: anything an over-eager gate parked is re-judged on the same
 * evidence as a fresh scan. Entries the rescan cannot judge are kept rather than silently
 * dropped, and `source: 'inspector'` rows are never touched — a person chose those.
 */
export async function revalidateQuarantine(
  store: QuarantineStoreLike,
  scanDomain: (domain: string) => Promise<Pick<AiScanResult, 'verdict'>>,
  log: (message: string) => void = (message) => console.log(message),
): Promise<{ kept: number; cleared: string[] }> {
  const quarantine = store.get('aiThreatQuarantine') || [];
  const kept: ThreatQuarantineItem[] = [];
  const cleared: string[] = [];

  for (const item of quarantine) {
    if (item.source === 'inspector') {
      kept.push(item);
      continue;
    }
    try {
      const rescan = await scanDomain(item.domain);
      if (rescan.verdict === 'clean') {
        cleared.push(item.domain);
      } else {
        kept.push(item);
      }
    } catch {
      kept.push(item);
    }
  }

  if (cleared.length > 0) {
    // Re-read before writing: a sweep may have quarantined new domains while the rescan ran, and
    // writing the stale `kept` snapshot would silently drop them.
    const clearedSet = new Set(cleared);
    const current = store.get('aiThreatQuarantine') || [];
    store.set('aiThreatQuarantine', current.filter((i) => !clearedSet.has(i.domain)));
    log(
      `[AI Quarantine] Revalidation cleared ${cleared.length} stale ${cleared.length === 1 ? 'entry' : 'entries'} ` +
        `the current classifier reports clean: ${cleared.slice(0, 10).join(', ')}${cleared.length > 10 ? `, +${cleared.length - 10} more` : ''}`,
    );
  }
  return { kept: kept.length, cleared };
}
