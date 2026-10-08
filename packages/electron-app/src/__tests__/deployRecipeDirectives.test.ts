/**
 * @jest-environment jsdom
 *
 * The copyable directive each Deploy Hub recipe offers, checked against the vocabulary the
 * target's own documentation lists.
 *
 * Every recipe hands the user at least one line meant for a config file — `include:` for
 * Unbound, a `zone` stanza and `response-policy` clause for BIND, `actionsfile` for Privoxy,
 * unit keys under `[Service]` for systemd. Those heads are a documented vocabulary, and the
 * vocabularies are not interchangeable: named.conf takes `include "...";` where unbound.conf
 * takes `include: "..."`, and a recipe that drifts to a neighbouring product's grammar still
 * looks plausible in the UI because a directive-shaped line renders fine either way.
 *
 * So this suite renders each recipe for real — a DOM environment, not static markup, because
 * the thing under test is what a Copy button puts on the clipboard — clicks every button with
 * `handleCopy` bound, collects the payloads plus every `<code>`/`<pre>` line the recipe prints,
 * and classifies each line. A line that is statement-shaped under the target's grammar must
 * carry a keyword the target's documentation lists, and a command line must invoke an
 * executable the target documents or a generic host tool. Anything else — URLs, file paths,
 * resource records, prose labels — is not a directive and is skipped.
 *
 * The vocabularies below are the independent half of the check: they are written from the
 * target's documentation (cited per entry), not from the helpers that produce the lines, so
 * the recipe and the oracle cannot drift together.
 */

import { describe, expect, it } from '@jest/globals';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';

import { DEPLOY_TARGETS, type DeployTargetId } from '../deploy/deployTargets';
import type { DeployPaneRenderer, HubPaneProps } from '../deploy/panes/paneProps';
import { DaemonManager } from '../daemonManager';

// React refuses `act` without the flag; the render must flush before the DOM is read.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The panes read `window.electron` while deciding what to show; an empty bridge is enough here.
(globalThis as unknown as { window: { electron?: unknown } }).window.electron = {};

/** One statement grammar plus the keyword list the target's documentation gives it. */
interface DirectiveGrammar {
  /** Captures the statement head — the keyword — in group 1 when the line is statement-shaped. */
  match: RegExp;
  /** The heads the target's own documentation lists for this shape. */
  vocabulary: readonly string[];
}

/** The documented surface of one target: its config statements and its own executables. */
interface RecipeDocs {
  /** Checked in order; the first grammar that matches a line decides which list judges it. */
  statements: readonly DirectiveGrammar[];
  /** The target's own binaries — `rndc`, `pihole` — checked on command-shaped lines. */
  commands: readonly string[];
}

/*
 * BIND 9 ARM, "named.conf Reference" — the statement heads named.conf accepts, plus the
 * `response-policy` options clause the recipe copies as a line of its own.
 */
const NAMED_CONF_STATEMENTS = [
  'acl', 'catalog-zones', 'controls', 'dlz', 'dnskey-policy', 'dnssec-policy', 'dyndb', 'http',
  'include', 'key', 'logging', 'masters', 'options', 'parental-agents', 'plugin', 'primaries',
  'response-policy', 'server', 'statistics-channels', 'tls', 'trust-anchor', 'trustees',
  'view', 'zone',
] as const;

/* RFC 1035 §5 and the ARM's zone-file section — the `$` directives a master file accepts. */
const ZONE_FILE_DIRECTIVES = ['GENERATE', 'INCLUDE', 'ORIGIN', 'TTL'] as const;

/* unbound.conf(5) — the top-level clauses, each spelled `clause:` in the config file. */
const UNBOUND_CLAUSES = [
  'auth-zone', 'cachedb', 'dnscrypt', 'dnstap', 'dynlib', 'forward-zone', 'include',
  'ipsecmod', 'python', 'remote-control', 'rpz', 'server', 'stub-zone', 'view',
] as const;

/* Privoxy User Manual, "Configuration" — the option keywords a config line may open with. */
const PRIVOXY_OPTIONS = [
  'accept-filter', 'accept-intercepted-requests', 'actionsfile', 'activity-animation',
  'allow-cgi-request-crunching', 'buffer-limit', 'client-header-order', 'client-header-tagger',
  'compression-level', 'confdir', 'connection-sharing', 'debug', 'default-server-timeout',
  'enable-compression', 'enable-edit-actions', 'enable-remote-http-toggle', 'enable-remote-toggle',
  'enforce-blocks', 'filterfile', 'forward', 'forward-socks4', 'forward-socks4a', 'forward-socks5',
  'forward-socks5t', 'forwarded-connect-retries', 'handle-as-empty-doc-returns-ok',
  'handle-as-image', 'hostname', 'jarfile', 'keep-alive-timeout', 'listen-address', 'logdir',
  'logfile', 'max-client-connections', 'receive-buffer-size', 'split-large-forms', 'templdir',
  'toggle', 'tolerate-pipelining', 'trust-x-forwarded-for', 'user-manual',
] as const;

/*
 * dnsmasq.conf(8) — the `keyword` / `keyword=value` options the file accepts. Pi-hole shares
 * the list because its recipes drop dnsmasq syntax into `/etc/dnsmasq.d/`.
 */
const DNSMASQ_OPTIONS = [
  'addn-hosts', 'address', 'alias', 'auth-zone', 'bind-dynamic', 'bind-interfaces',
  'bogus-nxdomain', 'bogus-priv', 'cache-size', 'conf-dir', 'conf-file', 'dhcp-host',
  'dhcp-option', 'dhcp-range', 'dns-rr', 'dnssec', 'domain', 'domain-needed', 'edns-packet-max',
  'enable-dbus', 'except-interface', 'expand-hosts', 'filterwin2k', 'group', 'hostsdir',
  'interface', 'listen-address', 'local', 'localise-queries', 'log-async', 'log-debug',
  'log-dhcp', 'log-facility', 'log-queries', 'mx-host', 'no-daemon', 'no-dhcp-interface',
  'no-hosts', 'no-negcache', 'no-ping', 'no-poll', 'no-resolv', 'port', 'proxy-dnssec',
  'read-ethers', 'resolv-file', 'server', 'srv-host', 'stop-dns-rebind', 'strict-order',
  'trust-anchor', 'user',
] as const;

/* Surge rule-set grammar — the rule types Shadowrocket and Surge document for `[Rule]` lines. */
const SURGE_RULE_TYPES = [
  'AND', 'DEST-PORT', 'DOMAIN', 'DOMAIN-KEYWORD', 'DOMAIN-SET', 'DOMAIN-SUFFIX', 'FINAL',
  'GEOIP', 'IN-PORT', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6', 'NOT', 'OR', 'PROTOCOL', 'RULE-SET',
  'SCRIPT', 'SRC-ADDR', 'SRC-IP', 'SUBNET', 'URL-REGEX', 'USER-AGENT',
] as const;

/* Surge config file — the bracketed sections a rule set lives under. */
const SURGE_SECTIONS = [
  'General', 'Header Rewrite', 'Host', 'MITM', 'Panel', 'Pro', 'Proxy', 'Proxy Group',
  'Replica', 'Rule', 'Script', 'URL Rewrite',
] as const;

/* systemd.unit(5) — the bracketed sections a unit file is divided into. */
const SYSTEMD_SECTIONS = [
  'Automount', 'Device', 'Install', 'Mount', 'Path', 'Scope', 'Service', 'Slice', 'Socket',
  'Swap', 'Target', 'Timer', 'Unit',
] as const;

/* systemd.unit(5), systemd.service(5) and systemd.exec(5) — the `Key=` settings they define. */
const SYSTEMD_KEYS = [
  'After', 'Alias', 'Also', 'AmbientCapabilities', 'Before', 'BindsTo', 'BusName',
  'CacheDirectory', 'CapabilityBoundingSet', 'Conflicts', 'ConfigurationDirectory',
  'CPUSchedulingPolicy', 'Description', 'Documentation', 'DynamicUser', 'Environment',
  'EnvironmentFile', 'ExecCondition', 'ExecReload', 'ExecStart', 'ExecStartPost',
  'ExecStartPre', 'ExecStop', 'ExecStopPost', 'Group', 'GuessMainPID', 'IOSchedulingClass',
  'LimitNOFILE', 'LimitNPROC', 'LogsDirectory', 'MemoryLimit', 'MemoryMax', 'Nice',
  'NoNewPrivileges', 'OOMScoreAdjust', 'OnFailure', 'PartOf', 'PIDFile', 'PrivateDevices',
  'PrivateTmp', 'ProtectClock', 'ProtectControlGroups', 'ProtectHome', 'ProtectHostname',
  'ProtectKernelModules', 'ProtectKernelTunables', 'ProtectSystem', 'ReadOnlyPaths',
  'ReadWritePaths', 'RemainAfterExit', 'RequiredBy', 'Requires', 'RequiresMountsFor',
  'Restart', 'RestartPreventExitStatus', 'RestartSec', 'RootDirectory', 'RuntimeDirectory',
  'RuntimeMaxSec', 'Slice', 'StandardError', 'StandardInput', 'StandardOutput',
  'StartLimitAction', 'StartLimitBurst', 'StartLimitIntervalSec', 'StateDirectory',
  'SuccessExitStatus', 'SupplementaryGroups', 'SyslogFacility', 'SyslogIdentifier',
  'SyslogLevel', 'TasksMax', 'TimeoutSec', 'TimeoutStartSec', 'TimeoutStopSec', 'Type',
  'UMask', 'User', 'WantedBy', 'Wants', 'WatchdogSec',
] as const;

/*
 * Host tools every deployment can run — fetching, files, scheduling, service management. A
 * recipe command headed by one of these is host plumbing, not a claim about the target's
 * vocabulary, so it is always allowed. The target's own binaries are not here on purpose:
 * `rndc` offered by a recipe that is not BIND's is a recipe bug this suite should catch.
 */
const GENERIC_TOOLS = new Set([
  'awk', 'bash', 'cat', 'chmod', 'chown', 'cp', 'cron', 'crontab', 'curl', 'cut', 'dash', 'date',
  'dd', 'dig', 'echo', 'env', 'grep', 'gzip', 'head', 'hostname', 'ifconfig', 'ip', 'kill',
  'killall', 'ln', 'mkdir', 'mv', 'nc', 'netstat', 'openssl', 'ping', 'printf', 'rm', 'rmdir',
  'resolvectl', 'route', 'scutil', 'sed', 'service', 'sh', 'sleep', 'sort', 'sysctl',
  'systemctl', 'systemd-resolve', 'tail',
  'tar', 'tee', 'test', 'touch', 'tr', 'uniq', 'wget', 'which', 'xargs',
]);

/*
 * The recipe grammar for a target that documents no config statements of its own: a `key:` or
 * `key=` line is statement-shaped everywhere, so it must still be examined — and it fails,
 * because the vocabulary it is checked against is empty.
 */
const NO_STATEMENTS: readonly DirectiveGrammar[] = [
  { match: /^([a-z][a-z0-9_-]*)\s*[:=]/, vocabulary: [] },
];

const DOCUMENTED: Record<DeployTargetId, RecipeDocs> = {
  // The browser pane hands the user clicks in a browser UI plus the URLs to visit — its code
  // spans are `scheme:`-shaped, which the generic statement grammar reads as config keys. The
  // schemes the pane actually prints are its vocabulary; a `key:` line that is not one of them
  // still fails.
  'browser-extension': {
    statements: [
      { match: /^([a-z][a-z0-9_-]*)\s*[:=]/, vocabulary: ['about', 'chrome', 'http'] },
    ],
    commands: [],
  },
  // The subscription targets hand the user URLs, not config statements, so a statement-shaped
  // line in their recipe has no documented keyword to carry and fails.
  'adguard-home': { statements: NO_STATEMENTS, commands: [] },
  'adguard-desktop': { statements: NO_STATEMENTS, commands: [] },
  'home-assistant': { statements: NO_STATEMENTS, commands: [] },
  hosts: { statements: NO_STATEMENTS, commands: [] },
  bind: {
    statements: [
      // named.conf statements are `keyword …;` — the closing semicolon is what separates a
      // statement from the `rndc reload` command a recipe also offers.
      { match: /^([a-z][a-z0-9_-]*)\s[^;]*;/, vocabulary: NAMED_CONF_STATEMENTS },
      { match: /^\$([A-Z]+)/, vocabulary: ZONE_FILE_DIRECTIVES },
    ],
    commands: ['delv', 'dig', 'host', 'named', 'named-checkconf', 'named-checkzone', 'named-compilezone', 'nslookup', 'rndc'],
  },
  unbound: {
    statements: [
      // unbound.conf clauses are `keyword:` — the colon is the grammar, and it is what makes
      // `include: "…"` right here where `include "…";` would be named.conf syntax.
      { match: /^([a-z][a-z0-9_-]*)\s*:/, vocabulary: UNBOUND_CLAUSES },
    ],
    // `configctl` is the OPNsense/pfSense service wrapper the BSD flavour's refresh line ends in.
    commands: ['configctl', 'unbound', 'unbound-anchor', 'unbound-checkconf', 'unbound-control', 'unbound-host'],
  },
  privoxy: {
    statements: [
      // A Privoxy config line is `option value` — a bare lowercase keyword followed by its
      // arguments, with `=` accepted so a dnsmasq-shaped line cannot slip past unchecked.
      { match: /^([a-z][a-z0-9-]*)[ \t=]/, vocabulary: PRIVOXY_OPTIONS },
    ],
    commands: ['privoxy'],
  },
  dnsmasq: {
    statements: [{ match: /^([a-z][a-z0-9_-]*)\s*=/, vocabulary: DNSMASQ_OPTIONS }],
    commands: ['dnsmasq'],
  },
  pihole: {
    statements: [{ match: /^([a-z][a-z0-9_-]*)\s*=/, vocabulary: DNSMASQ_OPTIONS }],
    commands: ['pihole'],
  },
  shadowrocket: {
    statements: [
      { match: /^([A-Z][A-Z0-9_-]*),/, vocabulary: SURGE_RULE_TYPES },
      { match: /^\[([^\]]+)\]/, vocabulary: SURGE_SECTIONS },
    ],
    commands: [],
  },
  'system-daemon': {
    statements: [
      { match: /^\[([^\]]+)\]/, vocabulary: SYSTEMD_SECTIONS },
      { match: /^([A-Z][A-Za-z]*)\s*=/, vocabulary: SYSTEMD_KEYS },
    ],
    commands: ['launchctl', 'service', 'systemctl'],
  },
};

/* ---------------------------------- the check ---------------------------------- */

/** A URL scheme (`http:`/`https:`/`file:`…) — an address, never a config statement. */
const URL_LINE = /^[a-zA-Z][\w+.-]*:\/\//;
/** A shell command: lowercase executable name, then whitespace and an argument. */
const COMMAND_LINE = /^([a-z][a-z0-9_.-]*)\s+\S/;

interface Found {
  /** 'statement' (config grammar) or 'command' (executable). */
  kind: 'statement' | 'command';
  /** The extracted head — `zone`, `include`, `rndc`, `pihole`. */
  head: string;
  /** The documented keywords for this statement shape; undefined on a command. */
  vocabulary?: readonly string[];
}

/**
 * What one payload line claims to be under the target's documented grammar — every shape it
 * matches, not just the first. A Privoxy option line (`actionsfile file`) and a shell command
 * (`curl -fsSL …`) are the same `word args` shape, so a line can be a candidate under the
 * statement grammar *and* the command grammar at once; either reading being documented is
 * enough, while neither being true is the violation. Lines that match nothing — URLs, paths,
 * resource records (`@ IN SOA …`), XML tags, prose — are not claims and produce no candidate.
 */
function classifyLine(docs: RecipeDocs, line: string): Found[] {
  const text = line.trim();
  if (!text || URL_LINE.test(text)) return [];
  const found: Found[] = [];
  for (const grammar of docs.statements) {
    const head = grammar.match.exec(text)?.[1];
    if (head) found.push({ kind: 'statement', head, vocabulary: grammar.vocabulary });
  }
  // Shell prefixes are not the command: `sudo rndc reload` is still an rndc call.
  const command = COMMAND_LINE.exec(text.replace(/^(?:(?:sudo|doas)\s+)+/, ''))?.[1];
  if (command) found.push({ kind: 'command', head: command });
  return found;
}

/**
 * The failure string for a line whose head the target's documentation does not list under any
 * grammar it matches, or null when the line is fine. `statementNames` collects every
 * statement-shaped head seen, so a recipe that stopped offering directives cannot pass vacuously.
 */
function checkLine(
  docs: RecipeDocs,
  label: string,
  surface: string,
  line: string,
  statementNames: string[],
): string | null {
  const candidates = classifyLine(docs, line);
  for (const found of candidates) {
    if (found.kind === 'statement') statementNames.push(found.head);
  }
  if (candidates.length === 0) return null;
  const documented = candidates.some((found) =>
    found.kind === 'command'
      ? GENERIC_TOOLS.has(found.head) || docs.commands.includes(found.head)
      : found.vocabulary!.includes(found.head),
  );
  if (documented) return null;
  // Every shape the line matched is undocumented — report the statement reading when there is
  // one, because a config-shaped failure is what the recipe author is looking for.
  const found = candidates.find((f) => f.kind === 'statement') ?? candidates[0]!;
  return found.kind === 'command'
    ? `${surface} line "${line.trim()}" invokes "${found.head}", which the ${label} ` +
        `documentation does not describe as a command`
    : `${surface} line "${line.trim()}" opens with "${found.head}", which the ${label} ` +
        `documentation does not list as a statement`;
}

interface Rendered {
  /** What each Copy button put on the clipboard — the payloads `handleCopy` received. */
  copied: string[];
  /** The `<code>`/`<pre>` text the recipe prints — directives a user copies by hand. */
  blocks: string[];
}

function renderRecipe(pane: DeployPaneRenderer, props: HubPaneProps): Rendered {
  const copied: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => {
      root.render(createElement(Fragment, null, pane({ ...props, handleCopy: (text) => copied.push(text) })));
    });
    // Every button is clicked, not only the ones labelled Copy: the spy records only what
    // `handleCopy` was given, so a button wired to copy the wrong string is what fails.
    host.querySelectorAll('button').forEach((button) => button.click());
    const blocks = [...host.querySelectorAll('code, pre')].map((el) => el.textContent ?? '');
    return { copied, blocks };
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

/* ----------------------------- recipe variants ------------------------------ */

const SAVE_PATH = '/tmp/blockingmachine/blocklist.txt';
const SERVER_STATUS = {
  isRunning: true,
  port: 9191,
  localUrl: 'http://127.0.0.1:9191',
  lanUrl: 'http://192.168.1.20:9191',
  lanIp: '192.168.1.20',
};

const noop = () => {};
const noopAsync = async () => {};

/**
 * A complete bundle, written out by hand in the same convention as `deployPanes.test.ts`, so a
 * pane cannot quietly depend on a field the Hub does not pass it. `handleCopy` is left open —
 * `renderRecipe` substitutes the collector before rendering.
 */
function bundle(overrides: Partial<HubPaneProps> = {}): HubPaneProps {
  return {
    savePath: SAVE_PATH,
    exportFormat: 'adguard',
    serverStatus: SERVER_STATUS,
    feedTokenConfigured: false,
    secretStorageAvailable: null,

    handleCopy: noop,
    copiedKey: null,

    sinkholeConfig: {
      piholeUrl: '',
      piholeApiKey: '',
      adguardHomeUrl: '',
      adguardHomeUser: '',
      adguardHomePassword: '',
      syncOnCompile: false,
      adguardMode: 'direct',
      adguardDirectPort: undefined,
      adguardDirectUrl: '',
      allowInsecureLocalTls: false,
      haToken: '',
      haWebhookUrl: '',
      customWebhookUrl: '',
    },
    setSinkholeConfig: noop,
    showHaToken: false,
    setShowHaToken: noop,
    showAdguardPass: false,
    setShowAdguardPass: noop,
    showPiholeKey: false,
    setShowPiholeKey: noop,
    adguardEnv: 'homeassistant',
    setAdguardEnv: noop,
    testingService: null,
    isSavingSinkhole: false,
    isSyncingSinkhole: false,
    sinkholeMessage: null,
    testResult: null,
    lastSyncResult: null,
    handleTestConnection: noopAsync,
    handleSaveSinkholeConfig: noopAsync,
    handleTriggerLiveSync: noopAsync,
    handleToggleSyncOnCompile: noopAsync,
    selectAdguardMode: noop,
    applyDetectedMode: noopAsync,
    directPortFocusRef: { current: 3000 },

    haApiPreview: null,
    isTestingHaApi: false,
    handleInspectHaApi: noopAsync,
    tierPlanState: 'loading',
    tierPlan: null,
    tierPlanError: null,
    loadTierPlan: noopAsync,
    chooseTierLedger: noopAsync,
    clearTierLedger: noopAsync,

    daemonStatus: {
      status: 'running',
      port: 5353,
      controlPort: 9292,
      upstream: 'https://dns.quad9.net/dns-query',
      rulesLoaded: 48213,
      protectionEnabled: true,
      uptimeSeconds: 4210,
      managedByApp: true,
      stats: { totalQueries: 100, blockedQueries: 40, allowedQueries: 60, blockRatePercent: 40 },
    },
    isDaemonLoading: false,
    daemonMessage: null,
    networkServices: ['Wi-Fi', 'Ethernet'],
    selectedService: 'Wi-Fi',
    setSelectedService: noop,
    showInstallScripts: false,
    serviceScripts: null,
    refreshDaemonStatus: noopAsync,
    handleStartDaemon: noopAsync,
    handleStopDaemon: noopAsync,
    handleToggleDaemonProtection: noopAsync,
    handleReloadDaemon: noopAsync,
    handleSetSystemDns: noopAsync,
    handleRestoreSystemDns: noopAsync,
    handleFlushCache: noopAsync,
    handleToggleInstallScripts: noopAsync,

    unboundReachability: null,
    unboundSnapshot: null,
    unboundResolver: null,
    resolverDraft: '',
    setResolverDraft: noop,
    referenceDraft: '',
    setReferenceDraft: noop,
    isCheckingUnbound: false,
    resolverMessage: null,
    handleCheckUnboundReachability: noopAsync,
    handleSaveUnboundResolver: noopAsync,

    bindMechanism: 'rpz',
    setBindMechanism: noop,

    extensionSaving: false,
    extensionSavedPath: null,
    extensionMessage: null,
    extensionBrowser: 'both',
    setExtensionBrowser: noop,
    handleDownloadExtension: noopAsync,
    siblingTargets: [],
    onSelectTarget: noop,

    ...overrides,
  };
}

interface Recipe {
  /** Which recipe inside the pane, for the failure message — most panes hold only one. */
  name: string;
  props: Partial<HubPaneProps>;
}

/** The real scripts the daemon recipe hands out, generated the way the main process does it. */
const SERVICE_SCRIPTS = new DaemonManager().getServiceInstallInstructions();

function recipesFor(id: DeployTargetId): readonly Recipe[] {
  switch (id) {
    case 'bind':
      // Both mechanisms are recipes: they copy different stanzas into the same named.conf.
      return [
        { name: 'response-policy zone', props: { bindMechanism: 'rpz' } },
        { name: 'shared null zone', props: { bindMechanism: 'null-zone' } },
      ];
    case 'system-daemon':
      return [
        {
          name: 'install scripts',
          props: { showInstallScripts: true, serviceScripts: SERVICE_SCRIPTS },
        },
      ];
    default:
      return [{ name: 'recipe', props: {} }];
  }
}

/* --------------------------------- the suite --------------------------------- */

/**
 * The recipes that must offer at least one documented statement — a count of zero here means
 * the pane stopped printing its directives and the check would otherwise pass vacuously.
 */
const MUST_OFFER: Readonly<Partial<Record<DeployTargetId, number>>> = {
  bind: 2, // zone stanza + response-policy clause (rpz), include + $TTL (null-zone)
  unbound: 3, // one `include:` per recipe flavour
  privoxy: 2, // `actionsfile` on the copy button and again in the recipe text
  shadowrocket: 2, // a rule-type line and its `[Rule]` section
  dnsmasq: 1, // the `addn-hosts=` directive the generic recipe tells the user to add
  'system-daemon': 8, // the unit file's [Unit]/[Service] sections and Key= settings
};

describe('every deploy recipe offers only directives the target documents', () => {
  for (const target of DEPLOY_TARGETS) {
    const docs = DOCUMENTED[target.id];
    for (const recipe of recipesFor(target.id)) {
      it(`${target.id} — ${recipe.name}`, () => {
        const { copied, blocks } = renderRecipe(target.pane, bundle(recipe.props));
        const violations: string[] = [];
        const statements: string[] = [];

        for (const [surface, payloads] of [
          ['copy button', copied],
          ['recipe text', blocks],
        ] as Array<[string, string[]]>) {
          for (const payload of payloads) {
            for (const line of payload.split('\n')) {
              const violation = checkLine(docs, target.label, surface, line, statements);
              if (violation) violations.push(`${target.id} / ${recipe.name}: ${violation}`);
            }
          }
        }

        expect(violations).toEqual([]);
        const floor = MUST_OFFER[target.id];
        if (floor !== undefined) {
          // `checked` counts statement lines seen, not distinct heads — the same directive on a
          // button and in the recipe text still proves the recipe offers something to check.
          expect(statements.length).toBeGreaterThanOrEqual(floor);
        }
      });
    }
  }

  it('fails a recipe whose directive head the target does not document', () => {
    const seen: string[] = [];
    // `upstream-zone:` is clause-shaped under unbound.conf grammar but is not a clause.
    expect(checkLine(DOCUMENTED.unbound, 'Unbound', 'test', 'upstream-zone: "example.com"', seen))
      .toContain('"upstream-zone"');
    // named.conf syntax in a Privoxy recipe — `actionsfile`'s sibling grammar still applies.
    expect(checkLine(DOCUMENTED.privoxy, 'Privoxy', 'test', 'include "/etc/privoxy/x";', seen))
      .toContain('"include"');
    // A typo'd executable is not a documented command either.
    expect(checkLine(DOCUMENTED.bind, 'BIND', 'test', 'rncd reload rpz.blockingmachine', seen))
      .toContain('"rncd"');
  });

  it('recognises the documented heads it claims to', () => {
    const seen: string[] = [];
    expect(checkLine(DOCUMENTED.bind, 'BIND', 't', 'zone "rpz.blockingmachine" { type master; };', seen)).toBeNull();
    expect(checkLine(DOCUMENTED.bind, 'BIND', 't', 'response-policy { zone "x"; };', seen)).toBeNull();
    expect(checkLine(DOCUMENTED.unbound, 'Unbound', 't', 'include: "/etc/unbound/x.conf"', seen)).toBeNull();
    expect(checkLine(DOCUMENTED.privoxy, 'Privoxy', 't', 'actionsfile blockingmachine.action', seen)).toBeNull();
    expect(checkLine(DOCUMENTED['system-daemon'], 'Daemon', 't', 'ExecStart=/usr/bin/node index.js', seen)).toBeNull();
    expect(checkLine(DOCUMENTED['system-daemon'], 'Daemon', 't', '[Service]', seen)).toBeNull();
    expect(seen).toEqual(['zone', 'response-policy', 'include', 'actionsfile', 'ExecStart', 'Service']);
  });
});
