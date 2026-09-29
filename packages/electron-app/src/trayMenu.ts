/**
 * Pure model of the menu-bar (Tray) menu and tooltip.
 *
 * Deliberately free of any `electron` import: the exact rows a user sees can
 * then be asserted in a plain Node test without booting the app. `TrayManager`
 * is the only thing that turns these descriptors into real Electron menu items
 * and wires up their click handlers.
 */

export interface TraySharedState {
  /** Last compilation timestamp (raw store value, already localized). */
  lastProcessTime: string | null;
  /** Number of unique rules from the most recent compilation. */
  lastRuleCount: number | null;
  /** Live compile progress, when a compilation is in flight. */
  compileProgress: { status: string; percent: number } | null;
  /** LAN feed-server status. */
  feedServer: { isRunning: boolean; lanUrl: string } | null;
  /** System DNS daemon protection state. */
  protection: {
    enabled: boolean;
    status: "running" | "paused" | "stopped";
  } | null;
}

/** Stable ids for every row that performs an action. */
export type TrayActionId =
  | "open"
  | "compile"
  | "toggle-protection"
  | "flush-dns"
  | "open-deploy"
  | "reveal-output"
  | "open-settings"
  | "quit";

export type TrayMenuRow =
  | { type: "separator" }
  /** A non-interactive informational line. */
  | { type: "status"; label: string }
  | {
      type: "action";
      id: TrayActionId;
      label: string;
      enabled: boolean;
      accelerator?: string;
      /**
       * Set for `toggle-protection`: the protection state the click should
       * apply (true = resume, false = pause).
       */
      protectionEnabled?: boolean;
    };

export type TrayActionRow = Extract<TrayMenuRow, { type: "action" }>;

/** Build the full menu, top to bottom, for the given state. */
export function buildTrayMenu(
  state: TraySharedState,
  compiling: boolean,
): TrayMenuRow[] {
  const rows: TrayMenuRow[] = [];

  // --- Status header ---
  const statusLine = compiling
    ? `Compiling… ${state.compileProgress?.percent ?? 0}%`
    : state.protection
      ? state.protection.enabled
        ? "Protection: Active"
        : "Protection: Paused"
      : "Protection: Daemon not running";
  rows.push({ type: "status", label: statusLine });

  const detailParts: string[] = [];
  if (state.lastRuleCount != null) {
    detailParts.push(`${state.lastRuleCount.toLocaleString()} rules`);
  }
  if (state.lastProcessTime) {
    detailParts.push(`updated ${state.lastProcessTime}`);
  }
  if (detailParts.length > 0) {
    rows.push({ type: "status", label: detailParts.join(" • ") });
  }

  rows.push({ type: "separator" });

  // --- Core actions ---
  rows.push({
    type: "action",
    id: "open",
    label: "Open Blockingmachine",
    enabled: true,
  });

  rows.push({
    type: "action",
    id: "compile",
    label: compiling ? "Compiling… (working)" : "Compile & Update Rules Now",
    enabled: !compiling,
  });

  if (state.compileProgress) {
    rows.push({
      type: "status",
      label: `⏳ ${state.compileProgress.status} (${state.compileProgress.percent}%)`,
    });
  }

  // --- Protection ---
  rows.push({ type: "separator" });
  const protectionRunning =
    state.protection?.status === "running" ||
    state.protection?.status === "paused";
  if (protectionRunning) {
    const paused =
      state.protection?.status === "paused" ||
      state.protection?.enabled === false;
    rows.push({
      type: "action",
      id: "toggle-protection",
      label: paused ? "Resume DNS Protection" : "Pause DNS Protection",
      enabled: true,
      protectionEnabled: paused,
    });
  } else {
    rows.push({ type: "status", label: "DNS Protection: Not Running" });
  }
  rows.push({
    type: "action",
    id: "flush-dns",
    label: "Flush DNS Cache",
    enabled: true,
  });

  // --- LAN / deployment ---
  rows.push({ type: "separator" });
  if (state.feedServer?.isRunning) {
    rows.push({
      type: "status",
      label: `LAN Feed: ${state.feedServer.lanUrl}`,
    });
  } else {
    rows.push({ type: "status", label: "LAN Feed: Offline" });
  }
  rows.push({
    type: "action",
    id: "open-deploy",
    label: "Open Deploy & Sync…",
    enabled: true,
  });

  // --- Files ---
  rows.push({ type: "separator" });
  rows.push({
    type: "action",
    id: "reveal-output",
    label: "Reveal Compiled Rules in Finder",
    enabled: true,
  });

  // --- Session ---
  rows.push({ type: "separator" });
  rows.push({
    type: "action",
    id: "open-settings",
    label: "Settings…",
    enabled: true,
    accelerator: "Cmd+,",
  });
  rows.push({
    type: "action",
    id: "quit",
    label: "Quit Blockingmachine",
    enabled: true,
    accelerator: "Cmd+Q",
  });

  return rows;
}

/** The tooltip shown on hover, mirroring the header of the menu. */
export function buildTrayTooltip(
  state: TraySharedState,
  compiling: boolean,
): string {
  const lines: string[] = ["Blockingmachine"];
  if (compiling) {
    lines.push(`Compiling… ${state.compileProgress?.percent ?? 0}%`);
  } else if (state.lastRuleCount != null) {
    lines.push(`${state.lastRuleCount.toLocaleString()} rules active`);
  }
  if (state.protection) {
    lines.push(
      state.protection.enabled
        ? "DNS protection active"
        : "DNS protection paused",
    );
  }
  return lines.join("\n");
}

/** Find the action row with the given id, if present. */
export function findTrayAction(
  rows: TrayMenuRow[],
  id: TrayActionId,
): TrayActionRow | undefined {
  return rows.find(
    (row): row is TrayActionRow => row.type === "action" && row.id === id,
  );
}

/**
 * Monotonic rebuild counter.
 *
 * Each menu rebuild stamps its rows with the epoch it was built at, and a
 * click whose stamp is no longer current is ignored — so a handler can never
 * act on a row that a newer rebuild already replaced.
 */
export class TrayEpoch {
  private current = 0;

  /** Start a new rebuild and return its epoch. */
  bump(): number {
    return ++this.current;
  }

  /** The epoch of the most recent rebuild. */
  get value(): number {
    return this.current;
  }

  /** Whether a click stamped with `epoch` still refers to the live menu. */
  isCurrent(epoch: number): boolean {
    return epoch === this.current;
  }
}

/** An empty state, useful as a base in tests and as a safe provider default. */
export function emptyTrayState(): TraySharedState {
  return {
    lastProcessTime: null,
    lastRuleCount: null,
    compileProgress: null,
    feedServer: null,
    protection: null,
  };
}
