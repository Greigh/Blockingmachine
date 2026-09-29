# Home Assistant Add-on: Blockingmachine

AI-powered adblock compiler, segregated DNS/Browser feed server, and local network defense hub for Home Assistant.

## Features

- **Ingress Web Dashboard**: A full hub UI in your Home Assistant sidebar — live rule statistics computed from the real feed files, a protection pause/resume switch, one-click copyable feed URLs, a searchable rule browser, and a diagnostics panel. The UI inherits Home Assistant's theme variables, so it matches light and dark modes.
- **Real Statistics**: Total / DNS / Browser rule counts are computed from the actual feed files on disk at request time — no fake placeholder numbers. Compile history (count, timestamp, duration) persists across restarts.
- **Protection Toggle**: Pause or resume network blocking state from the dashboard, the REST API, or a Home Assistant automation. Pauses can be time-boxed (`pauseMinutes`) and never survive an expired restart.
- **Live Events (SSE)**: `GET /v1/events` streams `compile_completed` and `protection_changed` events for Home Assistant automations and instant dashboard refreshes.
- **Rule Browser**: `GET /v1/rules?q=...&limit=...&offset=...` returns the compiled rules with scope tags for inspection from scripts or Lovelace templates.
- **Auto-Compile Scheduler**: Honors the `auto_compile_interval` add-on option (`12h`, `24h`, `weekly`, or `disabled`).
- **Segregated Feeds**:
  - `http://homeassistant.local:9191/dns.txt`: Pure DNS-level blocklist (zero cosmetic or browser modifiers).
  - `http://homeassistant.local:9191/browser.txt`: Pure browser extension rules with cosmetic element hiding.
  - `http://homeassistant.local:9191/unbound.conf`: The DNS rules rendered as Unbound `local-zone` statements, for resolvers that cannot read an ABP list.
- **Integration Ready**: Works seamlessly with the `blockingmachine` Home Assistant Custom Integration for Lovelace cards, automations, and live sensor monitoring.

## REST API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/v1/status` | GET | Full hub status: rule counts, compile ledger, protection state, feed URLs |
| `/v1/compile` | POST | Refresh statistics from the feed files, stamp the compile ledger, broadcast `compile_completed` |
| `/v1/protection` | POST | `{"enabled": true\|false}` or `{"pauseMinutes": 30}` — pause/resume blocking state |
| `/v1/rules` | GET | Rule browser: `?q=<substring>&limit=1..500&offset=N` |
| `/v1/events` | GET | Server-Sent Events: `connected`, `compile_completed`, `protection_changed` |
| `/dns.txt` | GET | DNS-level feed (AdGuard Home / Pi-hole compatible) |
| `/browser.txt` | GET | Browser-extension feed with cosmetic rules |
| `/unbound.conf` | GET | Unbound `local-zone` feed (aliases: `/unbound.txt`, `/blockingmachine.conf`) |

## Installation

1. In Home Assistant, navigate to **Settings** > **Add-ons** > **Add-on Store**.
2. Click the three dots in the top right corner and select **Repositories**.
3. Add this repository URL.
4. Locate **Blockingmachine** and click **Install**.
5. Enable **Show in sidebar** and click **Start**.

## Wiring into AdGuard Home Add-on

1. Open **AdGuard Home** in Home Assistant.
2. Go to **Filters** > **DNS blocklists**.
3. Click **Add blocklist** > **Add a custom list**.
4. Enter `http://homeassistant.local:9191/dns.txt` as the URL and `Blockingmachine DNS Feed` as the name.
5. Save and reload.

## Wiring into Pi-hole

1. Open the Pi-hole admin panel.
2. Go to **Group Management** > **Adlists**.
3. Add `http://homeassistant.local:9191/dns.txt` with a description like "Blockingmachine DNS Feed".
4. Run `pihole -g` (or click **Update** in the Gravity section).

## Wiring into Unbound

Unbound has no remote blocklist feature, so it cannot subscribe to `/dns.txt`. The add-on renders the
same DNS rules as `local-zone` statements at `/unbound.conf`, which Unbound reads from a drop-in
file that `unbound.conf` includes.

1. Save the feed to a drop-in file and make Unbound re-read it:

   ```bash
   curl -fsSL http://homeassistant.local:9191/unbound.conf \
     -o /etc/unbound/unbound.conf.d/blockingmachine.conf
   sudo unbound-control reload
   ```

2. Reference that file from `/etc/unbound/unbound.conf`:

   ```
   include: "/etc/unbound/unbound.conf.d/blockingmachine.conf"
   ```

3. Schedule the refresh, so the drop-in tracks the add-on without a restart:

   ```
   0 4 * * * curl -fsSL http://homeassistant.local:9191/unbound.conf -o /etc/unbound/unbound.conf.d/blockingmachine.conf && unbound-control reload
   ```

On **OPNsense** or **pfSense**, Unbound is the built-in resolver: the drop-in belongs under
`/var/unbound/` and the reload is `configctl unbound restart`. Home Assistant OS itself runs Unbound
only through an add-on, and that add-on does not expose its config directory — if you want Unbound to
consume this feed, run the resolver on a separate host (or a container) and point it at the same URL.

## Example automations

Pause protection while a trusted guest network is active:

```yaml
automation:
  - alias: "Pause Blockingmachine for guests"
    trigger:
      - platform: state
        entity_id: switch.guest_network
        to: "on"
    action:
      - service: rest_command.blockingmachine_pause
```

With a `rest_command` in `configuration.yaml`:

```yaml
rest_command:
  blockingmachine_pause:
    url: http://homeassistant.local:9191/v1/protection
    method: POST
    payload: '{"pauseMinutes": 120}'
```

Or subscribe to live compile events from any SSE-capable consumer at
`http://homeassistant.local:9191/v1/events`.

## How feeds are published

The add-on serves whatever the Blockingmachine desktop app (or CLI pipeline)
publishes into the add-on's data directory as `dns.txt` and `browser.txt`.
Until a first publish, the bundled baseline blocklist is served and the
dashboard clearly labels the feed source as `baseline` — compile from the
desktop app with the Home Assistant sync target to go live.
