/**
 * The app's admin-consent surface: run a shell command as administrator via
 * `osascript "do shell script … with administrator privileges"` — the repo's
 * established convention for operations that need macOS authorization (the
 * Task 3 capture installer is invoked the same way). The macOS auth sheet
 * osascript raises IS the consent UI; the renderer's button click is what
 * asks for it.
 *
 * Kept as its own module so the IPC tests can substitute the seam without
 * mocking node:child_process (which `requireActual` in sibling mocks cannot
 * reload once patched).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AdminShellResult {
  success: boolean;
  /** The user dismissed the authorization sheet (osascript's -128). */
  cancelled: boolean;
  /** stderr text on failure — sanitized by the caller, never trusted raw. */
  stderr: string;
}

/**
 * `shellCmd` is one POSIX command line — the caller owns quoting (it is an
 * AppleScript string payload, then a shell line). osascript gets a generous
 * timeout: the auth sheet waits on a human, not on the command.
 */
export async function runShellAsAdmin(
  shellCmd: string,
  timeoutMs = 180_000,
): Promise<AdminShellResult> {
  // Escape for the double-quoted AppleScript string context.
  const escaped = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `do shell script "${escaped}" with administrator privileges`;
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs });
    return { success: true, cancelled: false, stderr: '' };
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.message || err);
    return {
      success: false,
      cancelled: /user canceled|-128/i.test(stderr),
      stderr: stderr.slice(0, 300),
    };
  }
}
