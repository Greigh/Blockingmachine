/**
 * Shadowrocket deployment helpers.
 *
 * Shadowrocket is an iOS/iPadOS (and Apple-silicon Mac) proxy client with a large user base, and it
 * cannot read an AdGuard or hosts list: it consumes a Surge-style rule set — `DOMAIN-SUFFIX,host,REJECT`
 * lines under a `[Rule]` section. The export format has existed for a long time and was advertised
 * as deployable with no target and no recipe behind it, so these helpers build the feed URL and the
 * copy-pasteable steps the Deploy Hub shows, and the exact text is asserted in tests rather than
 * assembled inline in JSX.
 *
 * The same rule set is valid in Surge and in Clash-style clients, because the syntax is Surge's.
 */

/**
 * The file the Shadowrocket feed should point at.
 *
 * When Shadowrocket is the configured export, the compiled file *is* the rule set whatever it is
 * named, so the real filename is used and the hub serves it verbatim. Otherwise no `[Rule]` file
 * exists at all, and the conventional name is shown as a placeholder next to a warning telling the
 * user to switch the format.
 */
export function shadowrocketFeedFileName(exportFormat: string, savePath: string): string {
  const fileName = (savePath || '').split(/[/\\]/).pop() || '';
  if (exportFormat === 'shadowrocket' && fileName) return fileName;
  return 'shadowrocket.conf';
}

/** The LAN feed URL for the Shadowrocket export. */
export function shadowrocketFeedUrl(lanUrl: string, exportFormat: string, savePath: string): string {
  const base = (lanUrl || '').replace(/\/+$/, '') || 'http://<your-computer-ip>:9191';
  return `${base}/${shadowrocketFeedFileName(exportFormat, savePath)}`;
}

/**
 * Why the feed URL below cannot work yet, or null when it can.
 *
 * Showing a live-looking URL for a file that is never written would be a lie, so the pane surfaces
 * this instead of leaving the user to discover an empty feed.
 */
export function shadowrocketFormatWarning(exportFormat: string): string | null {
  if (exportFormat === 'shadowrocket') return null;
  return `The compiled export is currently "${exportFormat}". Set Format to Shadowrocket so the hub writes DOMAIN-SUFFIX rules instead of ${exportFormat} syntax.`;
}

/**
 * The LAN feed URL for the Home Assistant add-on's rule set.
 *
 * The add-on runs as a long-lived service on the same LAN, so a phone can subscribe to it rather
 * than to the desktop hub — which only answers while that process is running and the machine is
 * awake. The add-on serves the same rule set from the same DNS feed the Unbound drop-in is rendered
 * from, so a host sinkholed in the resolver is the host the phone blocks.
 */
export function shadowrocketHomeAssistantUrl(port: number = 9191): string {
  return `http://homeassistant.local:${port}/shadowrocket.conf`;
}

export interface ShadowrocketRecipeStep {
  id: string;
  title: string;
  detail: string;
}

/**
 * The setup steps, in order.
 *
 * Kept as data rather than JSX so the wording is testable, and worded for what the app actually
 * does: Shadowrocket re-fetches a remote config when it opens (and on a background interval when
 * iOS Background App Refresh is allowed for it), so unlike the Unbound drop-in there is no
 * server-side refresh command to write — the phone is the client.
 */
export const SHADOWROCKET_STEPS: ShadowrocketRecipeStep[] = [
  {
    id: 'feed',
    title: 'Serve the rule set',
    detail:
      'Turn the LAN feed server on above and leave Auto-start on, so the address below answers after a restart. The feed serves the compiled file at the path shown, so the format has to be Shadowrocket for it to contain any rules.',
  },
  {
    id: 'addon',
    title: 'Or serve it from the Home Assistant add-on instead',
    detail:
      'If Home Assistant is on the same LAN, the add-on serves this rule set too, from a path it never stops listening on. A phone subscribed to the add-on keeps working when this desktop is shut down, which is the usual reason a rule set stops arriving. The rule set is the same shape and the same allow decisions; its count is lower than the export above, because the add-on renders from the DNS feed and drops the rules a rule set cannot express.',
  },
  {
    id: 'subscribe',
    title: 'Add it in Shadowrocket',
    detail:
      'In Shadowrocket open Config → Add Remote Config, choose Rule Set, and paste the feed URL. The app re-fetches it each time it opens — and in the background if iOS is allowed to refresh it — so nothing has to run on the phone and no cron job is needed.',
  },
  {
    id: 'network',
    title: 'Keep the phone on the same network',
    detail:
      'The URL is a LAN address, so the device must be on the same Wi-Fi. For use away from home, publish the file behind HTTPS and point Shadowrocket at that address instead.',
  },
  {
    id: 'exceptions',
    title: 'Allow decisions are already in the list',
    detail:
      'Domains you allowed are omitted from the rule set rather than listed as exceptions, so the feed the app fetches already respects them. The `# EXCEPTION:` lines are comments kept for audit, not rules.',
  },
];

/**
 * The syntax note under the steps.
 *
 * `DOMAIN-SUFFIX` is what a domain block means in a Surge-style rule set, and saying why matters:
 * the older `DOMAIN,` form matches the exact host only, so every subdomain of a blocked domain
 * would be missed.
 */
export function shadowrocketSyntaxNote(): string {
  return 'Rules use DOMAIN-SUFFIX, which matches a domain and everything under it — the same rule set loads in Surge and Clash-style clients, since the syntax is Surge\u2019s.';
}
