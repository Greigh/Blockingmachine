/**
 * What the Hub hands a deploy pane.
 *
 * The Hub is dispatch and state; a pane is markup. That split only works if the boundary is
 * written down, so this file is the boundary: every value a pane may read and every action it may
 * take, in one interface. A pane picks its slice with `Pick<HubPaneProps, …>`, so a pane cannot
 * reach for state the Hub does not pass it, and adding a field here is a deliberate act rather than
 * a new `useState` in the view.
 *
 * Two things are deliberately *not* here. The Hub owns the state and the IPC, so nothing here is a
 * promise of data being current — a pane renders whatever it is given. And the derived values are
 * absent too: the feed URLs and notices a pane shows are computed inside the pane from the three
 * inputs below, by the same pure helpers the Hub's own header uses, so a pane cannot disagree with
 * the strip above it about the address it is telling the user to paste.
 *
 * No `chrome.*`, no `window.electron`, no state of its own: a bundle is a value, so a pane can be
 * rendered by `react-dom/server` in a test with nothing but an object literal.
 */

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type {
  DaemonStatusInfo,
  FeedServerStatus,
  FilterFormat,
  SinkholeConfig,
  SinkholeTestResult,
  UnboundResolverSettings,
} from '../../types/';
import type { UnboundReachability, UnboundReachabilitySnapshot } from '../../unboundReachability';
import type { TierPlanResult } from '../../components/ExtensionTierPlanCard';
import type { BindMechanism } from '../../bindDeploy';

/** The shape of a sync result as the Hub records it: the last push, per service. */
export interface HubSyncResult {
  service: string;
  /** 'warning' = trigger dispatched but confirmation never arrived (e.g. a slow HA service call). */
  status: 'success' | 'error' | 'skipped' | 'warning';
  message: string;
  details?: string;
  timestamp?: string;
}

/** The install scripts the daemon pane shows, fetched on demand from the main process. */
export interface HubServiceScripts {
  mac: string;
  linux: string;
}

/** The reference a pane needs to remember a port the user was editing when focus left the field. */
export type HubNumericRef = { current: number };

export interface HubPaneProps {
  /* -- The artifact, and the three inputs every feed URL is derived from ---------------- */

  /** Absolute path of the compiled list. Empty until the user has chosen somewhere to save. */
  savePath: string;
  /** The format the list was written in, which is what several panes' notices are about. */
  exportFormat: FilterFormat;
  /** Live state of the LAN feed server, or null before the Hub has read it. */
  serverStatus: FeedServerStatus | null;
  /**
   * Whether a feed token is configured — never the value. Recipe commands that POST back
   * (`/v1/deploy-report`) emit `$FEED_TOKEN` in the Authorization header so the shell on the
   * target host expands it at run time; plaintext credentials never cross into the renderer.
   */
  feedTokenConfigured: boolean;

  /* -- Copying, which every pane with a URL or a command needs ------------------------- */

  /** Copies text and lights up the button that asked for it, for 2.4s. */
  handleCopy: (text: string, key: string) => void;
  /** The key of the button currently showing "Copied", or null when none is. */
  copiedKey: string | null;

  /* -- Sinkhole connection settings, shared by AdGuard Home, Pi-hole and Home Assistant -- */

  sinkholeConfig: SinkholeConfig;
  setSinkholeConfig: Dispatch<SetStateAction<SinkholeConfig>>;
  /** Whether the Home Assistant token field is revealed. Shared: both HA panes edit it. */
  showHaToken: boolean;
  setShowHaToken: Dispatch<SetStateAction<boolean>>;
  showAdguardPass: boolean;
  setShowAdguardPass: Dispatch<SetStateAction<boolean>>;
  showPiholeKey: boolean;
  setShowPiholeKey: Dispatch<SetStateAction<boolean>>;
  /** Which of the four illustrated AdGuard environments the setup steps are written for. */
  adguardEnv: 'homeassistant' | 'docker' | 'router' | 'standalone';
  setAdguardEnv: Dispatch<SetStateAction<'homeassistant' | 'docker' | 'router' | 'standalone'>>;

  /**
   * Whether the OS keychain can seal the sinkhole secrets at rest — `false` means the tokens
   * and passwords typed into these panes persist as plaintext, which a credential field should
   * say next to itself rather than leave for the Settings page to discover. `null` = unknown.
   */
  secretStorageAvailable: boolean | null;

  /** The service a connection test is currently running against, or null when idle. */
  testingService: 'pihole' | 'adguard' | 'webhook' | null;
  isSavingSinkhole: boolean;
  isSyncingSinkhole: boolean;
  /** The transient banner text, already expired by the Hub after a few seconds. */
  sinkholeMessage: string | null;
  testResult: SinkholeTestResult | null;
  lastSyncResult: HubSyncResult | null;

  handleTestConnection: (service: 'pihole' | 'adguard' | 'webhook') => Promise<void>;
  handleSaveSinkholeConfig: (service: 'adguard' | 'pihole') => Promise<void>;
  handleTriggerLiveSync: (service: 'adguard' | 'pihole') => Promise<void>;
  handleToggleSyncOnCompile: (enabled: boolean) => Promise<void>;
  /** Switches AdGuard integration method, optionally patching fields at the same time. */
  selectAdguardMode: (
    mode: 'direct' | 'ha-api' | 'webhook',
    patch?: Partial<SinkholeConfig>,
  ) => void;
  /** Applies a mode the mismatch banner detected, which also clears the stale result. */
  applyDetectedMode: (mode: 'direct' | 'ha-api') => Promise<void>;
  /**
   * The port being edited, remembered across focus.
   *
   * A ref rather than state because it changes on every keystroke and must not re-render the Hub:
   * it exists only so that blurring the field can tell what the port was before the user started
   * typing, which is what makes it possible to rewrite that port in the URL it belongs to.
   */
  directPortFocusRef: HubNumericRef;

  /* -- Home Assistant's live inspection and the extension's tier plan -------------------- */

  haApiPreview: string | null;
  isTestingHaApi: boolean;
  handleInspectHaApi: () => Promise<void>;
  tierPlanState: 'loading' | 'ready' | 'error';
  tierPlan: TierPlanResult | null;
  tierPlanError: string | null;
  loadTierPlan: () => Promise<void>;
  chooseTierLedger: () => Promise<void>;
  clearTierLedger: () => Promise<void>;

  /* -- The bundled DNS daemon ---------------------------------------------------------- */

  daemonStatus: DaemonStatusInfo | null;
  isDaemonLoading: boolean;
  daemonMessage: string | null;
  networkServices: string[];
  selectedService: string;
  setSelectedService: Dispatch<SetStateAction<string>>;
  showInstallScripts: boolean;
  serviceScripts: HubServiceScripts | null;
  refreshDaemonStatus: () => Promise<void>;
  handleStartDaemon: () => Promise<void>;
  handleStopDaemon: () => Promise<void>;
  handleToggleDaemonProtection: () => Promise<void>;
  handleReloadDaemon: () => Promise<void>;
  handleSetSystemDns: () => Promise<void>;
  handleRestoreSystemDns: () => Promise<void>;
  handleFlushCache: () => Promise<void>;
  handleToggleInstallScripts: () => Promise<void>;

  /* -- Unbound reachability ------------------------------------------------------------ */

  unboundReachability: UnboundReachability | null;
  unboundSnapshot: UnboundReachabilitySnapshot | null;
  unboundResolver: UnboundResolverSettings | null;
  resolverDraft: string;
  setResolverDraft: Dispatch<SetStateAction<string>>;
  referenceDraft: string;
  setReferenceDraft: Dispatch<SetStateAction<string>>;
  isCheckingUnbound: boolean;
  resolverMessage: string | null;
  handleCheckUnboundReachability: () => Promise<void>;
  handleSaveUnboundResolver: () => Promise<void>;

  /* -- BIND's blocking mechanism ------------------------------------------------------- */

  /** Which of the two blocking mechanisms the BIND recipe is being written for. */
  bindMechanism: BindMechanism;
  setBindMechanism: Dispatch<SetStateAction<BindMechanism>>;

  /* -- The browser extension package ---------------------------------------------------- */

  /** Which release package the extension download fetches — the pane's browser selector. */
  extensionBrowser: 'chromium' | 'firefox' | 'both';
  setExtensionBrowser: Dispatch<SetStateAction<'chromium' | 'firefox' | 'both'>>;
  /** True while the extension is being built and copied out. */
  extensionSaving: boolean;
  /** The path the last build was written to, so the instructions can name it exactly. */
  extensionSavedPath: string | null;
  /** Transient result text — an error, or a note that the save happened. */
  extensionMessage: { text: string; type: 'success' | 'error' } | null;
  /** Downloads the release's extension package for the chosen browser, unpacked where the user picks. */
  handleDownloadExtension: (flavor: 'chromium' | 'firefox' | 'both') => Promise<void>;
  /**
   * The other deploy targets, so the extension pane can index the places the same protection
   * installs — a pane cannot import the registry (the registry imports it), so the Hub narrows
   * the list down to everything that is not the pane itself.
   */
  siblingTargets: readonly { id: string; label: string; summary: string; icon?: ReactNode }[];
  /** Switches the Hub's active tab — the sibling index's links. */
  onSelectTarget: (id: string) => void;
}

/**
 * How a registry entry turns into a pane.
 *
 * A function rather than a component type because the panes do not share one prop list: each pane
 * module exports the names of the fields it reads (`xxxPaneKeys`), derives its props type from that
 * list, and the registry entry carries the same list so the Hub can narrow the bundle before the
 * hand-off. The renderer's parameter is the subset type — a field the list omits is a compile error
 * inside the adapter, not a silent `undefined`.
 */
export type DeployPaneRenderer = (props: HubPaneProps) => ReactNode;

/**
 * Narrows the Hub's bundle to the fields a pane declares.
 *
 * This is the dispatch half of the boundary: the registry says which names a pane reads, the view
 * builds the full bundle, and this produces the object the renderer is actually invoked with — so
 * the element a pane returns has exactly the declared fields and no more. The type is as wide as
 * the keys given: called with an entry's own list, the result is exactly that pane's props.
 */
export function pickPaneProps<K extends keyof HubPaneProps>(
  props: HubPaneProps,
  keys: readonly K[],
): Pick<HubPaneProps, K> {
  const picked = {} as Pick<HubPaneProps, K>;
  for (const key of keys) picked[key] = props[key];
  return picked;
}
