/**
 * The addresses a deploy pane shows the user, derived in one place.
 *
 * The Hub's header prints the LAN feed URL and several panes print it again — to paste into Pi-hole,
 * dnsmasq, an OpenWrt cron line — and a few panes print a sibling address: the `file://` URL, the
 * localhost URL, or the per-format feed a resolver-specific client subscribes to. When those lived
 * as expressions in the view, two panes showing the "same" URL were two expressions that had to be
 * kept in step by hand, and nothing would have said so if one of them drifted.
 *
 * So each address is a function here, called by the header and by every pane. They take the three
 * inputs the panes all share — the save path and the server's own status — and nothing else, so a
 * pane can be rendered with an object literal and still produce the real address.
 *
 * The fallbacks are the point of half of this: with no server running there is no LAN address to
 * show, and printing an empty box is worse than printing the address to type in once it is. The
 * placeholder keeps the shape of the URL obvious without pretending to be reachable.
 */

import type { FeedServerStatus } from '../types/';

/**
 * The file name the feed server will serve, taken from the compiled list's own path.
 *
 * The server publishes whatever file it was pointed at, so the URL a client subscribes to has to
 * end in that name. Falls back to the exporter's own default when there is no path yet, so the URL
 * shown before the user has chosen a save location is still the one that will work afterwards.
 */
export function resolveFileName(savePath: string): string {
  return savePath ? savePath.split(/[/\\]/).pop() || 'rules.txt' : 'rules.txt';
}

/** The `file://` URL for native clients that read the list off disk rather than over the network. */
export function resolveFileUrl(savePath: string): string {
  return savePath ? `file://${savePath}` : '';
}

/**
 * The LAN subscription URL, as a device on the same network would reach it.
 *
 * Prefers the address the running server reports, and otherwise prints a placeholder that has to be
 * filled in by hand. It is never an empty string: a client that is handed one refuses the
 * subscription outright, whereas one handed `http://<your-mac-ip>:9191/…` can be told what is wrong.
 */
export function resolveLanFeedUrl(serverStatus: FeedServerStatus | null, savePath: string): string {
  const fileName = resolveFileName(savePath);
  return serverStatus?.lanUrl
    ? `${serverStatus.lanUrl}/${fileName}`
    : `http://<your-mac-ip>:9191/${fileName}`;
}

/**
 * The loopback subscription URL, for a client running on this same machine.
 *
 * Separate from the LAN address because a device pointed at its own host may be reaching a
 * different machine: a phone told to subscribe to `localhost` is subscribing to itself.
 */
export function resolveLocalFeedUrl(serverStatus: FeedServerStatus | null, savePath: string): string {
  const fileName = resolveFileName(savePath);
  return serverStatus?.localUrl
    ? `${serverStatus.localUrl}/${fileName}`
    : `http://localhost:9191/${fileName}`;
}
