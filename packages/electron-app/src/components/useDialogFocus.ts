import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus management shared by every `role="dialog"` surface: on open, focus the
 * first interactive element inside the dialog; while open, Tab/Shift-Tab cycle strictly
 * within it; Escape closes; on close, focus returns to whatever had it before open.
 * Matches the OnboardingModal pattern — a dialog that `aria-modal`s the page must not
 * leave focus stranded behind it.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusTimer = setTimeout(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      firstFocusable?.focus();
    }, 40);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;

      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (
          document.activeElement === firstEl ||
          !dialogRef.current.contains(document.activeElement)
        ) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (
        document.activeElement === lastEl ||
        !dialogRef.current.contains(document.activeElement)
      ) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [dialogRef, isOpen, onClose]);
}
