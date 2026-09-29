/**
 * Visual element picker.
 *
 * Behaviour that was broken before and is now guaranteed:
 *  - **Clicking the page blocks the element.** A click used to be swallowed
 *    without doing anything, so the only way to commit was to reach for the HUD.
 *  - **The HUD survives interaction.** It rebuilt its innerHTML — and its click
 *    handlers — on every mousemove, which dropped clicks and leaked listeners.
 *  - **The selector is verified before it is used.** No more bare-tag fallback
 *    that hid every `div` on the site; when no safe selector exists the HUD says
 *    so instead of blanking the page.
 */

import type { ElementPrediction } from '@blockingmachine/core/element-ai';
import { STORAGE_KEY_USER_COSMETICS } from '../shared/constants.js';
import { validateCosmeticSelector } from '../shared/cosmeticRules.js';
import {
  elementAiBadge,
  elementAiEvidenceLine,
  elementAiEvidenceRows,
  elementAiLine,
  elementAiScanSummary,
} from '../shared/elementAiDisplay.js';
import { injectCosmeticStyles } from './cosmeticHider.js';
import { recordElementDecision } from './elementAiFeedback.js';
import { countMatches, type ElementAiGroup, type ElementAiScanner } from './elementScanner.js';
import { snapshotElement } from './elementSnapshot.js';
import { createSelectorEngine, type SelectorEngine } from './selectorEngine.js';
import { BM_UI_ATTRIBUTE, isOwnUi, showToast } from './pageToast.js';

export interface PickerBlockInfo {
  selector: string;
  mode: 'element' | 'similar';
  matches: number;
}

export interface ElementPickerOptions {
  engine?: SelectorEngine;
  /**
   * The element Mini-AI. When supplied, the picker annotates every hovered element
   * with the model's verdict, outlines the clusters the model found on the page, and
   * teaches the model from the user's own block/keep decisions.
   */
  scanner?: ElementAiScanner;
  /** Called after a rule has been persisted, so the worker can count it. */
  onBlocked?: (info: PickerBlockInfo) => void;
  /** Called when a saved rule is removed by Undo. */
  onUndone?: (selector: string) => void;
}

const HUD_ID = 'bm-picker-hud';
const OVERLAY_ID = 'bm-picker-overlay';

/** Verdict colours, matching the element AI's badge tones. */
const AI_TONE_COLOURS: Record<string, string> = {
  ad: '#fdba74',
  tracker: '#d8b4fe',
  annoyance: '#5eead4',
  content: '#cbd5e1',
};

/**
 * The page's hostname, or an empty string when there is no window to read it from.
 * Every caller wraps its message send in a `try`, which would otherwise swallow the
 * `ReferenceError` from a bare `location` reference and make the send vanish
 * silently — exactly what happened before this helper existed.
 */
function currentHostname(): string {
  try {
    return typeof location !== 'undefined' && location.hostname ? location.hostname : '';
  } catch {
    return '';
  }
}

export class ElementPicker {
  private active = false;
  private currentElement: Element | null = null;
  private overlayEl: HTMLElement | null = null;
  private hudEl: HTMLElement | null = null;
  private selectorTextEl: HTMLElement | null = null;
  private metaTextEl: HTMLElement | null = null;
  private blockButton: HTMLButtonElement | null = null;
  private similarButton: HTMLButtonElement | null = null;
  private previewButton: HTMLButtonElement | null = null;

  private isPreviewing = false;
  private previewedDisplay = '';
  /** The element hidden by the preview, so it can always be restored. */
  private previewedElement: HTMLElement | null = null;
  /** The element whose styles we hid, so Undo can restore exactly that one. */
  private hiddenElement: Element | null = null;
  private hiddenDisplay = '';
  /** Last pointer position, used for ArrowDown (narrow to the deepest child). */
  private lastPointer = { x: 0, y: 0 };

  private aiTextEl: HTMLElement | null = null;
  private aiHintEl: HTMLElement | null = null;
  /** The signal list under the verdict. Holds no listeners, so it can be rebuilt freely. */
  private aiEvidenceEl: HTMLElement | null = null;
  private currentPrediction: ElementPrediction | null = null;
  private highlighted = 0;

  private readonly engine: SelectorEngine;
  private readonly scanner: ElementAiScanner | null;
  private readonly options: ElementPickerOptions;

  constructor(options: ElementPickerOptions = {}) {
    this.options = options;
    this.engine = options.engine ?? createSelectorEngine();
    this.scanner = options.scanner ?? null;
  }

  public isActive(): boolean {
    return this.active;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  public start(): void {
    if (this.active) return;
    this.active = true;

    this.createOverlay();
    this.createHud();
    this.attachListeners();

    if (document.body) document.body.style.cursor = 'crosshair';

    // Let the user see the page before the scan runs: outlining first would delay
    // the picker appearing on a heavy page for no benefit.
    this.highlighted = 0;
    window.setTimeout(() => void this.runAiScan(), 0);

    showToast({
      message:
        'Element picker: click an element to block it. ↑ parent · ↓ child · S similar · P preview · A mark as ad · N mark as content · Esc cancel.',
      tone: 'info',
      durationMs: 6000,
    });
  }

  /** Scans the page with the element Mini-AI and outlines what it found. */
  private async runAiScan(): Promise<void> {
    if (!this.scanner || !this.active) return;
    try {
      const result = this.scanner.scan();
      this.highlighted = this.scanner.highlight(result);
      this.refreshHud();
      if (result.groups.length > 0) {
        showToast({
          message: `AI scanned this page: ${elementAiScanSummary({ hide: result.hideCount, suggest: result.suggestCount })}. Click a highlighted element to block it.`,
          tone: 'info',
          durationMs: 5200,
        });
      }
    } catch (err) {
      console.warn('[Blockingmachine] Element AI scan failed:', err);
    }
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;

    this.detachListeners();
    this.removeOverlay();
    this.removeHud();
    this.scanner?.clearHighlights();

    this.restorePreview();
    this.currentElement = null;
    this.currentPrediction = null;

    if (document.body) document.body.style.cursor = '';
  }

  // ─── Overlay + HUD ──────────────────────────────────────────────────────────

  private createOverlay(): void {
    if (this.overlayEl) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute(BM_UI_ATTRIBUTE, 'overlay');
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483645',
      border: '2px solid #06b6d4',
      backgroundColor: 'rgba(6, 182, 212, 0.14)',
      boxShadow: '0 0 12px rgba(6, 182, 212, 0.45)',
      borderRadius: '4px',
      display: 'none',
      boxSizing: 'border-box',
    });
    document.documentElement.appendChild(overlay);
    this.overlayEl = overlay;
  }

  private removeOverlay(): void {
    this.overlayEl?.remove();
    this.overlayEl = null;
  }

  /**
   * Built once. Only text content and the disabled state are updated afterwards,
   * so the buttons keep the listeners they were given.
   */
  private createHud(): void {
    if (this.hudEl) return;

    const hud = document.createElement('div');
    hud.id = HUD_ID;
    hud.setAttribute(BM_UI_ATTRIBUTE, 'hud');
    Object.assign(hud.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '2147483647',
      background: 'rgba(15, 23, 42, 0.97)',
      color: '#f8fafc',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12px',
      padding: '14px 16px',
      borderRadius: '12px',
      boxShadow: '0 18px 40px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.1)',
      width: '330px',
      maxWidth: 'calc(100vw - 48px)',
      display: 'flex',
      flexDirection: 'column',
      gap: '9px',
      pointerEvents: 'auto',
    });

    const title = document.createElement('div');
    Object.assign(title.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontWeight: '700',
      fontSize: '13px',
    });
    const titleText = document.createElement('span');
    titleText.textContent = '🎯 Element picker';
    const hint = document.createElement('span');
    hint.textContent = 'Click to block';
    this.aiHintEl = hint;
    Object.assign(hint.style, { fontSize: '10px', color: '#94a3b8', fontWeight: '400' });
    title.append(titleText, hint);

    const selectorBox = document.createElement('div');
    Object.assign(selectorBox.style, {
      background: 'rgba(0, 0, 0, 0.45)',
      padding: '8px 10px',
      borderRadius: '7px',
      border: '1px solid rgba(255,255,255,0.07)',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      minHeight: '46px',
    });
    const selectorLabel = document.createElement('div');
    selectorLabel.textContent = 'CSS selector';
    Object.assign(selectorLabel.style, { fontSize: '9.5px', color: '#94a3b8', letterSpacing: '0.4px' });
    const selectorText = document.createElement('code');
    Object.assign(selectorText.style, {
      color: '#38bdf8',
      wordBreak: 'break-all',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '11px',
    });
    selectorText.textContent = 'Hover an element to inspect it…';
    const metaText = document.createElement('div');
    Object.assign(metaText.style, { fontSize: '10px', color: '#94a3b8' });
    selectorBox.append(selectorLabel, selectorText, metaText);

    const makeButton = (
      label: string,
      variant: 'primary' | 'ghost',
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.textContent = label;
      Object.assign(button.style, {
        flex: '1',
        padding: '7px 10px',
        borderRadius: '7px',
        font: 'inherit',
        fontWeight: variant === 'primary' ? '700' : '500',
        cursor: 'pointer',
        border: variant === 'primary' ? 'none' : '1px solid rgba(255,255,255,0.16)',
        background: variant === 'primary' ? '#06b6d4' : 'rgba(255,255,255,0.06)',
        color: variant === 'primary' ? '#04121a' : '#e2e8f0',
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      return button;
    };

    // The AI verdict for whatever is under the pointer. Sits above the selector so
    // the model's opinion is read before the mechanical details.
    const aiRow = document.createElement('div');
    Object.assign(aiRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      padding: '7px 9px',
      borderRadius: '7px',
      background: 'rgba(56, 189, 248, 0.08)',
      border: '1px solid rgba(56, 189, 248, 0.22)',
      minHeight: '32px',
    });
    const aiChip = document.createElement('span');
    aiChip.textContent = 'AI';
    Object.assign(aiChip.style, {
      fontSize: '9px',
      fontWeight: '700',
      letterSpacing: '0.6px',
      color: '#04121a',
      background: '#38bdf8',
      borderRadius: '4px',
      padding: '1px 5px',
      flex: '0 0 auto',
    });
    const aiText = document.createElement('span');
    Object.assign(aiText.style, { fontSize: '10.5px', color: '#bae6fd', lineHeight: '1.35' });
    aiText.textContent = 'Scanning this page…';
    aiRow.append(aiChip, aiText);

    // Which signals produced that verdict, one row each. The verdict alone tells a user
    // what the model decided; this tells them what it saw, which is what decides whether
    // they trust it. Rebuilt in place on every hover — it holds no listeners, and the
    // buttons below are created once for exactly that reason.
    const aiEvidence = document.createElement('div');
    Object.assign(aiEvidence.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      marginTop: '-3px',
    });

    const aiButtonRow = document.createElement('div');
    Object.assign(aiButtonRow.style, { display: 'flex', gap: '6px' });
    const markAdButton = makeButton('This is an ad', 'ghost');
    const markContentButton = makeButton('Not an ad', 'ghost');
    aiButtonRow.append(markAdButton, markContentButton);

    const navigateRow = document.createElement('div');
    Object.assign(navigateRow.style, { display: 'flex', gap: '6px' });
    const widenButton = makeButton('↑ Parent', 'ghost');
    const narrowButton = makeButton('↓ Child', 'ghost');
    const similarButton = makeButton('≈ Similar', 'ghost');
    navigateRow.append(widenButton, narrowButton, similarButton);

    const actionRow = document.createElement('div');
    Object.assign(actionRow.style, { display: 'flex', gap: '6px' });
    const previewButton = makeButton('Preview', 'ghost');
    const blockButton = makeButton('Block element', 'primary');
    const cancelButton = makeButton('Esc ✕', 'ghost');
    cancelButton.style.flex = '0';
    actionRow.append(previewButton, blockButton, cancelButton);

    hud.append(title, aiRow, aiEvidence, selectorBox, aiButtonRow, navigateRow, actionRow);
    document.documentElement.appendChild(hud);

    markAdButton.addEventListener('click', () => void this.markCurrent('hide', { block: true }));
    markContentButton.addEventListener('click', () => void this.markCurrent('keep'));
    widenButton.addEventListener('click', () => this.widen());
    narrowButton.addEventListener('click', () => this.narrow());
    similarButton.addEventListener('click', () => this.commitSimilar());
    previewButton.addEventListener('click', () => this.togglePreview());
    blockButton.addEventListener('click', () => this.commitCurrent());
    cancelButton.addEventListener('click', () => this.stop());

    this.hudEl = hud;
    this.selectorTextEl = selectorText;
    this.metaTextEl = metaText;
    this.blockButton = blockButton;
    this.similarButton = similarButton;
    this.previewButton = previewButton;
    this.aiTextEl = aiText;
    this.aiEvidenceEl = aiEvidence;
  }

  private removeHud(): void {
    this.hudEl?.remove();
    this.hudEl = null;
    this.selectorTextEl = null;
    this.metaTextEl = null;
    this.aiTextEl = null;
    this.aiEvidenceEl = null;
    this.aiHintEl = null;
    this.blockButton = null;
    this.similarButton = null;
    this.previewButton = null;
  }

  /** Current selector for the highlighted element, verified against the DOM. */
  private currentResult(): { selector: string | null; matches: number; reason?: string } {
    if (!this.currentElement) return { selector: null, matches: 0 };
    return this.engine.generate(this.currentElement);
  }

  private refreshHud(): void {
    const { selector, matches, reason } = this.currentResult();
    const tag = this.currentElement ? this.currentElement.tagName.toLowerCase() : '';
    const rect = this.currentElement?.getBoundingClientRect();

    if (this.selectorTextEl) {
      this.selectorTextEl.textContent = selector ?? reason ?? 'Select an element…';
      this.selectorTextEl.style.color = selector ? '#38bdf8' : '#fbbf24';
    }

    if (this.metaTextEl) {
      const parts: string[] = [];
      if (tag) parts.push(`<${tag}>`);
      if (rect) parts.push(`${Math.round(rect.width)}×${Math.round(rect.height)}`);
      if (selector) parts.push(matches === 1 ? 'unique match' : `${matches} matches`);
      this.metaTextEl.textContent = parts.join(' · ');
    }

    if (this.aiTextEl) {
      if (this.currentPrediction) {
        const badge = elementAiBadge(this.currentPrediction);
        this.aiTextEl.textContent = `${badge.label} · ${badge.actionLabel} · ${badge.detail}`;
        this.aiTextEl.style.color = AI_TONE_COLOURS[badge.tone];
      } else {
        this.aiTextEl.textContent = this.scanner
          ? 'No AI verdict available for this element.'
          : 'AI disabled.';
        this.aiTextEl.style.color = '#94a3b8';
      }
    }

    this.refreshEvidence();

    if (this.aiHintEl && this.scanner) {
      this.aiHintEl.textContent = this.highlighted > 0 ? `${this.highlighted} outlined by AI` : 'Click to block';
    }

    // The full explanation, including everything the HUD had to shorten: the model's own
    // first reason and the signals it weighed, in the order it weighed them.
    if (this.hudEl && this.currentPrediction) {
      this.hudEl.title = [elementAiLine(this.currentPrediction), elementAiEvidenceLine(this.currentPrediction, 4)]
        .filter(Boolean)
        .join('\n');
    }

    const usable = Boolean(selector);
    if (this.blockButton) {
      this.blockButton.disabled = !usable;
      this.blockButton.style.opacity = usable ? '1' : '0.45';
      this.blockButton.style.cursor = usable ? 'pointer' : 'not-allowed';
      this.blockButton.textContent = usable ? 'Block element' : 'No safe selector';
    }
    if (this.previewButton) {
      this.previewButton.textContent = this.isPreviewing ? 'Show' : 'Preview';
    }
  }

  /**
   * Renders the signals behind the current verdict, one row each, strongest first.
   *
   * Rebuilds only this container's children: the HUD's buttons live outside it, which is
   * what keeps a mousemove from costing a listener a click.
   */
  private refreshEvidence(): void {
    const container = this.aiEvidenceEl;
    if (!container) return;

    const plain = (what: string): void => {
      if (container.childElementCount === 1 && container.firstElementChild?.textContent === what) return;
      const row = document.createElement('div');
      row.textContent = what;
      Object.assign(row.style, { fontSize: '10px', color: '#94a3b8' });
      container.replaceChildren(row);
    };

    if (!this.currentPrediction) {
      container.replaceChildren();
      return;
    }

    const rows = elementAiEvidenceRows(this.currentPrediction);
    if (rows.length === 0) {
      plain('No independent evidence — the model chose from context alone.');
      return;
    }

    const nodes = rows.map((row) => {
      const line = document.createElement('div');
      Object.assign(line.style, {
        fontSize: '10px',
        lineHeight: '1.4',
        display: 'flex',
        gap: '5px',
        alignItems: 'baseline',
      });

      const marker = document.createElement('span');
      marker.textContent = row.strength === 'definitive' ? '●' : row.strength === 'supporting' ? '○' : '·';
      Object.assign(marker.style, {
        flex: '0 0 auto',
        color: row.strength === 'definitive' ? '#fbbf24' : '#64748b',
        fontSize: row.strength === 'context' ? '11px' : '8px',
      });

      const text = document.createElement('span');
      text.textContent = row.detail ? `${row.label} ${row.detail}` : row.label;
      Object.assign(text.style, {
        color: row.strength === 'context' ? '#64748b' : row.strength === 'definitive' ? '#e2e8f0' : '#94a3b8',
        wordBreak: 'break-word',
      });

      line.append(marker, text);
      return line;
    });

    // The marker only needs explaining when both kinds are on screen.
    const mixed = rows.some((row) => row.strength === 'definitive') && rows.some((row) => row.strength === 'supporting');
    const legend = mixed ? '● acts alone   ○ needs a second signal' : '';
    if (legend) {
      const footnote = document.createElement('div');
      footnote.textContent = legend;
      Object.assign(footnote.style, { fontSize: '9px', color: '#64748b' });
      nodes.push(footnote);
    }

    container.replaceChildren(...nodes);
  }

  /** Puts a previewed element back, whichever one it was. */
  private restorePreview(): void {
    if (!this.isPreviewing) return;
    if (this.previewedElement) {
      // Only the display value is touched — assigning the whole style attribute
      // would wipe any other inline styles the page had set.
      this.previewedElement.style.display = this.previewedDisplay;
    }
    this.isPreviewing = false;
    this.previewedElement = null;
  }

  private highlight(el: Element | null): void {
    if (!el || el === this.currentElement) return;
    // Moving to another element must first un-hide the previewed one, otherwise
    // it would stay invisible for the rest of the session.
    this.restorePreview();
    this.currentElement = el;
    this.currentPrediction = this.scanner ? this.safeClassify(el) : null;

    const rect = el.getBoundingClientRect();
    if (this.overlayEl) {
      this.overlayEl.style.display = 'block';
      this.overlayEl.style.top = `${rect.top}px`;
      this.overlayEl.style.left = `${rect.left}px`;
      this.overlayEl.style.width = `${rect.width}px`;
      this.overlayEl.style.height = `${rect.height}px`;
    }
    this.refreshHud();
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  private widen(): void {
    const parent = this.currentElement?.parentElement;
    if (!parent || parent === document.documentElement) return;
    // Force the highlight to accept the new element.
    this.currentElement = null;
    this.highlight(parent);
  }

  private narrow(): void {
    if (!this.currentElement) return;
    const child = this.deepestChildAt(this.currentElement, this.lastPointer);
    if (!child || child === this.currentElement) return;
    this.currentElement = null;
    this.highlight(child);
  }

  /** The deepest descendant under the pointer, for ↓ / wheel selection. */
  private deepestChildAt(root: Element, point: { x: number; y: number }): Element | null {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || isOwnUi(hit)) return null;
    if (hit === root) return null;
    return root.contains(hit) ? hit : null;
  }

  // ─── Preview ────────────────────────────────────────────────────────────────

  private togglePreview(): void {
    const el = this.currentElement as HTMLElement | null;
    if (!el) return;

    if (this.isPreviewing) {
      this.restorePreview();
      if (this.overlayEl) this.overlayEl.style.display = 'block';
    } else {
      this.previewedDisplay = el.style.display;
      this.previewedElement = el;
      el.style.display = 'none';
      this.isPreviewing = true;
      if (this.overlayEl) this.overlayEl.style.display = 'none';
    }
    this.refreshHud();
  }

  // ─── Committing ─────────────────────────────────────────────────────────────

  private async commitCurrent(): Promise<void> {
    const element = this.currentElement;
    const prediction = this.currentPrediction;
    const { selector, matches } = this.currentResult();
    if (!selector) {
      this.refreshHud();
      return;
    }
    await this.applyRule(selector, matches, 'element');

    // Blocking something the model did not already consider definitive is the user
    // teaching it: record the decision so the same shape is caught next time, on this
    // site and any other.
    if (element && this.scanner && (!prediction || prediction.action !== 'hide')) {
      try {
        const classifier = this.scanner.getClassifier();
        await recordElementDecision(
          classifier,
          snapshotElement(element, { computed: false, ancestors: true }),
          'hide',
        );
      } catch (err) {
        console.warn('[Blockingmachine] Could not learn from this block:', err);
      }
    }
  }

  private async commitSimilar(): Promise<void> {
    const element = this.currentElement;
    if (!element) return;

    // Prefer the model's own cluster: the signature token names the *kind* of thing
    // the user just called an ad, which is more accurate than a structural selector
    // and is the same key user feedback is stored under.
    const aiSelector = this.aiGroupSelector(element);
    if (aiSelector) {
      const matches = countMatches(aiSelector);
      if (matches > 1 && validateCosmeticSelector(aiSelector, matches).ok) {
        await this.applyRule(aiSelector, matches, 'similar');
        return;
      }
    }

    const { selector, matches } = this.engine.generateSimilar(element);
    if (!selector) {
      showToast({ message: 'No "similar elements" selector could be built for this element.', tone: 'warn' });
      return;
    }
    await this.applyRule(selector, matches, 'similar');
  }

  /** The AI-derived selector for an element's cluster, when there is one. */
  private aiGroupSelector(element: Element): string | null {
    if (!this.scanner) return null;
    try {
      const prediction = this.safeClassify(element);
      if (!prediction) return null;
      // Pure shape evidence groups nothing: a 300×250 image is not a family.
      if (prediction.corroboration === 'model-only') return null;
      return this.scanner.selectorForGroup(element, prediction.signature.token);
    } catch {
      return null;
    }
  }

  /**
   * Persists a cosmetic rule, hides the element immediately, and offers Undo.
   * Used by the picker and by the right-click "block element" actions.
   */
  public async applyRule(
    selector: string,
    matches: number,
    mode: 'element' | 'similar',
  ): Promise<boolean> {
    const check = validateCosmeticSelector(selector, matches);
    if (!check.ok) {
      showToast({ message: `Selector rejected: ${check.reason}.`, tone: 'warn' });
      return false;
    }

    const element = this.currentElement as HTMLElement | null;

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_USER_COSMETICS);
      const existing: unknown = stored?.[STORAGE_KEY_USER_COSMETICS];
      const list: string[] = Array.isArray(existing)
        ? existing.filter((s): s is string => typeof s === 'string')
        : [];
      if (!list.includes(selector)) {
        list.push(selector);
        await chrome.storage.local.set({ [STORAGE_KEY_USER_COSMETICS]: list });
      }
    } catch (err) {
      console.warn('[Blockingmachine] Could not persist cosmetic rule:', err);
    }

    injectCosmeticStyles([selector]);

    if (element && mode === 'element') {
      this.hiddenElement = element;
      this.hiddenDisplay = element.style.display;
      element.style.display = 'none';
    }

    this.options.onBlocked?.({ selector, mode, matches });

    try {
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKED',
        payload: {
          selector,
          mode,
          matches,
          domain: currentHostname(),
        },
      });
    } catch {
      // The worker may be asleep; the rule is already persisted.
    }

    const count = matches === 1 ? '' : ` (${matches} elements)`;
    showToast({
      message: `Blocked ${selector}${count}`,
      tone: 'success',
      actions: [{ label: 'Undo', onClick: () => void this.undoLastRule(selector) }],
    });

    if (this.active) this.stop();
    return true;
  }

  /** Removes the most recently added rule and restores the element inline. */
  public async undoLastRule(selector?: string): Promise<boolean> {
    const target = selector ?? null;
    if (!target) return false;

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_USER_COSMETICS);
      const existing: unknown = stored?.[STORAGE_KEY_USER_COSMETICS];
      const list: string[] = Array.isArray(existing)
        ? existing.filter((s): s is string => typeof s === 'string')
        : [];
      const next = list.filter((s) => s !== target);
      await chrome.storage.local.set({ [STORAGE_KEY_USER_COSMETICS]: next });
    } catch (err) {
      console.warn('[Blockingmachine] Could not remove cosmetic rule:', err);
      return false;
    }

    if (this.hiddenElement) {
      (this.hiddenElement as HTMLElement).style.display = this.hiddenDisplay;
      this.hiddenElement = null;
    }

    // The page's stored-style listener re-injects from storage; force it too so
    // undo is immediate even if storage events are delayed.
    try {
      const res = await chrome.storage.local.get([STORAGE_KEY_USER_COSMETICS]);
      const remaining = res?.[STORAGE_KEY_USER_COSMETICS];
      if (Array.isArray(remaining)) {
        injectCosmeticStyles(remaining.filter((s): s is string => typeof s === 'string'));
      }
    } catch {
      // Best effort.
    }

    this.options.onUndone?.(target);
    try {
      chrome.runtime.sendMessage({ type: 'REMOVE_USER_COSMETIC', payload: { selector: target } });
    } catch {
      // Non-fatal.
    }
    showToast({ message: 'Undone — the element is visible again.', tone: 'info' });
    return true;
  }

  /**
   * Blocks a specific element without opening the picker. This is what the
   * right-click → "Block element" action calls.
   */
  public async blockElement(element: Element): Promise<boolean> {
    const { selector, matches, reason } = this.engine.generate(element);
    if (!selector) {
      showToast({ message: reason ?? 'No safe selector for that element.', tone: 'warn' });
      return false;
    }
    this.currentElement = element;
    const ok = await this.applyRule(selector, matches, 'element');
    this.currentElement = null;
    return ok;
  }

  /** Blocks every element matching this one's signature, AI cluster first. */
  public async blockSimilarTo(element: Element): Promise<boolean> {
    const aiSelector = this.aiGroupSelector(element);
    if (aiSelector) {
      const matches = countMatches(aiSelector);
      if (matches > 0 && validateCosmeticSelector(aiSelector, matches).ok) {
        this.currentElement = null;
        return this.applyRule(aiSelector, matches, 'similar');
      }
    }

    const { selector, matches, reason } = this.engine.generateSimilar(element);
    if (!selector) {
      showToast({ message: reason ?? 'No similar-element selector available.', tone: 'warn' });
      return false;
    }
    this.currentElement = null;
    return this.applyRule(selector, matches, 'similar');
  }

  /** Blocks one element and records the decision, for the context menu. */
  public async blockElementAsAd(element: Element): Promise<boolean> {
    const ok = await this.blockElement(element);
    if (ok) await this.markElement(element, 'hide');
    return ok;
  }

  /** Records "this is content" for an element, for the context menu. */
  public async keepElement(element: Element): Promise<boolean> {
    const ok = await this.markElement(element, 'keep');
    if (ok) showToast({ message: 'Marked as content — this kind of element stays visible.', tone: 'success' });
    return ok;
  }

  /** Selector for an element, for "copy selector" actions. */
  public selectorFor(element: Element): string | null {
    return this.engine.generate(element).selector;
  }

  // ─── AI integration ─────────────────────────────────────────────────────────

  /** Classifies an element without ever letting a model error break the picker. */
  private safeClassify(element: Element): ElementPrediction | null {
    if (!this.scanner) return null;
    try {
      return this.scanner.classifyElement(element);
    } catch {
      return null;
    }
  }

  /** The element AI's verdict for the current element, if one has been computed. */
  public currentVerdict(): ElementPrediction | null {
    return this.currentPrediction;
  }

  /**
   * Records the user's own judgement about the current element and persists it.
   *
   * This is the feedback loop that makes the model improve in place: `hide` teaches
   * it that this kind of element should go (and is the only evidence that can
   * promote a shape the model cannot name), `keep` vetoes it everywhere.
   */
  public async markElement(element: Element, action: 'hide' | 'keep', options: { block?: boolean } = {}): Promise<boolean> {
    if (!this.scanner) return false;
    try {
      const classifier = this.scanner.getClassifier();
      const snapshot = snapshotElement(element, { computed: false, ancestors: true });
      await recordElementDecision(classifier, snapshot, action);

      if (options.block) {
        const { selector, matches } = this.engine.generate(element);
        if (selector) await this.applyRule(selector, matches, 'element');
      }

      // The outline set is now stale: the decision changed what the model believes.
      this.highlighted = this.scanner.highlight(this.scanner.scan());
      this.currentPrediction = this.safeClassify(element);
      this.refreshHud();
      return true;
    } catch (err) {
      console.warn('[Blockingmachine] Could not record element feedback:', err);
      return false;
    }
  }

  private async markCurrent(action: 'hide' | 'keep', options: { block?: boolean } = {}): Promise<void> {
    const element = this.currentElement;
    if (!element || !this.scanner) return;
    const ok = await this.markElement(element, action, options);
    if (!ok) return;
    showToast({
      message:
        action === 'hide'
          ? 'Marked as an ad — this kind of element will now be hidden automatically.'
          : 'Marked as content — this kind of element will always be left visible.',
      tone: 'success',
    });
  }

  /** Blocks every cluster the element AI found, in one action. */
  public async blockAiGroups(groups: ElementAiGroup[]): Promise<{ blocked: number; selectors: string[] }> {
    const selectors: string[] = [];
    for (const group of groups) {
      const matches = countMatches(group.selector);
      if (validateCosmeticSelector(group.selector, matches).ok) selectors.push(group.selector);
    }
    if (selectors.length === 0) return { blocked: 0, selectors: [] };

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_USER_COSMETICS);
      const existing: unknown = stored?.[STORAGE_KEY_USER_COSMETICS];
      const list: string[] = Array.isArray(existing)
        ? existing.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const merged = Array.from(new Set([...list, ...selectors]));
      await chrome.storage.local.set({ [STORAGE_KEY_USER_COSMETICS]: merged });
    } catch (err) {
      console.warn('[Blockingmachine] Could not persist AI rules:', err);
    }

    injectCosmeticStyles(selectors);
    for (const selector of selectors) {
      try {
        chrome.runtime.sendMessage({
          type: 'ELEMENT_PICKED',
          payload: { selector, mode: 'similar', matches: countMatches(selector), domain: currentHostname() },
        });
      } catch {
        // The worker may be asleep; the rules are already persisted.
      }
    }

    this.scanner?.clearHighlights();
    showToast({
      message: `Blocked ${selectors.length} element group${selectors.length === 1 ? '' : 's'} found by the AI.`,
      tone: 'success',
      actions: [{ label: 'Undo', onClick: () => void this.undoRules(selectors) }],
    });
    if (this.active) this.stop();
    return { blocked: selectors.length, selectors };
  }

  /** Removes several rules at once, used by the AI block-all action. */
  public async undoRules(selectors: string[]): Promise<boolean> {
    let removed = true;
    for (const selector of selectors) {
      const ok = await this.undoLastRule(selector);
      if (!ok) removed = false;
    }
    return removed;
  }

  // ─── Listeners ──────────────────────────────────────────────────────────────

  /** Elements we must never pick, because they are our own UI. */
  private isPageTarget(target: EventTarget | null): target is Element {
    return target instanceof Element && !isOwnUi(target);
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.active) return;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    if (this.isPreviewing) return;
    if (!this.isPageTarget(event.target)) return;
    this.highlight(event.target);
  };

  /**
   * Click = block. The old implementation called preventDefault and stopped
   * there, which is exactly why clicking an element appeared to do nothing.
   */
  private handleClick = (event: MouseEvent): void => {
    if (!this.active) return;
    if (isOwnUi(event.target)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.shiftKey) {
      this.togglePreview();
      return;
    }

    if (this.isPageTarget(event.target)) {
      this.currentElement = null;
      this.highlight(event.target);
    }
    void this.commitCurrent();
  };

  /** Stop the page from reacting to the click sequence while picking. */
  private handleSuppress = (event: Event): void => {
    if (!this.active || isOwnUi(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (isOwnUi(event.target)) return;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopImmediatePropagation();
        this.stop();
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this.widen();
        break;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this.narrow();
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        void this.commitCurrent();
        break;
      case 'p':
      case 'P':
        event.preventDefault();
        event.stopPropagation();
        this.togglePreview();
        break;
      case 's':
      case 'S':
        event.preventDefault();
        event.stopPropagation();
        void this.commitSimilar();
        break;
      case 'a':
      case 'A':
        event.preventDefault();
        event.stopPropagation();
        void this.markCurrent('hide', { block: true });
        break;
      case 'n':
      case 'N':
        event.preventDefault();
        event.stopPropagation();
        void this.markCurrent('keep');
        break;
      default:
        break;
    }
  };

  /** Wheel up walks outward, wheel down walks inward. */
  private handleWheel = (event: WheelEvent): void => {
    if (!this.active || isOwnUi(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.deltaY < 0) this.widen();
    else this.narrow();
  };

  private attachListeners(): void {
    window.addEventListener('mousemove', this.handleMouseMove, true);
    window.addEventListener('click', this.handleClick, true);
    window.addEventListener('mousedown', this.handleSuppress, true);
    window.addEventListener('mouseup', this.handleSuppress, true);
    window.addEventListener('auxclick', this.handleSuppress, true);
    window.addEventListener('contextmenu', this.handleSuppress, true);
    window.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('wheel', this.handleWheel, { capture: true, passive: false });
  }

  private detachListeners(): void {
    window.removeEventListener('mousemove', this.handleMouseMove, true);
    window.removeEventListener('click', this.handleClick, true);
    window.removeEventListener('mousedown', this.handleSuppress, true);
    window.removeEventListener('mouseup', this.handleSuppress, true);
    window.removeEventListener('auxclick', this.handleSuppress, true);
    window.removeEventListener('contextmenu', this.handleSuppress, true);
    window.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('wheel', this.handleWheel, true);
  }

  /**
   * Legacy entry point kept for compatibility with the existing test suite:
   * the best verified-unique selector for an element, or an empty string.
   */
  public generateSelector(el: Element): string {
    return this.engine.generate(el).selector ?? '';
  }
}
