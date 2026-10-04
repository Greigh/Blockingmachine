/**
 * Every "Copy" affordance routes through here. The renderer's `navigator.clipboard.writeText`
 * answers to the DOM permission model — in Electron it can refuse with `NotAllowedError` (window
 * unfocused, permission not granted), and a bare call turns that refusal into an unhandled
 * rejection the dev overlay turns into a crash screen. The preload's `copyToClipboard` goes to
 * Electron's `clipboard` module or the `copy-to-clipboard` IPC handler instead, which has no
 * permission gate on the desktop. The DOM path stays as a fallback for contexts where the bridge
 * is absent (tests), and the boolean result keeps "Copied!" indicators honest — a refused write
 * must not claim success.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const bridge = (
    globalThis as { window?: { electron?: { copyToClipboard?: (t: string) => unknown } } }
  ).window?.electron?.copyToClipboard;
  if (bridge) {
    try {
      const result = await bridge(text);
      if (result && typeof result === 'object' && 'success' in result) {
        return (result as { success?: boolean }).success !== false;
      }
      return true;
    } catch {
      // The bridge refused or never resolved — try the DOM path before giving up.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
