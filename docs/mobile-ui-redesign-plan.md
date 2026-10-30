# Mobile App UI Redesign — Implementation Plan

Spec: `docs/mobile-ui-redesign-design.md` (approved). Branch: `feat/mobile-shell-redesign` off `main`. Execution: native, TDD, one commit per task; independent reviewer subagent after each task, fixes before proceeding. Commit identity: Daniel Hipskind `<dghipskind@gmail.com>`; no agent attribution.

Mobile conventions: `jest-expo`, tests in `src/__tests__/`, `tsc --noEmit` + `eslint` + `npm test -w packages/mobile` gates. Note: the mobile jest process has a pre-existing open-handle hang after tests pass — judge suites by results, not exit.

## Tasks

### 1 — Route registry
`src/routes.ts`: `TabId` union, `TABS` array `{id, label, icon, route}` in order Home, Protect, Check, Rules, Telemetry; `SETTINGS_ROUTE = '/settings'`; `tabIcon()` helper for the `icon()` factory shape `_layout` uses. Test: order/ids/labels/icons; every route is a valid expo-router path.

### 2 — Shell rewire
- `src/components/ScreenHeader.tsx`: large title + trailing gear (`router.push(SETTINGS_ROUTE)`, `accessibilityLabel="Settings"`).
- `app/settings.tsx` (pushed route): copy of current `(tabs)/settings.tsx` wholesale — all cards come along; slimming is tasks 3–4. Back affordance via stack header.
- `app/(tabs)/_layout.tsx`: five `Tabs.Screen`s from the registry (index, protect, check, rules, telemetry); settings entry removed.
- New `app/(tabs)/protect.tsx` + `app/(tabs)/rules.tsx`: placeholder screens rendering `ScreenHeader` + empty-state text (filled in tasks 3–4) — keeps the rewire self-contained.
- `src/components/SideNav.tsx`: render from registry + gear item → `/settings`.
- Each existing tab screen adopts `ScreenHeader` in place of its inline title.
- Tests: registry→layout contract scan (every `Tabs.Screen` name matches a registry route); SideNav order = registry order; ScreenHeader gear renders + pushes route.

### 3 — Protect screen
Move from `app/settings.tsx` → `app/(tabs)/protect.tsx`, verbatim where feasible: `LocalFilterCard` (Android), `IosTunnelCard`, `IosHubFilterCard`, `HttpsCaptureCard` (Android), `LocalDnsCard`, standalone-ruleset sync block, `PerAppBypass` card, plus their hooks/state/handlers/imports. Platform gating (`Platform.OS` branches) travels unchanged.
Tests: RNTL mount (mocked native modules/state providers); relocation audit — moved card identifiers (`local-vpn`, `standalone`, `per-app`, `localDns`, `httpsCapture` strings) absent from `app/settings.tsx`, present in `protect.tsx`.

### 4 — Rules screen
Move from `app/settings.tsx` → `app/(tabs)/rules.tsx`: `HubSourcesCard`, custom-rules editor, `FilterFeedsCard` (standalone feeds), plus their state/handlers. Settings now holds only: servers/pairing, feed token, feed URLs, hub HTTPS pins, docs.
Tests: RNTL mount; relocation audit (source/feed/custom-rule identifiers absent from settings, present in rules); settings slim audit — remaining `SectionTitle` labels = the five retained cards.

### 5 — Home "this phone" row + final audit
- `index.tsx` dashboard: "This phone" status row — on-device filter state (vpn/tunnel running, local DNS, standalone ruleset freshness) read from existing state (`src/filter/*`, filter state provider); tapping pushes `/protect`.
- Sweep: stale `settings.tsx` card refs, `SideNav` on compact behavior, gear on all five tabs, badge still on Telemetry.
- Tests: dashboard row renders phone-filter status; nav target = protect.
- Final: full mobile suite + `tsc --noEmit` + `eslint` + whole-branch reviewer.

## Out of scope per spec
API/native-module changes, new features, TestFlight plumbing (separate follow-up step).
