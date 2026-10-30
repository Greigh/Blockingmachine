# Mobile App UI Redesign — `packages/mobile`

**Status:** implemented 2026-10-25. Companion to `electron-ui-design.md` — same product model, mobile-native shell.

## Problem

The mobile app grew the same way the desktop app did: features accreted into the catch-all surface. `(tabs)/settings.tsx` is ~1,700 lines and ~15 cards; fewer than half are preferences or connection config. The rest are features — on-device filtering, standalone ruleset sync, per-app bypass, HTTPS capture, local DNS service, hub source/feed/custom-rule editing — reachable only by scrolling a flat list under a gear icon.

The app also conflates two scopes that read as one today: *the hub* (remote control of the desktop/HA add-on over `/v1/*`) and *this phone* (Phase-2 on-device filtering — VPN/tunnel, local DNS, standalone ruleset). Both appear as undifferentiated cards in the same scroll.

## Model

Same protection-hub mental model as the desktop redesign, mapped to the app's two scopes:

- **Home answers one question:** is the hub protecting the network *and* is this phone filtering? Both statuses surface at a glance.
- **Features live where they're used**, on the tab that matches their scope.
- **Settings holds connection and preferences only** — servers/pairing, feed token, feed URLs, hub HTTPS pins, docs.

## Information architecture

Five tabs (compact pill + rail/sidebar tiers unchanged in mechanism):

| Tab | Owns | Source today |
|---|---|---|
| **Home** | Hub protection + this-phone filter status, compile freshness, quick compile action | `index.tsx` (dashboard) + a new on-device status row |
| **Protect** | On-device filter/tunnel (per-platform card), standalone ruleset sync, per-app bypass, HTTPS capture, local DNS service, web-filtering-via-hub | Settings cards |
| **Check** | Domain verdict + history | unchanged |
| **Rules** | Hub filter sources, custom rules, standalone filter feeds | Settings cards |
| **Telemetry** | Quarantine/threats + compile history + activity | unchanged (keeps badge) |
| **⚙ Settings** | Servers/pairing, feed token, feed URLs, hub HTTPS pins, docs | pushed sheet via header gear, not a tab |

Decisions made with the owner:

- Settings is a **header gear** (mobile convention; keeps the bar at five).
- **Local DNS service lives in Protect** — other devices consume it, but the service runs on this phone.
- Hub HTTPS pins + feed URLs stay in the Settings sheet — small hub-config cards that read naturally under the connection umbrella.

## Structural changes

- **`src/routes.ts`** (new) — single registry of the five tabs: `id, label, icon, order`. Drives `Tabs.Screen` declarations and `SideNav` (which currently hardcodes four). One vocabulary, like the desktop registry.
- **`app/(tabs)/_layout.tsx`** — four `Tabs.Screen`s → five; titles/icons from the registry.
- **`app/(tabs)/protect.tsx`** (new) — this-phone filtering workspace: the platform on-device card (Android `LocalFilterCard` / iOS `IosTunnelCard`), standalone ruleset sync, per-app bypass, HTTPS capture (Android), iOS hub-filter card, local DNS service.
- **`app/(tabs)/rules.tsx`** (new) — corpus workspace: hub filter sources, custom rules, standalone filter feeds.
- **`app/settings.tsx`** — moves out of `(tabs)` to a pushed route; retains servers/pairing, feed token, feed URLs, hub HTTPS pins, docs. Presented as a sheet/screen with a back affordance.
- **`src/components/ScreenHeader.tsx`** (new) — shared large-title header with a trailing gear (`router.push('/settings')`); tabs render it in place of their current inline titles. Keeps the aurora-to-status-bar look (no navigator header).
- **`src/components/SideNav.tsx`** — renders from the registry; gear item appended for rail/sidebar variants.
- **`app/(tabs)/index.tsx`** — dashboard gains a "This phone" status row (vpn/tunnel, local DNS, standalone-ruleset freshness) linking to Protect.
- **`app/(tabs)/settings.tsx`** — deleted; its surviving cards move to `app/settings.tsx`, its feature cards already re-homed above.

## What does not change

- `/v1` API surface, SSE wiring, TanStack Query usage, server store, SecureStore token, pairing flows, mDNS discovery, `add-server` modal.
- The floating glass tab bar, Android blur channel, width tiers, Duo edge-strip handling.
- Native modules and their lifecycles — cards move, their hooks/handlers come along verbatim.
- Check and Telemetry content, including the quarantine badge contract.
- No new features; this is a re-organization. The one additive surface is Home's "this phone" status row, read from state the app already tracks.

## Accessibility

- Tab items keep accessibility labels; the gear gets `accessibilityLabel="Settings"` on every screen header.
- Protect/Rules cards keep existing accessible labels and roles — they move, they aren't rewritten.
- Settings sheet gets a standard back chevron, `headerShown` from the stack (it can use the native header since it's a pushed route — the aurora treatment is a tab-screen concern).

## Testing

- Route-registry unit test (order, ids, labels).
- Relocation audits mirroring the desktop ratchets: grep-scans asserting the moved card identifiers live in `protect.tsx`/`rules.tsx` and *not* in `settings.tsx`/`_layout.tsx`.
- RNTL render tests for the two new tab screens (mount with mocked bridge/modules).
- `SideNav` item-count/order test.
- Existing suites keep passing — dashboard/check/telemetry tests are unaffected except the dashboard's new status row.

## Out of scope

- Any `/v1` or native-module changes.
- Phase-2 feature work (new filtering capabilities).
- TestFlight/release plumbing — handled as a separate step after this lands.
