"""DataUpdateCoordinator for Blockingmachine."""
from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
from typing import Any
from urllib.parse import quote

from aiohttp import ClientError, ClientTimeout

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, DEFAULT_SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class BlockingmachineDataUpdateCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Class to manage fetching Blockingmachine status and metrics."""

    def __init__(
        self,
        hass: HomeAssistant,
        host: str,
        port: int,
        scan_interval: int = DEFAULT_SCAN_INTERVAL,
        token: str | None = None,
    ) -> None:
        """Initialize."""
        self.host = host
        self.port = port
        self.base_url = f"http://{host}:{port}"
        self.session = async_get_clientsession(hass)
        # Both servers accept `Authorization: Bearer <token>` — the add-on requires it on
        # every endpoint once `feed_token` is set, and the desktop app requires it on
        # mutations once `feedToken` is set. An empty token sends no header, which keeps
        # the documented open-LAN model unchanged.
        self._headers = {"Authorization": f"Bearer {token}"} if token else {}

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
        )

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch latest status from Blockingmachine REST endpoint."""
        url = f"{self.base_url}/v1/status"
        try:
            async with self.session.get(
                url, headers=self._headers, timeout=ClientTimeout(total=8)
            ) as response:
                if response.status == 401:
                    raise ConfigEntryAuthFailed(
                        "Blockingmachine rejected the configured feed token"
                    )
                if response.status != 200:
                    raise UpdateFailed(f"Blockingmachine returned HTTP {response.status}")
                data = await response.json()
                return data
        except ConfigEntryAuthFailed:
            raise
        except (ClientError, asyncio.TimeoutError) as err:
            raise UpdateFailed(f"Error communicating with Blockingmachine at {url}: {err}") from err

    async def async_compile_rules(self) -> bool:
        """Trigger filter compilation."""
        url = f"{self.base_url}/v1/compile"
        try:
            async with self.session.post(
                url, headers=self._headers, timeout=ClientTimeout(total=10)
            ) as response:
                if response.status == 200:
                    await self.async_request_refresh()
                    return True
                return False
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to trigger compilation on Blockingmachine: %s", err)
            return False

    async def async_check_domain(self, domain: str) -> dict[str, Any]:
        """Check domain verdict against rules and AI radar."""
        url = f"{self.base_url}/v1/check?domain={quote(domain, safe='')}"
        try:
            async with self.session.get(
                url, headers=self._headers, timeout=ClientTimeout(total=6)
            ) as response:
                if response.status == 200:
                    return await response.json()
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to check domain %s: %s", domain, err)
        return {"domain": domain, "blocked": False, "error": True}

    async def async_set_protection(self, enabled: bool) -> bool:
        """Pause or resume DNS protection on the hub."""
        url = f"{self.base_url}/v1/protection"
        try:
            async with self.session.post(
                url, json={"enabled": enabled}, headers=self._headers,
                timeout=ClientTimeout(total=5),
            ) as response:
                if response.status == 200:
                    await self.async_request_refresh()
                    return True
                # A 503 is the honest "the DNS daemon is not running" answer — log the
                # server's own message so the failure names its cause.
                body = await response.text()
                _LOGGER.warning(
                    "Protection toggle on Blockingmachine failed (HTTP %s): %s",
                    response.status, body,
                )
                return False
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to toggle protection on Blockingmachine: %s", err)
            return False

    async def async_set_browser_cosmetics(self, enabled: bool) -> bool:
        """Remotely toggle browser cosmetic element shields."""
        url = f"{self.base_url}/v1/control/cosmetics"
        try:
            async with self.session.post(
                url, json={"enabled": enabled}, headers=self._headers,
                timeout=ClientTimeout(total=5),
            ) as response:
                return response.status == 200
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to toggle browser cosmetics: %s", err)
            return False

    async def async_reload_browser_rules(self) -> bool:
        """Signal connected browser extensions to reload rules."""
        url = f"{self.base_url}/v1/control/reload"
        try:
            async with self.session.post(
                url, headers=self._headers, timeout=ClientTimeout(total=5)
            ) as response:
                return response.status == 200
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to broadcast reload to browsers: %s", err)
            return False
