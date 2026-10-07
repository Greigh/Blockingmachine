# Home Assistant Add-on: Blockingmachine

AI-powered adblock compiler, segregated DNS/Browser feed server, and local network defense hub for Home Assistant.

## Features

- **Ingress Web Dashboard**: A full hub UI in your Home Assistant sidebar — live rule statistics computed from the real feed files, a protection pause/resume switch, one-click copyable feed URLs, a searchable rule browser, and a diagnostics panel. The UI inherits Home Assistant's theme variables, so it matches light and dark modes.
- **Real Statistics**: Total / DNS / Browser rule counts are computed from the actual feed files on disk at request time — no fake placeholder numbers. Compile history (count, timestamp, duration) persists across restarts.
- **Protection Toggle**: Pause or resume network blocking state from the dashboard, the REST API, or a Home Assistant automation. Pauses can be time-boxed (`pauseMinutes`) and never survive an expired restart.
- **Live Events (SSE)**: `GET /v1/events` streams `compile_completed` and `protection_changed` events for Home Assistant automations and instant dashboard refreshes.
- **Optional Feed Token**: Set `feed_token` and every endpoint — feeds, REST API, dashboard — requires it via `?token=`, `Bearer`, or Basic auth, so the rule set can be served on a network that is not fully trusted.
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
| `/v1/compile` | POST | Refresh statistics from the feed files, stamp the compile ledger, broadcast `compile_completed` |
| `/v1/protection` | POST | `{"enabled": true\|false}` or `{"pauseMinutes": 30}` — pause/resume blocking state |
| `/v1/check` | GET | `?domain=<host>` — the verdict a DNS consumer would get: longest-match against the live feed, so a child allow survives a blocked parent |
| `/v1/rules` | GET | Rule browser: `?q=<substring>&limit=1..500&offset=N` |
| `/v1/events` | GET | Server-Sent Events: `connected`, `compile_completed`, `protection_changed` |
| `/dns.txt` | GET | DNS-level feed (AdGuard Home / Pi-hole compatible) |
| `/browser.txt` | GET | Browser-extension feed with cosmetic rules |
| `/unbound.conf` | GET | Unbound `local-zone` feed (aliases: `/unbound.txt`, `/blockingmachine.conf`) |
| `/shadowrocket.conf` | GET | Shadowrocket/Surge rule set for a phone (aliases: `/shadowrocket.txt`, `/ruleset.conf`) |
| `/privoxy.action` | GET | Privoxy `{+block}`/`{-block}` action file (aliases: `/privoxy.txt`, `/blockingmachine.action`) |
| `/db.blockingmachine.rpz` | GET | BIND RPZ zone file — SOA plus wildcard CNAME pairs (aliases: `/bind.rpz`, `/rpz.blockingmachine`) |

## Authentication (optional)

The feed port is published to the network the add-on runs on, which on a flat home LAN is the
convenient default — anything that can reach `homeassistant.local:9191` can read the feeds. On a
network that is not fully trusted (a guest VLAN, a shared building network, anywhere you would
not hand the blocklist to a stranger — or worse, the `/v1/protection` toggle that pauses
blocking), set **`feed_token`** in the add-on's options. It is stored as a masked password field.

Once set, **every** endpoint requires it — feeds, the REST API, and the dashboard, which embeds
rule previews and the feed URLs, so leaving it open would leak what the token protects. Refusals
return `401` with a `Basic` challenge. Three credential shapes work, because consumers differ in
what they can send:

- **Query parameter** — `?token=<your-token>` appended to the feed URL. This is the shape for
  subscriptions that cannot send headers: Shadowrocket remote configs, most adlist URLs, and the
  cron fetches below all work by just pasting the URL.
- **Userinfo URL** — `http://user:<your-token>@homeassistant.local:9191/dns.txt` works in AdGuard
  Home, Pi-hole and anywhere a URL is accepted; the fetcher translates it to Basic auth.
- **Authorization header** — `Bearer <token>` or `Basic <base64>` for scripts:
  `curl -fsSL -u "user:<token>" …` or `curl -fsSL -H "Authorization: Bearer <token>" …`.

The dashboard prints each feed URL with the token already in it — anyone who can open that page
was authorized for it, and a copied URL is meant to work as pasted. With a token set, the sidebar
panel may show a browser login prompt instead of loading inline; open
`http://homeassistant.local:9191/` directly and answer the prompt.

One deliberate non-feature: the `X-Ingress-Path`/`X-Hass-Source` headers that mark requests
arriving through Home Assistant's ingress proxy are *not* accepted as proof — they are headers,
not credentials, and anything that can reach the port directly can set them by hand.

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

2. Reference that file from Unbound's configuration. On Debian and Ubuntu nothing needs adding —
   the shipped `/etc/unbound/unbound.conf` already pulls in `unbound.conf.d/*.conf` via
   `include-toplevel`, so a manual `include:` for the same file would parse it twice. On other
   layouts, add the line where user configuration survives:

   ```
   include: "/etc/unbound/unbound.conf.d/blockingmachine.conf"
   ```

3. Schedule the refresh, so the drop-in tracks the add-on without a restart:

   ```
   0 4 * * * curl -fsSL http://homeassistant.local:9191/unbound.conf -o /etc/unbound/unbound.conf.d/blockingmachine.conf && unbound-control reload
   ```

On **OPNsense**, `unbound.conf` is regenerated from templates — the drop-in belongs in a file
under `/usr/local/etc/unbound.opnsense.d/` (any `*.conf` there is auto-included), and on
**pfSense** the `include:` line goes in the Unbound *Custom options* box. On **OpenWrt** the
UCI-generated config appends `/etc/unbound/unbound_ext.conf`, which is where the line goes.
Home Assistant OS itself runs Unbound only through an add-on, and that add-on does not expose
its config directory — if you want Unbound to consume this feed, run the resolver on a separate
host (or a container) and point it at the same URL.

## Wiring into Shadowrocket (iPhone / iPad)

Shadowrocket cannot read a DNS or hosts list at all. It subscribes to a Surge-style rule set, which
the add-on renders from the same DNS feed as `/unbound.conf` — so a domain sinkholed in your
resolver is the domain the phone blocks.

The reason to point the phone here rather than at the desktop hub is uptime: the add-on is a service
that answers whenever Home Assistant does, where a hub feed only answers while that process is
running and that machine is awake. A rule set that stops arriving is usually a rule set pointing at
a laptop.

1. In Shadowrocket open **Config → Add Remote Config**, choose **Rule Set**.
2. Paste `http://homeassistant.local:9191/shadowrocket.conf`.
3. Shadowrocket re-fetches it each time it opens — and in the background when iOS allows refresh —
   so no cron and nothing to run on the phone.

Two things about the file that are worth knowing rather than discovering:

- The rules live under a `[Rule]` section and use `DOMAIN-SUFFIX`. A rule set without the section is
  not read, and `DOMAIN` (exact host only) would miss every subdomain of a blocked domain.
- Allowed subdomains are emitted as `DOMAIN-SUFFIX,host,DIRECT` **before** the parent that would
  otherwise block them, because a Surge-style rule set is first-match-wins. This is the reverse of
  how Unbound and Privoxy order the same exception, and getting it backwards silently re-blocks
  what you allowed.

The URL is on your LAN, so the device has to be on the same network. For use away from home,
publish the file behind HTTPS and point Shadowrocket at that address instead.

## Wiring into Privoxy

Privoxy cannot subscribe to a blocklist: `actionsfile` names a file in its config directory, and
it is re-read only at startup — there is no reload signal. So the feed is transport for the copy
step, not a subscription, and the add-on renders the action file from the same DNS feed as
`/unbound.conf` — `{+block}` sections, leading-dot patterns, and `{-block}` bypasses after the
blocks (Privoxy is last-match-wins, so that ordering is what makes an exception work).

1. Fetch the action file into Privoxy's config directory:

   ```bash
   curl -fsSL http://homeassistant.local:9191/privoxy.action \
     -o /etc/privoxy/privoxy.action
   ```

2. Name it in `/etc/privoxy/config` — a bare file name resolves inside the config directory, and
   a URL here loads nothing:

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

BIND has no remote blocklist feature either, so `/db.blockingmachine.rpz` is transport for the
same copy-and-reload recipe — not a subscription. The file is a Response Policy Zone: the SOA a
primary zone cannot load without, then two records per blocked name (`host CNAME .` and
`*.host CNAME .`, because a bare trigger matches that name only), and `CNAME rpz-passthru.` pairs
for allowed names.

1. Fetch the zone where `named` can read it:

   ```bash
   curl -fsSL http://homeassistant.local:9191/db.blockingmachine.rpz \
     -o /etc/bind/db.blockingmachine.rpz
   ```

2. Declare the zone in `named.conf`, and enable the policy inside `options { }` — the stanza alone
   only loads the file:

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
    payload: '{"pauseMinutes": 120}'
```

Or subscribe to live compile events from any SSE-capable consumer at
`http://homeassistant.local:9191/v1/events`.

## How feeds are published

The add-on serves `dns.txt` and `browser.txt` from its data directory. Until a
first publish, the bundled baseline blocklist is served and the dashboard
clearly labels the feed source as `baseline`.

To go live, point the add-on at the desktop hub — set **`feed_source_url`** in
the add-on's options to the desktop's feed server (`http://<your-mac>:9191`),
and **`feed_source_token`** if the desktop has a feed token configured. Every
compile — the dashboard's *Compile Rules Now* or the `auto_compile_interval`
schedule — then pulls the latest feeds from the desktop and recounts. The
add-on pulls rather than waiting for a push on purpose: the desktop is a
laptop that sleeps, while the add-on is a service that retries on schedule.
A failed pull keeps the existing feeds and says so in the compile result —
a stale ruleset is better than an empty one.
