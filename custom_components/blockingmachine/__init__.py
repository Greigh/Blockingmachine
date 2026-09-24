"""The Blockingmachine Home Assistant Integration."""
from __future__ import annotations

import logging
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall

from .const import (
    DOMAIN,
    CONF_HOST,
    CONF_PORT,
    CONF_SCAN_INTERVAL,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_SCAN_INTERVAL,
    SERVICE_COMPILE,
    SERVICE_CHECK_DOMAIN,
)
from .coordinator import BlockingmachineDataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.SWITCH,
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Blockingmachine from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    host = entry.data.get(CONF_HOST, DEFAULT_HOST)
    port = entry.data.get(CONF_PORT, DEFAULT_PORT)
    scan_interval = entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)

    coordinator = BlockingmachineDataUpdateCoordinator(
        hass, host=host, port=port, scan_interval=scan_interval
    )

    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Register custom services
    async def handle_compile(call: ServiceCall) -> None:
        """Handle compile service call."""
        _LOGGER.info("Home Assistant service triggered: blockingmachine.compile")
        for coord in hass.data[DOMAIN].values():
            await coord.async_compile_rules()

    async def handle_check_domain(call: ServiceCall) -> None:
        """Handle domain check service call."""
        domain = call.data.get("domain", "")
        for coord in hass.data[DOMAIN].values():
            res = await coord.async_check_domain(domain)
            _LOGGER.info("Domain check result for %s: %s", domain, res)

    if not hass.services.has(DOMAIN, SERVICE_COMPILE):
        hass.services.async_register(DOMAIN, SERVICE_COMPILE, handle_compile)
    if not hass.services.has(DOMAIN, SERVICE_CHECK_DOMAIN):
        hass.services.async_register(DOMAIN, SERVICE_CHECK_DOMAIN, handle_check_domain)

    entry.async_on_unload(entry.add_update_listener(update_listener))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)

    return unload_ok


async def update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Update options listener."""
    await hass.config_entries.async_reload(entry.entry_id)
