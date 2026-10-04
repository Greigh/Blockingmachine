/**
 * Unbound deployment helpers.
 *
 * Unbound is the resolver behind OPNsense, pfSense, and most Linux `unbound` installs. Unlike
 * AdGuard Home and Pi-hole it cannot subscribe to an ABP or hosts feed: it wants `local-zone`
 * statements, served from a drop-in file that `unbound.conf` includes.
 *
 * These helpers build the feed URL and the copy-pasteable configuration the Deploy Hub shows, so
 * the exact text a user is told to paste is asserted in tests rather than assembled inline in JSX.
 */

import { isLoopbackResolvHost } from './unboundAddress';

/**
 * The file the Unbound feed should point at.
 *
 * When Unbound is the configured export, the compiled file *is* the Unbound feed whatever it is
 * named, so the real filename is used and the hub serves it verbatim. Otherwise no `local-zone`
 * file exists at all, and the conventional name is shown as a placeholder next to a warning
 * telling the user to switch the format.
 */
export function unboundFeedFileName(exportFormat: string, savePath: string): string {
  const fileName = (savePath || '').split(/[/\\]/).pop() || '';
  if (exportFormat === 'unbound' && fileName) return fileName;
  return 'unbound.conf';
}

/** The LAN feed URL for the Unbound export. */
export function unboundFeedUrl(lanUrl: string, exportFormat: string, savePath: string): string {
  const base = (lanUrl || '').replace(/\/+$/, '') || 'http://<your-computer-ip>:9191';
  return `${base}/${unboundFeedFileName(exportFormat, savePath)}`;
}

export interface UnboundTarget {
  id: string;
  name: string;
  /** Where this flavour keeps drop-in configuration. */
  configPath: string;
  /** The command that re-reads the drop-in file. */
  reloadCommand: string;
  /**
   * Where the `include:` line belongs on this flavour — the file that actually survives a
   * config regeneration, not literally `unbound.conf`, which two of these rebuild from scratch.
   */
  includePlacement: string;
}

/** The Unbound flavours the Deploy Hub writes recipes for. */
export const UNBOUND_TARGETS: UnboundTarget[] = [
  {
    id: 'bsd',
    name: 'OPNsense / pfSense',
    configPath: '/var/unbound/blockingmachine.conf',
    reloadCommand: 'configctl unbound restart',
    // OPNsense regenerates unbound.conf from templates, so hand edits do not survive; its own
    // drop-in directory is auto-included instead. On pfSense the equivalent is the DNS
    // Resolver's Custom Options box.
    includePlacement:
      'put the include line in a `/usr/local/etc/unbound.opnsense.d/blockingmachine.conf` drop-in \u2014 the generated `unbound.conf` auto-includes it, and hand edits to that file do not survive (on pfSense, the DNS Resolver\u2019s Custom options box)',
  },
  {
    id: 'linux',
    name: 'Debian, Ubuntu, Raspberry Pi OS',
    configPath: '/etc/unbound/unbound.conf.d/blockingmachine.conf',
    reloadCommand: 'sudo unbound-control reload',
    // Debian's shipped unbound.conf ends in include-toplevel for this directory — the drop-in
    // is loaded without any edit, and a manual include would parse the file twice.
    includePlacement:
      'no include line is needed \u2014 the shipped `unbound.conf` already picks up `unbound.conf.d/*.conf` via `include-toplevel`, and adding one by hand would load the file twice',
  },
  {
    id: 'openwrt',
    name: 'OpenWrt (unbound)',
    configPath: '/etc/unbound/blockingmachine.conf',
    reloadCommand: '/etc/init.d/unbound reload',
    // OpenWrt generates /var/lib/unbound/unbound.conf from UCI; unbound_ext.conf is the file it
    // appends an include for at the end of the generated config — the place user clauses live.
    includePlacement:
      'put the include line in `/etc/unbound/unbound_ext.conf` \u2014 UCI rebuilds `unbound.conf`, and this is the file it includes at the end of what it generates',
  },
];

/** The `include:` line that pulls the drop-in file into `unbound.conf`. */
export function unboundIncludeDirective(configPath: string): string {
  return `include: "${configPath}"`;
}

/**
 * The one-liner that refreshes the drop-in file from the hub and makes Unbound re-read it.
 *
 * A plain `curl` like this is what Unbound users actually run: the resolver has no remote-list
 * feature, so the scheduled fetch *is* the subscription.
 *
 * `report` appends the report-back tail: the command POSTs `ok`/`fail` to the hub after the
 * reload, so a fetch that broke overnight is a recorded fact on the next launch rather than an
 * absence the reachability card has to read around. Two details keep the report honest:
 * the reporting curls are best-effort with a 5-second cap so a dead hub cannot stall the cron
 * job, and the ok-report is swallowed (`|| true`) so its own failure cannot cascade into a
 * `fail` report for a fetch that worked — `ok=0` only ever means the fetch or the reload failed.
 */
/**
 * One shell argument, single-quoted — the only quoting that cannot be broken from inside.
 *
 * Every value pasted into the command is quoted this way, the feed token most of all: inside
 * double quotes `$(…)`, backticks and `$VAR` still evaluate, so a token copied from a hostile
 * config would otherwise arrive at the user's shell as code rather than a string.
 */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function unboundFetchCommand(
  feedUrl: string,
  configPath: string,
  report?: { url: string; token?: string | null },
): string {
  // The fetch lands in a temp file and moves over the live drop-in only on success — a curl
  // that dies mid-body must not leave a truncated zone file for unbound to load.
  const tmp = `${configPath}.tmp`;
  const base =
    `curl -fsSL ${sq(feedUrl)} -o ${sq(tmp)} && mv ${sq(tmp)} ${sq(configPath)}` +
    ` && ${reloadCommandFor(configPath)}`;
  if (!report?.url) return base;
  const auth = report.token ? ` -H ${sq(`Authorization: Bearer ${report.token}`)}` : '';
  const post = (ok: 0 | 1) => `curl -fsS -m 5 -o /dev/null -X POST${auth} ${sq(`${report.url}&ok=${ok}`)}`;
  return `${base} && (${post(1)} || true) || ${post(0)}`;
}

/**
 * The endpoint the refresh command reports back to.
 *
 * Same base the feed URL is served from — the report is only meaningful to the hub that served
 * the file, and a resolver that can reach the feed can reach the report.
 */
export function unboundReportUrl(lanUrl: string): string {
  const base = (lanUrl || '').replace(/\/+$/, '') || 'http://<your-computer-ip>:9191';
  return `${base}/v1/deploy-report?target=unbound`;
}

function reloadCommandFor(configPath: string): string {
  const target = UNBOUND_TARGETS.find((entry) => entry.configPath === configPath);
  return target?.reloadCommand ?? 'unbound-control reload';
}

/**
 * Why the feed URL below cannot work yet, or null when it can.
 *
 * Showing a live-looking URL for a file that is never written would be a lie, so the pane surfaces
 * this instead of leaving the user to discover an empty feed.
 */
export interface UnboundResolverHintInput {
  /** Why the typed address cannot be used, when that is the case. */
  error?: string | null;
  /** `host:port` the check will query, or null when there is no usable address. */
  effective?: string | null;
  /** True when nothing is set and the conventional address was assumed. */
  usedDefault?: boolean;
  /** This machine's configured DNS servers, used to suggest what to type. */
  systemServers?: readonly string[];
}

/**
 * The line under the resolver field.
 *
 * The default is a guess the user has to be able to see through, and the common reason it is wrong
 * has a specific answer: Unbound runs on a router or another host, so the address that works is
 * usually the one this machine already resolves through. Naming it turns a wrong verdict into a
 * one-line fix instead of a dead end, and costs one line of prose rather than a settings screen.
 */
export function unboundResolverHint(input: UnboundResolverHintInput): string {
  if (input.error) return input.error;
  if (!input.effective) return 'The canary query runs against this address.';

  if (input.usedDefault) {
    const suggestion = (input.systemServers ?? [])
      .map((server) => server.trim())
      .find((server) => server && !isLoopbackResolvHost(server));
    const base = `No address is set, so the check queries ${input.effective} — the resolver on this machine. Rows name the address they came from, so a wrong guess is visible rather than silent.`;
    return suggestion
      ? `${base} This machine resolves through ${suggestion}; if Unbound runs there, that is the address to enter.`
      : base;
  }

  return `The check queries ${input.effective}. Set this to the Unbound instance that serves your clients — a router-hosted resolver needs its LAN address, not 127.0.0.1.`;
}

/**
 * The line under the reference field.
 *
 * The reference is what makes an NXDOMAIN mean something, so the reason it is there has to be
 * visible: without a second resolver, a name that never existed and a name this deployment blocks
 * give the same answer. It is also queried with the canary, which is worth saying out loud.
 */
export function unboundReferenceHint(input: {
  error?: string | null;
  effective?: string | null;
  source?: 'explicit' | 'system' | 'none';
}): string {
  if (input.error) return input.error;
  if (!input.effective) {
    return 'No reference resolver is available, so a live canary is reported as unconfirmed. Enter one to have the check confirm the test domain exists before reading NXDOMAIN as proof.';
  }
  const origin = input.source === 'system'
    ? 'this machine\u2019s own configured resolver'
    : 'the address you set';
  return `The canary is also looked up on ${input.effective} (${origin}) to confirm the name exists — otherwise a domain that was never registered answers NXDOMAIN exactly like one the drop-in blocks.`;
}

export function unboundFormatWarning(exportFormat: string): string | null {
  if (exportFormat === 'unbound') return null;
  return `The compiled export is currently "${exportFormat}". Set Format to Unbound so the hub writes local-zone rules instead of ${exportFormat} syntax.`;
}
