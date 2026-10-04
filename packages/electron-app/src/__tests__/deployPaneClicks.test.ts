/**
 * @jest-environment jsdom
 *
 * The onClick wiring of every Deploy Hub pane, verified by clicking the buttons a user would.
 *
 * `deployRecipeDirectives.test.ts` proves the payloads are documented; this suite proves the
 * buttons deliver them — that the button next to the field labelled "Feed URL" copies *that
 * field's* value, that the mechanism pill calls `setBindMechanism` with the pill's own id, that
 * "Test Connection" reaches the handler for the service the pane is about. A button wired to the
 * wrong variable renders fine and copies the wrong thing, and nothing else in the suite would
 * say so: anchors check that strings exist in source, not which handler fires.
 *
 * The load-bearing check is completeness: every `<button>` a pane renders must be listed in its
 * spec, and every spec entry must match a rendered button, so a new button added without wiring
 * coverage fails here instead of shipping untested. Expected payloads are written by hand, not
 * derived from the helpers under test — the helpers have their own unit tests, and an oracle that
 * imports them could drift together with a mistake.
 */

import { describe, expect, it } from '@jest/globals';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { DEPLOY_TARGETS, type DeployTargetId } from '../deploy/deployTargets';
import { DeployHubHeader } from '../deploy/DeployHubHeader';
import { pickPaneProps } from '../deploy/panes/paneProps';
import type { HubPaneProps } from '../deploy/panes/paneProps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { window: { electron?: unknown } }).window.electron = {};

/* ---------------------------------- harness ---------------------------------- */

/** Every handler prop replaced by a recorder, so a click is observed rather than trusted. */
type Calls = Map<string, unknown[][]>;
type Recorder = (name: string) => (...args: unknown[]) => void;

function recorders(): {
  calls: Calls;
  record: Recorder;
  handlers: Record<string, unknown>;
} {
  const calls: Calls = new Map();
  const record: Recorder = (name: string) => (...args: unknown[]) => {
    calls.set(name, [...(calls.get(name) ?? []), args]);
  };
  const recordAsync = (name: string) => (...args: unknown[]) => {
    record(name)(...args);
    return Promise.resolve();
  };
  const handlers: Record<string, unknown> = {};
  for (const name of [
    'handleCopy', 'setSinkholeConfig', 'setShowHaToken', 'setShowAdguardPass',
    'setShowPiholeKey', 'setAdguardEnv', 'selectAdguardMode', 'setSelectedService',
    'setResolverDraft', 'setReferenceDraft', 'setBindMechanism', 'onSelectTarget',
  ]) handlers[name] = record(name);
  for (const name of [
    'handleTestConnection', 'handleSaveSinkholeConfig', 'handleTriggerLiveSync',
    'handleToggleSyncOnCompile', 'applyDetectedMode', 'handleInspectHaApi',
    'loadTierPlan', 'chooseTierLedger', 'clearTierLedger', 'refreshDaemonStatus',
    'handleStartDaemon', 'handleStopDaemon', 'handleToggleDaemonProtection',
    'handleReloadDaemon', 'handleSetSystemDns', 'handleRestoreSystemDns',
    'handleFlushCache', 'handleToggleInstallScripts', 'handleCheckUnboundReachability',
    'handleSaveUnboundResolver', 'handleDownloadExtension',
  ]) handlers[name] = recordAsync(name);
  return { calls, record, handlers };
}

const SAVE_PATH = '/tmp/blockingmachine/blocklist.txt';
const SINKHOLE: HubPaneProps['sinkholeConfig'] = {
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
};
const SERVER_STATUS = {
  isRunning: true,
  port: 9191,
  localUrl: 'http://127.0.0.1:9191',
  lanUrl: 'http://192.168.1.20:9191',
  lanIp: '192.168.1.20',
};

/** Same convention as deployRecipeDirectives.test.ts — a full bundle, written out by hand. */
function bundle(overrides: Partial<HubPaneProps> = {}): HubPaneProps {
  const noop = () => {};
  const noopAsync = async () => {};
  return {
    savePath: SAVE_PATH,
    exportFormat: 'adguard',
    serverStatus: SERVER_STATUS,
    feedToken: '',
    secretStorageAvailable: null,
    handleCopy: noop,
    copiedKey: null,
    sinkholeConfig: SINKHOLE,
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
    handleDownloadExtension: noopAsync,
    siblingTargets: [],
    onSelectTarget: noop,
    ...overrides,
  };
}

/**
 * What a click must produce. `copiesRow` is the strong wiring check: the button copies its own
 * sibling input's value — the text the user is looking at — so a handler bound to the wrong
 * variable fails even when both strings render correctly. `copies`/`calls` pin the payload for
 * buttons that carry no input.
 */
type Expectation =
  | { readonly copiesRow: string }
  | { readonly copies: string }
  | { readonly calls: string; readonly args?: readonly unknown[] };

interface ButtonSpec {
  /** A substring of the button's text or of its `title` attribute. */
  readonly label: string;
  /** Which matching button, when more than one carries the label (e.g. two "Copy Commands"). */
  readonly occurrence?: number;
  readonly expect: Expectation;
}

interface PaneSpec {
  readonly target: DeployTargetId;
  /** The props state this spec mounts — state-dependent panes appear once per variant. */
  readonly when: string;
  readonly overrides?: Partial<HubPaneProps>;
  readonly buttons: readonly ButtonSpec[];
}

function findButton(
  host: HTMLElement,
  spec: Pick<ButtonSpec, 'label' | 'occurrence'>
): HTMLButtonElement {
  const matches = [...host.querySelectorAll('button')].filter((button) => {
    const text = (button.textContent ?? '').replace(/\s+/g, ' ');
    // Title covers the eye toggles that show an icon; className is the fallback for the ones
    // whose text is a bare emoji, where no readable label exists to match.
    const title = button.getAttribute('title') ?? '';
    return (
      text.includes(spec.label) ||
      title.includes(spec.label) ||
      button.className.includes(spec.label)
    );
  });
  const found = matches[spec.occurrence ?? 0];
  if (!found) {
    const seen = [...host.querySelectorAll('button')].map(
      (b) => `"${(b.textContent ?? '').replace(/\s+/g, ' ').trim()}"`,
    );
    throw new Error(`no button matching "${spec.label}"; rendered: ${seen.join(', ')}`);
  }
  return found as HTMLButtonElement;
}

function verifyPane(spec: PaneSpec): void {
  const target = DEPLOY_TARGETS.find((t) => t.id === spec.target);
  if (!target) throw new Error(`no DEPLOY_TARGETS entry for ${spec.target}`);
  const { calls, handlers } = recorders();
  const props = bundle({ ...(handlers as Partial<HubPaneProps>), ...spec.overrides });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  try {
    act(() => {
      // The same narrowing the Hub applies: the pane is handed only the fields it declares.
      root.render(
        createElement(Fragment, null, target.pane(pickPaneProps(props, target.paneKeys)))
      );
    });
    const rendered = [...host.querySelectorAll('button')] as HTMLButtonElement[];

    // Completeness, both directions: every rendered button is spec'd, every spec renders.
    const renderedLabels = rendered.map(
      (b) => `"${(b.textContent ?? '').replace(/\s+/g, ' ').trim() || b.getAttribute('title')}"`,
    );
    if (rendered.length !== spec.buttons.length) {
      throw new Error(
        `${spec.target} rendered ${rendered.length} buttons but the spec lists ` +
          `${spec.buttons.length}: ${renderedLabels.join(', ')}`,
      );
    }

    const used = new Set<HTMLButtonElement>();
    for (const entry of spec.buttons) {
      const button = findButton(host, entry);
      used.add(button);

      const before = new Map([...calls].map(([k, v]) => [k, v.length]));
      act(() => button.click());

      if ('copiesRow' in entry.expect || 'copies' in entry.expect) {
        const got = calls.get('handleCopy') ?? [];
        if (got.length !== (before.get('handleCopy') ?? 0) + 1) {
          throw new Error(`clicking "${entry.label}" in ${spec.target} produced no handleCopy call`);
        }
        const [text, key] = got[got.length - 1]! as [string, string];
        expect(typeof key === 'string' && key.length > 0).toBe(true);
        if ('copiesRow' in entry.expect) {
          const input = button.closest('.deploy-feed-input-row')?.querySelector('input');
          if (!input) throw new Error(`"${entry.label}" is not beside a readOnly input`);
          expect(text).toBe(input.value);
          expect(input.value).toContain(entry.expect.copiesRow);
        } else {
          expect(text).toContain(entry.expect.copies);
        }
      } else {
        const got = calls.get(entry.expect.calls) ?? [];
        if (got.length !== (before.get(entry.expect.calls) ?? 0) + 1) {
          throw new Error(
            `clicking "${entry.label}" in ${spec.target} produced no ${entry.expect.calls} call`,
          );
        }
        if (entry.expect.args) expect(got[got.length - 1]).toEqual(entry.expect.args);
      }
    }
    if (used.size !== rendered.length) {
      throw new Error(
        `${spec.target}: spec entries matched ${used.size} distinct buttons of ${rendered.length}`,
      );
    }

    // Two buttons sharing a key both light "Copied" together — the keys must be distinct.
    const keys = (calls.get('handleCopy') ?? []).map(([, key]) => key as string);
    expect(new Set(keys).size).toBe(keys.length);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

/* ---------------------------------- the specs ---------------------------------- */

const PANES: readonly PaneSpec[] = [
  {
    target: 'privoxy',
    when: 'default',
    buttons: [
      { label: 'Copy file name', expect: { copiesRow: 'privoxy.action' } },
      {
        label: 'Copy Add-on URL',
        expect: { copiesRow: 'http://homeassistant.local:9191/privoxy.action' },
      },
      { label: 'Copy actionsfile line', expect: { copies: 'actionsfile privoxy.action' } },
      {
        label: 'Copy LAN fetch',
        expect: {
          copies: 'curl -fsSL "http://192.168.1.20:9191/privoxy.action" -o /etc/privoxy/privoxy.action',
        },
      },
      { label: 'Copy restart command', expect: { copies: 'sudo systemctl restart privoxy' } },
    ],
  },
  {
    target: 'bind',
    when: 'rpz mechanism',
    buttons: [
      {
        label: 'Response Policy Zone (recommended)',
        expect: { calls: 'setBindMechanism', args: ['rpz'] },
      },
      { label: 'Shared null zone', expect: { calls: 'setBindMechanism', args: ['null-zone'] } },
      { label: 'Copy file name', expect: { copiesRow: 'blocklist.txt' } },
      {
        label: 'Copy Add-on URL',
        expect: { copiesRow: 'http://homeassistant.local:9191/db.blockingmachine.rpz' },
      },
      {
        label: 'Copy zone stanza',
        expect: { copies: 'zone "rpz.blockingmachine" { type master; file "blocklist.txt"; };' },
      },
      {
        label: 'Copy response-policy line',
        expect: { copies: 'response-policy { zone "rpz.blockingmachine"; };' },
      },
      { label: 'Copy reload command', expect: { copies: 'rndc reload rpz.blockingmachine' } },
    ],
  },
  {
    target: 'bind',
    when: 'null-zone mechanism',
    overrides: { bindMechanism: 'null-zone' },
    buttons: [
      {
        label: 'Response Policy Zone (recommended)',
        expect: { calls: 'setBindMechanism', args: ['rpz'] },
      },
      { label: 'Shared null zone', expect: { calls: 'setBindMechanism', args: ['null-zone'] } },
      { label: 'Copy file name', expect: { copiesRow: 'db.blockingmachine.null' } },
      // The null mechanism has no response-policy line — the recipe says so itself — and its
      // configuration change applies through `rndc reconfig`, not a zone reload.
      { label: 'Copy include line', expect: { copies: 'include "/etc/bind/blockingmachine-zones.conf";' } },
      { label: 'Copy reconfig command', expect: { copies: 'rndc reconfig' } },
    ],
  },
  {
    target: 'unbound',
    when: 'default',
    buttons: [
      { label: 'Copy Feed URL', expect: { copiesRow: 'http://192.168.1.20:9191/unbound.conf' } },
      {
        label: 'Copy include: directive',
        expect: { copies: 'include: "/etc/unbound/unbound.conf.d/blockingmachine.conf"' },
      },
      { label: 'Copy refresh command', expect: { copies: 'curl -fsSL' } },
      { label: 'Check now', expect: { calls: 'handleCheckUnboundReachability' } },
      { label: 'Save addresses', expect: { calls: 'handleSaveUnboundResolver' } },
      // The per-target stepper blocks — each copies the refresh line for *its* config path.
      // 'Copy' also substring-matches the three top-card buttons, so the stepper copies start
      // at occurrence 3 in DOM order.
      {
        label: 'Copy',
        occurrence: 3,
        expect: { copies: '/var/unbound/blockingmachine.conf' },
      },
      {
        label: 'Copy',
        occurrence: 4,
        expect: { copies: '/etc/unbound/unbound.conf.d/blockingmachine.conf' },
      },
      {
        label: 'Copy',
        occurrence: 5,
        expect: { copies: '/etc/unbound/blockingmachine.conf' },
      },
    ],
  },
  {
    target: 'dnsmasq',
    when: 'default',
    buttons: [
      { label: 'Copy Feed URL', expect: { copiesRow: 'http://192.168.1.20:9191/blocklist.txt' } },
    ],
  },
  {
    target: 'shadowrocket',
    when: 'default',
    buttons: [
      { label: 'Copy Feed URL', expect: { copiesRow: 'http://192.168.1.20:9191/shadowrocket.conf' } },
      {
        label: 'Copy Add-on URL',
        expect: { copiesRow: 'http://homeassistant.local:9191/shadowrocket.conf' },
      },
    ],
  },
  {
    target: 'hosts',
    when: 'default',
    buttons: [
      {
        label: 'Copy Command',
        expect: {
          copiesRow:
            'sudo cp "/tmp/blockingmachine/blocklist.txt" /etc/hosts && sudo killall -HUP mDNSResponder',
        },
      },
    ],
  },
  {
    target: 'adguard-desktop',
    when: 'default',
    buttons: [
      { label: 'Copy file:// URL', expect: { copiesRow: 'file:///tmp/blockingmachine/blocklist.txt' } },
      { label: 'Copy Localhost URL', expect: { copiesRow: 'http://127.0.0.1:9191/blocklist.txt' } },
    ],
  },
  {
    target: 'pihole',
    // The reload button is disabled until a Pi-hole URL is configured — correct gating, and a
    // config that could never satisfy it would render the button dead, so the spec sets one.
    when: 'configured',
    overrides: {
      sinkholeConfig: { ...SINKHOLE, piholeUrl: 'http://pi.hole/admin' },
    },
    buttons: [
      {
        label: 'pi.hole/admin',
        expect: {
          calls: 'setSinkholeConfig',
          args: [expect.objectContaining({ piholeUrl: 'http://pi.hole/admin' })],
        },
      },
      {
        label: 'HA Pi-hole (:8080)',
        expect: {
          calls: 'setSinkholeConfig',
          args: [expect.objectContaining({ piholeUrl: 'http://homeassistant.local:8080/admin' })],
        },
      },
      {
        label: 'Docker (localhost)',
        expect: {
          calls: 'setSinkholeConfig',
          args: [expect.objectContaining({ piholeUrl: 'http://localhost:80/admin' })],
        },
      },
      { label: 'deploy-eye-btn', expect: { calls: 'setShowPiholeKey', args: [true] } },
      { label: '⚡ Test Connection', expect: { calls: 'handleTestConnection', args: ['pihole'] } },
      { label: '💾 Save Settings', expect: { calls: 'handleSaveSinkholeConfig', args: ['pihole'] } },
      {
        label: 'Trigger Gravity Reload Now',
        expect: { calls: 'handleTriggerLiveSync', args: ['pihole'] },
      },
      { label: 'Copy Feed URL', expect: { copiesRow: 'http://192.168.1.20:9191/blocklist.txt' } },
      { label: 'Copy Command', expect: { copies: 'pihole -g' } },
    ],
  },
  {
    target: 'home-assistant',
    when: 'default',
    buttons: [
      {
        label: 'REST Service API',
        expect: {
          calls: 'setSinkholeConfig',
          args: [expect.objectContaining({ adguardMode: 'ha-api' })],
        },
      },
      {
        label: 'Webhook',
        expect: {
          calls: 'setSinkholeConfig',
          args: [expect.objectContaining({ adguardMode: 'webhook' })],
        },
      },
      { label: 'Save Connection', expect: { calls: 'handleSaveSinkholeConfig', args: ['adguard'] } },
      { label: 'Test Connection', expect: { calls: 'handleTestConnection', args: ['adguard'] } },
      { label: 'Reload Home Assistant', expect: { calls: 'handleTriggerLiveSync', args: ['adguard'] } },
      { label: 'Copy API URL', expect: { copiesRow: 'http://192.168.1.20:9191/v1/status' } },
      { label: 'Copy DNS Feed', expect: { copiesRow: 'http://192.168.1.20:9191/dns.txt' } },
      { label: 'Copy Browser Feed', expect: { copiesRow: 'http://192.168.1.20:9191/browser.txt' } },
      { label: 'Copy ABP Threats', expect: { copiesRow: 'http://192.168.1.20:9191/threats.txt' } },
      { label: 'Copy Domain Feed', expect: { copiesRow: 'http://192.168.1.20:9191/ai-threats.txt' } },
      { label: 'Fetch Live JSON', expect: { calls: 'handleInspectHaApi' } },
    ],
  },
  {
    target: 'adguard-home',
    // Same gating as Pi-hole: "Push Live Reload Now" is disabled with no target URL.
    when: 'direct mode, configured',
    overrides: {
      sinkholeConfig: { ...SINKHOLE, adguardHomeUrl: 'http://192.168.8.1:3000' },
    },
    buttons: [
      {
        label: 'Direct Port 3000 (Recommended)',
        expect: { calls: 'selectAdguardMode', args: ['direct'] },
      },
      { label: 'HA REST API', expect: { calls: 'selectAdguardMode', args: ['ha-api'] } },
      { label: 'Webhook', expect: { calls: 'selectAdguardMode', args: ['webhook'] } },
      {
        label: 'homeassistant.local:3000',
        expect: {
          calls: 'selectAdguardMode',
          args: ['direct', { adguardHomeUrl: 'http://homeassistant.local:3000' }],
        },
      },
      {
        label: 'HA API (:8123)',
        expect: {
          calls: 'selectAdguardMode',
          args: ['ha-api', { adguardHomeUrl: 'http://homeassistant.local:8123' }],
        },
      },
      {
        label: 'Docker (localhost)',
        expect: {
          calls: 'selectAdguardMode',
          args: ['direct', { adguardHomeUrl: 'http://localhost:3000' }],
        },
      },
      {
        label: 'GL.iNet (192.168.8.1)',
        expect: {
          calls: 'selectAdguardMode',
          args: ['direct', { adguardHomeUrl: 'http://192.168.8.1:3000' }],
        },
      },
      {
        label: 'Nabu Casa Cloud',
        expect: {
          calls: 'selectAdguardMode',
          args: ['ha-api', { adguardHomeUrl: 'https://your-instance.ui.nabu.casa' }],
        },
      },
      { label: 'deploy-eye-btn', expect: { calls: 'setShowAdguardPass', args: [true] } },
      { label: '⚡ Test Connection', expect: { calls: 'handleTestConnection', args: ['adguard'] } },
      { label: '💾 Save Settings', expect: { calls: 'handleSaveSinkholeConfig', args: ['adguard'] } },
      {
        label: 'Push Live Reload Now',
        expect: { calls: 'handleTriggerLiveSync', args: ['adguard'] },
      },
      { label: 'Copy Feed URL', expect: { copiesRow: 'http://192.168.1.20:9191/blocklist.txt' } },
      {
        label: 'Or copy the file path',
        expect: { copies: '/tmp/blockingmachine/blocklist.txt' },
      },
      { label: 'Home Assistant', expect: { calls: 'setAdguardEnv', args: ['homeassistant'] } },
      { label: 'Docker / NAS', expect: { calls: 'setAdguardEnv', args: ['docker'] } },
      { label: 'GL.iNet / Router', expect: { calls: 'setAdguardEnv', args: ['router'] } },
      { label: 'Standalone', expect: { calls: 'setAdguardEnv', args: ['standalone'] } },
    ],
  },
  {
    target: 'system-daemon',
    when: 'daemon running, scripts hidden',
    buttons: [
      { label: 'Pause Protection', expect: { calls: 'handleToggleDaemonProtection' } },
      { label: 'Reload Rules', expect: { calls: 'handleReloadDaemon' } },
      { label: 'Stop Daemon', expect: { calls: 'handleStopDaemon' } },
      { label: 'Refresh', expect: { calls: 'refreshDaemonStatus' } },
      { label: 'Set as System DNS', expect: { calls: 'handleSetSystemDns' } },
      { label: 'Restore DHCP Default', expect: { calls: 'handleRestoreSystemDns' } },
      { label: 'Flush DNS Cache', expect: { calls: 'handleFlushCache' } },
      { label: 'View Install Scripts', expect: { calls: 'handleToggleInstallScripts' } },
    ],
  },
  {
    target: 'system-daemon',
    when: 'daemon running, install scripts shown',
    overrides: {
      showInstallScripts: true,
      serviceScripts: { mac: 'MAC-SCRIPT-MARKER', linux: 'LINUX-SCRIPT-MARKER' },
    },
    buttons: [
      { label: 'Pause Protection', expect: { calls: 'handleToggleDaemonProtection' } },
      { label: 'Reload Rules', expect: { calls: 'handleReloadDaemon' } },
      { label: 'Stop Daemon', expect: { calls: 'handleStopDaemon' } },
      { label: 'Refresh', expect: { calls: 'refreshDaemonStatus' } },
      { label: 'Set as System DNS', expect: { calls: 'handleSetSystemDns' } },
      { label: 'Restore DHCP Default', expect: { calls: 'handleRestoreSystemDns' } },
      { label: 'Flush DNS Cache', expect: { calls: 'handleFlushCache' } },
      { label: 'Hide Scripts', expect: { calls: 'handleToggleInstallScripts' } },
      // Two buttons share the "Copy Commands" label — they must copy their own script.
      { label: 'Copy Commands', occurrence: 0, expect: { copies: 'MAC-SCRIPT-MARKER' } },
      { label: 'Copy Commands', occurrence: 1, expect: { copies: 'LINUX-SCRIPT-MARKER' } },
    ],
  },
  {
    target: 'browser-extension',
    when: 'default',
    overrides: {
      siblingTargets: [
        { id: 'adguard-home', label: 'AdGuard Home', summary: 'Sync through the AdGuard Home API.' },
        { id: 'pihole', label: 'Pi-hole', summary: 'Push the compiled list into gravity.' },
      ],
    },
    buttons: [
      { label: 'Download extension package', expect: { calls: 'handleDownloadExtension' } },
      // The sibling index links into the Hub's own tab switcher, not an IPC.
      { label: 'AdGuard Home', expect: { calls: 'onSelectTarget', args: ['adguard-home'] } },
      { label: 'Pi-hole', expect: { calls: 'onSelectTarget', args: ['pihole'] } },
    ],
  },
  {
    target: 'browser-extension',
    when: 'after a save',
    overrides: {
      extensionSavedPath: '/tmp/dl/blockingmachine-extension',
      siblingTargets: [],
    },
    buttons: [
      { label: 'Download extension package', expect: { calls: 'handleDownloadExtension' } },
      { label: 'Copy saved path', expect: { copies: '/tmp/dl/blockingmachine-extension' } },
    ],
  },
];

describe('every Deploy Hub pane wires its buttons to the right handler', () => {
  it('covers every registered target', () => {
    const covered = new Set(PANES.map((spec) => spec.target));
    for (const target of DEPLOY_TARGETS) {
      if (!covered.has(target.id)) throw new Error(`no click spec for target "${target.id}"`);
    }
  });

  for (const spec of PANES) {
    it(`${spec.target} (${spec.when})`, () => verifyPane(spec));
  }
});

/**
 * The header the view renders above the tab strip gets the same treatment as a pane: it is markup
 * over a prop bundle, so mount it directly and verify every button reaches its handler — including
 * the controls that only exist in the header, like the feed server toggle and the compile button.
 */
describe('the Deploy Hub header wires its controls the same way', () => {
  function mountHeader(overrides: Record<string, unknown> = {}, bridge = true) {
    const { calls, record } = recorders();
    const revealed: string[] = [];
    (window as any).electron = bridge
      ? { showItemInFolder: (p: string) => revealed.push(p) }
      : {};
    const props = {
      savePath: SAVE_PATH,
      exportFormat: 'adguard',
      uniqueRulesCount: 1234,
      lastProcessTime: null,
      handleCopy: record('handleCopy'),
      copiedKey: null,
      onTriggerCompile: record('onTriggerCompile'),
      onNavigateSettings: record('onNavigateSettings'),
      serverStatus: SERVER_STATUS,
      isServerLoading: false,
      onToggleFeedServer: record('onToggleFeedServer'),
      autoStartFeedServer: false,
      onToggleAutoStartFeedServer: record('onToggleAutoStartFeedServer'),
      launchOnStartup: false,
      onToggleLaunchOnStartup: record('onToggleLaunchOnStartup'),
      ...overrides,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(DeployHubHeader, props as any)));
    return { host, root, calls, revealed };
  }

  /** The checkbox inputs are labelled by their wrapping <label>, not by a title. */
  function checkboxFor(host: HTMLElement, labelText: string): HTMLInputElement {
    const label = [...host.querySelectorAll('label')].find((l) =>
      (l.textContent ?? '').includes(labelText));
    const input = label?.querySelector<HTMLInputElement>('input[type=checkbox]');
    if (!input) throw new Error(`no checkbox under "${labelText}"`);
    return input;
  }

  it('wires every rendered button and checkbox', () => {
    const { host, calls, revealed } = mountHeader();
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(6);

    // 'called' for the parameterless handlers (a click passes the event, so there are no args to
    // pin); an args array where the button delivers a real payload like handleCopy's.
    const clickThen = (match: string, expectCalls: Record<string, 'called' | unknown[][]>) => {
      calls.clear();
      act(() => findButton(host, { label: match }).click());
      for (const [name, expected] of Object.entries(expectCalls)) {
        if (expected === 'called') {
          if (!calls.get(name)?.length) throw new Error(`"${match}" did not call ${name}`);
        } else {
          expect(calls.get(name)).toEqual(expected);
        }
      }
    };

    clickThen('Compile (⌘R)', { onTriggerCompile: 'called' });
    clickThen('Copy Path', { handleCopy: [[SAVE_PATH, 'local-path']] });
    clickThen('Format Settings', { onNavigateSettings: 'called' });
    clickThen('Stop Server', { onToggleFeedServer: 'called' });
    // "Reveal" is the one control that still reaches the bridge itself — no prop handler exists.
    act(() => findButton(host, { label: 'Reveal in Finder' }).click());
    expect(revealed).toEqual([SAVE_PATH]);

    // Same rule as copiesRow for the panes: the button must copy the URL the row displays.
    const urlCode = host.querySelector('.deploy-server-url');
    if (!urlCode?.textContent) throw new Error('no .deploy-server-url rendered');
    clickThen('Copy LAN subscription URL', {
      handleCopy: [[urlCode.textContent, 'lan-url']],
    });
    expect(urlCode.textContent).toBe('http://192.168.1.20:9191/blocklist.txt');

    calls.clear();
    const autoStart = checkboxFor(host, 'Auto-start on launch');
    act(() => autoStart.click());
    expect(calls.get('onToggleAutoStartFeedServer')).toEqual([[true]]);
    const launch = checkboxFor(host, 'Launch on computer startup');
    act(() => launch.click());
    expect(calls.get('onToggleLaunchOnStartup')).toEqual([[true]]);
  });

  it('omits the optional buttons when the handlers are not passed', () => {
    const { host } = mountHeader(
      { onTriggerCompile: undefined, onNavigateSettings: undefined },
      false
    );
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Compile (⌘R)');
    expect(labels).not.toContain('Format Settings');
    expect(labels).not.toContain('Reveal in Finder'); // no bridge → no button
  });

  it('shows the offline state and placeholder URL when the server is down', () => {
    const { host, calls } = mountHeader({ serverStatus: null });
    act(() => findButton(host, { label: 'Start Server' }).click());
    if (!calls.get('onToggleFeedServer')?.length) {
      throw new Error('"Start Server" did not call onToggleFeedServer');
    }
    expect(host.querySelector('.deploy-server-url')?.textContent).toBe(
      'http://<your-mac-ip>:9191/blocklist.txt'
    );
    expect(host.textContent).toContain('LAN Feed Server (Offline)');
  });
});
