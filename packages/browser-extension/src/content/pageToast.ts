/**
 * In-page notifications.
 *
 * Actions started from the toolbar or the right-click menu happen outside the
 * page, so the page itself has to confirm what happened — otherwise a right-click
 * "Block element" looks like it did nothing at all.
 */

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: 'info' | 'success' | 'warn';
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
  durationMs?: number;
  actions?: ToastAction[];
}

const UI_ATTRIBUTE = 'data-bm-ui';
const TOAST_ID = 'bm-page-toast';
const TONE_STYLES: Record<string, { accent: string; icon: string }> = {
  info: { accent: '#38bdf8', icon: '🛡️' },
  success: { accent: '#34d399', icon: '✅' },
  warn: { accent: '#fbbf24', icon: '⚠️' },
};

export const BM_UI_ATTRIBUTE = UI_ATTRIBUTE;

/** True when a node belongs to our own injected UI rather than the page. */
export function isOwnUi(node: unknown): boolean {
  if (typeof Element === 'undefined' || !(node instanceof Element)) return false;
  return node.hasAttribute(UI_ATTRIBUTE) || node.closest(`[${UI_ATTRIBUTE}]`) !== null;
}

/**
 * Removes the current toast, if there is one.
 *
 * Defensive about the environment on purpose: this runs from a `setTimeout` and from
 * click handlers, so it can fire after the frame it belonged to has been torn down.
 * A bare `document` reference there throws inside a timer, which is an unhandled
 * error the page never sees and the extension cannot recover from.
 */
export function dismissToast(): void {
  if (typeof document === 'undefined' || !document.getElementById) return;
  try {
    document.getElementById(TOAST_ID)?.remove();
  } catch {
    // The document is gone; there is nothing left to dismiss.
  }
}

export function showToast(options: ToastOptions): HTMLElement | null {
  if (typeof document === 'undefined' || !document.documentElement) return null;

  dismissToast();

  const tone = TONE_STYLES[options.tone ?? 'info'] ?? TONE_STYLES.info;
  const container = document.createElement('div');
  container.id = TOAST_ID;
  container.setAttribute(UI_ATTRIBUTE, 'toast');
  Object.assign(container.style, {
    position: 'fixed',
    zIndex: '2147483647',
    left: '50%',
    bottom: '28px',
    transform: 'translateX(-50%) translateY(8px)',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    maxWidth: 'min(560px, calc(100vw - 32px))',
    padding: '10px 14px',
    borderRadius: '10px',
    background: 'rgba(15, 23, 42, 0.96)',
    color: '#f8fafc',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '12.5px',
    lineHeight: '1.35',
    boxShadow: '0 12px 30px -8px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.09)',
    borderLeft: `3px solid ${tone.accent}`,
    opacity: '0',
    transition: 'opacity 0.16s ease, transform 0.16s ease',
    pointerEvents: 'auto',
  });

  const icon = document.createElement('span');
  icon.textContent = tone.icon;
  icon.style.flexShrink = '0';
  container.appendChild(icon);

  const text = document.createElement('span');
  text.textContent = options.message;
  text.style.flex = '1';
  text.style.minWidth = '0';
  container.appendChild(text);

  for (const action of options.actions ?? []) {
    const button = document.createElement('button');
    button.textContent = action.label;
    Object.assign(button.style, {
      flexShrink: '0',
      padding: '4px 10px',
      borderRadius: '6px',
      border: `1px solid ${tone.accent}`,
      background: 'transparent',
      color: tone.accent,
      font: 'inherit',
      fontWeight: '600',
      cursor: 'pointer',
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissToast();
      action.onClick();
    });
    container.appendChild(button);
  }

  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  Object.assign(close.style, {
    flexShrink: '0',
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    font: 'inherit',
    cursor: 'pointer',
    padding: '0 2px',
  });
  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissToast();
  });
  container.appendChild(close);

  document.documentElement.appendChild(container);

  // Next frame, so the entry transition actually runs. Guarded because the frame can
  // be detached before the callback lands.
  const reveal = (): void => {
    try {
      container.style.opacity = '1';
      container.style.transform = 'translateX(-50%) translateY(0)';
    } catch {
      // Detached element: the toast is already gone.
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  else reveal();

  const duration = options.durationMs ?? (options.actions?.length ? 6000 : 3200);
  if (duration > 0) {
    // Only this toast dismisses itself: a newer toast may have replaced it by then.
    setTimeout(() => {
      if (container.isConnected) dismissToast();
    }, duration);
  }

  return container;
}
