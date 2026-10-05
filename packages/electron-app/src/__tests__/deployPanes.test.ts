/**
 * Every deploy pane, rendered from a literal prop bundle.
 *
 * The panes used to be eleven `case` arms inside a 2,982-line view, which meant nothing could be
 * rendered without the whole Hub: the state, the Electron bridge and the platform dispatcher all
 * lived in one scope, so the only way to look at a pane was to run the app. That is why the markup
 * went untested for years — a pane that rendered a blank column, or a URL with `undefined` in it,
 * was invisible to the suite.
 *
 * Now each pane is a pure function of the bundle in `deploy/panes/paneProps`, and every field here
 * is written out by hand rather than mocked, so a pane cannot quietly depend on something the Hub
 * does not pass it. Three things are checked for all eleven: that they render, that they show the
 * artifact they were handed rather than a placeholder, and that changing the artifact changes the
 * markup — which is the assertion that fails if a pane stops reading its props and starts printing a
 * constant.
 *
 * The values here are ordinary: a save path, a running server, an unconfigured sinkhole. A pane that
 * only renders correctly with a connection set up is not testable, and neither was true of the
 * markup before.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Fragment, isValidElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEPLOY_TARGETS } from '../deploy/deployTargets';
import { pickPaneProps } from '../deploy/panes/paneProps';
import type { HubPaneProps } from '../deploy/panes/paneProps';
import { bindHomeAssistantUrl, bindIncludeLine, bindNamedConfZoneLine, bindZoneFileName } from '../bindDeploy';
import { UNBOUND_TARGETS, unboundIncludeDirective } from '../unboundDeploy';
import { shadowrocketHomeAssistantUrl } from '../shadowrocketDeploy';
import {
  privoxyActionsFileDirective,
  privoxyFeedFileName,
  privoxyHomeAssistantUrl,
  privoxyReloadCommand,
} from '../privoxyDeploy';
import { DeployHubView } from '../views/DeployHubView';

/**
 * The Hub reads `window.electron` while rendering its header, to decide whether it can offer
 * "Reveal in Finder". Nothing else touches it here: `renderToStaticMarkup` does not run effects, so
 * no IPC is issued and no promise is left dangling.
 */
(globalThis as unknown as { window: unknown }).window = { electron: {} };

const SAVE_PATH = '/tmp/blockingmachine/blocklist.txt';
const SERVER_STATUS = {
  isRunning: true,
  port: 9191,
  localUrl: 'http://127.0.0.1:9191',
  lanUrl: 'http://192.168.1.20:9191',
  lanIp: '192.168.1.20',
};
const LAN_FEED = 'http://192.168.1.20:9191/blocklist.txt';

/** Does nothing. A pane only ever passes these to a handler it does not call while rendering. */
const noop = () => {};
const noopAsync = async () => {};

/**
 * A complete bundle, built by hand so that the compiler enforces every field.
 *
 * Note what is absent: no IP is pre-resolved, no feed URL is pre-computed, and the daemon is
 * reported as stopped. Every pane derives what it displays, so these are the only inputs there are.
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
      stats: {
        totalQueries: 100,
        blockedQueries: 40,
        allowedQueries: 60,
        blockRatePercent: 40,
      },
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
    handleDownloadExtension: noopAsync,
    siblingTargets: [],
    onSelectTarget: noop,

    ...overrides,
  };
}

/**
 * Renders a pane the way the Hub does: through the registry entry, with the bundle narrowed to the
 * keys the pane module declares. A pane reading a field its `paneKeys` omit gets `undefined` here
 * exactly as it would in the app, which is what the no-undefined-markup assertions below catch.
 */
const renderPane = (id: (typeof DEPLOY_TARGETS)[number]['id'], props: HubPaneProps) => {
  const target = DEPLOY_TARGETS.find((entry) => entry.id === id);
  if (!target) throw new Error(`no such target: ${id}`);
  const subset = pickPaneProps(props, target.paneKeys);
  return renderToStaticMarkup(createElement(Fragment, null, target.pane(subset)));
};

/**
 * What each pane is for, as a string only it would print.
 *
 * The point is not the wording — it is that each anchor is tied to the pane's own purpose, so a
 * pane that renders the wrong screen, or the right screen twice, fails here.
 */
const ANCHORS: Record<string, readonly string[]> = {
  'adguard-home': ['Live API Automation', 'Feed Subscription &amp; Setup', LAN_FEED],
  pihole: ['Pi-hole Gravity Automation', 'pihole -g', LAN_FEED],
  'home-assistant': ['Home Assistant Hub Connection', 'Integration &amp; Add-on Endpoints'],
  'system-daemon': ['Local DNS Filtering Proxy', 'dns.quad9.net'],
  'adguard-desktop': [`file://${SAVE_PATH}`, 'http://127.0.0.1:9191/blocklist.txt'],
  hosts: [`sudo cp &quot;${SAVE_PATH}&quot; /etc/hosts`],
  dnsmasq: ['Network DNS Stream URL', LAN_FEED],
  unbound: [
    'Unbound Local-Zone Feed',
    escapeHtml(unboundIncludeDirective(UNBOUND_TARGETS[1].configPath)),
  ],
  shadowrocket: ['Shadowrocket Rule Set Feed', shadowrocketHomeAssistantUrl()],
  privoxy: [
    'Privoxy Action File',
    escapeHtml(privoxyActionsFileDirective(privoxyFeedFileName('adguard', SAVE_PATH))),
    escapeHtml(privoxyReloadCommand()),
    privoxyHomeAssistantUrl(),
  ],
  bind: ['BIND Response Policy Zone', bindZoneFileName(SAVE_PATH, 'rpz'), bindHomeAssistantUrl()],
};

describe('deploy panes render from props alone', () => {
  it.each(DEPLOY_TARGETS.map((target) => target.id))('%s renders its own screen', (id) => {
    const markup = renderPane(id, bundle());

    expect(markup.length).toBeGreaterThan(200);
    for (const anchor of ANCHORS[id] ?? []) {
      expect(markup).toContain(anchor);
    }
    // A pane handed a field it forgot to read prints the JavaScript value of `undefined`, which is
    // the failure this suite exists to make visible: a blank column with no error anywhere.
    expect(markup).not.toContain('undefined');
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('[object Object]');
  });

  it('hands each pane exactly the fields its module declares — the subset, not the bundle', () => {
    for (const target of DEPLOY_TARGETS) {
      // The same call the view makes: registry entry, bundle narrowed by the entry's own keys.
      const element = target.pane(pickPaneProps(bundle(), target.paneKeys));
      if (!isValidElement(element)) {
        throw new Error(`${target.id} did not produce a React element`);
      }
      const passed = Object.keys(element.props as Record<string, unknown>).sort();
      const declared = [...target.paneKeys].sort();
      // Both directions at once: a key the adapter passes that was not declared, and a declared
      // key that never reaches the component, are the same failure with different faces.
      expect(passed).toEqual(declared);
    }
  });

  it('shows the LAN address the running server reported, in every pane that prints one', () => {
    const running = bundle();
    for (const id of ['adguard-home', 'pihole', 'dnsmasq'] as const) {
      expect(renderPane(id, running)).toContain(LAN_FEED);
    }
  });

  it('falls back to an address the user can fill in when the server is not running', () => {
    const stopped = bundle({ serverStatus: null });
    for (const id of ['adguard-home', 'pihole', 'dnsmasq'] as const) {
      const markup = renderPane(id, stopped);
      // An empty box is worse than a placeholder: a client handed one refuses the subscription
      // outright, and one handed the placeholder can be told what is missing.
      expect(markup).toContain('http://&lt;your-mac-ip&gt;:9191/blocklist.txt');
      expect(markup).not.toContain(LAN_FEED);
    }
  });

  it('changes what it prints when the artifact changes, rather than rendering a constant', () => {
    const moved = bundle({
      savePath: '/var/lib/blockingmachine/compiled-lists/rules.hosts',
      serverStatus: { ...SERVER_STATUS, lanUrl: 'http://10.0.0.5:9191' },
    });

    expect(renderPane('hosts', moved)).toContain('/var/lib/blockingmachine/compiled-lists/');
    expect(renderPane('hosts', moved)).not.toContain(SAVE_PATH);
    // The feed address ends in the compiled file's name, not its directory: the server publishes one
    // file at the root of the feed, so a path-aware URL would 404.
    expect(renderPane('adguard-home', moved)).toContain('http://10.0.0.5:9191/rules.hosts');
    // The BIND pane takes its file name from the save path, so the zone file it tells the user to
    // copy must follow it — this is what caught the pane falling back to a default.
    expect(renderPane('bind', moved)).toContain('rules.hosts');
    expect(renderPane('bind', bundle())).not.toContain('rules.hosts');
  });

  it('switches the BIND recipe when the mechanism changes, and not only the caption', () => {
    const rpz = renderPane('bind', bundle({ bindMechanism: 'rpz' }));
    const nullZone = renderPane('bind', bundle({ bindMechanism: 'null-zone' }));

    // The two recipes differ in which file is named and which lines are offered; a pane that
    // showed the RPZ recipe under the null-zone heading would pass a text check and mislead.
    expect(rpz).toContain('db.blockingmachine.rpz');
    expect(nullZone).toContain('db.blockingmachine.null');
    expect(nullZone).toContain(escapeHtml(bindIncludeLine()));
    expect(nullZone).not.toContain(escapeHtml(bindNamedConfZoneLine(bindZoneFileName(SAVE_PATH, 'rpz'))));
    expect(rpz).toContain(escapeHtml(bindNamedConfZoneLine(bindZoneFileName(SAVE_PATH, 'rpz'))));
    // The add-on serves only the RPZ zone — the null mechanism has no per-compile file to fetch,
    // so showing the URL under it would offer a fetch for an artifact that does not exist.
    expect(rpz).toContain(bindHomeAssistantUrl());
    expect(nullZone).not.toContain(bindHomeAssistantUrl());
  });

  it('reflects the configured sinkhole rather than an empty form, when there is one', () => {
    const configured = bundle({
      sinkholeConfig: {
        ...bundle().sinkholeConfig,
        adguardHomeUrl: 'http://adguard.lan:8080',
        adguardHomeUser: 'admin',
        adguardHomePassword: 'hunter2',
        adguardDirectPort: 8080,
      },
    });
    const markup = renderPane('adguard-home', configured);
    expect(markup).toContain('Configured');
    expect(markup).toContain('http://adguard.lan:8080');
    // The default port is shown in the mode selector, so a pane reading the wrong field would
    // print 3000 here and still look plausible.
    expect(markup).toContain('Direct Port 8080');
    expect(renderPane('adguard-home', bundle())).not.toContain('Configured');
  });

  it('shows the direct-mode warning in the pane, only for a direct-mode URL that cannot work', () => {
    // Settings has always warned here; the pane offered the same field without it. The markup is
    // now one component both render — this pins that the pane shows it in direct mode, and that
    // the same address under ha-api does not warn (the URL *is* Home Assistant's there).
    const withSinkhole = (sinkholeConfig: Partial<HubPaneProps['sinkholeConfig']>) =>
      bundle({ sinkholeConfig: { ...bundle().sinkholeConfig, ...sinkholeConfig } });

    const haFrontend = renderPane(
      'adguard-home',
      withSinkhole({ adguardMode: 'direct', adguardHomeUrl: 'http://homeassistant.local:8123' }),
    );
    expect(haFrontend).toContain('Home Assistant web interface, not AdGuard Direct');

    const nabuCasa = renderPane(
      'adguard-home',
      withSinkhole({ adguardMode: 'direct', adguardHomeUrl: 'https://some-instance.ui.nabu.casa' }),
    );
    expect(nabuCasa).toContain('Nabu Casa');

    // The address is exactly right for ha-api — the warning must not fire there.
    const haApi = renderPane(
      'adguard-home',
      withSinkhole({ adguardMode: 'ha-api', adguardHomeUrl: 'http://homeassistant.local:8123' }),
    );
    expect(haApi).not.toContain('not AdGuard Direct');

    const clean = renderPane(
      'adguard-home',
      withSinkhole({ adguardMode: 'direct', adguardHomeUrl: 'http://192.168.8.1:3000', adguardDirectPort: 3000 }),
    );
    expect(clean).not.toContain('not AdGuard Direct');
  });

  it('reports a daemon that is stopped differently from one that is running', () => {
    const running = renderPane('system-daemon', bundle());
    expect(running).toContain('● Active Shield');
    expect(running).toContain('48,213');

    const stopped = renderPane(
      'system-daemon',
      bundle({
        daemonStatus: {
          ...bundle().daemonStatus!,
          status: 'stopped',
          managedByApp: false,
          upstream: '',
          stats: undefined,
        },
      }),
    );
    expect(stopped).toContain('○ Daemon Inactive');
    expect(stopped).toContain('Start Local Daemon');
    // An absent upstream falls back to the documented default rather than printing nothing.
    expect(stopped).toContain('dns.quad9.net');
  });
});

describe('the Hub', () => {
  it('renders every tab in the registry order, and the default pane below them', () => {
    const markup = renderToStaticMarkup(createElement(DeployHubView, { savePath: SAVE_PATH }));

    let previous = -1;
    for (const target of DEPLOY_TARGETS) {
      const at = markup.indexOf(`>${escapeHtml(target.label)}</span>`);
      // -1 would mean a tab rendered without its label, and comparing positions would still pass,
      // so both are asserted: the label exists, and it is after the one before it.
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }

    // The pane is the registry's, not a hardcoded default: the Hub opens on the first target and
    // that target's own screen is what renders — today the Browser pane.
    expect(markup).toContain('Browser Extension Package');
    expect(markup).not.toContain('Pi-hole Gravity Automation');
  });

  it('shows the compiled artifact, and the server state it actually has', () => {
    const markup = renderToStaticMarkup(createElement(DeployHubView, { savePath: SAVE_PATH }));
    expect(markup).toContain(SAVE_PATH);
    // `renderToStaticMarkup` runs no effects, so the Hub has not asked the main process whether the
    // feed server is up. The header must therefore read as offline and offer an address to fill in,
    // rather than print a live reading it does not have — the same fallback the panes use.
    expect(markup).toContain('LAN Feed Server (Offline)');
    expect(markup).toContain('http://&lt;your-mac-ip&gt;:9191/blocklist.txt');
    expect(markup).toContain('Ready to Deploy');
  });

  it('leaves the header markup to DeployHubHeader and keeps the tab strip itself', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const view = readFileSync(join(root, 'src/views/DeployHubView.tsx'), 'utf8');
    // The view renders the header component; the top-bar markup itself must not live there any
    // more — a re-inlined copy would render identically and drift, the exact trap the panes' own
    // extraction was meant to close.
    if (!view.includes('<DeployHubHeader')) {
      throw new Error('DeployHubView.tsx does not render <DeployHubHeader>');
    }
    if (view.includes('deploy-hub-top-bar')) {
      throw new Error('DeployHubView.tsx still embeds the header markup inline');
    }
    // The strip, though, is the view's: a tab click is what drives `activeTab` and the select
    // effect, so the buttons stay next to the state they set.
    if (!view.includes('deploy-platform-tabs')) {
      throw new Error('DeployHubView.tsx no longer owns the platform tab strip');
    }
  });
});

/** The `&`, `<` and `>` React escapes before a literal, so anchors are written the way the user reads them. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
