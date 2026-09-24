# Home Assistant Add-on: Blockingmachine

AI-powered adblock compiler, segregated DNS/Browser feed server, and local network defense hub for Home Assistant.

## Features

- **Ingress Web Dashboard**: Access the complete Blockingmachine interface directly from your Home Assistant sidebar.
- **Dedicated Feeds**:
  - `http://homeassistant.local:9191/dns.txt`: Pure DNS-level blocklist (zero cosmetic or browser modifiers).
  - `http://homeassistant.local:9191/browser.txt`: Pure browser extension rules with cosmetic element hiding.
- **Integration Ready**: Works seamlessly with the `blockingmachine` Home Assistant Custom Integration for Lovelace cards, automations, and live sensor monitoring.

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
