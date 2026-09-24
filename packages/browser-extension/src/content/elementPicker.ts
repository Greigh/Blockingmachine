import { STORAGE_KEY_USER_COSMETICS } from '../shared/constants.js';
import { injectCosmeticStyles } from './cosmeticHider.js';

export class ElementPicker {
  private active = false;
  private currentElement: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private hudEl: HTMLElement | null = null;
  private isPreviewing = false;
  private originalDisplay = '';

  public start(): void {
    if (this.active) return;
    this.active = true;

    this.createOverlay();
    this.createHud();
    this.attachListeners();

    document.body.style.cursor = 'crosshair';
    console.log('[Blockingmachine] Visual element picker active.');
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;

    this.detachListeners();
    this.removeOverlay();
    this.removeHud();

    if (this.isPreviewing && this.currentElement) {
      this.currentElement.style.display = this.originalDisplay;
      this.isPreviewing = false;
    }

    document.body.style.cursor = '';
    console.log('[Blockingmachine] Visual element picker closed.');
  }

  public isActive(): boolean {
    return this.active;
  }

  private createOverlay(): void {
    if (this.overlayEl) return;

    this.overlayEl = document.createElement('div');
    this.overlayEl.id = 'bm-picker-overlay';
    Object.assign(this.overlayEl.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483646',
      border: '2px solid #06b6d4',
      backgroundColor: 'rgba(6, 182, 212, 0.15)',
      boxShadow: '0 0 12px rgba(6, 182, 212, 0.4)',
      borderRadius: '4px',
      transition: 'top 0.06s ease, left 0.06s ease, width 0.06s ease, height 0.06s ease',
      display: 'none',
    });

    document.documentElement.appendChild(this.overlayEl);
  }

  private removeOverlay(): void {
    if (this.overlayEl && this.overlayEl.parentNode) {
      this.overlayEl.parentNode.removeChild(this.overlayEl);
      this.overlayEl = null;
    }
  }

  private createHud(): void {
    if (this.hudEl) return;

    this.hudEl = document.createElement('div');
    this.hudEl.id = 'bm-picker-hud';
    Object.assign(this.hudEl.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '2147483647',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12px',
      padding: '14px 16px',
      borderRadius: '10px',
      boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1)',
      maxWidth: '360px',
      minWidth: '280px',
      backdropFilter: 'blur(12px)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });

    this.updateHudContent('Hover over an element to inspect...');
    document.documentElement.appendChild(this.hudEl);
  }

  private removeHud(): void {
    if (this.hudEl && this.hudEl.parentNode) {
      this.hudEl.parentNode.removeChild(this.hudEl);
      this.hudEl = null;
    }
  }

  private updateHudContent(selector: string, dimensions?: { width: number; height: number }): void {
    if (!this.hudEl) return;

    const dimStr = dimensions ? ` (${Math.round(dimensions.width)}×${Math.round(dimensions.height)})` : '';

    this.hudEl.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 13px;">
        <span style="display: flex; align-items: center; gap: 6px;">
          <span style="color: #06b6d4;">🎯</span> Element Picker
        </span>
        <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">ESC to cancel</span>
      </div>
      <div style="background: rgba(0, 0, 0, 0.4); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
        <div style="font-size: 10px; color: #94a3b8; margin-bottom: 2px;">CSS Selector${dimStr}:</div>
        <code style="color: #38bdf8; word-break: break-all; font-family: monospace; font-size: 11px;">${this.escapeHtml(selector)}</code>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 4px;">
        <button id="bm-btn-preview" style="flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: #e2e8f0; font-size: 11px; cursor: pointer; font-weight: 500;">
          ${this.isPreviewing ? 'Show Element' : 'Preview'}
        </button>
        <button id="bm-btn-block" style="flex: 1; padding: 6px 10px; border-radius: 6px; border: none; background: #06b6d4; color: #000; font-size: 11px; cursor: pointer; font-weight: 600;">
          Block Element
        </button>
        <button id="bm-btn-cancel" style="padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #94a3b8; font-size: 11px; cursor: pointer;">
          ✕
        </button>
      </div>
    `;

    const btnPreview = this.hudEl.querySelector('#bm-btn-preview');
    const btnBlock = this.hudEl.querySelector('#bm-btn-block');
    const btnCancel = this.hudEl.querySelector('#bm-btn-cancel');

    if (btnPreview) {
      btnPreview.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePreview();
      });
    }
    if (btnBlock) {
      btnBlock.addEventListener('click', (e) => {
        e.stopPropagation();
        this.confirmBlock(selector);
      });
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        this.stop();
      });
    }
  }

  private togglePreview(): void {
    if (!this.currentElement) return;

    if (this.isPreviewing) {
      this.currentElement.style.display = this.originalDisplay;
      this.isPreviewing = false;
      if (this.overlayEl) this.overlayEl.style.display = 'block';
    } else {
      this.originalDisplay = this.currentElement.style.display;
      this.currentElement.style.display = 'none';
      this.isPreviewing = true;
      if (this.overlayEl) this.overlayEl.style.display = 'none';
    }

    if (this.currentElement) {
      const sel = this.generateSelector(this.currentElement);
      this.updateHudContent(sel);
    }
  }

  private async confirmBlock(selector: string): Promise<void> {
    if (!selector || selector.startsWith('Hover')) return;

    try {
      let userSelectors: string[] = [];
      if (chrome.storage?.local) {
        const res = await chrome.storage.local.get(STORAGE_KEY_USER_COSMETICS);
        if (Array.isArray(res[STORAGE_KEY_USER_COSMETICS])) {
          userSelectors = res[STORAGE_KEY_USER_COSMETICS];
        }
        if (!userSelectors.includes(selector)) {
          userSelectors.push(selector);
          await chrome.storage.local.set({ [STORAGE_KEY_USER_COSMETICS]: userSelectors });
        }
      }

      // Immediately hide the element on page
      injectCosmeticStyles([selector]);

      // Inform background worker
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKED',
        payload: {
          selector,
          domain: window.location.hostname,
        },
      });

      console.log(`[Blockingmachine] Cosmetic rule saved: ${selector}`);
    } catch (err) {
      console.warn('[Blockingmachine] Failed to save cosmetic rule:', err);
    }

    this.stop();
  }

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.active || this.isPreviewing) return;

    const target = e.target as HTMLElement | null;
    if (!target || target === this.overlayEl || target.closest('#bm-picker-hud')) return;

    if (target === this.currentElement) return;
    this.currentElement = target;

    const rect = target.getBoundingClientRect();
    if (this.overlayEl) {
      this.overlayEl.style.display = 'block';
      this.overlayEl.style.top = `${rect.top}px`;
      this.overlayEl.style.left = `${rect.left}px`;
      this.overlayEl.style.width = `${rect.width}px`;
      this.overlayEl.style.height = `${rect.height}px`;
    }

    const selector = this.generateSelector(target);
    this.updateHudContent(selector, { width: rect.width, height: rect.height });
  };

  private handleClick = (e: MouseEvent): void => {
    if (!this.active) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('#bm-picker-hud')) return;

    e.preventDefault();
    e.stopPropagation();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.stop();
    } else if (e.key === 'Tab' && this.currentElement) {
      // Navigate to parent element
      e.preventDefault();
      const parent = this.currentElement.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        this.currentElement = parent;
        const rect = parent.getBoundingClientRect();
        if (this.overlayEl) {
          this.overlayEl.style.top = `${rect.top}px`;
          this.overlayEl.style.left = `${rect.left}px`;
          this.overlayEl.style.width = `${rect.width}px`;
          this.overlayEl.style.height = `${rect.height}px`;
        }
        const selector = this.generateSelector(parent);
        this.updateHudContent(selector, { width: rect.width, height: rect.height });
      }
    }
  };

  private attachListeners(): void {
    window.addEventListener('mousemove', this.handleMouseMove, true);
    window.addEventListener('click', this.handleClick, true);
    window.addEventListener('keydown', this.handleKeyDown, true);
  }

  private detachListeners(): void {
    window.removeEventListener('mousemove', this.handleMouseMove, true);
    window.removeEventListener('click', this.handleClick, true);
    window.removeEventListener('keydown', this.handleKeyDown, true);
  }

  /**
   * Generates a concise, robust, and unique CSS selector for an element.
   */
  public generateSelector(el: HTMLElement): string {
    const tagName = el.tagName.toLowerCase();

    // 1. Try unique ID if it doesn't look randomly generated
    if (el.id && typeof el.id === 'string') {
      const isDynamic = /[0-9a-f]{8,}/i.test(el.id) || /^[0-9]+$/.test(el.id);
      if (!isDynamic) {
        const idSelector = `#${CSS.escape(el.id)}`;
        if (this.isUnique(idSelector)) return idSelector;
      }
    }

    // 2. Try distinctive data attributes
    const targetAttrs = ['data-testid', 'data-ad-unit', 'data-slot', 'data-ad-client', 'aria-label'];
    for (const attr of targetAttrs) {
      const val = el.getAttribute(attr);
      if (val && val.length < 50) {
        const attrSelector = `${tagName}[${attr}="${CSS.escape(val)}"]`;
        if (this.isUnique(attrSelector)) return attrSelector;
      }
    }

    // 3. Try semantic classes
    if (el.classList.length > 0) {
      const filteredClasses = Array.from(el.classList).filter(
        (c) =>
          !c.startsWith('bm-') &&
          c.length > 2 &&
          !/[0-9a-f]{8,}/i.test(c) &&
          !['flex', 'block', 'hidden', 'relative', 'absolute'].includes(c)
      );

      if (filteredClasses.length > 0) {
        // Try single class
        for (const c of filteredClasses) {
          const classSelector = `.${CSS.escape(c)}`;
          if (this.isUnique(classSelector)) return classSelector;
        }

        // Try compound class
        const compound = `${tagName}.${filteredClasses.map((c) => CSS.escape(c)).slice(0, 2).join('.')}`;
        if (this.isUnique(compound)) return compound;
      }
    }

    // 4. Fallback to parent path
    const parent = el.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      const parentTag = parent.tagName.toLowerCase();
      const parentId = parent.id && !/[0-9a-f]{8,}/i.test(parent.id) ? `#${CSS.escape(parent.id)}` : parentTag;
      const index = Array.from(parent.children).indexOf(el) + 1;
      const nthSelector = `${parentId} > ${tagName}:nth-child(${index})`;
      if (this.isUnique(nthSelector)) return nthSelector;
    }

    return tagName;
  }

  private isUnique(selector: string): boolean {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
