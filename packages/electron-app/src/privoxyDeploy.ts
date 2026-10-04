/**
 * Privoxy deployment helpers.
 *
 * Privoxy is a long-lived filtering proxy with a large install base, and it cannot read an AdGuard
 * or hosts list: it consumes a **section-based action file**, where every URL pattern belongs to the
 * `{+block{…}}` block above it. The format has been emitted and advertised for years with no deploy
 * target behind it — and, until it was fixed, with an artifact that could not have been deployed
 * either: the core formatter wrote one `{ +block { host } }` header per rule, a section with an empty
 * pattern list, which blocks nothing.
 *
 * Privoxy reads action files off its own filesystem: the `actionsfile` directive in `config` names a
 * *path* — and the file itself is only read at startup, since Privoxy has no reload signal. The
 * deployment is therefore a copy-and-restart recipe like the BIND one, and the helpers here build
 * the paths, commands and copy-pasteable steps as data rather than inline JSX, so the wording is
 * asserted in tests.
 *
 * One property of the format has to be explained rather than hidden: **the last matching action
 * wins**, the opposite of a Shadowrocket rule set, so a child bypass is emitted *after* the parent
 * block it escapes.
 */

/** Where a packaged install keeps `config` and its action files. */
export const PRIVOXY_CONF_DIR = '/etc/privoxy';

/**
 * The action-file name the deployment uses end to end.
 *
 * One name has to agree everywhere: it is what the feed serves, what the copy step saves the
 * fetched file as, and what the `actionsfile` line names — `actionsfile` resolves a bare name
 * against the config directory. When Privoxy is the configured export the compiled file *is* the
 * action file whatever it is named, so the real filename is used verbatim; otherwise no action
 * file exists yet and the conventional name is the placeholder next to a warning about the format.
 */
export function privoxyFeedFileName(exportFormat: string, savePath: string): string {
  const fileName = (savePath || '').split(/[/\\]/).pop() || '';
  if (exportFormat === 'privoxy' && fileName) return fileName;
  return 'privoxy.action';
}

/** The LAN address the compiled file is fetched from for the copy step. */
export function privoxyFeedUrl(lanUrl: string, exportFormat: string, savePath: string): string {
  const base = (lanUrl || '').replace(/\/+$/, '') || 'http://<your-computer-ip>:9191';
  return `${base}/${privoxyFeedFileName(exportFormat, savePath)}`;
}

/**
 * The Home Assistant add-on's address for the same action file.
 *
 * The add-on renders the action file from the published DNS feed itself rather than serving a
 * file the desktop compiled, so this URL answers whatever export format the desktop is set to —
 * and, being a long-lived service on the LAN, it answers while this machine is off. The fetch is
 * still just transport: Privoxy reads the file locally and nothing subscribes to anything.
 */
export function privoxyHomeAssistantUrl(port: number = 9191): string {
  return `http://homeassistant.local:${port}/privoxy.action`;
}

/** Why the fetched file cannot be a Privoxy action file yet, or null when it can. */
export function privoxyFormatWarning(exportFormat: string): string | null {
  if (exportFormat === 'privoxy') return null;
  return `The compiled export is currently "${exportFormat}". Set Format to Privoxy so the hub writes a {+block} action file instead of ${exportFormat} syntax.`;
}

/**
 * The `actionsfile` line to add to `config` — a file name, never a URL.
 *
 * `actionsfile` resolves its argument against the config directory, so a bare file name is the
 * complete directive. A feed address here is the deployment that reads as plausible and loads
 * nothing: Privoxy will not fetch it.
 */
export function privoxyActionsFileDirective(fileName: string): string {
  return `actionsfile ${fileName}`;
}

/** The copy step: pull the compiled file once from the hub onto the proxy host. */
export function privoxyFetchCommand(feedUrl: string, fileName: string): string {
  return `curl -fsSL "${feedUrl}" -o ${PRIVOXY_CONF_DIR}/${fileName}`;
}

/** Privoxy has no reload signal — a restart is how it picks up a changed action file. */
export function privoxyReloadCommand(): string {
  return 'sudo systemctl restart privoxy';
}

export interface PrivoxyRecipeStep {
  id: string;
  title: string;
  detail: string;
}

/**
 * The setup steps, in order.
 *
 * Privoxy consumes a local file, so the recipe mirrors the BIND one: compile, copy the artifact
 * into the config directory, point `config` at it, and restart — the reload is explicit because
 * replacing the file while Privoxy runs leaves the old rules in effect.
 */
export const PRIVOXY_STEPS: PrivoxyRecipeStep[] = [
  {
    id: 'compile',
    title: 'Compile the action file',
    detail:
      'Set Format to Privoxy so the hub writes a {+block} action file \u2014 an AdGuard or hosts export is not a format Privoxy can read. The saved file is what gets copied in the next step.',
  },
  {
    id: 'copy',
    title: 'Copy it onto the proxy host',
    detail:
      'Action files live beside `config` \u2014 `/etc/privoxy/` on a packaged Linux install, or `etc/privoxy` under the Homebrew prefix on macOS. The command below fetches the compiled file once from the hub\u2019s feed address; transferring the file any other way works the same.',
  },
  {
    id: 'addon',
    title: 'Or fetch it from the Home Assistant add-on',
    detail:
      'If Home Assistant is on the same LAN, the add-on renders this action file from the published DNS feed \u2014 sections, leading-dot patterns and bypass ordering included \u2014 and serves it while this desktop is off, whatever export format the desktop compiles. The command below saves it under the same name, so the rest of the recipe is unchanged.',
  },
  {
    id: 'actionsfile',
    title: 'Point Privoxy at the file',
    detail:
      'Add the actionsfile line below to `config`. It names a file \u2014 a bare name resolves inside the config directory \u2014 not a URL: a feed address in it is the deployment that reads as plausible and loads nothing.',
  },
  {
    id: 'reload',
    title: 'Restart Privoxy',
    detail:
      'Privoxy reads `config` and its action files at startup and has no reload signal, so replacing the file without restarting leaves the old rules running. On systemd hosts the command below is the restart; on a router package, restart the service from its UI.',
  },
  {
    id: 'ordering',
    title: 'Ordering is already handled',
    detail:
      'Privoxy applies the last matching action, so a child you allowed under a blocked parent is emitted in a {-block} section *after* the parent block rather than listed as an exception comment. The # EXCEPTION: lines are kept for audit only.',
  },
];

/**
 * The syntax note under the steps.
 *
 * The leading dot is not cosmetic: a bare host in an action file matches that host only, while
 * `.example.com` matches the domain and every subdomain of it — which is what a domain block means.
 */
export function privoxySyntaxNote(): string {
  return 'Host patterns are written with a leading dot — `.example.com` matches the domain and everything under it, while a bare `example.com` would match that host only. Privoxy applies the last matching action, which is why allow decisions come after the blocks they escape.';
}
