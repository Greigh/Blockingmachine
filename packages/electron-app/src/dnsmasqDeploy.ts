/**
 * dnsmasq deployment helpers.
 *
 * The pane this feeds presents the hub's LAN feed to clients that genuinely do subscribe —
 * Technitium, pfBlockerNG — and to dnsmasq itself, which does not. The recipe that used to be
 * here had dnsmasq `curl` a compiled file into `/etc/dnsmasq.d/` and run `reload`; that line is
 * inert twice over. dnsmasq(8) is explicit: *"SIGHUP does NOT re-read the configuration file"* —
 * a reload touches only the hosts-style inputs, so a conf-dir drop-in is never applied. And on
 * OpenWrt the path is wrong anyway: the generated confdir is `/tmp/dnsmasq.d` (per-instance
 * `/tmp/dnsmasq.<cfg>.d` on current builds), not `/etc/dnsmasq.d`.
 *
 * The mechanism that does reload is `addn-hosts`: it is on SIGHUP's re-read list, so a
 * hosts-format file fetched on a schedule and followed by `reload` lands without a restart —
 * the same drop-in-then-scheduled-refresh shape as the Unbound recipe. OpenWrt's generated
 * config already carries `addn-hosts=/tmp/hosts`, so there is nothing to enable.
 *
 * Everything this pane names reads hosts format — Technitium's built-in blocking, a dnsmasq
 * addn-hosts file, a pfBlockerNG DNSBL feed — so the recipe is coupled to `hosts` the way the
 * sibling panes are coupled to their format, and says so.
 */

/** OpenWrt's generated config points `addn-hosts` at this directory by default. */
export const DNSMASQ_OPENWRT_HOSTS_DIR = '/tmp/hosts';

/** Where the generic recipe puts the fetched file once `addn-hosts` points at it. */
export const DNSMASQ_HOSTS_FILE = '/etc/blockingmachine.hosts';

/**
 * The `addn-hosts` line for a dnsmasq.conf that does not already have one.
 *
 * This is the directive that makes the recipe work: it is the hosts-file input dnsmasq re-reads
 * on SIGHUP, which is what lets the scheduled fetch below take effect with `reload` rather than
 * `restart`.
 */
export function dnsmasqAddnHostsDirective(file: string): string {
  return `addn-hosts=${file}`;
}

/** The scheduled fetch-and-reload, as a cron line. */
export function dnsmasqCronLine(feedUrl: string, file: string): string {
  return `0 4 * * * curl -fsSL "${feedUrl}" -o ${file} && ${dnsmasqReloadCommand()}`;
}

/**
 * The reload — correct here precisely because the fetched file is a hosts file.
 *
 * `reload` sends SIGHUP, which re-reads `--addn-hosts` (and `--hostsdir`) inputs but never the
 * configuration, so this command is right for a hosts file and wrong for a conf-dir drop-in.
 */
export function dnsmasqReloadCommand(): string {
  return '/etc/init.d/dnsmasq reload';
}

/** Why the fetched file cannot be a hosts file yet, or null when it can. */
export function dnsmasqFormatWarning(exportFormat: string): string | null {
  if (exportFormat === 'hosts') return null;
  return `The compiled export is currently "${exportFormat}". Set Format to hosts so the hub writes 0.0.0.0 lines — every consumer on this page reads hosts files.`;
}

export interface DnsmasqRecipeStep {
  id: string;
  title: string;
  detail: string;
}

/** The setup recipes, in the order the pane shows them. */
export const DNSMASQ_STEPS: DnsmasqRecipeStep[] = [
  {
    id: 'technitium',
    title: 'Technitium DNS Server',
    detail:
      'In Technitium Admin go to Settings \u2192 Blocking \u2192 Block List URLs, paste the LAN feed URL, and Save \u2014 the server re-downloads the list every 24 hours. Its built-in blocking reads hosts-format and plain domain lists, which is what the hosts export gives it.',
  },
  {
    id: 'openwrt',
    title: 'OpenWrt / dnsmasq',
    detail:
      'OpenWrt\u2019s generated config already carries addn-hosts=/tmp/hosts, and a reload re-reads it \u2014 schedule the fetch below so each compile lands in a hosts file there. The older shape of this recipe (a conf file in /etc/dnsmasq.d plus reload) never worked: /etc/dnsmasq.d is not OpenWrt\u2019s conf-dir \u2014 that is /tmp/dnsmasq.d \u2014 and reload does not re-read configuration files anyway.',
  },
  {
    id: 'dnsmasq',
    title: 'dnsmasq on Debian, Ubuntu or other hosts',
    detail:
      'Point addn-hosts at the fetched file once in dnsmasq.conf, then the same fetch-and-reload cron applies every compile. This is the one input a reload actually re-reads \u2014 conf-dir and conf-file contents only load at startup.',
  },
  {
    id: 'pfblocker',
    title: 'pfSense / OPNsense (pfBlockerNG)',
    detail:
      'In pfBlockerNG create a new DNSBL feed pointing at the LAN feed URL with List Action set to Unbound \u2014 it parses hosts-format lists and re-fetches them on its cron schedule.',
  },
];
