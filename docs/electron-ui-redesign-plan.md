# Electron Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the Electron renderer into a five-section shell (Home, Rules, Discover, Distribute, Settings) with feature configuration moved out of Settings and into the surfaces that own it.

**Architecture:** A `routes.ts` registry is the single source of truth for sections, sub-screens, sidebar order, the ⌘ map, and legacy IPC view-name translation. Section hosts (`RulesView`, `DiscoverView`, `DistributeView`) render shared sub-nav primitives — `SectionTabs` for few sub-screens, `InnerNav` for many — around existing view components, which move untouched. `DashboardView` becomes `HomeView`; `DeployHubView` becomes `DistributeView`; `Settings.tsx` shrinks to five preference cards.

**Tech Stack:** React 18 + TypeScript (webpack renderer), Jest (node env for `.test.ts`, jsdom for `.dom.test.tsx`), Electron IPC via `window.electron` (`types/index.d.ts`).

**Spec:** `docs/electron-ui-design.md` — read it first; this plan argues from it.

## Global Constraints

- Commits authored `Daniel Hipskind <dghipskind@gmail.com>` (use `git -c user.name="Daniel Hipskind" -c user.email="dghipskind@gmail.com" commit`); **zero** AI attribution — no `Co-Authored-By`, no "Generated with", no tool/agent names in messages, comments, or docs.
- Work on branch `feat/electron-shell-redesign` (never `codex/*`, `claude/*`, `devin/*`).
- No IPC or main-process changes except **one additive read-only getter** — `get-deploy-refresh-reports` returning `store.get('deployRefreshReports')` — needed by Home's Network reach strip. If declined at review, the strip derives status from `getLiveServices` + `getSinkholeConfig` only and refresh targets show "recipe ready".
- Renderer tests: `cd packages/electron-app && node --experimental-vm-modules ../../node_modules/jest/bin/jest.js [<path>]`; typecheck `npm run type-check`; lint `npm run lint`. Full quiet suite (`npm test`) before any push.
- All `window.electron.*` calls preserved verbatim; view files are moved/re-hosted, not rewritten.
- Markdown files: one logical line per block, never hard-wrap.

## Review Focus

1. **Legacy `navigate-view` names** — `index.ts` sends `process|sources|modules|custom|inspector|browser|bulkImport|deploy|ai-radar`; every one must resolve to a route, unknown names must fall back to Home without crashing (Task 1 tests pin the whole map).
2. **Orphaned sinkhole fields** — `allowInsecureLocalTls`, `httpsFilterDataToken`, `adguardDirectPort` etc.: the Settings deletion must not strand a control the panes never render (Task 6's audit step pins which fields land in NetworkPane).
3. **`bulkImport` deep-link** — must open Rules › Feeds with `SourcesView` on its `'bulk'` internal tab, not silently land on 'list' (Task 4 test).
4. **Drawer mode** — ≤460px: sidebar stays an overlay, tab bars wrap, the Distribute inner list collapses to a picker above the pane (Task 9 responsive check).
5. **Secrets** — `piholeApiKey`/`adguardHomePassword`/`haToken` move between files; the `*Configured`-flag + `clearSecrets` contract and `SecretClearButton` behavior must survive relocation (Task 6 test asserts no plaintext secret prop crosses a boundary it didn't before).

---

### Task 1: Route registry

**Files:**
- Create: `packages/electron-app/src/routes.ts`
- Test: `packages/electron-app/src/__tests__/routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SectionId = 'home' | 'rules' | 'discover' | 'distribute' | 'settings';
  export interface AppRoute { section: SectionId; tab: string | null }
  export interface TabSpec { id: string; label: string }
  export interface SectionSpec { id: SectionId; label: string; icon: ReactNode; shortcut: string; tabs: readonly TabSpec[] }
  export const SECTIONS: readonly SectionSpec[];          // sidebar order
  export const DEFAULT_ROUTE: AppRoute;                   // { section: 'home', tab: null }
  export function routeForViewName(name: string): AppRoute | null; // legacy IPC map
  export function isSectionId(v: unknown): v is SectionId;
  export function sectionById(id: SectionId): SectionSpec;
  ```
- Tab ids pinned by spec: rules → `feeds|modules|custom|output`; discover → `radar|engine|inspect`; distribute → deploy target ids + `network`; home/settings → `tabs: []`.

- [ ] **Step 1: Write the failing test** — `routes.test.ts` asserts: SECTIONS is exactly `[home, rules, discover, distribute, settings]`; every section's `tabs` ids unique; `routeForViewName` maps `'process'→{home,null}`, `'sources'→{rules,'feeds'}`, `'modules'→{rules,'modules'}`, `'custom'→{rules,'custom'}`, `'browser'→{rules,'output'}`, `'inspector'→{discover,'inspect'}`, `'ai-radar'→{discover,'radar'}`, `'bulkImport'→{rules,'feeds'}`, `'deploy'→{distribute,null}`, `'settings'→{settings,null}`; unknown/garbage names return `null`.
- [ ] **Step 2: Run** `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js src/__tests__/routes.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement `routes.ts`** per interfaces; icons are the existing sidebar SVGs extracted into a small `sectionIcon()` helper (reuse markup from `Sidebar.tsx`).
- [ ] **Step 4: Re-run test** — PASS.
- [ ] **Step 5: Commit** — `feat(electron-app): route registry for five-section shell`.

### Task 2: Sub-nav primitives

**Files:**
- Create: `packages/electron-app/src/components/SectionTabs.tsx`, `packages/electron-app/src/components/InnerNav.tsx`
- Test: `packages/electron-app/src/__tests__/sectionTabs.dom.test.tsx`, `innerNav.dom.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const SectionTabs: React.FC<{ tabs: readonly TabSpec[]; activeId: string; onSelect: (id: string) => void; ariaLabel: string }>;
  export const InnerNav: React.FC<{ groups: readonly { label: string; items: readonly { id: string; label: string; icon?: ReactNode; status?: 'live' | 'idle' }[] }[]; activeId: string; onSelect: (id: string) => void; ariaLabel: string }>;
  ```
- SectionTabs renders `role="tablist"` / `role="tab"` / `role="tabpanel"` contract: `aria-selected`, `aria-controls`, arrow-key movement, Home/End jump. InnerNav renders a labelled `nav` landmark with group headings and per-item status dots; `aria-current` on the active row. CSS classes: `section-tabs`, `section-tab(.active)`, `inner-nav`, `inner-nav-group`, `inner-nav-item(.active)`, `inner-nav-dot(.live)` — styled in `index.css` in this task.

- [ ] **Step 1: Failing DOM tests** — SectionTabs: renders tabs in order, `aria-selected` only on active, ArrowRight/ArrowLeft moves focus+selection, Home/End jump to ends, Enter/Space activate. InnerNav: groups render with headings, `aria-current` on active item, status dots get `.live`/`idle` classes, click fires `onSelect` with the item id.
- [ ] **Step 2: Run both files** — FAIL.
- [ ] **Step 3: Implement both components + `index.css` additions.**
- [ ] **Step 4: Re-run** — PASS.
- [ ] **Step 5: Commit** — `feat(electron-app): SectionTabs and InnerNav sub-navigation primitives`.

### Task 3: Deploy registry gains groups

**Files:**
- Modify: `packages/electron-app/src/deploy/deployTargets.tsx` (add `group` field to `DeployTargetEntry`/`DeployTargetSpec`; add `DEPLOY_GROUP_ORDER`)
- Test: `packages/electron-app/src/__tests__/deployTargetGroups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DeployGroup = 'dns' | 'apps' | 'local';
  export const DEPLOY_GROUP_ORDER: readonly { id: DeployGroup; label: string }[];
  // group assignments — dns: pihole, adguard-home, dnsmasq, unbound, bind, home-assistant
  //                     apps: browser-extension, adguard-desktop, privoxy, shadowrocket
  //                     local: system-daemon, hosts
  export function deployTargetsByGroup(): readonly { id: DeployGroup; label: string; targets: readonly DeployTargetSpec[] }[];
  ```
- `network` is NOT a `DeployGroup` — the LAN-feed row is appended by `DistributeView`, not the registry (it has no deploy pane).

- [ ] **Step 1: Failing test** — `deployTargetsByGroup()` returns the three groups in order with exactly the target ids listed above; every `DEPLOY_TARGETS` entry appears exactly once.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — add `group: DeployGroup` to each of the 12 entries; `pane`/`paneKeys`/`selectEffect` untouched.
- [ ] **Step 4: Re-run** — PASS.
- [ ] **Step 5: Commit** — `feat(electron-app): group deploy targets for the inner list`.

### Task 4: RulesView + DiscoverView hosts

**Files:**
- Create: `packages/electron-app/src/views/RulesView.tsx`, `packages/electron-app/src/views/DiscoverView.tsx`
- Create: `packages/electron-app/src/components/AiEnginePane.tsx` (extracted from `Settings.tsx` lines ~2085–2683: `AiProviderConfig`, `AiWatchdogConfig`, `RadarDisplayConfig`, element-harvest summary state + IPC calls verbatim)
- Test: `packages/electron-app/src/__tests__/rulesView.dom.test.tsx`, `discoverView.dom.test.tsx`

**Interfaces:**
- Consumes: `SectionTabs` (Task 2), `TabSpec` (Task 1).
- Produces:
  ```ts
  export const RulesView: React.FC<{ initialTab?: string; feedsInitialTab?: 'list' | 'bulk'; sources; saveSources; onTriggerCompile; navigate: (r: AppRoute) => void; setError; setSuccessMessage }>;
  export const DiscoverView: React.FC<{ initialTab?: string; liveRadarSession; inspectorDomain?: string; onTriggerCompile; navigate: (r: AppRoute) => void; setError; setSuccessMessage }>;
  export const AiEnginePane: React.FC<{}>;  // self-contained: loads/saves its own config via window.electron
  ```
- RulesView tabs: `feeds` → `SourcesView initialTab={feedsInitialTab}`; `modules` → `ModulesView`; `custom` → `CustomRulesView`; `output` → `RuleBrowserView`. Old prop names forwarded verbatim; `onNavigate`/`onNavigateDeploy` callbacks become `navigate({section:'distribute',tab:null})` etc.
- DiscoverView tabs: `radar` → `AIRadarView` (`onNavigateInspector` → internal `setTab('inspect')` + `setInspectorDomain(d)`); `engine` → `AiEnginePane`; `inspect` → `RuleInspectorView initialDomain={inspectorDomain} onNavigateCustomRules={() => navigate({section:'rules',tab:'custom'})}`.

- [ ] **Step 1: Failing DOM tests** — RulesView renders four tabs with correct labels and mounts SourcesView by default; `feedsInitialTab='bulk'` lands SourcesView on its bulk mode; DiscoverView mounts Radar by default; switching to `inspect` mounts RuleInspectorView with the domain prop.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement hosts + extract `AiEnginePane`** — lift the AI Engine `<div className="setting-card">` block and its state/handlers from `Settings.tsx` into the new component; leave a comment-free clean removal (imports the block needs move with it).
- [ ] **Step 4: Re-run** — PASS; `npm run type-check` clean (the extraction removes imports from Settings.tsx — unused ones go with it).
- [ ] **Step 5: Commit** — `feat(electron-app): Rules and Discover section hosts`.

### Task 5: DistributeView

**Files:**
- Create: `packages/electron-app/src/views/DistributeView.tsx` (from `views/DeployHubView.tsx` — rename + re-skin; all hub state, `paneProps` assembly, `pickPaneProps` narrowing, `selectEffect` handling preserved verbatim)
- Modify: `packages/electron-app/src/index.css` (`.inner-nav` responsive collapse at ≤460px)
- Test: `packages/electron-app/src/__tests__/distributeView.dom.test.tsx`

**Interfaces:**
- Consumes: `InnerNav` (Task 2), `deployTargetsByGroup()` (Task 3), `AppRoute` (Task 1).
- Produces:
  ```ts
  export const DistributeView: React.FC<{ savePath: string; initialTarget?: string; onNavigateSettings: () => void; onTriggerCompile: () => void }>;
  ```
- Inner list groups: `deployTargetsByGroup()` then a fixed Network group containing `{ id: 'network', label: 'LAN feed & pairing' }`. Status dots: `live` for targets with a configured signal (sinkholeConfig `*Configured` flags for pihole/adguard-home/home-assistant; `live.extension.lastContactAt` for browser-extension; daemon `status==='running'` for system-daemon; `live.feed.isRunning` for network); `idle` otherwise.
- The 12 panes and their `paneKeys` narrowing are unchanged — `DeployHubView`'s `paneProps` object and `activeTarget.pane(...)` dispatch carry over; only the tab strip JSX is replaced by `InnerNav` + pane body. `onNavigateSettings` still jumps to Settings for the one pane affordance that uses it.

- [ ] **Step 1: Failing DOM test** — renders the grouped inner list (three group headings + Network row), clicking a target renders its pane (assert Pi-hole pane's URL field appears after selecting `pihole`), `browser-extension` selected by default (`DEFAULT_DEPLOY_TARGET_ID`), `selectEffect` fires for `system-daemon` (daemon-status refresh spy), status dots reflect fixture `live`/`sinkholeConfig` props.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `git mv`-style rename of `DeployHubView.tsx` → `DistributeView.tsx`, then replace the `platform-tabs` strip with `InnerNav` and add the Network row dispatch (`activeTab === 'network'` renders `NetworkPane` — Task 6 provides it; until then render a stub `NetworkPane` placeholder component that Task 6 replaces).
- [ ] **Step 4: Re-run** — PASS.
- [ ] **Step 5: Commit** — `feat(electron-app): Distribute section with grouped inner nav`.

### Task 6: NetworkPane

**Files:**
- Create: `packages/electron-app/src/views/NetworkPane.tsx`
- Modify: `packages/electron-app/src/Settings.tsx` (remove LAN & Pairing card, Network Sinkholes card, Automation card)
- Test: `packages/electron-app/src/__tests__/networkPane.dom.test.tsx`

**Interfaces:**
- Consumes: existing IPC — `getFeedServerStatus`, `startFeedServer`, `stopFeedServer`, `get-feed-pairing-payload`, `getSinkholeConfig`, `setSinkholeConfig`; `SecretClearButton`, `secretFields` helpers.
- Produces: `export const NetworkPane: React.FC<{}>;` (self-contained like the deploy panes — reads/writes via `window.electron`).
- Content: `Settings.tsx` lines ~1279–1463 (LAN Access & Mobile Pairing: feed port/status controls, HTTPS data-port token display, `QRCodeSVG` pairing block) moved verbatim + **orphan-field audit**: enumerate every `sinkholeConfig`/Settings field the deleted sections rendered; grep each against `deploy/panes/*.tsx`; any field rendered nowhere (expected candidates: `allowInsecureLocalTls`, `adguardDirectPort` if pane-free, `syncOnCompile` if it moved to ScheduleCard) lands in a small "Connection options" card here.

- [ ] **Step 1: Failing DOM test** — renders feed-server status row, pairing QR mount point, data-port token field; "Start feed server" button calls `startFeedServer`; the audit list is asserted: a test greps `deploy/panes/*.tsx` for each removed Settings field name and asserts the orphans' names appear in `NetworkPane.tsx`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — move the markup/state; write the audit table into the pane's header comment; wire into DistributeView's `network` dispatch.
- [ ] **Step 4: Re-run** — PASS; type-check clean.
- [ ] **Step 5: Commit** — `feat(electron-app): Network pane absorbs LAN feed, pairing, orphaned sinkhole fields`.

### Task 7: HomeView

**Files:**
- Create: `packages/electron-app/src/views/HomeView.tsx` (rename of `views/DashboardView.tsx` — same compile machinery, `progress`, `dashboardStats`, `savePath`, `compileNonce` props preserved)
- Create: `packages/electron-app/src/components/ScheduleCard.tsx`, `packages/electron-app/src/components/NetworkReachStrip.tsx`
- Modify: `packages/electron-app/src/index.ts` (add `ipcMain.handle('get-deploy-refresh-reports', () => store.get('deployRefreshReports') ?? {})`), `packages/electron-app/src/preload.ts` + `packages/electron-app/src/types/index.d.ts` (expose `getDeployRefreshReports(): Promise<Record<string, DeployRefreshReport>>`) — **the one flagged additive IPC**
- Test: `packages/electron-app/src/__tests__/homeView.dom.test.tsx`, `scheduleCard.dom.test.tsx`, `networkReachStrip.dom.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const HomeView: React.FC<{ savePath: string; autoTriggerCompile: boolean; compileNonce: number; onCompileConsumed: () => void; navigate: (r: AppRoute) => void }>;
  export const ScheduleCard: React.FC<{}>;                 // reads getSinkholeConfig/setSinkholeConfig + setAutoSchedule
  export const NetworkReachStrip: React.FC<{ onOpenDistribute: () => void }>;
  ```
- Home layout: `ProtectionCard` (unchanged) → compile hero + `ScheduleCard` two-column row → `NetworkReachStrip`. Dashboard's `overview-stats-grid` cards collapse into the hero's single stat line (feeds enabled / modules on / custom rules / shield rating — data already computed in `dashboardStats`).
- `ScheduleCard` = `Settings.tsx` Automation card (lines ~1153–1207) verbatim: `autoSchedule` select ('disabled'|'12h'|'24h'|'weekly' via `setAutoSchedule`) + `syncOnCompile` toggle via `setSinkholeConfig`.
- `NetworkReachStrip` chip derivation: pihole/AGH/HA → `*Configured` flags + `lastSyncResult`-style detail if present; browser-extension → `live.extension.lastContactAt`; system-daemon → `live.daemon.status`; unbound/bind/dnsmasq/privoxy/shadowrocket → `getDeployRefreshReports()` (or "recipe ready" fallback if the IPC was declined); feed/pairing chip → `live.feed`. "Open Distribute →" calls `onOpenDistribute`.

- [ ] **Step 1: Failing DOM tests** — HomeView renders ProtectionCard + compile hero + schedule card + reach strip in order; ScheduleCard select calls `setAutoSchedule('weekly')` on change; NetworkReachStrip renders one chip per fixture target with the right freshness strings and fires `onOpenDistribute`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — rename + reorganize HomeView; extract ScheduleCard; build NetworkReachStrip; add the IPC getter + preload + type (if approved).
- [ ] **Step 4: Re-run** — PASS; type-check clean.
- [ ] **Step 5: Commit** — `feat(electron-app): Home surface — protection, compile+schedule, network reach`.

### Task 8: Settings slim + App shell rewire

**Files:**
- Modify: `packages/electron-app/src/Settings.tsx` (cut to five cards: Appearance, Export format, Save location, Startup, About — delete Tour card, Automation card, LAN & Pairing card, Network Sinkholes card, AI Engine card; `settings-index` nav deleted with them)
- Modify: `packages/electron-app/src/App.tsx` (`currentView` → `route: AppRoute`; sidebar renders `SECTIONS`; keydown map ⌘1–4 + ⌘,; `onNavigateView`/`onTriggerCompile`/`onOpenSettings` translate via `routeForViewName`; `inspectorInitialDomain`/`feedsInitialTab` state passed to hosts)
- Modify: `packages/electron-app/src/components/Sidebar.tsx` (nav items rendered from `SECTIONS`; sources badge rides on Rules; `isRadarScanning` LIVE pill rides on Discover; section labels and Welcome Tour item removed — tour replay lives in Settings › About)
- Test: `packages/electron-app/src/__tests__/appShell.dom.test.tsx`, update `settings` DOM coverage

**Interfaces:**
- Consumes: everything above.
- Produces: `navigate(route: AppRoute): void` threaded to every host; `{section:'rules',tab:'feeds'}` + `feedsInitialTab='bulk'` for the `'bulkImport'` deep-link.

- [ ] **Step 1: Failing DOM tests** — App renders five sidebar items in registry order; `⌘1..⌘4`/`⌘,` keydown switches sections; a `navigate-view 'deploy'` IPC callback lands on Distribute; `'inspector'` lands Discover › Inspect; `'bulkImport'` lands Rules › Feeds in bulk mode; Settings renders exactly five `setting-card` elements and no `settings-index` nav.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — App.tsx state swap, Sidebar registry render, Settings deletion (verify imports cleaned).
- [ ] **Step 4: Re-run + `npm run type-check` + `npm run lint`** — PASS.
- [ ] **Step 5: Commit** — `feat(electron-app): five-section shell — sidebar, keyboard map, slim Settings`.

### Task 9: Sweep — responsive, a11y, full suite

**Files:**
- Modify: `packages/electron-app/src/index.css` (final responsive polish), any straggler view-name references (`grep -rn "'process'\|'deploy'\|'ai-radar'" src/`)
- Test: full suite

- [ ] **Step 1: Legacy-name sweep** — `grep -rn "currentView\|navigate-view\|'process'\|'bulkImport'" src/` outside `routes.ts` — every remaining occurrence is either the IPC boundary or a bug to fix.
- [ ] **Step 2: Responsive check** — jsdom can't measure widths; manually verify `index.css`: ≤460px collapses inner-nav to a `select` picker, tab bars `flex-wrap`, drawer unchanged. Add a DOM test asserting the picker element exists at narrow container widths if feasible via class toggling, else document manual check.
- [ ] **Step 3: Full suite** — `npm test` (all workspaces' electron tests + lint + type-check). Fix fallout: existing tests that assert on removed markup (sidebar labels, settings sections, deploy tab strip) get updated to the new structure — same assertions, new selectors.
- [ ] **Step 4: Commit** — `refactor(electron-app): retire old view model`.
- [ ] **Step 5: Report** — suite counts, remaining manual checks (real-window resize, VoiceOver drawer pass per `audit/UIUX_FINAL_RELEASE_ACCEPTANCE.md` procedures).
