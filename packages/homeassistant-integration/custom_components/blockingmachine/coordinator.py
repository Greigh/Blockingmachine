"""DataUpdateCoordinator for Blockingmachine."""
from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
from typing import Any

from aiohttp import ClientError, ClientTimeout

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, DEFAULT_SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class BlockingmachineDataUpdateCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Class to manage fetching Blockingmachine status and metrics."""

    def __init__(self, hass: HomeAssistant, host: str, port: int, scan_interval: int = DEFAULT_SCAN_INTERVAL) -> None:
        """Initialize."""
        self.host = host
        self.port = port
        self.base_url = f"http://{host}:{port}"
        self.session = async_get_clientsession(hass)

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
            async with self.session.get(url, timeout=ClientTimeout(total=8)) as response:
                if response.status != 200:
                    raise UpdateFailed(f"Blockingmachine returned HTTP {response.status}")
                data = await response.json()
                return data
        except (ClientError, asyncio.TimeoutError) as err:
            raise UpdateFailed(f"Error communicating with Blockingmachine at {url}: {err}") from err

    async def async_compile_rules(self) -> bool:
        """Trigger filter compilation."""
        url = f"{self.base_url}/v1/compile"
        try:
            async with self.session.post(url, timeout=ClientTimeout(total=10)) as response:
                if response.status == 200:
                    await self.async_request_refresh()
                    return True
                return False
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to trigger compilation on Blockingmachine: %s", err)
            return False

    async def async_check_domain(self, domain: str) -> dict[str, Any]:
        """Check domain verdict against rules and AI radar."""
        url = f"{self.base_url}/v1/check?domain={domain}"
        try:
            async with self.session.get(url, timeout=ClientTimeout(total=6)) as response:
                if response.status == 200:
                    return await response.json()
        except (ClientError, asyncio.TimeoutError) as err:
            _LOGGER.error("Failed to check domain %s: %s", domain, err)
        return {"domain": domain, "blocked": False, "error": True}
