# Electron app shell redesign — design

Status: approved for planning (design review 2026-10-29). Scope: `packages/electron-app` render tree only — no IPC, main-process, or mobile changes.

## Why

The app's information architecture grew by accretion: ten sidebar items in five groups, a twelve-tab Deploy & Sync strip, and a 2,820-line Settings view where feature configuration (sinkhole credentials, LAN feed & mobile pairing, AI provider, compile schedule) sits beside actual preferences (theme, export format, save location). The product's centre of gravity has also moved: the DNS daemon, LAN feed server, mobile companion, HTTPS filter, and AI Radar make it a protection hub, not just a list compiler. The home screen should answer "is my network protected and current?" — the same question the mobile companion answers.

## Structure — five sections

Sidebar collapses to five items; section labels are unnecessary at that size. Each section's sub-screens are reached by one of two patterns chosen by count: a top tab bar (few) or a grouped inner list (many).

### Home (⌘1)

The protection deck, in three zones:

1. **Protection** — today's `ProtectionCard` verbatim: daemon state pill (Active / Paused / Daemon off), port, rules loaded, uptime, blocked-query share, Pause/Start and "Deploy to devices" actions, plus its live strip (feed server address, browser-extension telemetry, auto-compile cadence).
2. **Filter lists + Schedule** — a two-column row: the compile hero (button, ⌘R, last-run timestamp, output path, corpus stats as a single stat line: feeds enabled / modules on / custom rules / shield rating) beside a new schedule card holding `Settings › Automation` (recompile cadence select, push-to-sinkholes toggle, next run).
3. **Network reach** — the one new synthesis: a row of configured deploy targets with freshness (e.g. "Pi-hole · synced 2h ago", "iPhone · paired · seen 4m ago", "Unbound · recipe ready · never pushed") plus an "Open Distribute" link. Cards on Home inform; they do not duplicate sidebar navigation.

### Rules (⌘2)

Top tab bar with four tabs:

- **Feeds** — `SourcesView` + `BulkImportView` merged (bulk import becomes a panel/mode of Feeds, not its own view) + preset bundles.
- **Modules** — `ModulesView` (curated shields).
- **Custom** — `CustomRulesView`.
- **Output** — `RuleBrowserView` (browse compiled lists).

### Discover (⌘3)

Top tab bar with three tabs:

- **Radar** — `AIRadarView` unchanged.
- **AI engine** — provider/model/endpoint configuration extracted from `Settings › AI Engine` (Mini-AI, Ollama, Gemini).
- **Inspect** — `RuleInspectorView`. Radar's `onNavigateInspector` deep-link becomes a same-section tab switch carrying the domain; Inspect keeps its outbound link to Rules › Custom.

### Distribute (⌘4)

Grouped inner list replaces the twelve-tab strip. Each row carries a status dot (configured/live vs never-set-up):

- **DNS & routers** — Pi-hole, AdGuard Home, dnsmasq, Unbound, BIND, Home Assistant.
- **Apps & devices** — Browser extension, AdGuard desktop, Privoxy, Shadowrocket.
- **This Mac** — System daemon, Hosts file.
- **Network** — "LAN feed & pairing": feed-server state and controls, HTTPS data-port token, mobile-pairing QR (absorbed from `Settings › LAN & Pairing`), plus any credential fields orphaned by deleting the Settings sinkhole block (audit: `allowInsecureLocalTls`, data-port token — anything no pane renders).

The twelve panes are moved, not rewritten — they keep their own credential fields, so `Settings › Network Sinkholes` is deleted outright with no shared "Credentials" replacement. `sinkholeConfig` stays shared state in the Distribute host as today.

### Settings (⌘,)

One scroll page, five cards, ~600 lines (from 2,820): **Appearance** (theme + accent palette), **Export format** (compile default), **Save location**, **Startup** (launch at login, feed-server autostart), **About** (version, update check, community links, replay-tour button). Welcome Tour no longer appears in Settings' index beyond the replay button; the onboarding modal itself is unchanged.

## Mechanics

- **Route registry** — new `src/routes.ts`: the single source of truth for sections, sub-screens, sidebar order, keyboard map, and deep-link translation. Rendered by `Sidebar`, the tab bars, and the IPC nav handler.
- **App state** — `{ section, tab }` replaces the flat `currentView` string. Launch lands on Home (same as today's `'process'` default); tab selection is session-ephemeral.
- **Deep links** — IPC `onNavigateView`, tray menu, and onboarding completions send today's view names (`'deploy'`, `'sources'`, `'inspector'`, …); the registry translates them to `{section, tab}` at the boundary. Main-process code is unchanged.
- **Keyboard** — ⌘1 Home, ⌘2 Rules, ⌘3 Discover, ⌘4 Distribute, ⌘, Settings; ⌘R stays compile. Old ⌘5–⌘8 are retired; per-tab shortcuts are deliberately absent (later escape hatch: `Ctrl+Shift+1…n` selects the nth tab of the current section if muscle memory misses them).
- **A11y** — tab bars implement the `tablist`/`tab`/`tabpanel` pattern (arrow-key movement, Home/End); the Distribute inner list is a second labelled `nav` landmark; `aria-current="page"` on the active sidebar item; existing ≤460px drawer mode preserved, with the inner list collapsing to a picker above the pane and tab bars wrapping/scroll-snapping.
- **Error surface** — the global error/success banners stay at the top of the scroll area.

## Components

- `src/routes.ts` — route registry (new).
- `src/components/SectionTabs.tsx` — shared tab bar (new); `src/components/InnerNav.tsx` — grouped inner list (new).
- `src/views/HomeView.tsx` — `DashboardView` reorganized: protection card, compile + schedule row, network reach strip; redundant summary stat cards collapse into the compile card's stat line.
- `src/views/DistributeView.tsx` — `DeployHubView` re-skinned around the inner list; the pane registry, `paneProps` narrowing, and shared `sinkholeConfig` state are preserved.
- `src/views/RulesView.tsx`, `src/views/DiscoverView.tsx` — thin tab hosts wrapping the existing view components.
- `src/views/NetworkPane.tsx` — new Distribute pane absorbing LAN feed / pairing / orphaned credential fields.
- `src/Settings.tsx` — cut to the five preference cards.
- Everything else — the twelve deploy panes, `SourcesView`, `ModulesView`, `CustomRulesView`, `RuleBrowserView`, `RuleInspectorView`, `AIRadarView`, `OnboardingModal`, `PresetsModal` — moves as-is.

## Testing

- The existing renderer test suite (809 tests; DOM tests for `ProtectionCard`, `HttpsFilterCard`, `RuleInspectorView`, deploy panes) stays green — components move, they don't change.
- New coverage: route-registry exhaustiveness (every nav target and every legacy IPC view name resolves), deep-link translation, the keyboard map, reduced Settings card inventory, tab-bar ARIA behaviour.
- Verification protocol unchanged: full workspace suite + lint + typecheck before push; the app's documented a11y baseline (axe-clean, VoiceOver-verified drawer) must remain true.

## Out of scope

Visual re-skin (theme, accent tokens, card styling unchanged); mobile companion; main-process and IPC surface; new features; the `audit/` programme's unverified items.
