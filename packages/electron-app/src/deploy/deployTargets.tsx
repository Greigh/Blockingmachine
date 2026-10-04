/**
 * The Deploy Hub's platform target registry.
 *
 * The tab strip used to be nine hand-written `<button>` blocks: the label, the icon, the id and the
 * order all lived in JSX, so renaming a platform, reordering them, or rendering a tooltip meant
 * editing markup nine times, and nothing tied a tab to the pane behind it. The registry makes the
 * list data — id, label, summary, icon, order — and `DeployHubView` renders it. A new platform is
 * therefore one entry here plus one pane module.
 *
 * Each entry also names the pane that renders it. That is the coupling the file exists to hold: the
 * pane is a required field, so a target added without one does not compile, and it was the same
 * property as a `switch` whose `default` narrowed to `never`. What changed is which side holds the
 * link — the registry now points at the pane instead of the Hub pointing at each platform by name —
 * so the Hub's `renderDeployPane` switch went away with the two thousand lines it dispatched to, and
 * a target can no longer be spelled out anywhere in the view.
 *
 * The list itself is still inert: no `chrome.*`, no IPC, no state, and no side effects on import.
 * The pane reference is a render function, which is only markup, and `selectEffect` stays a name
 * rather than a callback so that adding a platform cannot quietly make the registry do something at
 * mount time.
 */

import React, { type ReactNode } from 'react';
import { renderBrowserExtensionPane, browserExtensionPaneKeys } from './panes/BrowserExtensionPane';
import { renderAdGuardHomePane, adGuardHomePaneKeys } from './panes/AdGuardHomePane';
import { renderPiholePane, piholePaneKeys } from './panes/PiholePane';
import { renderHomeAssistantPane, homeAssistantPaneKeys } from './panes/HomeAssistantPane';
import { renderSystemDaemonPane, systemDaemonPaneKeys } from './panes/SystemDaemonPane';
import { renderAdGuardDesktopPane, adGuardDesktopPaneKeys } from './panes/AdGuardDesktopPane';
import { renderHostsPane, hostsPaneKeys } from './panes/HostsPane';
import { renderDnsmasqPane, dnsmasqPaneKeys } from './panes/DnsmasqPane';
import { renderUnboundPane, unboundPaneKeys } from './panes/UnboundPane';
import { renderShadowrocketPane, shadowrocketPaneKeys } from './panes/ShadowrocketPane';
import { renderPrivoxyPane, privoxyPaneKeys } from './panes/PrivoxyPane';
import { renderBindPane, bindPaneKeys } from './panes/BindPane';
import type { DeployPaneRenderer, HubPaneProps } from './panes/paneProps';

/**
 * A side effect a tab runs when it becomes active.
 *
 * Declared as data keyed by name, so the registry stays free of callbacks and the component owns
 * the one function each id resolves to. A target with no effect simply omits it.
 */
export type DeploySelectEffect = 'refresh-daemon-status';

/**
 * The shape a registry entry is *written* in.
 *
 * Deliberately looser than `DeployTargetSpec`: every id here is a plain string literal, because the
 * id union is derived from the list below rather than declared beside it. That is what makes an
 * added target flow all the way through — a new entry widens `DeployTargetId` on its own, and
 * because `pane` is required, the same entry has to say what renders it before it compiles.
 */
interface DeployTargetEntry {
  id: string;
  label: string;
  summary: string;
  icon: ReactNode;
  /**
   * The fields of the Hub bundle the pane reads, imported from the pane module itself so the
   * declaration and the props type can never drift. The Hub narrows the bundle to this list before
   * invoking `pane` — a pane receives what it uses, nothing else.
   */
  paneKeys: readonly (keyof HubPaneProps)[];
  /** The pane this tab opens. Required, so a target cannot be added without something to render. */
  pane: DeployPaneRenderer;
  selectEffect?: DeploySelectEffect;
}

/** The icon frame every tab shares, so a new target only supplies its own paths. */
function tabIcon(children: ReactNode): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * The targets, in tab order.
 *
 * Order is deliberate and user-facing: the browser extension is the install most users are here
 * for, so it leads; the sinkhole integrations follow it, the hosts/rules/resolver views after.
 */
const TARGETS = [
  {
    id: 'browser-extension',
    label: 'Browser',
    summary: 'The extension itself: build, download, and load it into the browser.',
    icon: tabIcon(
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M2 9h20" />
        <path d="M8 4v5" />
      </>,
    ),
    paneKeys: browserExtensionPaneKeys,
    pane: renderBrowserExtensionPane,
  },
  {
    id: 'adguard-home',
    label: 'AdGuard Home',
    summary: 'Sync through the AdGuard Home API, Home Assistant, or a webhook.',
    icon: tabIcon(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />),
    paneKeys: adGuardHomePaneKeys,
    pane: renderAdGuardHomePane,
  },
  {
    id: 'pihole',
    label: 'Pi-hole',
    summary: 'Push the compiled list into a Pi-hole gravity database.',
    icon: tabIcon(
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <line x1="9" y1="1" x2="9" y2="4" />
        <line x1="15" y1="1" x2="15" y2="4" />
        <line x1="9" y1="20" x2="9" y2="23" />
        <line x1="15" y1="20" x2="15" y2="23" />
      </>,
    ),
    paneKeys: piholePaneKeys,
    pane: renderPiholePane,
  },
  {
    id: 'home-assistant',
    label: 'Home Assistant',
    summary: 'Add-on and integration: the Hub feed served from Home Assistant itself.',
    icon: tabIcon(
      <>
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </>,
    ),
    paneKeys: homeAssistantPaneKeys,
    pane: renderHomeAssistantPane,
  },
  {
    id: 'system-daemon',
    label: 'Local System DNS',
    summary: 'The bundled DNS daemon, installed as a launchd or systemd service.',
    icon: tabIcon(
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </>,
    ),
    // The pane reports live service state, so selecting it refreshes rather than showing stale
    // readings from the last mount.
    selectEffect: 'refresh-daemon-status',
    paneKeys: systemDaemonPaneKeys,
    pane: renderSystemDaemonPane,
  },
  {
    id: 'adguard-desktop',
    label: 'AdGuard App',
    summary: 'Subscribe the AdGuard desktop app to the local feed by URL or file path.',
    icon: tabIcon(
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>,
    ),
    paneKeys: adGuardDesktopPaneKeys,
    pane: renderAdGuardDesktopPane,
  },
  {
    id: 'hosts',
    label: 'System Hosts',
    summary: 'Apply the sinkhole directly to this machine through /etc/hosts.',
    icon: tabIcon(
      <>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </>,
    ),
    paneKeys: hostsPaneKeys,
    pane: renderHostsPane,
  },
  {
    id: 'dnsmasq',
    label: 'Routers & DNS',
    summary: 'dnsmasq, Technitium, pfSense and OPNsense stream the feed over the LAN.',
    icon: tabIcon(
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>,
    ),
    paneKeys: dnsmasqPaneKeys,
    pane: renderDnsmasqPane,
  },
  {
    id: 'unbound',
    label: 'Unbound DNS',
    summary: 'A local-zone drop-in feed for OPNsense, pfSense, Linux and OpenWrt.',
    icon: tabIcon(
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M8 11h8" />
        <path d="M12 7v8" />
      </>,
    ),
    paneKeys: unboundPaneKeys,
    pane: renderUnboundPane,
  },
  {
    id: 'shadowrocket',
    label: 'Shadowrocket',
    summary: 'A Surge-style rule-set feed for the iOS client — and Surge itself.',
    icon: tabIcon(
      <>
        <rect x="6" y="2" width="12" height="20" rx="2" />
        <line x1="10" y1="18" x2="14" y2="18" />
        <path d="M9 8h6" />
        <path d="M9 11h6" />
      </>,
    ),
    paneKeys: shadowrocketPaneKeys,
    pane: renderShadowrocketPane,
  },
  {
    id: 'privoxy',
    label: 'Privoxy',
    summary: 'A section-based action file for the Privoxy filtering proxy, copied as a local file.',
    icon: tabIcon(
      <>
        <path d="M4 4h16v12H4z" />
        <path d="M8 20h8" />
        <path d="M12 16v4" />
        <path d="M8 8h8" />
      </>
    ),
    paneKeys: privoxyPaneKeys,
    pane: renderPrivoxyPane,
  },
  {
    id: 'bind',
    label: 'BIND DNS',
    summary: 'A Response Policy Zone whose CNAME policy records do the blocking.',
    icon: tabIcon(
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </>
    ),
    paneKeys: bindPaneKeys,
    pane: renderBindPane,
  },
] as const satisfies readonly DeployTargetEntry[];

/** Every id the registry declares. Derived, so the list above is the single source of truth. */
export type DeployTargetId = (typeof TARGETS)[number]['id'];

export interface DeployTargetSpec {
  id: DeployTargetId;
  /** Short text for the tab. */
  label: string;
  /** One line about what the target is, used as the tab's tooltip. */
  summary: string;
  /** Inline icon, sized to match the strip. */
  icon: ReactNode;
  /**
   * The fields of the Hub bundle this pane reads — the pane module's own list, so what the pane
   * declares it uses is the same array the Hub narrows the bundle down to before invoking `pane`.
   */
  paneKeys: readonly (keyof HubPaneProps)[];
  /** Renders the tab's pane, given the subset of the Hub's state `paneKeys` names. */
  pane: DeployPaneRenderer;
  /** Runs when the tab is selected, when the target needs live state to render. */
  selectEffect?: DeploySelectEffect;
}

/** The registry the UI reads, in tab order. */
export const DEPLOY_TARGETS: readonly DeployTargetSpec[] = TARGETS;

/** The tab the Hub opens on — the extension is the install most users are here for. */
export const DEFAULT_DEPLOY_TARGET_ID: DeployTargetId = 'browser-extension';

const BY_ID = new Map<string, DeployTargetSpec>(DEPLOY_TARGETS.map((target) => [target.id, target]));

export function isDeployTargetId(id: unknown): id is DeployTargetId {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The spec for an id, or undefined for anything that is not in the registry. */
export function deployTargetById(id: string | null | undefined): DeployTargetSpec | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}
