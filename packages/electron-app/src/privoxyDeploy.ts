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
 * The helpers here build the feed URL and the copy-pasteable steps, as data rather than inline JSX,
 * so the wording is asserted in tests.
 *
 * One property of the format has to be explained rather than hidden: **the last matching action
 * wins**, the opposite of a Shadowrocket rule set, so a child bypass is emitted *after* the parent
 * block it escapes.
 */

/**
 * The file the Privoxy feed should point at.
 *
 * When Privoxy is the configured export the compiled file *is* the action file whatever it is
 * named, so the real filename is served verbatim. Otherwise no action file exists and the
 * conventional name is shown as a placeholder next to a warning about the format.
 */
export function privoxyFeedFileName(exportFormat: string, savePath: string): string {
  const fileName = (savePath || '').split(/[/\\]/).pop() || '';
  if (exportFormat === 'privoxy' && fileName) return fileName;
  return 'privoxy.action';
}

/** The LAN feed URL for the Privoxy export. */
export function privoxyFeedUrl(lanUrl: string, exportFormat: string, savePath: string): string {
  const base = (lanUrl || '').replace(/\/+$/, '') || 'http://<your-computer-ip>:9191';
  return `${base}/${privoxyFeedFileName(exportFormat, savePath)}`;
}

/** Why the feed URL below cannot work yet, or null when it can. */
export function privoxyFormatWarning(exportFormat: string): string | null {
  if (exportFormat === 'privoxy') return null;
  return `The compiled export is currently "${exportFormat}". Set Format to Privoxy so the hub writes a {+block} action file instead of ${exportFormat} syntax.`;
}

/** The `actionsfile` line to add to `config`, with the feed URL already substituted. */
export function privoxyActionsFileDirective(feedUrl: string): string {
  return `actionsfile ${feedUrl}`;
}

export interface PrivoxyRecipeStep {
  id: string;
  title: string;
  detail: string;
}

/**
 * The setup steps, in order.
 *
 * Privoxy fetches a remote actions file itself, so unlike the Unbound drop-in there is no
 * server-side refresh command to write: the proxy is the client. The interval is Privoxy's own
 * business, so the wording does not promise one.
 */
export const PRIVOXY_STEPS: PrivoxyRecipeStep[] = [
  {
    id: 'feed',
    title: 'Serve the action file',
    detail:
      'Turn the LAN feed server on above and leave Auto-start on, so the address below answers after a restart. The feed serves the compiled file at the path shown, so the format has to be Privoxy for it to contain an action file.',
  },
  {
    id: 'actionsfile',
    title: 'Point Privoxy at it',
    detail:
      'Add the actionsfile line below to Privoxy\u2019s config. Privoxy fetches a remote actions file itself and re-reads it on its own schedule, so nothing has to run on the proxy host and no cron job is needed.',
  },
  {
    id: 'reload',
    title: 'Restart or re-read the config',
    detail:
      'The actionsfile line is read at startup, so restart Privoxy once after adding it \u2014 after that the file itself is re-fetched without a restart. On a router package that is usually a service restart from its web UI.',
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
