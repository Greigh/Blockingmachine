# Home Assistant Add-on: Blockingmachine

AI-powered adblock compiler, segregated DNS/Browser feed server, and local network defense hub for Home Assistant.

## Features

- **Ingress Web Dashboard**: A full hub UI in your Home Assistant sidebar — live rule statistics computed from the real feed files, a protection pause/resume switch, one-click copyable feed URLs, a searchable rule browser, and a diagnostics panel. The UI inherits Home Assistant's theme variables, so it matches light and dark modes.
- **Real Statistics**: Total / DNS / Browser rule counts are computed from the actual feed files on disk at request time — no fake placeholder numbers. Compile history (count, timestamp, duration) persists across restarts.
- **Protection Toggle**: Pause or resume network blocking state from the dashboard, the REST API, or a Home Assistant automation. Pauses can be time-boxed (`pauseMinutes`) and never survive an expired restart.
- **Live Events (SSE)**: `GET /v1/events` streams `compile_completed`, `protection_changed`, and `remote_control` events for Home Assistant automations and instant dashboard refreshes.
- **LAN Authentication**: New installs mint a token and require it on every endpoint — feeds, REST API, dashboard — via `?token=`, `Bearer`, Basic auth, or the dashboard's session cookie. Upgraded installs keep open access until you flip the switch; a `feed_token` option always means required. See *Authentication*.
- **Rule Browser**: `GET /v1/rules?q=...&limit=...&offset=...` returns the compiled rules with scope tags for inspection from scripts or Lovelace templates.
- **Auto-Compile Scheduler**: Honors the `auto_compile_interval` add-on option (`12h`, `24h`, `weekly`, or `disabled`).
- **Segregated Feeds**:
  - `http://homeassistant.local:9191/dns.txt`: Pure DNS-level blocklist (zero cosmetic or browser modifiers).
  - `http://homeassistant.local:9191/browser.txt`: Pure browser extension rules with cosmetic element hiding.
  - `http://homeassistant.local:9191/unbound.conf`: The DNS rules rendered as Unbound `local-zone` statements, for resolvers that cannot read an ABP list.
  - `http://homeassistant.local:9191/shadowrocket.conf`: The DNS rules rendered as a Surge-style rule set for a phone on this LAN, so Shadowrocket subscribes to the add-on instead of a desktop that has to stay on.
  - `http://homeassistant.local:9191/privoxy.action`: The DNS rules rendered as a Privoxy `{+block}` action file, for the copy-and-restart deploy recipe.
  - `http://homeassistant.local:9191/db.blockingmachine.rpz`: The DNS rules rendered as a BIND Response Policy Zone — SOA preamble plus wildcard record pairs — for the same copy-and-reload recipe.
- **Integration Ready**: Works seamlessly with the `blockingmachine` Home Assistant Custom Integration for Lovelace cards, automations, and live sensor monitoring.

## REST API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/v1/status` | GET | Full hub status: rule counts, compile ledger, protection state, feed URLs |
| `/v1/compile` | POST | Refresh statistics from the feed files, stamp the compile ledger, broadcast `compile_completed`. Sends `Content-Type: application/json` (an empty `{}` body is fine) |
| `/v1/protection` | POST | `{"enabled": true\|false}` or `{"pauseMinutes": 30}` — pause/resume blocking state. Requires `Content-Type: application/json` |
| `/v1/check` | GET | `?domain=<host>` — the verdict a DNS consumer would get: longest-match against the live feed, so a child allow survives a blocked parent |
| `/v1/rules` | GET | Rule browser: `?q=<substring>&limit=1..500&offset=N` |
| `/v1/events` | GET | Server-Sent Events: `connected`, `compile_completed`, `protection_changed`, `remote_control` |
| `/v1/control/cosmetics` | GET/POST | Broadcast `toggle_cosmetics` to browsers on `/v1/events` (hub-parity remote control) |
| `/v1/control/reload` | POST | Broadcast `reload_rules` to browsers on `/v1/events` (hub-parity remote control) |
| `/dns.txt` | GET | DNS-level feed (AdGuard Home / Pi-hole compatible) |
| `/browser.txt` | GET | Browser-extension feed with cosmetic rules |
| `/unbound.conf` | GET | Unbound `local-zone` feed (aliases: `/unbound.txt`, `/blockingmachine.conf`) |
| `/shadowrocket.conf` | GET | Shadowrocket/Surge rule set for a phone (aliases: `/shadowrocket.txt`, `/ruleset.conf`) |
| `/privoxy.action` | GET | Privoxy `{+block}`/`{-block}` action file (aliases: `/privoxy.txt`, `/blockingmachine.action`) |
| `/db.blockingmachine.rpz` | GET | BIND RPZ zone file — SOA plus wildcard CNAME pairs (aliases: `/bind.rpz`, `/rpz.blockingmachine`) |

## Authentication

The add-on has two LAN postures, recorded in `.lan-auth.json` inside the add-on's data directory so the decision survives restarts:

- **Required (the secured default)** — every endpoint demands the token: feeds, the REST API, and the dashboard. A **new install** lands here automatically: the first boot mints a 192-bit token, stores it at `.feed_token` (mode `0600`) in the data dir, and prints it **once** in the add-on's Log tab — that log line is the credential-recovery path, the same deliberate disclosure boundary as the desktop app's pairing QR. Setting **`feed_token`** in the options also means required, with your own token as the credential (it wins over a generated one).
- **Open (compatibility mode)** — a token is honoured when a client sends one, but never required. An install that *upgrades* into this version lands here automatically: finding prior feed/stat artifacts in the data dir is what proves it is not a new install — token absence alone is never the signal. Use it for feeds whose subscribers cannot carry a credential at all.

Changing the mode is an **administrative operation** — it needs the add-on's *management credential*, not the feed token and not just reaching the port. Every install mints one on first boot (`0600`, `.admin_token` in the data dir, printed once in the add-on **Log**). Find it with the Terminal & SSH or Samba add-ons (`cat /data/blockingmachine/.admin_token`), or in that first-boot Log line. The dashboard's **LAN authentication** card has an *Admin token* field — it stays in the tab's session storage, travels as an `X-Admin-Token` header, and is never stored or sent in a URL. From a shell: `curl -X POST -H "X-Admin-Token: <token>" -H "Content-Type: application/json" -d '{"mode":"required"}' http://<ha>:9191/v1/auth-mode`. A caller without it gets `403` and nothing changes — an open install cannot be force-locked, and a required install cannot be force-opened. The dashboard card shows the token to an authorized viewer so the Copy buttons keep working. In required mode the dashboard itself answers browsers with an unlock page instead of a bare 401: type the feed token once and a `bm_token` session cookie (HttpOnly, SameSite=Strict) keeps Home Assistant ingress and the dashboard working without the `?token=` query hanging around on every click.

Refusals return `401` with a `Basic` challenge for feed clients. Three credential shapes work, because consumers differ in what they can send:

- **Query parameter** — `?token=<your-token>` appended to the feed URL. This is the shape for subscriptions that cannot send headers: Shadowrocket remote configs, most adlist URLs, and the cron fetches below all work by just pasting the URL.
- **Userinfo URL** — `http://user:<your-token>@homeassistant.local:9191/dns.txt` works in AdGuard Home, Pi-hole and anywhere a URL is accepted; the fetcher translates it to Basic auth.
- **Authorization header** — `Bearer <token>` or `Basic <base64>` for scripts: `curl -fsSL -u "user:<token>" …` or `curl -fsSL -H "Authorization: Bearer <token>" …`.

The dashboard prints each feed URL with the token already in it — anyone who can open that page was authorized for it, and a copied URL is meant to work as pasted.

One deliberate non-feature: the `X-Ingress-Path`/`X-Hass-Source` headers that mark requests arriving through Home Assistant's ingress proxy are *not* accepted as proof — they are headers, not credentials, and anything that can reach the port directly can set them by hand.

## Installation

1. In Home Assistant, navigate to **Settings** > **Add-ons** > **Add-on Store**.
2. Click the three dots in the top right corner and select **Repositories**.
3. Add this repository URL.
4. Locate **Blockingmachine** and click **Install**.
5. Enable **Show in sidebar** and click **Start**.

The add-on publishes only `9191/tcp` — the feed server and REST API. It does
**not** run a DNS resolver, so nothing binds `5353/udp`: blocking itself stays
with the resolver that subscribes to the feeds (AdGuard Home, Pi-hole, Unbound,
Shadowrocket), and no port on the host can collide with mDNS because none is
claimed.

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

Unbound has no remote blocklist feature, so it cannot subscribe to `/dns.txt`. The add-on renders the same DNS rules as `local-zone` statements at `/unbound.conf`, which Unbound reads from a drop-in file that `unbound.conf` includes.

1. Save the feed to a drop-in file and make Unbound re-read it:

   ```bash
   curl -fsSL http://homeassistant.local:9191/unbound.conf \
     -o /etc/unbound/unbound.conf.d/blockingmachine.conf
   sudo unbound-control reload
   ```

2. Reference that file from Unbound's configuration. On Debian and Ubuntu nothing needs adding — the shipped `/etc/unbound/unbound.conf` already pulls in `unbound.conf.d/*.conf` via `include-toplevel`, so a manual `include:` for the same file would parse it twice. On other layouts, add the line where user configuration survives:

   ```
   include: "/etc/unbound/unbound.conf.d/blockingmachine.conf"
   ```

3. Schedule the refresh, so the drop-in tracks the add-on without a restart:

   ```
   0 4 * * * curl -fsSL http://homeassistant.local:9191/unbound.conf -o /etc/unbound/unbound.conf.d/blockingmachine.conf && unbound-control reload
   ```

On **OPNsense**, `unbound.conf` is regenerated from templates — the drop-in belongs in a file under `/usr/local/etc/unbound.opnsense.d/` (any `*.conf` there is auto-included), and on **pfSense** the `include:` line goes in the Unbound *Custom options* box. On **OpenWrt** the UCI-generated config appends `/etc/unbound/unbound_ext.conf`, which is where the line goes. Home Assistant OS itself runs Unbound only through an add-on, and that add-on does not expose its config directory — if you want Unbound to consume this feed, run the resolver on a separate host (or a container) and point it at the same URL.

## Wiring into Shadowrocket (iPhone / iPad)

Shadowrocket cannot read a DNS or hosts list at all. It subscribes to a Surge-style rule set, which the add-on renders from the same DNS feed as `/unbound.conf` — so a domain sinkholed in your resolver is the domain the phone blocks.

The reason to point the phone here rather than at the desktop hub is uptime: the add-on is a service that answers whenever Home Assistant does, where a hub feed only answers while that process is running and that machine is awake. A rule set that stops arriving is usually a rule set pointing at a laptop.

1. In Shadowrocket open **Config → Add Remote Config**, choose **Rule Set**.
2. Paste `http://homeassistant.local:9191/shadowrocket.conf`.
3. Shadowrocket re-fetches it each time it opens — and in the background when iOS allows refresh — so no cron and nothing to run on the phone.

Two things about the file that are worth knowing rather than discovering:

- The rules live under a `[Rule]` section and use `DOMAIN-SUFFIX`. A rule set without the section is not read, and `DOMAIN` (exact host only) would miss every subdomain of a blocked domain.
- Allowed subdomains are emitted as `DOMAIN-SUFFIX,host,DIRECT` **before** the parent that would otherwise block them, because a Surge-style rule set is first-match-wins. This is the reverse of how Unbound and Privoxy order the same exception, and getting it backwards silently re-blocks what you allowed.

The URL is on your LAN, so the device has to be on the same network. For use away from home, publish the file behind HTTPS and point Shadowrocket at that address instead.

## Wiring into Privoxy

Privoxy cannot subscribe to a blocklist: `actionsfile` names a file in its config directory, and it is re-read only at startup — there is no reload signal. So the feed is transport for the copy step, not a subscription, and the add-on renders the action file from the same DNS feed as `/unbound.conf` — `{+block}` sections, leading-dot patterns, and `{-block}` bypasses after the blocks (Privoxy is last-match-wins, so that ordering is what makes an exception work).

1. Fetch the action file into Privoxy's config directory:

   ```bash
   curl -fsSL http://homeassistant.local:9191/privoxy.action \
     -o /etc/privoxy/privoxy.action
   ```

2. Name it in `/etc/privoxy/config` — a bare file name resolves inside the config directory, and a URL here loads nothing:

   ```
   actionsfile privoxy.action
   ```

3. Restart and schedule the refresh — each fetch needs a restart before the new patterns apply:

   ```
   sudo systemctl restart privoxy
   ```

   ```
   0 4 * * * curl -fsSL http://homeassistant.local:9191/privoxy.action -o /etc/privoxy/privoxy.action && systemctl restart privoxy
   ```

## Wiring into BIND

BIND has no remote blocklist feature either, so `/db.blockingmachine.rpz` is transport for the same copy-and-reload recipe — not a subscription. The file is a Response Policy Zone: the SOA a primary zone cannot load without, then two records per blocked name (`host CNAME .` and `*.host CNAME .`, because a bare trigger matches that name only), and `CNAME rpz-passthru.` pairs for allowed names.

1. Fetch the zone where `named` can read it:

   ```bash
   curl -fsSL http://homeassistant.local:9191/db.blockingmachine.rpz \
     -o /etc/bind/db.blockingmachine.rpz
   ```

2. Declare the zone in `named.conf`, and enable the policy inside `options { }` — the stanza alone only loads the file:

   ```
   zone "rpz.blockingmachine" { type master; file "db.blockingmachine.rpz"; };
   response-policy { zone "rpz.blockingmachine"; };
   ```

3. Reload, and re-fetch after each publish:

   ```
   sudo rndc reload rpz.blockingmachine
   ```

   ```
   0 4 * * * curl -fsSL http://homeassistant.local:9191/db.blockingmachine.rpz -o /etc/bind/db.blockingmachine.rpz && rndc reload rpz.blockingmachine
   ```

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
    content_type: application/json
    payload: '{"pauseMinutes": 120}'
```

All POST endpoints require `Content-Type: application/json` — a request with any other content type (or none) is refused with `415`. This is deliberate: browsers cannot send a JSON content type cross-origin without a CORS preflight that this server does not grant, which keeps a drive-by web page from toggling protection on an open-mode install. On a required-mode install add the token to the URL (`?token=…`) or an `Authorization: Bearer` header.

Or subscribe to live compile events from any SSE-capable consumer at `http://homeassistant.local:9191/v1/events`.

With the `blockingmachine` custom integration installed, the same stream arrives as **Home Assistant bus events** — the integration subscribes to `/v1/events` on whichever hub it is configured against (add-on or desktop) and re-fires each SSE event as `blockingmachine_<name>`: `blockingmachine_protection_changed`, `blockingmachine_compile_completed`, `blockingmachine_remote_control`, `blockingmachine_rules_updated`, `blockingmachine_quarantine_added`. Automations trigger on them directly:

```yaml
automation:
  - alias: "Blockingmachine paused"
    trigger:
      - platform: event
        event_type: blockingmachine_protection_changed
        event_data:
          enabled: false
    action:
      - service: notify.notify
        data:
          message: "Blockingmachine protection is paused"
```

Pushed events that change entity state (`protection_changed`, `compile_completed`, `rules_updated`, `quarantine_added`) also refresh the coordinator immediately — the 30-second poll remains the source of truth while the stream reconnects.

## How feeds are published

The add-on serves `dns.txt` and `browser.txt` from its data directory. Until a first publish, the bundled baseline blocklist is served and the dashboard clearly labels the feed source as `baseline`.

To go live, point the add-on at the desktop hub — set **`feed_source_url`** in the add-on's options to the desktop's feed server (`http://<your-mac>:9191`), and **`feed_source_token`** if the desktop has a feed token configured. Every compile — the dashboard's *Compile Rules Now* or the `auto_compile_interval` schedule — then pulls the latest feeds from the desktop and recounts. The add-on pulls rather than waiting for a push on purpose: the desktop is a laptop that sleeps, while the add-on is a service that retries on schedule. A failed pull keeps the existing feeds and says so in the compile result — a stale ruleset is better than an empty one.
